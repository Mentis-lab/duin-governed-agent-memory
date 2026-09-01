// agui-terminal.ts — the deadline terminal frame sequence, factored out of server.ts so it is PURE
// and unit-testable off the HTTP server (no electron / socket deps).
//
// R3/Phase-2 — after the per-turn wall-clock deadline fires, the terminal frame must be emitted FROM
// THE DEADLINE TIMER, independent of the round loop unwinding. A wedged "dispatch agents" fan-out
// never reaches the downstream terminal path, so without an independent emit the bridge
// reconnect-churns for minutes. These frames uphold the AG-UI RUN_STARTED→…→RUN_FINISHED contract:
// a RUN_ERROR (telemetry + the client's chat:error signal) followed by a clean TEXT_MESSAGE_END +
// RUN_FINISHED so the client always unblocks exactly once.

/** The user-facing note appended when a turn is cut off by the wall-clock budget. Italic + leading
 *  blank lines so it reads as a separate closing line after any already-streamed partial answer. */
export const DEADLINE_TIMEOUT_NOTE =
  '\n\n_This turn hit its time budget before finishing. Ask me to continue and I will pick up from here — or narrow the request so I can answer in one pass._'

/** The note appended when the MODEL stopped because it hit its output-token cap (finishReason
 *  'length') rather than because it finished. Distinct from the deadline note because the remedy is
 *  different: the turn had time, the reply had no room, so "continue" resumes mid-document and
 *  asking section-by-section avoids the cap entirely. */
export const OUTPUT_CAP_NOTE =
  '\n\n_I kept writing past the output limit for as long as I was allowed and still did not reach the end, so this stops mid-thought — it is not a finished answer. Ask me to continue and I will pick up from here, or ask for one section at a time._'

/** Continuation was refused because the ANSWER no longer fits the model's context window — each
 *  slice is appended to the prompt, so a long enough answer eventually crowds out room to write
 *  more. Its own note because the remedy inverts the usual advice: "continue" is exactly what will
 *  NOT work here, since the next request would be the one that overflows. */
export const CONTEXT_FULL_NOTE =
  '\n\n_This answer grew until it filled the model\'s context window, so I stopped rather than fail mid-sentence. Continuing in this conversation will not get further — start a fresh one for the remainder, ask for the rest section by section, or switch to a model with a larger context._'

/** The output cap can bind before the model writes ANY answer, because reasoning is billed against
 *  the same budget. Measured against Zhipu 2026-08-03: at max_tokens=512, completion_tokens came
 *  back 512 with reasoning_tokens=508 and content the empty string. Without its own note that turn
 *  renders as a blank reply, which reads like a bug rather than a budget. */
export const OUTPUT_CAP_EMPTY_NOTE =
  '\n\n_I ran out of output budget while still reasoning, so there is no answer above — the model spent the whole allowance thinking. Narrowing the question, or asking for one section at a time, leaves room for the reply._'

/** The ordered terminal frames the deadline timer emits (exactly once, guarded by terminalSent in
 *  the caller). RUN_ERROR first (so telemetry + the bridge see the cut-off), then the closing frames
 *  so the stream terminates cleanly. */
/** The agentic loop ran out of tool rounds with the model still working. Its own note because
 *  this is the one cut where the ANSWER may be fine and the TASK is not — the model was still
 *  reading, editing and verifying when the budget ran out, so the remedy is to continue or to
 *  narrow the job, not to rephrase the question. */
export const MAX_ROUNDS_NOTE =
  '\n\n_I ran out of tool rounds for this turn while still working, so the task above is unfinished — not wrong, just incomplete. Ask me to continue and I will pick up from here, or split it into smaller steps._'

/** The same call failed identically N times running, so the loop stopped instead of spending the
 *  rest of its round budget on it. Its own note because the remedy is specific and actionable: the
 *  operator is told WHICH call is stuck (the root cause is appended by the caller), which is the
 *  one thing a bare "the turn ended" could never tell them. */
export const REPEAT_FAILURE_NOTE =
  '\n\n_I stopped early: the same call kept failing with the same arguments, so continuing would just repeat it. The failing step is named above — fixing that (a path, a permission, a missing key) and asking again is the way forward._'

export type TerminalCutReason =
  | 'stalled'
  | 'max-wallclock'
  | 'output-cap'
  | 'output-cap-empty'
  | 'context-full'
  | 'max-rounds'
  | 'repeat-failure'

const CUT_MESSAGE: Record<TerminalCutReason, string> = {
  stalled: 'turn stalled — no progress within the idle budget',
  'max-wallclock': 'turn exceeded the time budget',
  'output-cap': 'response truncated — continuation budget exhausted',
  'output-cap-empty': 'no answer produced — the output cap was spent on reasoning',
  'context-full': 'response truncated — the answer filled the context window',
  'max-rounds': 'task unfinished — the agentic round budget was exhausted',
  'repeat-failure': 'stopped early — the same call kept failing'
}

const CUT_NOTE: Record<TerminalCutReason, string> = {
  stalled: DEADLINE_TIMEOUT_NOTE,
  'max-wallclock': DEADLINE_TIMEOUT_NOTE,
  'output-cap': OUTPUT_CAP_NOTE,
  'output-cap-empty': OUTPUT_CAP_EMPTY_NOTE,
  'context-full': CONTEXT_FULL_NOTE,
  'max-rounds': MAX_ROUNDS_NOTE,
  'repeat-failure': REPEAT_FAILURE_NOTE
}

export function deadlineTerminalFrames(
  reason: TerminalCutReason = 'max-wallclock'
): Array<Record<string, unknown>> {
  return [
    { type: 'RUN_ERROR', message: CUT_MESSAGE[reason] },
    { type: 'TEXT_MESSAGE_CONTENT', delta: CUT_NOTE[reason] },
    { type: 'TEXT_MESSAGE_END' },
    { type: 'RUN_FINISHED' }
  ]
}
