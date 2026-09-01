// promotion-retention.ts — Measure: a real WRITER for the promotion-predictions
// ledger + a backward-retention (regression) gate (SIP-Bench).
//
// The ledger promotion-predictions.jsonl is READ by calibration-native.ts
// (calRowsPromotion) but nothing ever WROTE it — a dark loop: the brain claimed to
// track whether promoted rules/changes held, but the evidence file stayed empty.
// This closes it two ways:
//
//   1. WRITER — registerPromotionPrediction appends a resolved promotion record
//      (engine, the fitness level it resolved at, passed/failed) when the self-
//      improve loop adjudicates a change. The ledger becomes live evidence.
//   2. BACKWARD-RETENTION GATE — backwardRetentionGate replays the prior PASSED
//      promotions and refuses a new change that would drop an engine BELOW the
//      fitness level an earlier promotion was validated at. A forward gain that
//      silently regresses a past win is not an improvement (SIP-Bench's finding:
//      guard backward retention, not just the new metric).
//
// The gate is PURE. The writer/reader touch the jsonl ledger (append-only), matching
// the other brain ledgers (self-improve-registry, calibration-*). An empty ledger ⇒
// the gate retains everything ⇒ keep-behavior is byte-identical until promotions
// actually accrue, so wiring it in is zero-regression on a fresh brain.

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

const stateDir = (vault: string): string => join(vault, '.duin', '_state')
const promotionPredictionsPath = (vault: string): string =>
  join(stateDir(vault), 'promotion-predictions.jsonl')

/** A resolved promotion record — the shape calibration-native.calRowsPromotion reads
 *  (id / verdict / expected_behavior / trigger_signature / eval_after / created),
 *  plus the engine + the fitness level it resolved at (for the retention gate). */
export interface PromotionPredictionRecord {
  id: string
  engine: string
  expected_behavior: string
  trigger_signature?: Record<string, unknown>
  /** 'passed' when the change was kept, 'failed' when rolled back. */
  verdict: 'passed' | 'failed' | ''
  /** The target engine's wilson_lo fitness when this promotion resolved. */
  passed_at_fitness: number | null
  created: string
  landed_in?: string
  eval_after?: { by?: string }
}

/** WRITER. Append a resolved promotion record to the ledger (append-only, best-
 *  effort — a write failure must not stall the self-improve loop, so the caller
 *  wraps this; here we only ensure the dir exists). */
export function registerPromotionPrediction(vault: string, rec: PromotionPredictionRecord): void {
  const path = promotionPredictionsPath(vault)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(rec) + '\n', 'utf-8')
}

/** Read the promotion-predictions ledger (missing ⇒ []). */
export function readPromotionPredictions(vault: string): PromotionPredictionRecord[] {
  const path = promotionPredictionsPath(vault)
  if (!existsSync(path)) return []
  const out: PromotionPredictionRecord[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as PromotionPredictionRecord)
    } catch {
      /* skip a corrupt line — one bad row must not blind the gate */
    }
  }
  return out
}

/** The replay universe for the retention gate: prior PASSED promotions, each tied
 *  to the engine + the fitness level it was validated at. Derive from the ledger. */
export interface RetentionRecord {
  id: string
  engine: string
  passedAtFitness: number
}

export function replaySet(records: PromotionPredictionRecord[]): RetentionRecord[] {
  const out: RetentionRecord[] = []
  for (const r of records) {
    if (r.verdict !== 'passed') continue
    if (typeof r.passed_at_fitness !== 'number' || !Number.isFinite(r.passed_at_fitness)) continue
    out.push({ id: r.id, engine: r.engine, passedAtFitness: r.passed_at_fitness })
  }
  return out
}

export interface RetentionRegression {
  id: string
  engine: string
  was: number
  now: number
}

export interface RetentionResult {
  /** true ⇒ no prior passed promotion regressed → safe to keep. */
  retained: boolean
  regressions: RetentionRegression[]
  /** fraction of prior passed promotions still at/above their validated level;
   *  1 when the replay set is empty (nothing to regress). */
  retentionRate: number
}

/** Default fitness-drop tolerance (wilson_lo points) before a regression is called.
 *  wilson_lo jitters with sample size, so a small band avoids false regressions. */
const DEFAULT_TOLERANCE = 0.05

/**
 * BACKWARD-RETENTION GATE (SIP-Bench). PURE. Replays prior passed promotions and
 * flags any whose engine now sits materially below the fitness it was validated at.
 * `currentScore(engine)` returns the engine's current wilson_lo (null ⇒ unknown ⇒
 * skipped, never a false regression — absent evidence is fail-safe-open, the same
 * contract the verify gates use). An empty replay set retains trivially.
 */
export function backwardRetentionGate(
  replay: RetentionRecord[],
  currentScore: (engine: string) => number | null,
  opts: { tolerance?: number } = {}
): RetentionResult {
  const tol = Number.isFinite(opts.tolerance as number) ? (opts.tolerance as number) : DEFAULT_TOLERANCE
  const regressions: RetentionRegression[] = []
  let measurable = 0
  for (const r of replay) {
    const now = currentScore(r.engine)
    if (now == null || !Number.isFinite(now)) continue // unknown → can't prove a regression
    measurable++
    if (now < r.passedAtFitness - tol) {
      regressions.push({ id: r.id, engine: r.engine, was: r.passedAtFitness, now })
    }
  }
  const retentionRate = measurable === 0 ? 1 : (measurable - regressions.length) / measurable
  return { retained: regressions.length === 0, regressions, retentionRate }
}
