// decision-loop — the CLOSING ARROW for owed DECISIONS, the counterpart to forecast-loop.
//
// forecast-loop's header describes this exact failure for forecasts: "resolution ran only
// when the calibration endpoint was hit (on-view) or a verdict was set. So an operator who
// never opened the panel left the ledger unresolved forever." Owed DECISIONS had the same
// shape and no equivalent fix: the ONLY thing that ever resolved one was a human clicking an
// outcome in the Active Work panel. Stop opening the panel and owed decisions accumulate
// forever, their decision-window predictions never resolve, and the calibration arm that
// consumes them silently flatlines. Measured on the live vault 2026-07-27:
// `resolved_this_run: 0`, every confidence bucket `gated: true`, stream-verdicts untouched
// since 07-17.
//
// WHAT THIS DOES NOT DO, deliberately: it never invents a substantive outcome. The Active
// Work panel offered five — cleared/blocked/done (substantive, which auto-resolve the
// decision-window prediction as 'averted') and dismissed/cancelled (non-substantive,
// EXCLUDED from hit-rate so they cannot inflate the score). An automated adjudicator that
// guessed 'cleared' would be manufacturing the very ground truth the metric exists to
// measure — the self-grading trap. So this closes windows on EVIDENCE only:
//
//   · evidence that the call was made  → resolve (substantive, scored)
//   · window passed, no evidence       → archive as unobserved (NOT scored either way)
//
// The second case is the one that unblocks calibration: an unresolved window is invisible to
// the ledger, whereas an explicit "no call was observed in the window" is a real datum.
import { resolveNode } from './decision-write-native'
import type { OpenLoop } from './types'

/** Days past `decide_by` before an unobserved window is closed. A window that just lapsed may
 *  still be acted on; one lapsed by more than this was not a call the operator was going to
 *  make. Generous on purpose — closing early would destroy a real pending decision, while
 *  closing late costs only a delayed datum. */
export const UNOBSERVED_GRACE_DAYS = 14

export interface DecisionLoopResult {
  /** owed decisions considered this run */
  seen: number
  /** closed as substantive — evidence showed the call was made */
  resolved: number
  /** closed as unobserved — the window lapsed past the grace period with no evidence */
  unobserved: number
  /** left open — still inside the window, or lapsed but within grace */
  open: number
}

const EMPTY: DecisionLoopResult = { seen: 0, resolved: 0, unobserved: 0, open: 0 }

/** Parse a `decide_by` date. Returns null for missing/unparseable — an owed decision with no
 *  deadline has no window to lapse, so it is never auto-closed. */
export function parseDecideBy(due: string | null | undefined): Date | null {
  if (!due || typeof due !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(due.trim())
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return Number.isNaN(d.getTime()) ? null : d
}

/** Whole days `today` is past `due` (negative while the window is still open). */
export function daysPast(due: Date, today: Date): number {
  return Math.floor((today.getTime() - due.getTime()) / 86_400_000)
}

/** Is this owed decision past its window by more than the grace period? PURE — the whole
 *  close/keep-open decision, so it is testable without a vault. */
export function isUnobserved(
  due: string | null | undefined,
  today: Date,
  graceDays: number = UNOBSERVED_GRACE_DAYS
): boolean {
  const d = parseDecideBy(due)
  if (!d) return false
  return daysPast(d, today) > graceDays
}

/** One pass over the owed-decision register.
 *
 *  Idempotent: a node closed on a previous run is no longer emitted as an open loop, so a
 *  repeat run is a no-op. Best-effort — a failure returns zeros rather than throwing, matching
 *  runForecastLoop, because this fires unattended on a tick and must never take the tick down.
 *
 *  `loops` is injected rather than read here so the caller owns the (expensive) graph build
 *  and this stays unit-testable without a vault. */
export function runDecisionLoop(
  vaultDir: string | null,
  loops: readonly OpenLoop[],
  today: Date = new Date(),
  graceDays: number = UNOBSERVED_GRACE_DAYS
): DecisionLoopResult {
  if (!vaultDir) return { ...EMPTY }
  try {
    // Always 0 in this pass, and that is the design, not an oversight. Closing a window as
    // SUBSTANTIVE means asserting the operator made a call, which is the one thing an
    // unattended adjudicator must not invent — so the substantive arm stays unimplemented
    // until there is a real evidence source for it (a recorded decision note, or a claim
    // that supersedes the node). The field is kept so the result shape mirrors
    // ForecastLoopResult and so wiring it later does not change every call site.
    const resolved = 0
    let unobserved = 0
    let open = 0
    const owed = loops.filter((l) => l.kind === 'owed' && !!l.node_id)
    for (const loop of owed) {
      if (!isUnobserved(loop.due, today, graceDays)) {
        open++
        continue
      }
      // 'archive', not 'resolve'. Both close the node and leave an audit line, but archive is
      // the non-substantive verb — it must not read as a call the operator made. The note
      // records WHY, so the register stays self-explaining months later.
      const d = parseDecideBy(loop.due)
      const late = d ? daysPast(d, today) : 0
      const r = resolveNode(
        vaultDir,
        loop.node_id as string,
        'archive',
        `auto: decision window lapsed ${late}d ago with no recorded call — closed unobserved, not scored`,
        today
      )
      if (r.ok) unobserved++
      else open++
    }
    return { seen: owed.length, resolved, unobserved, open }
  } catch {
    return { ...EMPTY }
  }
}
