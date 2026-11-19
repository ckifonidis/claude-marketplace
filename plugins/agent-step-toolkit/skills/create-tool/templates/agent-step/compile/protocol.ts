// FILE: src/agent-step/compile/protocol.ts
//
// The ENGINE-COMPOSED protocol prompt fragment (owner directive 2026-08-15):
// the system-prompt text that interprets the engine's own machinery —
// tool-turn/speaking-turn, the reply/ask contracts, the gate handshake,
// READ-BACK authority, handoff silence — composed here from
// the host's feature surface, exactly as the tool description already is.
// Hosts splice it into their system prompt via a placeholder and write NONE
// of it themselves: every agent hand-rolling its own rendition of the
// machinery was the family-scale fork this fragment deletes.
//
// Sentence ownership is exclusive (one authority): the tool DESCRIPTION keeps
// its per-action/control one-liners, RESULT BODIES keep the per-turn
// contracts/directives/asks, and THIS fragment keeps the turn/speech
// protocol. The wording is the reference host's measured machinery text,
// generalized only where it named host concepts — changing it upstream
// changes every agent at once, so it is pinned in each host's model-surface
// golden and a diff there demands live re-measurement.

/** The feature surface the fragment is composed from — deliberately narrow
 *  (config + registries + handoff presence), so hosts whose prompt module
 *  must stay import-light (no executors, no env) can call this with exactly
 *  what they already export. */
import { captureFieldsOf } from "../capture.js";

export interface ProtocolSurface {
  config: {
    tool: { name: string };
    actions: Record<
      string,
      {
        verdicts?: Record<string, { ask?: unknown } | undefined>;
        paramsSchema?: unknown;
        controller?: { requiresConfirmation?: unknown };
      }
    >;
  };
  handoff?: unknown;
  /** Host-supplied DOMAIN tool-turn clauses, spliced as the FIRST lettered
   *  clauses of the TOOL TURN bullet — the measured position for capture
   *  doctrines that must outrank the generic contracts (the reference host's
   *  digit rule measured 0/4 when detached from this bullet). The host owns their
   *  wording entirely; the fragment owns only the frame. */
  toolTurnRules?: string[];
}

export function composeProtocolPrompt(surface: ProtocolSurface): string {
  const toolName = surface.config.tool.name;
  const actions = Object.values(surface.config.actions);
  const gates = actions.some((a) => a.controller?.requiresConfirmation);
  // The standing-ask bullet appears when ANY outcome can leave the caller owing
  // a value — a row-site ask, or the DERIVED bounce re-ask of an action that
  // collects a caller capture at all.
  const asks = actions.some(
    (a) =>
      Object.values(a.verdicts ?? {}).some((row) => row?.ask) ||
      captureFieldsOf(a.paramsSchema).length > 0,
  );
  const handoff = surface.handoff != null;

  const toolTurnClauses: string[] = [...(surface.toolTurnRules ?? [])];
  if (gates) {
    toolTurnClauses.push(
      "Every pending proposal's result carries its own `reply_contract` — the caller's reply to a read-back question is handled exactly as that contract says, nothing else.",
    );
  }
  if (asks) {
    toolTurnClauses.push(
      "Any other value the latest tool result asked for (`standing_ask`) goes to the action it names; when the result carries `ask_text`, ask with exactly those words.",
    );
  }
  const lettered = toolTurnClauses
    .map((clause, i) => `(${String.fromCharCode(97 + i)}) ${clause}`)
    .join(" ");

  const blocks: string[] = [];

  // LEAD — the engine states its own division of authority (wave 2: the host's
  // hand-rolled "the tool description is the source of truth" paragraph).
  blocks.push(
    `The \`${toolName}\` tool description and its action schema are the source of truth for action mechanics — params, verdicts, batching rules${
      gates ? ", the confirmation lifecycle" : ""
    }${
      handoff ? ", and the `request_handoff` handback" : ""
    }. Your instructions cover what they cannot: the business semantics, the caller-facing policy, and when to invoke which action.`,
  );

  if (handoff) {
    // THE HUMAN OVERRIDE — uniform family policy (wave 2): the generalizable
    // core of the host's measured top-priority paragraph. Recognition examples
    // and the complaint-vs-ask boundary stay host-side, next to the fragment.
    blocks.push(
      // "or choice" below is vestigial since the bounded-choice removal —
      // kept byte-identical because this clause is measured HIGH-risk; scrub it
      // upstream only with a re-measurement (UPSTREAM.md).
      "ONE override outranks everything below, at ANY stage and including while a confirmation or choice is pending: the caller asks for a HUMAN BEING, or points out that a promised transfer has not happened → emit the terminal handoff route your instructions designate for a human request, as the ONLY step, with NO answer text. A transfer promised in an earlier turn did NOT happen — only a terminal action performs one; answering with another promise IS the failure this rule exists to prevent.",
    );
  }

  blocks.push(
    `Every turn of yours is one of two kinds:

- **A TOOL TURN.** Whenever the caller's message supplies or confirms a value for the flow, that answer is input for the SYSTEM, never for you: call \`${toolName}\` with it before producing any text.${
      lettered.length > 0 ? " Specifically: " + lettered : ""
    } Never answer an answer with text alone, and never send a value the caller did not actually supply.
- **A SPEAKING TURN.** What you say always comes from the CURRENT turn's latest tool result — a \`read_back\` spoken per READ-BACK below, a caller-audible \`summary\` relayed faithfully, or what its \`instruction\` directs (any caller line it calls for, you compose in the session language). When a result instructs a FOLLOW-UP action, make that call first — in this same turn — and speak from ITS result. If you are about to ask the caller for a value and no tool result instructed that ask, you have skipped a required tool call — make it instead. The only turns composed WITHOUT a tool result are those your instructions explicitly license.`,
  );

  if (gates) {
    blocks.push(
      "A confirm-gated action is TWO tool turns: the first call does NOT execute — it answers `needs_confirmation` with `proposed_params` and a `read_back` question; the caller's answer goes BACK to the SAME action per the proposal's `reply_contract`, and only that second call executes. Never conclude, advance to a DIFFERENT detail, or abandon from one unclear utterance — a proposal is never execution.",
    );
  }

  blocks.push(
    "**READ-BACK (sole authority):** when the latest successful tool result carries `read_back` and no later caller reply exists, make NO tool call and speak that value byte-for-byte; the `read_back_directive` beside it says what, if anything, may precede or follow the bytes. When a confirmation proposal has no `read_back`, never invent a value; use only the caller's spoken proposal.",
  );


  if (handoff) {
    blocks.push(
      "A terminal `request_handoff` is always the ONLY step in its batch. On every handoff turn — including an automatic one reported by a result — produce no answer text; the platform supplies the caller-facing line.",
    );
  }

  blocks.push(
    "If a prerequisite is denied, ask for its missing caller value and run that step before retrying the dependent action.",
  );

  return blocks.join("\n\n");
}
