// escalation.ts — Long-run L8 (HITL). The operator-ping path shared by the L4
// stall watchdog, the L5 budget guard, the L7 resource guard, and the L6
// permanent-error/reconcile-divergence routes. When a loop can no longer make
// safe autonomous progress it PAUSES (durable, via the store) and escalates a
// human-readable notice through the injected channel seam.
//
// The seam boundary keeps this module pure of any channel/electron import:
// production closes `DeliverSeam` over channelDispatch(ref, body); tests capture
// the delivered body. `escalate` is fail-closed on delivery: a throwing or
// !ok seam yields { delivered:false } rather than crashing the loop tick.

import type { Loop } from '../loop-store'

/** The closed set of operator-escalation triggers. Anything outside this set is
 *  NOT worth an operator ping (see `shouldEscalate`). */
export type EscalationReason =
  | 'stalled'
  | 'repeated-failure'
  | 'budget-breach'
  | 'resource-exhaustion'
  | 'approval-timeout'
  | 'permanent-error'
  | 'turn-incomplete'
  | 'verify-failed'

const ESCALATION_REASONS: ReadonlySet<string> = new Set<EscalationReason>([
  'stalled',
  'repeated-failure',
  'budget-breach',
  'resource-exhaustion',
  'approval-timeout',
  'permanent-error',
  'turn-incomplete',
  'verify-failed'
])

/** Human-facing one-liner per reason — what the operator should understand the
 *  loop needs. */
const REASON_BLURB: Record<EscalationReason, string> = {
  stalled: 'no forward progress after repeated iterations',
  'repeated-failure': 'the same step keeps failing',
  'budget-breach': 'the cost budget was exceeded',
  'resource-exhaustion': 'a resource guard (disk/memory) tripped',
  'approval-timeout': 'an approval request went unanswered',
  'permanent-error': 'an unrecoverable error / state divergence',
  'turn-incomplete': 'a turn hit its budget before finishing the item',
  'verify-failed': 'the turn corrupted the brain store or cited a non-existent note'
}

/** PURE type-guard. True when `reason` is a known escalation trigger — the gate
 *  before spending an operator ping. */
export function shouldEscalate(reason: string): reason is EscalationReason {
  return ESCALATION_REASONS.has(reason)
}

/** Injected outbound-channel boundary. Production closes over
 *  channelDispatch(ref, body); tests capture the body. Resolves { ok } so a
 *  delivery failure is data, not an exception. */
export type DeliverSeam = (body: string) => Promise<{ ok: boolean; error?: string }>

/** Compose the human-readable escalation notice for a paused loop. Kept pure so
 *  the exact wording is unit-assertable. */
function formatEscalation(reason: EscalationReason, loop: Loop): string {
  const blurb = REASON_BLURB[reason]
  const task = loop.instruction && loop.instruction.trim() ? ` — task: ${loop.instruction.trim()}` : ''
  return (
    `Loop ${loop.id} paused: ${reason} (${blurb}). ` +
    `iteration ${loop.iteration}, mode ${loop.mode}${task}. ` +
    `Operator attention needed — the loop halted rather than proceed unattended.`
  )
}

/**
 * Format a human-readable escalation and send it via the injected seam.
 * Side-effecting only through `deliver`; returns whether delivery succeeded.
 * Fail-closed: a throwing seam or a !ok result both report { delivered:false }.
 */
export async function escalate(
  reason: EscalationReason,
  loop: Loop,
  deliver: DeliverSeam
): Promise<{ delivered: boolean }> {
  const body = formatEscalation(reason, loop)
  try {
    const res = await deliver(body)
    return { delivered: res?.ok === true }
  } catch {
    return { delivered: false }
  }
}
