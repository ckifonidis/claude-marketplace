// FILE: src/agent-step/compile/validate.ts
//
// Construction-time validation. Fails at CONSTRUCTION, not on the first tool
// call — a miswired tool must surface at startup. Everything checkable from
// the config alone is checked here, including CROSS-ACTION consistency
// (a capturer's consumer must declare `requiresMatch`; an issuer's consumer
// must exist); only genuinely runtime conditions (an effect against absent
// flow state) are left to the run pipeline's defensive throws.

import type { z } from "zod";
import type { ActionDef } from "../types.js";
import { buildControlActivation, type ActivationInputs } from "./activation.js";
import {
  handoffParamsSchema,
} from "../handoff/contract.js";
import type { HandoffRequest } from "../state.js";
import {
  type AbortPolicy,
} from "../controls/contract.js";
import { reservedControlNames } from "../controls/registry.js";
import { channelsOf, type StateSchemaLike } from "./state-schema.js";

export interface ValidatableOptions {
  config: {
    tool: { name: string; description: string };
    actions: Record<string, ActionDef<string>>;
  };
  stateSchema?: StateSchemaLike;
  selectors: Record<string, unknown>;
  executors: Record<string, unknown>;
  verifiers: Record<string, unknown>;
  handoff?: {
    modelRequestSchema?: z.ZodType<HandoffRequest>;
  };
  abortPolicy?: AbortPolicy<string>;
  ladders?: import("../controls/note-refusal.js").LadderRegistry;
  onErrorThreshold?: unknown;
}

/** The library-managed slots this configuration will WRITE (non-null values),
 *  derived from the features it uses. The host's state schema must carry a
 *  channel for each — the patch merger copies only fields present in the
 *  channel map, so a missing channel silently DISCARDS the write: the runner
 *  would report `needs_confirmation` while no gate was ever stored. */
function requiredManagedChannels(opts: ValidatableOptions): string[] {
  const required = new Set<string>();
  for (const action of Object.values(opts.config.actions)) {
    if (action.asks && Object.keys(action.asks).length > 0) {
      required.add("awaitingInput");
    }
    const c = action.controller;
    if (!c) {
      if (action.pageable) required.add("pagedRead");
      continue;
    }
    if (
      c.requiresConfirmation ||
      c.requiresOtp ||
      c.issuesOtp ||
      c.requiresMatch ||
      c.startsMatchFor
    ) {
      required.add("awaitingInput");
    }
    if (c.startsFlow || c.endsFlow || c.requiresFlow || c.issuesOtp) {
      required.add("currentFlow");
    }
    if (action.pageable) required.add("pagedRead");
  }
  if (opts.handoff != null) {
    required.add("handoff");
  }
  if (opts.handoff != null || opts.onErrorThreshold != null) {
    required.add("errorCount");
  }
  // The once-latch record (the ladders): without this channel the runner's
  // write is silently discarded, so a free use never spends and the
  // escalation NEVER fires.
  if (Object.keys(opts.ladders ?? {}).length > 0) {
    required.add("spentLadders");
  }
  // …and the gate budgets: without the channel a spent proposal / mismatch is
  // never recorded, and an abort refunds the whole budget again.
  for (const action of Object.values(opts.config.actions) as {
    controller?: { requiresConfirmation?: unknown; requiresMatch?: unknown };
  }[]) {
    if (action.controller?.requiresConfirmation || action.controller?.requiresMatch) {
      required.add("spentLadders");
    }
  }
  return [...required];
}

export function validateConfig(opts: ValidatableOptions): void {
  const { config, selectors, executors, verifiers } = opts;
  if (!opts.stateSchema) {
    throw new Error("agent-step: buildAgentStepTool requires `stateSchema`.");
  }
  // Channel completeness: every library slot this config writes must have a
  // channel in the host schema, or the merger drops the write silently.
  const channels = channelsOf(opts.stateSchema);
  const missing = requiredManagedChannels(opts).filter((slot) => !(slot in channels));
  if (missing.length > 0) {
    throw new Error(
      `agent-step: the state schema is missing channel(s) ${missing
        .map((m) => `"${m}"`)
        .join(", ")} required by this configuration — writes to them would be ` +
        `silently discarded. Spread \`agentStepStateSpec\` (Annotation.Root) or ` +
        `\`agentStepZodShape\` (Zod) into the host state schema.`,
    );
  }
  const ladders = opts.ladders ?? {};
  const configuredHandoffSchema = opts.handoff?.modelRequestSchema as unknown;
  if (
    configuredHandoffSchema !== undefined &&
    (configuredHandoffSchema === null ||
      (typeof configuredHandoffSchema !== "object" &&
        typeof configuredHandoffSchema !== "function") ||
      typeof (configuredHandoffSchema as { safeParse?: unknown }).safeParse !==
        "function")
  ) {
    throw new Error("agent-step: handoff.modelRequestSchema must be a Zod schema.");
  }
  const actionNames = Object.keys(config.actions);
  // Shared construction (compile/activation.ts); conservativeLifecycle keeps
  // the reserved-name set independent of the lifecycle analysis below.
  const activation = buildControlActivation({
    actions: config.actions as Record<string, import("../types.js").ActionDef<string>>,
    handoff: opts.handoff as ActivationInputs<string>["handoff"],
    abortPolicy: opts.abortPolicy,
    ladders: opts.ladders,
    conservativeLifecycle: true,
  });
  const repeatableConfirmationActions = activation.repeatableConfirmationActions;
  // A repeatable gate's taxonomy is incompatible with the generic reply
  // contract: the generic template ends "anything else → make no call and
  // re-ask", while the repeat control exists precisely so the re-ask is a
  // TOOL CALL returning the stored bytes (measured 2026-08-14: at a repeatable
  // consent gate governed by the generic contract, the model made no call on a
  // clarification and executed on side-speech). Fail construction rather than
  // silently inherit the wrong contract.
  for (const name of repeatableConfirmationActions) {
    const opts = config.actions[name].controller?.requiresConfirmation;
    const contract =
      typeof opts === "object" ? opts.replyContract : undefined;
    // A GateContractSpec always composes non-empty (the composer validates its
    // own fields), so presence is the whole check.
    if (contract == null) {
      throw new Error(
        `agent-step: action "${name}" enables repeatReadBack but declares no ` +
          `replyContract. A repeatable gate routes re-asks through the repeat ` +
          `control, which the generic reply contract forbids ("make no call"); ` +
          `declare the gate's own reply taxonomy in ` +
          `requiresConfirmation.replyContract.`,
      );
    }
  }

  const rawAbortPolicy = opts.abortPolicy as unknown;
  if (
    rawAbortPolicy !== undefined &&
    (rawAbortPolicy === null || typeof rawAbortPolicy !== "object")
  ) {
    throw new Error("agent-step: abortPolicy must be an object.");
  }
  if (opts.abortPolicy) {
    if (
      opts.abortPolicy.requireActive !== undefined &&
      typeof opts.abortPolicy.requireActive !== "boolean"
    ) {
      throw new Error("agent-step: abortPolicy.requireActive must be a boolean.");
    }
    if (
      opts.abortPolicy.allowStandalone !== undefined &&
      typeof opts.abortPolicy.allowStandalone !== "boolean"
    ) {
      throw new Error("agent-step: abortPolicy.allowStandalone must be a boolean.");
    }
    const followers = opts.abortPolicy.allowedFollowers;
    if (followers !== undefined) {
      if (
        !Array.isArray(followers) ||
        followers.some(
          (name) => typeof name !== "string" || name.trim().length === 0,
        )
      ) {
        throw new Error(
          "agent-step: abortPolicy.allowedFollowers must contain non-empty action names.",
        );
      }
      if (new Set(followers).size !== followers.length) {
        throw new Error(
          "agent-step: abortPolicy.allowedFollowers contains duplicate actions.",
        );
      }
      for (const follower of followers) {
        if (!actionNames.includes(follower)) {
          throw new Error(
            `agent-step: abortPolicy lists unknown allowedFollower "${follower}".`,
          );
        }
      }
      if (opts.abortPolicy.allowStandalone === false && followers.length === 0) {
        throw new Error(
          "agent-step: abortPolicy with allowStandalone=false requires at least one allowedFollower (or omit allowedFollowers to permit any domain action).",
        );
      }
    }

    const pendingTargets = opts.abortPolicy.allowedPendingTargets;
    if (pendingTargets !== undefined) {
      if (
        !Array.isArray(pendingTargets) ||
        pendingTargets.some(
          (name) => typeof name !== "string" || name.trim().length === 0,
        )
      ) {
        throw new Error(
          "agent-step: abortPolicy.allowedPendingTargets must contain non-empty action names.",
        );
      }
      if (pendingTargets.length === 0) {
        throw new Error(
          "agent-step: abortPolicy.allowedPendingTargets must not be empty when provided.",
        );
      }
      if (new Set(pendingTargets).size !== pendingTargets.length) {
        throw new Error(
          "agent-step: abortPolicy.allowedPendingTargets contains duplicate actions.",
        );
      }
      for (const target of pendingTargets) {
        if (!actionNames.includes(target)) {
          throw new Error(
            `agent-step: abortPolicy lists unknown allowedPendingTarget "${target}".`,
          );
        }
      }
    }
  }


  // `abort_pending_input` is always reserved. `request_handoff` is reserved
  // ONLY when the library handoff is opted into — a tool that does NOT pass
  // `handoff` may define its own action under that name.
  for (const reserved of reservedControlNames(activation)) {
    if (actionNames.includes(reserved)) {
      throw new Error(
        `agent-step: "${reserved}" is a reserved action name auto-injected by the library; remove it from config.actions.`,
      );
    }
  }

  for (const a of actionNames) {
    const action = config.actions[a];
    // Selectors and executors are registered 1:1 under the action name.
    if (typeof selectors[a] !== "function") {
      throw new Error(
        `agent-step: action "${a}" expects a state selector at selectors["${a}"] but none was found.`,
      );
    }
    if (typeof executors[a] !== "function") {
      throw new Error(
        `agent-step: action "${a}" expects an executor at executors["${a}"] but none was found.`,
      );
    }
    if (typeof action.description !== "string" || action.description.length === 0) {
      throw new Error(
        `agent-step: action "${a}" is missing a non-empty description.`,
      );
    }
    for (const p of action.prereqs) {
      if (!verifiers[p]) {
        throw new Error(
          `agent-step: action "${a}" lists prereq "${p}" but verifiers["${p}"] was not provided.`,
        );
      }
    }
    // Cross-action lifecycle consistency — checkable from the config alone,
    // so a miswired double-entry or OTP pair fails at startup instead of
    // mid-conversation.
    const controller = action.controller;
    if (controller?.startsMatchFor) {
      const consumerName = controller.startsMatchFor.consumer_action;
      const consumer = config.actions[consumerName];
      if (!consumer?.controller?.requiresMatch) {
        throw new Error(
          `agent-step: action "${a}" declares startsMatchFor "${consumerName}" but that consumer doesn't declare requiresMatch.`,
        );
      }
    }
    if (controller?.issuesOtp) {
      const consumerName = controller.issuesOtp.consumer_action;
      if (!config.actions[consumerName]) {
        throw new Error(
          `agent-step: action "${a}" declares issuesOtp for "${consumerName}" but no such action exists.`,
        );
      }
    }
    if (controller?.requiresMatch) {
      const capturerName = controller.requiresMatch.capturer;
      if (!config.actions[capturerName]) {
        throw new Error(
          `agent-step: action "${a}" declares requiresMatch with capturer "${capturerName}" but no such action exists.`,
        );
      }
    }
    // Declared verdict rows (`ActionDef.verdicts`): the summary is required
    // by type; backendFailure marks a code that must exist statically; a
    // row's ask must not double-declare a key `asks` already owns.
    for (const [code, row] of Object.entries(action.verdicts ?? {})) {
      if (typeof code !== "string" || code.trim().length === 0) {
        throw new Error(`agent-step: action "${a}" has a verdicts entry with an empty code.`);
      }
      if (row.backendFailure && typeof row.body?.error !== "string") {
        throw new Error(
          `agent-step: action "${a}" verdicts["${code}"] sets backendFailure but body.error is not a static string — the failure counter matches on that code.`,
        );
      }
    }
    // Standing asks: every mapped target must exist, and the named capture
    // param must be a declared field of the target's params schema — a typo
    // here would synthesize calls the target cannot parse.
    for (const [code, ask] of Object.entries(action.asks ?? {})) {
      if (typeof code !== "string" || code.trim().length === 0) {
        throw new Error(`agent-step: action "${a}" has an asks entry with an empty code.`);
      }
      const target = config.actions[ask.action];
      if (!target) {
        throw new Error(
          `agent-step: action "${a}" asks["${code}"] targets unknown action "${ask.action}".`,
        );
      }
      if (ask.expects !== "digits" && ask.expects !== "text") {
        throw new Error(
          `agent-step: action "${a}" asks["${code}"] has invalid expects "${String(ask.expects)}".`,
        );
      }
      const shape = (target.paramsSchema as { shape?: Record<string, unknown> }).shape;
      if (shape && !(ask.param in shape)) {
        throw new Error(
          `agent-step: action "${a}" asks["${code}"] names param "${ask.param}" which is not declared on "${ask.action}".`,
        );
      }
    }
  }
  if (actionNames.length === 0) {
    throw new Error("agent-step: at least one action must be defined.");
  }


  // Capture-bounce bounds (ActionDef.captureBounces): the engine's only defence
  // against an unbounded re-ask loop on a malformed capture. Validated here so
  // a typo'd ladder name fails at construction rather than on the Nth bounce of
  // a live call.
  for (const [name, action] of Object.entries(opts.config.actions)) {
    const policy = (action as { captureBounces?: { max?: unknown; ladder?: unknown } })
      .captureBounces;
    if (policy === undefined) continue;
    if (!Number.isInteger(policy.max) || (policy.max as number) < 1) {
      throw new Error(
        `agent-step: action "${name}" needs captureBounces.max as an integer ≥ 1.`,
      );
    }
    if (typeof policy.ladder !== "string" || !(policy.ladder in ladders)) {
      throw new Error(
        `agent-step: action "${name}" has captureBounces.ladder "${String(
          policy.ladder,
        )}" which is not a configured ladder.`,
      );
    }
  }

  if (Object.keys(ladders).length > 0 && opts.handoff == null) {
    throw new Error(
      "agent-step: ladders require handoff — every ladder escalates into one.",
    );
  }
  for (const [name, ladder] of Object.entries(ladders)) {
    if (name.trim().length === 0) {
      throw new Error("agent-step: ladder names must be non-empty.");
    }
    if (ladder.description.trim().length === 0) {
      throw new Error(
        `agent-step: ladder "${name}" is missing a non-empty description.`,
      );
    }
    if (ladder.instruction.trim().length === 0) {
      throw new Error(
        `agent-step: ladder "${name}" is missing a non-empty instruction.`,
      );
    }
    if (
      ladder.maxFreeUses !== undefined &&
      (!Number.isInteger(ladder.maxFreeUses) || ladder.maxFreeUses < 1)
    ) {
      throw new Error(
        `agent-step: ladder "${name}" needs maxFreeUses ≥ 1 when set.`,
      );
    }
    // Deliberately the LIBRARY contract, not the host's model schema: an
    // escalation route is engine-only by design — a host may (and should)
    // remove it from the model-requestable routes entirely, so the engine
    // holds the only path to it.
    const parsed = handoffParamsSchema.safeParse(ladder.onExhaust);
    if (!parsed.success) {
      throw new Error(
        `agent-step: ladder "${name}" has an invalid onExhaust: ${parsed.error.issues
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
  }
  // Gate `onExhaust` routes — same rules as a ladder's: engine-only, needs
  // the library handoff, validated against the LIBRARY contract.
  for (const [name, action] of Object.entries(config.actions)) {
    const controller = (action as import("../types.js").ActionDef<string>).controller;
    const confirm = controller?.requiresConfirmation;
    const routes = [
      typeof confirm === "object" ? confirm.onExhaust : undefined,
      controller?.requiresMatch?.onExhaust,
    ];
    for (const route of routes) {
      if (route === undefined) continue;
      if (opts.handoff == null) {
        throw new Error(`agent-step: action "${name}" sets onExhaust but handoff is not configured.`);
      }
      const parsed = handoffParamsSchema.safeParse(route);
      if (!parsed.success) {
        throw new Error(
          `agent-step: action "${name}" has an invalid onExhaust: ${parsed.error.issues
            .map((issue) => issue.message)
            .join("; ")}`,
        );
      }
    }
  }
}
