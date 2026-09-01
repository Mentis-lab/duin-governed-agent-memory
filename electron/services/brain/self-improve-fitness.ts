// self-improve-fitness.ts — the engine fitness VECTOR + keep-if-better gate for DUIN's
// engine self-improvement loop.
//
// It adds NO new statistics: the Wilson lower bound + n>=20 gate already live in
// calibration-native (the faithful port of server.py:calibration()), computed PER DOMAIN.
// So the multi-objective "private score" — one conservative number per engine — is just a
// projection of calibration().domains. A proposed harness change is kept only if it does
// not regress ANY engine (the multi-task-family gate; here the task families are the
// forecast/signal domains). Temporal held-out is free: score the window since a change was
// applied and it can only reflect outcomes that resolved after it (they couldn't be overfit).
import { calibration } from './calibration-native'
import { recallEfficacyFitness } from '../local-brain/recall-efficacy'

export interface EngineFitness {
  /** calibration domain — e.g. risk | decision-window | stream | plan-adherence | promotion */
  engine: string
  /** wilson_lo: the conservative lower bound of the useful-rate. null when no observations. */
  score: number | null
  /** resolved observations behind the score */
  n: number
  /** n < CAL_MIN_N(20) → not yet a trustworthy signal */
  gated: boolean
}

/** Default per-engine noise floor for the keep-if-better gate. wilson_lo jitters with sample
 *  size even at a steady rate, so a drop must clear this before it counts as a regression —
 *  otherwise the loop would roll back good changes on noise. Tunable per engine later. */
export const DEFAULT_MIN_DELTA = 0.02

/** The private fitness vector, read live from the resolved ledgers. Pure projection of
 *  calibration().domains — every engine already carries wilson_lo + observed + gated.
 *  `since` (ISO date) windows the held-out: score only outcomes resolved on/after it, so a
 *  change applied at that time is judged on outcomes it could not have overfit. */
export function readFitnessVector(vaultDir: string | null, since?: string, until?: string): EngineFitness[] {
  const resp = calibration(vaultDir, since, until)
  const calEngines: EngineFitness[] = Object.entries(resp.domains).map(([engine, d]) => ({
    engine,
    score: d.wilson_lo ?? null,
    n: d.observed ?? 0,
    gated: d.gated ?? true,
  }))
  // Recall-efficacy engines (recall-efficacy:<kind>) join the vector so an RSI knob that moves ONE
  // recall kind is A/B'd against that kind's MEASURED usefulness (windowed held-out), not the weak,
  // near-circular 'promotion' domain. Distinct engines also let two such knobs run concurrently (a
  // real population). Same EngineFitness shape → gateVector/gradePrediction treat them uniformly.
  return [...calEngines, ...recallEfficacyFitness(vaultDir, since, until)]
}

export interface EngineDelta {
  engine: string
  before: number | null
  after: number | null
  delta: number | null
  /** a trustworthy drop beyond minDelta — the only thing that fails the gate */
  regressed: boolean
  /** had a baseline but the after-score is not trustworthy (gated/absent) — hold, don't accept blind */
  inconclusive: boolean
}

export interface FitnessVerdict {
  pass: boolean
  regressions: EngineDelta[]
  inconclusive: EngineDelta[]
  deltas: EngineDelta[]
  reason: string
}

/** Keep-if-better across the whole vector. A change FAILS iff some engine regressed with
 *  trustworthy data (before + after both ungated, delta < -minDelta). An engine that had a
 *  baseline but reads gated/absent after is INCONCLUSIVE (surfaced, not a hard fail — the
 *  loop decides whether to wait); an engine with no trustworthy baseline is establishing one.
 *  Mirrors forecast_fitness.py:gate(), lifted per-engine. */
/** Grade a per-change IMPROVEMENT prediction (AHE falsifiable contract, SIA activation): did the
 *  target engine's fitness actually RISE by >= minDelta on the held-out A/B? This is STRICTER than
 *  gateVector's keep criterion (which only requires no-regression, delta >= -minDelta), so a change
 *  can be kept yet FAIL its prediction — which is the point: it tracks whether RSI changes deliver
 *  their claimed lift, not merely avoid harm. Returns null when either window is gated/immature (not
 *  yet gradable). PURE. */
export function gradePrediction(before: EngineFitness[], after: EngineFitness[], engine: string, minDelta = DEFAULT_MIN_DELTA): boolean | null {
  const b = before.find((e) => e.engine === engine)
  const a = after.find((e) => e.engine === engine)
  if (!a || a.gated || a.score == null || !b || b.gated || b.score == null) return null
  return a.score - b.score >= minDelta
}

/** Grade an RSI change's ex-ante MAGNITUDE forecast (calibrated-forecast contract, SIA activation).
 *  gradePrediction asks only the DIRECTION (did it rise by >= minDelta?); this asks the MAGNITUDE: did
 *  the predicted delta land within `tol` of the ACTUAL held-out delta? Returns { err, hit } where
 *  err = |predictedDelta − (after − before)| and hit = err <= tol, or null when either window is
 *  gated/immature (same guard as gradePrediction — not yet gradable). The hit feeds a real rsi-forecast
 *  calibration domain, so the loop learns how well-MODELED (not just how lucky) each knob move is. PURE. */
export function gradeForecastError(
  before: EngineFitness[],
  after: EngineFitness[],
  engine: string,
  predictedDelta: number,
  tol = DEFAULT_MIN_DELTA
): { err: number; hit: boolean } | null {
  const b = before.find((e) => e.engine === engine)
  const a = after.find((e) => e.engine === engine)
  if (!a || a.gated || a.score == null || !b || b.gated || b.score == null) return null
  const err = Math.abs(predictedDelta - (a.score - b.score))
  return { err, hit: err <= tol }
}

export function gateVector(before: EngineFitness[], after: EngineFitness[], minDelta = DEFAULT_MIN_DELTA): FitnessVerdict {
  const bMap = new Map(before.map((e) => [e.engine, e]))
  const deltas: EngineDelta[] = after.map((a) => {
    const b = bMap.get(a.engine)
    const noBaseline = !b || b.score === null || b.gated
    if (noBaseline) {
      return { engine: a.engine, before: b?.score ?? null, after: a.score, delta: null, regressed: false, inconclusive: false }
    }
    if (a.score === null || a.gated) {
      return { engine: a.engine, before: b!.score, after: a.score, delta: null, regressed: false, inconclusive: true }
    }
    const delta = round3(a.score - (b!.score as number))
    return { engine: a.engine, before: b!.score, after: a.score, delta, regressed: delta < -minDelta, inconclusive: false }
  })
  const regressions = deltas.filter((d) => d.regressed)
  const inconclusive = deltas.filter((d) => d.inconclusive)
  const pass = regressions.length === 0
  const scored = deltas.filter((d) => d.delta !== null).length
  return {
    pass,
    regressions,
    inconclusive,
    deltas,
    reason: pass
      ? `no engine regressed (${scored} scored${inconclusive.length ? `, ${inconclusive.length} inconclusive` : ''})`
      : `regressed: ${regressions.map((d) => `${d.engine} ${d.before}->${d.after} (${fmt(d.delta)})`).join(', ')}`,
  }
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}
function fmt(d: number | null): string {
  return d === null ? 'n/a' : (d >= 0 ? `+${d}` : `${d}`)
}
