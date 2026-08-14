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
import {
  deflectAsideEnabled,
  handoffParamsSchema,
  type HandoffSpec,
} from "../handoff/contract.js";
import type { HandoffRequest } from "../state.js";
import type { BoundedChoiceRegistry } from "../interaction/bounded-choice.js";
import { repeatReadBackEnabled } from "../interaction/confirmation.js";
import {
  resolveAbortPolicy,
  type AbortPolicy,
  type ControlActivation,
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
  boundedChoices?: BoundedChoiceRegistry;
  onErrorThreshold?: unknown;
}

/** The library-managed slots this configuration will WRITE (non-null values),
 *  derived from the features it uses. The host's state schema must carry a
 *  channel for each — the patch merger copies only fields present in the
 *  channel map, so a missing channel silently DISCARDS the write: the runner
 *  would report `needs_confirmation` while no gate was ever stored. */
function requiredManagedChannels(opts: ValidatableOptions): string[] {
  const required = new Set<string>();
  // The audit trail is written on EVERY finalized batch regardless of which
  // features the config uses (run/finalize.ts), so — unlike every slot below —
  // it is unconditionally required. NOTE the failure mode differs from the
  // merger-dropped slots: finalize writes `committed` directly, so a missing
  // channel surfaces as a `Command.update` field the host graph has no channel
  // for — an update the graph either rejects or silently discards. Both are
  // wrong states; fail at construction instead.
  required.add("actionTrail");
  for (const action of Object.values(opts.config.actions)) {
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
  if (Object.keys(opts.boundedChoices ?? {}).length > 0) {
    required.add("boundedChoice");
  }
  if (opts.handoff != null) {
    required.add("handoff");
  }
  if (opts.handoff != null || opts.onErrorThreshold != null) {
    required.add("errorCount");
  }
  // The deflect_aside latch: without this channel the runner's write is
  // silently discarded, so the free deflection never spends and the
  // escalation NEVER fires.
  if (deflectAsideEnabled(opts.handoff as HandoffSpec<unknown> | undefined)) {
    required.add("deflectedAside");
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
  const boundedChoices = opts.boundedChoices ?? {};
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
  const effectiveHandoffSchema =
    configuredHandoffSchema === undefined
      ? handoffParamsSchema
      : (configuredHandoffSchema as z.ZodType<HandoffRequest>);
  const actionNames = Object.keys(config.actions);
  const repeatableConfirmationActions = actionNames.filter((name) =>
    repeatReadBackEnabled(
      config.actions[name].controller?.requiresConfirmation,
    ),
  );

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

  const activation: ControlActivation = {
    // Reserved names don't depend on lifecycle opts (the abort name is always
    // reserved); pass a conservative value.
    hasLifecycleOpts: true,
    handoffEnabled: opts.handoff != null,
    handoffModelRequestSchema: effectiveHandoffSchema,
    abortPolicy: resolveAbortPolicy(opts.abortPolicy),
    repeatableConfirmationActions,
    boundedChoices,
    boundedChoicesEnabled: Object.keys(boundedChoices).length > 0,
    deflectAsideEnabled: deflectAsideEnabled(
      opts.handoff as HandoffSpec<unknown> | undefined,
    ),
  };

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
  }
  if (actionNames.length === 0) {
    throw new Error("agent-step: at least one action must be defined.");
  }

  for (const [name, choice] of Object.entries(boundedChoices)) {
    if (name.trim().length === 0) {
      throw new Error("agent-step: bounded-choice names must be non-empty.");
    }
    if (choice.description.trim().length === 0) {
      throw new Error(
        `agent-step: bounded choice "${name}" is missing a non-empty description.`,
      );
    }
    const selections = choice.selections.map((selection) => selection.trim());
    if (selections.length === 0 || selections.some((selection) => selection.length === 0)) {
      throw new Error(
        `agent-step: bounded choice "${name}" requires at least one non-empty selection.`,
      );
    }
    if (new Set(selections).size !== selections.length) {
      throw new Error(
        `agent-step: bounded choice "${name}" contains duplicate selections.`,
      );
    }
    for (const action of choice.directInputActions ?? []) {
      if (!config.actions[action]) {
        throw new Error(
          `agent-step: bounded choice "${name}" lists unknown directInputAction "${action}".`,
        );
      }
    }
    if (choice.onRepeatHandoff && !opts.handoff) {
      throw new Error(
        `agent-step: bounded choice "${name}" configures onRepeatHandoff but handoff is not enabled.`,
      );
    }
    if (choice.onRepeatHandoff) {
      // A configured repeat fallback must be one of the same routes the model
      // is allowed to request. The base schema remains the trusted state/effect
      // contract, but accepting a broader fallback here would make the host's
      // advertised route allow-list internally inconsistent.
      const parsed = effectiveHandoffSchema.safeParse(choice.onRepeatHandoff);
      const canonical = parsed.success
        ? handoffParamsSchema.safeParse(parsed.data)
        : null;
      if (!parsed.success || !canonical?.success) {
        const issues = !parsed.success
          ? parsed.error.issues
          : canonical && !canonical.success
            ? canonical.error.issues
            : [];
        throw new Error(
          `agent-step: bounded choice "${name}" has an invalid onRepeatHandoff: ${issues
            .map((issue) => issue.message)
            .join("; ")}`,
        );
      }
    }
  }
}
