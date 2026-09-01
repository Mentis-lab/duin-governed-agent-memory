// executor-capability — earned autonomy for the external executor.
//
// The decided stance (plan Q1, attended-first) made mechanical, and made so through the seam
// DUIN already has for exactly this: the ANS capability ledger + the gate composer
// (ans/gate-compose.ts). The composer meets the consequence-tier verdict with a capability's
// earned rung, keyed by TOOL NAME, and can only tighten. So a capability registered under the id
// `delegate_task` (== the tool name) makes the composer govern it with ZERO gate code:
//
// The mechanism, precisely (agui-approval.ts decideAguiGate + agui-gate.ts:~175):
//   · under trusted-afk, RULE 4 auto-allows a gated tool (the exec-token turn IS the
//     authorization) — so delegate_task's base verdict there is `allow`, NOT prompt. THEN the
//     composer meets that allow with the capability's rung:
//       - rung 'stage' (unearned): meet(allow, stage) = prompt; AFK has no window, so that prompt
//         fails closed → the run is HELD until the operator earns it.
//       - rung 'reflexive' (earned): meet(allow, reflexive) = allow → a trusted-afk turn may
//         START the run. Its results are still held for review (executor-review never auto-merges)
//         and every child tool call is still gated.
//   · under interactive/review, spawn-recursive already resolves to `prompt` (not a review
//     auto-allow tier), so the operator is always asked regardless of rung — the rung only ever
//     tightens, never loosens.
//
// The signal that moves the rung IS the review decision: keep a run's changes → ratify, discard
// → revert (a governor miss that can demote). Nothing here loosens a tool gate.

import { registerCapability, recordFeedback, classify } from '../ans/capability-ledger'
import { runGovernorPass } from '../ans/governor'
import { messageOf } from '../guarded'

/** MUST equal the tool name: ans/gate-compose.ts looks the capability up by the tool it gates. */
export const EXECUTOR_DSH_CAP_ID = 'delegate_task'

/** Register the executor capability. Starts staged — nothing autonomous until earned. Idempotent;
 *  call at boot beside seedCapabilities(). */
export function registerExecutorCapability(): void {
  registerCapability({
    id: EXECUTOR_DSH_CAP_ID,
    title: 'Run a delegated coding executor',
    rung: 'stage'
  })
}

/** The executor capability's current enforcement answer: 'run' (earned reflexive), 'stage'
 *  (probation), 'hold' (pinned manual), or 'unknown' (not registered / ledger reset). */
export function executorRung(): 'run' | 'stage' | 'hold' | 'unknown' {
  return classify(EXECUTOR_DSH_CAP_ID)
}

/**
 * Record the operator's verdict on a finished run and let the governor act on it.
 * keep → ratify (accepted work), discard → revert (a miss that can demote). The governor pass is
 * best-effort: a demotion is a safety tightening, never something whose failure should throw into
 * the review IPC.
 */
export function recordExecutorOutcome(kept: boolean): void {
  try {
    recordFeedback(EXECUTOR_DSH_CAP_ID, kept ? 'ratify' : 'revert')
    if (!kept) runGovernorPass()
  } catch (err) {
    console.debug('[executor-capability] outcome record best-effort:', messageOf(err))
  }
}
