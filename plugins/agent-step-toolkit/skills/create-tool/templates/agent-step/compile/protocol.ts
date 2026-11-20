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
import { repeatableConfirmationActionsOf } from "./activation.js";

export interface ProtocolSurface {
  config: {
    tool: { name: string; toolChoice?: "auto" | "required" };
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

  if (surface.config.tool.toolChoice === "required") {
    // `repeat_pending_question` and the reply kinds exist only when some gate
    // opted into `repeatReadBack` — the same roster that activates them
    // (compile/activation.ts). Without one they are absent from the tool, and
    // READ-BACK must not send the model to a control it cannot call.
    //
    // The repeat sentence below is MEASURED bytes. Leave its wording alone.
    //
    // It maps reply CONTENT to mechanism: the stored question and nothing else
    // → `repeat_pending_question` (the result then forbids added words, which
    // is what holds a speaker or ownership claim to the unchanged question);
    // anything of the model's own first → speech. The contracts decide the
    // content per reply. Two things about it look wrong and are not worth
    // fixing: it is a second voice on WHEN to call the control, and its bare
    // `awaiting.question` also matches an ungated verbatim question the
    // control refuses. Three changes were measured on the reference host's
    // live graph (2026-11-19/20, checkpoint replays, 12 per case per build)
    // and reverted; with these bytes every case below holds 12/12, the
    // handover claim 22/24:
    //   - field list scoped to "a standing value ask's …": a channel check at
    //     a standing ask left speech-with-reassurance for the control (15/18);
    //   - sentence reduced to "use it where the question's contract directs":
    //     a phone-handover claim got a paraphrased spoken re-ask (9/24);
    //   - one mechanism for an ask (speech, `{ask_text}` inserting the stored
    //     question on any turn; the control advertised for confirmations
    //     only): channel checks, resume and the closure recap held, but claims
    //     lost the unchanged question — ownership claim 3/12 at one ask and
    //     10/12 at another, one reply asking for the other person's name;
    //     handover claim 7/12. Nothing but the control's result enforces
    //     "nothing added".
    // The over-claim costs nothing live: the ungated question is re-asked by
    // speech 24/24.
    const repeatable =
      repeatableConfirmationActionsOf(surface.config.actions).length > 0;
    return [
      `Use \`${toolName}\` for workflow steps or the sole \`respond_to_caller\` step for speech. The action schemas own parameters and mechanics; these instructions own business meaning.`,
      handoff ? "A human request or an expectation of a promised transfer takes priority at every stage, including pending confirmation: select the configured human handoff as the sole step. Handoff results end the turn; the platform delivers their closing." : "",
      ...(surface.toolTurnRules ?? []),
      gates ? "After a CALLER reply, the pending proposal's `reply_contract` classifies that answer. A first gated call proposes; only a later caller confirmation permits the exact-parameter re-call that executes. Speaking preserves the proposal." : "",
      asks ? "A `standing_ask` identifies the action and capture owed. A supplied value belongs to that action; the `ask_contract` governs other replies." : "",
      "A result's `continuation` owns progression: `await_caller` requires presentation; an `action` names the required next call. Otherwise the caller's request determines further work or a reply. Greetings, open choices and supported clarifications use `respond_to_caller`; its `awaiting` record preserves the unanswered question. Interpret the caller's meaning and compose natural speech within that result contract.",
      "**READ-BACK (sole authority):** present a current result's `read_back`, `ask_text`, or `reply_text` using its matching placeholder in `respond_to_caller.text`" +
        (repeatable ? ", without a reply kind" : "") +
        ". The system inserts the exact bytes; `read_back_directive` governs surrounding words. These placeholders refer only to this caller turn's latest tool result. " +
        (repeatable
          ? "To repeat a previous question without a new explanation, use `repeat_pending_question` when the pending record supplies stored text (`ask_text`, `awaiting.question`, or a repeatable confirmation). With `kind: \"clarification\"`, supply only `explanation`: the short answer, without a question, recap, or announcement of repetition. The engine appends the complete stored confirmation and requires a later caller answer; this reply needs no repeat step. With `kind: \"choice\"`, the existing proposal stays pending while the caller chooses a path. "
          : "") +
        "Otherwise compose the permitted reply naturally from the conversation and approved facts.",
    ].filter(Boolean).join("\n\n");
  }

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
