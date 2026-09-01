// loop-digest.ts — Long-run L8 (Observability). Renders the periodic status
// digest line the loop delivers to its channel so a human can see, at a glance,
// how a multi-hour autonomous run is progressing without reading the journal.
//
// PURE: no I/O, no channel, no clock read on the hot path. `buildDigest` derives
// everything from its input; the only impurity is the OPTIONAL `now` argument,
// which defaults to Date.now() so the integrator can call `buildDigest(input)`
// verbatim, while tests pass a fixed `now` for a deterministic string. The
// delivery itself is done by the caller via the L8 DeliverSeam (see
// escalation.ts) — this module only shapes the text.

import type { Loop } from '../loop-store'
import type { TokenUsage } from './run-journal'

/** Everything the periodic status digest needs. `usage` is the last turn's
 *  token accounting (null when unavailable); `costUsd` is the loop's accrued
 *  spend; `buildStatus` is the artifact's last known build health. */
export interface DigestInput {
  loop: Pick<Loop, 'id' | 'iteration' | 'startedAt' | 'maxIterations'>
  backlogStats: { pending: number; done: number; error: number; total: number }
  usage: TokenUsage | null
  costUsd: number
  nextItem: string | null
  buildStatus: 'green' | 'red' | 'unknown'
}

const MS_PER_HOUR = 3_600_000

/** Whole hours the loop has been running, floored; 0 when never started or the
 *  clock is behind startedAt (never negative). */
function elapsedHours(startedAt: number | null, now: number): number {
  if (startedAt == null) return 0
  const ms = now - startedAt
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.floor(ms / MS_PER_HOUR)
}

/** Percent of the backlog completed, 0..100 integer; 0 when the queue is empty
 *  so a fresh loop reads "0% done" rather than NaN. */
function percentDone(done: number, total: number): number {
  if (total <= 0) return 0
  const pct = Math.round((done / total) * 100)
  if (pct < 0) return 0
  if (pct > 100) return 100
  return pct
}

/**
 * PURE. Render the one-line markdown status digest for channel delivery (L8):
 *
 *   hour H: X% done (done/total), N files/items, build <status>, $C spent[, T tok], next: <item>
 *
 * `now` is optional (defaults to Date.now()) so the integrator wires the exact
 * `buildDigest(input)` signature from the contract while tests stay deterministic.
 */
export function buildDigest(input: DigestInput, now: number = Date.now()): string {
  const { loop, backlogStats, usage, costUsd, nextItem, buildStatus } = input
  const hour = elapsedHours(loop.startedAt, now)
  const pct = percentDone(backlogStats.done, backlogStats.total)
  const spent = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0
  const parts: string[] = [
    `hour ${hour}: ${pct}% done (${backlogStats.done}/${backlogStats.total})`,
    `${backlogStats.done} files/items`,
    `build ${buildStatus}`,
    `$${spent.toFixed(2)} spent`
  ]
  if (usage) {
    const tok = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    parts.push(`${tok} tok`)
  }
  if (backlogStats.error > 0) {
    parts.push(`${backlogStats.error} err`)
  }
  parts.push(`next: ${nextItem && nextItem.trim() ? nextItem : 'none'}`)
  return parts.join(', ')
}
