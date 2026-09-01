// Calibration engine — the prediction→verdict loop (TS port of DUIN's
// calibration(), server.py:2425). PURE: given logged predictions (each joined
// with its verdict), compute per-kind hit-rates + totals. The durable ledger
// (logging predictions, recording verdicts) lives in brain-db.ts; keeping the
// math pure here makes it unit-testable without a database.
//
// hit_rate = (happened + averted) / resolved — i.e. of the predictions you've
// resolved, how often the foresight was worth heeding (it occurred, or you
// acted and averted it) vs. a false alarm. unobserved predictions don't count
// toward resolved.

import type { LoggedPrediction, CalibrationBucket, CalibrationReport, VerdictOutcome } from './types'

const RECENT_LIMIT = 20

/**
 * Auto-resolution rule (keyless, from signals the brain already has) — the
 * prediction→verdict loop without manual clicking. Pure; the facade applies it
 * and persists the result, a human verdict always overrides.
 *
 * Only decision-window predictions auto-resolve (their id encodes the node). HONEST
 * grading (P4a, 2026-07): a decision-window resolves as a SUCCESS ('averted') ONLY from
 * a REAL recorded outcome — an actual recorded decision. A passed clock is NOT evidence:
 *   - a substantive decision was recorded    → 'averted' (the warning did its job)
 *   - a non-substantive call (dismissed/cancelled) → 'unobserved' (left owed but
 *       NOT a real call — excluded from the hit-rate denominator)
 *   - the decide-by date passed with NO recorded decision → 'expired-unconfirmed'
 *       (EXCLUDED from the denominator — NOT a success). A decision-window asserts
 *       "a decision on this node is owed by D"; a passed D with no recorded decision
 *       tells us only that we never observed the outcome — the operator may have
 *       decided off-system, or it silently lapsed. Grading that as a hit ('happened')
 *       was the self-congratulatory free clock-win (the brain grading itself). Grading
 *       it as a hard miss would over-penalize a genuinely-owed decision we simply can't
 *       confirm. The honest verdict for "no confirmation either way" is EXCLUSION.
 *   - otherwise                              → null (still open)
 * `decidedNodeIds` (substantive) takes precedence over `neutralNodeIds` (a node
 * in both is treated as averted). Deadline-collision / problem have no reliable
 * keyless signal → left to the human.
 */
export function autoVerdict(
  pred: { id: string; kind: string; due?: string | null },
  decidedNodeIds: Set<string>,
  todayISO: string,
  neutralNodeIds: Set<string> = new Set()
): VerdictOutcome | null {
  if (pred.kind === 'decision-window') {
    const nodeId = pred.id.startsWith('decide::') ? pred.id.slice('decide::'.length) : ''
    if (nodeId && decidedNodeIds.has(nodeId)) return 'averted'
    if (nodeId && neutralNodeIds.has(nodeId)) return 'unobserved'
    // decide-by lapsed with no recorded decision: honestly UNCONFIRMED, never a free win.
    if (pred.due && pred.due < todayISO) return 'expired-unconfirmed'
    return null
  }
  return null
}

/**
 * @deprecated PROD-DEAD after Item 1 (calibration unification, 2026-07-07). The
 * canonical calibration surface is now the federated native ledger
 * (`forecast-track-record.json` → `getCalibration(vaultDir)` in index.ts), NOT the
 * SQLite Stack-A logged-predictions this computed over. Kept (with its unit test) as
 * a reference implementation of the pure kind→hit_rate math; `autoVerdict` above is
 * still live (index.ts autoResolvePredictions). Delete once no reference is wanted.
 */
export function computeCalibration(predictions: LoggedPrediction[]): CalibrationReport {
  const byKind = new Map<string, CalibrationBucket>()

  const bucketFor = (kind: string): CalibrationBucket => {
    let b = byKind.get(kind)
    if (!b) {
      b = {
        kind,
        total: 0,
        happened: 0,
        averted: 0,
        false_alarm: 0,
        unobserved: 0,
        expired: 0,
        resolved: 0,
        hit_rate: null
      }
      byKind.set(kind, b)
    }
    return b
  }

  for (const p of predictions) {
    const b = bucketFor(p.kind)
    b.total++
    switch (p.outcome) {
      case 'happened':
        b.happened++
        break
      case 'averted':
        b.averted++
        break
      case 'false_alarm':
        b.false_alarm++
        break
      case 'expired-unconfirmed':
        // decide-by lapsed with no recorded decision — EXCLUDED from resolved (not a
        // success, not a graded miss). Kept distinct from 'unobserved' for the audit.
        b.expired = (b.expired ?? 0) + 1
        break
      default:
        b.unobserved++
    }
  }

  let logged = 0
  let resolvedAll = 0
  let heededAll = 0
  for (const b of byKind.values()) {
    b.resolved = b.happened + b.averted + b.false_alarm
    b.hit_rate = b.resolved > 0 ? (b.happened + b.averted) / b.resolved : null
    logged += b.total
    resolvedAll += b.resolved
    heededAll += b.happened + b.averted
  }

  const buckets = [...byKind.values()].sort((a, b) => b.total - a.total)
  const recent = [...predictions]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, RECENT_LIMIT)

  return {
    buckets,
    totals: {
      logged,
      resolved: resolvedAll,
      hit_rate: resolvedAll > 0 ? heededAll / resolvedAll : null
    },
    recent
  }
}

// ─────────────────── P4b — bounded empirical confidence calibration ───────────────────

/** Max amount (absolute confidence points) the empirical rate may move a prediction's
 *  stated confidence in a single pass. Bounds the wire so ONE domain's rate can never
 *  swing behavior wildly — defense-in-depth even though P4a made the rate honest. */
export const CALIBRATION_MAX_SHIFT = 0.15
/** Blend weight on the (rate − prior) gap before the cap. <1 keeps the prior anchored. */
export const CALIBRATION_BLEND = 0.5
/** Hard floor: the calibrated confidence never drops below this, so a low honest rate
 *  INFORMS (down-weights) a nudge without ever hard-SUPPRESSING it to zero. */
export const CALIBRATION_FLOOR = 0.05

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

/**
 * Calibrate a prediction's prior confidence toward its KIND's empirical success rate —
 * a bounded, Platt-flavoured empirical adjustment (P4b, the CONSUMER of the now-honest
 * decision-window signal). PURE + deterministic.
 *
 * Discipline (honest by construction):
 *   - GATED / no data: `rate == null` or `observed < minN` → return the prior UNCHANGED.
 *     A thin ledger never manufactures (or destroys) confidence it can't support.
 *   - BOUNDED: the move toward the rate is `BLEND · (rate − prior)` clamped to ±MAX_SHIFT,
 *     so even `rate = 0` can only nudge, never dominate.
 *   - NO HARD-SUPPRESS: the result is floored at CALIBRATION_FLOOR — the signal weights a
 *     nudge down, it never silences it.
 */
export function calibrateConfidence(
  prior: number,
  rate: number | null,
  observed: number,
  opts: { minN?: number; maxShift?: number; blend?: number; floor?: number } = {}
): number {
  const minN = opts.minN ?? 20
  const maxShift = opts.maxShift ?? CALIBRATION_MAX_SHIFT
  const blend = opts.blend ?? CALIBRATION_BLEND
  const floor = opts.floor ?? CALIBRATION_FLOOR
  if (rate == null || !Number.isFinite(rate) || observed < minN) return prior // gated → prior
  const rawShift = blend * (rate - prior)
  const shift = rawShift > maxShift ? maxShift : rawShift < -maxShift ? -maxShift : rawShift
  return clamp01(Math.max(floor, prior + shift))
}
