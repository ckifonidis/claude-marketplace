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
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { AGENT_STEP_SLOT_META } from "../state.js";
import { resolveActionAsks } from "./asks.js";
import { captureFieldsOf, objectShapeOf, fieldKindOf } from "../capture.js";

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
    offTopic?: { mode?: string };
    resolveClosingMessage?: unknown;
    delegateFailureMessage?: unknown;
  };
  abortPolicy?: AbortPolicy<string>;
  /** Host reply categories for the standing-ask contract — model-facing prose,
   *  so the reference lint below covers it. */
  askContract?: { categories?: readonly string[] };
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
    // A row-site ask records the dictation slot, and so does the DERIVED
    // bounce re-ask of any action that collects a caller value.
    const rowsAsk = Object.values(action.verdicts ?? {}).some((row) => row.ask);
    if (rowsAsk || captureFieldsOf(action.paramsSchema).length > 0) {
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
  // The escalation latch: without this channel the runner's write is silently
  // discarded, so a free explanation never spends and the escalation NEVER
  // fires. Needed whenever escalation is reachable at all — the handoff opts
  // in `note_refusal`, and any caller capture can bounce.
  // Escalation ends in a handoff, so the latch is only ever written when one is
  // configured (`note_refusal` is injected then, and the capture bounce climbs
  // only then). Without a handoff there is nothing to escalate to and nothing
  // to record.
  if (opts.handoff != null) {
    required.add("spentLadders");
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
  // Caller-audible handoff text is HOST-RENDERED from state, without engine or
  // model-prose fallbacks — so the renderers must exist at construction.
  if (opts.handoff) {
    if (typeof opts.handoff.resolveClosingMessage !== "function") {
      throw new Error(
        "agent-step: handoff.resolveClosingMessage is required — the closing for " +
          "completed/abandon is host-rendered from state (the engine never speaks " +
          "`context` or a library default).",
      );
    }
    if (
      opts.handoff.offTopic?.mode === "delegate" &&
      typeof opts.handoff.delegateFailureMessage !== "function"
    ) {
      throw new Error(
        "agent-step: handoff.delegateFailureMessage is required in delegate mode — " +
          "a failed delegate run speaks this host-rendered fallback.",
      );
    }
  }
  const actionNames = Object.keys(config.actions);
  // Shared construction (compile/activation.ts); conservativeLifecycle keeps
  // the reserved-name set independent of the lifecycle analysis below.
  const activation = buildControlActivation({
    actions: config.actions as Record<string, import("../types.js").ActionDef<string>>,
    handoff: opts.handoff as ActivationInputs<string>["handoff"],
    abortPolicy: opts.abortPolicy,
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

  // ── Reference lint on HOST model-facing prose ──────────────────────────────
  //
  // The measured contract categories ROUTE the model
  // by naming actions in prose ('call "abort_pending_input", routing kind words
  // to "collect_full_name"'). Those names are strings inside strings: nothing
  // tied them to the action registry, so renaming or removing an action left
  // prose that instructs the model to call something that no longer exists —
  // and the model's call then bounces as `unknown_action` on a turn the prose
  // was written to make smooth.
  //
  // Convention (held by every host string today): an ACTION is written in
  // DOUBLE QUOTES; wire fields (`read_back`, `standing_ask`, `invalid_params`)
  // are written bare or in backticks and are deliberately NOT linted — they
  // are not actions, and the engine owns them. Only host-supplied prose is
  // linted; engine frames carry `"{action}"` placeholders, which never match.
  const callableNames = new Set<string>([...actionNames, ...reservedControlNames(activation)]);
  const QUOTED_SNAKE = /"([a-z][a-z0-9]*(?:_[a-z0-9]+)+)"/g;
  const lintProse = (text: unknown, where: string): void => {
    if (typeof text !== "string") return;
    for (const [, token] of text.matchAll(QUOTED_SNAKE)) {
      if (!callableNames.has(token)) {
        throw new Error(
          `agent-step: ${where} names "${token}" in double quotes, which is not a declared action or control — ` +
            "model-facing prose may only route to something callable (write wire fields in backticks instead).",
        );
      }
    }
  };

  for (const category of opts.askContract?.categories ?? []) {
    lintProse(category, "askContract category");
  }
  for (const a of actionNames) {
    const spec = config.actions[a]?.controller?.requiresConfirmation;
    const categories =
      typeof spec === "object" && spec !== null
        ? (spec as { replyContract?: { categories?: unknown[] } }).replyContract?.categories
        : undefined;
    for (const category of categories ?? []) {
      lintProse(category, `action "${a}" replyContract category`);
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
    // by type; backendFailure marks a code that must exist statically.
    // Rows are the action's whole result space: an executor returns
    // `{ verdict }` and the runner composes the body from the named row, so an
    // action with NO rows cannot answer a single call — every invocation would
    // fail as `executor_error` at runtime. Fail at construction instead.
    if (Object.keys(action.verdicts ?? {}).length === 0) {
      throw new Error(
        `agent-step: action "${a}" declares no verdict rows — every executor result names a row, so a row-less action can never answer a call.`,
      );
    }
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
    // Row-site standing asks: resolved through the SAME code path the compiler
    // uses (compile/asks.ts), so a config that validates cannot then fail to
    // compile — and every rule the resolver enforces (target exists, target has
    // a capture field, the sole-capture default resolves, the named param is a
    // capture and not a judgement, no ask on a terminal row) is checked exactly
    // once, in one place.
    resolveActionAsks(a, action, config.actions);

    // The caller-capture hard rule, enforced at CONSTRUCTION instead of by a
    // per-host test: a value-shape keyword in the model-facing JSON Schema
    // stops being a verdict the tool returns and becomes a precondition for
    // EMITTING the call — the model counts digits itself, withholds the call
    // or pads a digit to satisfy the pattern (measured live 2026-07-31).
    // Shape rules belong in refinements, which are invisible here. Every
    // domain action is checked (the incident field predated the kind
    // registry, so the check cannot be limited to registered captures);
    // `minItems`/`maxItems` bound arrays the MODEL constructs and `enum`
    // enumerates closed values, so they stay legal.
    const offending = findShapeKeyword(toJsonSchema(action.paramsSchema as never));
    if (offending) {
      throw new Error(
        `agent-step: action "${a}" exposes JSON-Schema keyword "${offending.keyword}" at ` +
          `${offending.path} in its model-facing params schema. Express value-shape rules as ` +
          "zod REFINEMENTS (callerDigits / callerTextParam / superRefine) so the tool judges " +
          "the capture and the model never pre-judges the call.",
      );
    }
  }

  // ─── Config-level invalidation table: every named slot must be a real host
  //     channel (a typo'd name silently never fires — or worse, never clears),
  //     and no library-managed slot may be watched or nulled through it. ───── //
  const invalidations = (config as { invalidations?: Record<string, string[]> }).invalidations ?? {};
  const librarySlots = new Set(Object.keys(AGENT_STEP_SLOT_META));
  for (const [watched, dependents] of Object.entries(invalidations)) {
    for (const slot of [watched, ...dependents]) {
      if (librarySlots.has(slot)) {
        throw new Error(
          `agent-step: invalidations names library-managed slot "${slot}" — library slots ` +
            "transition through effects and the run pipeline, never through invalidation.",
        );
      }
      if (!(slot in channels)) {
        throw new Error(
          `agent-step: invalidations names "${slot}", which is not a channel of the state ` +
            "schema — the write would be silently dropped.",
        );
      }
    }
  }

  // ─── `bounceCapture`: only meaningful with SEVERAL captures,
  //     and it must name one of them — a typo would silently disable the
  //     bounce re-ask it exists to restore. ────────────────────────────────── //
  for (const [name, action] of Object.entries(config.actions)) {
    if (action.bounceCapture === undefined) continue;
    const captures = captureFieldsOf(action.paramsSchema).map((f) => f.name);
    if (!captures.includes(action.bounceCapture)) {
      throw new Error(
        `agent-step: action "${name}" bounceCapture "${action.bounceCapture}" is not one of ` +
          `its capture fields (${captures.join(", ") || "none"}).`,
      );
    }
    if (captures.length < 2) {
      throw new Error(
        `agent-step: action "${name}" declares bounceCapture with a single capture field — ` +
          "the bounce capture is derived there; omit it.",
      );
    }
  }

  // ─── State-satisfied inputs (`ActionDef.satisfies`): every declared fact is
  //     machine-checkable BY DESIGN — paths against the state schema, mode
  //     against the gate, the else row against the declared verdicts. ─────── //
  for (const [name, action] of Object.entries(config.actions)) {
    const spec = action.satisfies;
    if (!spec) continue;
    const paths = Object.entries(spec.values ?? {});
    if (paths.length === 0) {
      throw new Error(
        `agent-step: action "${name}" declares satisfies with no values — ` +
          "name at least one state path to satisfy from.",
      );
    }
    for (const [key, path] of paths) {
      const root = String(path).split(".")[0];
      if (librarySlots.has(root)) {
        throw new Error(
          `agent-step: action "${name}" satisfies.values["${key}"] reads library-managed ` +
            `slot "${root}" — satisfied inputs come from host/channel state only.`,
        );
      }
      if (!(root in channels)) {
        throw new Error(
          `agent-step: action "${name}" satisfies.values["${key}"] names "${path}", whose ` +
            `root "${root}" is not a channel of the state schema — it could never resolve.`,
        );
      }
      // A bundle key that names one of the action's own params must name a
      // CAPTURE field: satisfying a judged/relay param from state would let
      // state impersonate a model classification.
      const shape = objectShapeOf(action.paramsSchema);
      const field = shape?.[key];
      if (field) {
        const kind = fieldKindOf(field);
        if (kind !== "digits" && kind !== "text") {
          throw new Error(
            `agent-step: action "${name}" satisfies.values["${key}"] targets param "${key}", ` +
              "which is not a caller-capture field — only captures can be satisfied from state.",
          );
        }
      }
    }
    const gated = action.controller?.requiresConfirmation != null;
    if (spec.mode === "consent") {
      if (!gated) {
        throw new Error(
          `agent-step: action "${name}" declares satisfies mode "consent" but is not ` +
            "confirmation-gated — the consent question rides the confirmation gate; the " +
            "engine never synthesizes one.",
        );
      }
      if (typeof spec.ask !== "function") {
        throw new Error(
          `agent-step: action "${name}" satisfies mode "consent" requires \`ask\` — the ` +
            "rendered reuse-consent question the caller answers.",
        );
      }
      if (!spec.elseVerdict || !(action.verdicts ?? {})[spec.elseVerdict]) {
        throw new Error(
          `agent-step: action "${name}" satisfies mode "consent" requires \`elseVerdict\` ` +
            "naming a declared verdict row — the business answer when nothing usable is carried.",
        );
      }
      // Consent resolves PARTIALLY: capture-field keys are required, the rest
      // are optional riders. Without at least one capture key the rider rule
      // would let an EMPTY bundle resolve — a consent question offering
      // nothing the action can act on.
      const captureNames = new Set(captureFieldsOf(action.paramsSchema).map((f) => f.name));
      if (!paths.some(([key]) => captureNames.has(key))) {
        throw new Error(
          `agent-step: action "${name}" satisfies mode "consent" declares no values key ` +
            "naming one of the action's own capture fields — every key would be an optional " +
            "rider and an empty bundle could resolve; the consent must offer the action's point.",
        );
      }
    } else {
      if (gated) {
        throw new Error(
          `agent-step: action "${name}" declares satisfies mode "silent" but is ` +
            "confirmation-gated — a silent skip of a confirmation gate is not representable; " +
            'use mode "consent".',
        );
      }
      if (spec.ask || spec.elseVerdict) {
        throw new Error(
          `agent-step: action "${name}" satisfies mode "silent" declares ` +
            `${spec.ask ? "`ask`" : "`elseVerdict`"} — a silent source asks nothing, and an ` +
            "empty call with nothing carried reaches the executor, which owns that answer.",
        );
      }
    }
  }
}

/** Walk a composed JSON Schema for value-shape keywords. Keys under a
 *  `properties` map are PROPERTY NAMES, not keywords — a param named
 *  "format" is legal — so that level recurses without keyword-checking its
 *  keys. */
const SHAPE_KEYWORDS = new Set(["pattern", "minLength", "maxLength", "format"]);

function findShapeKeyword(
  node: unknown,
  path = "$",
): { keyword: string; path: string } | null {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const hit = findShapeKeyword(node[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (node === null || typeof node !== "object") return null;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "properties" && value !== null && typeof value === "object") {
      for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) {
        const hit = findShapeKeyword(sub, `${path}.properties.${prop}`);
        if (hit) return hit;
      }
      continue;
    }
    if (SHAPE_KEYWORDS.has(key)) return { keyword: key, path };
    const hit = findShapeKeyword(value, `${path}.${key}`);
    if (hit) return hit;
  }
  return null;
}
