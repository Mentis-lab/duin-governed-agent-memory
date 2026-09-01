// calibration-recalibrate — Platt scaling on log-odds (gap-closure item 17), the AIA-Forecaster
// extremization/recalibration step. Given resolved (confidence, outcome) pairs, fit a 2-param
// logistic sigmoid(a·logit(p)+b) that maps STATED confidence → a better-calibrated confidence:
//   a > 1 EXTREMIZES (sharpens toward 0/1 — the classic under-confidence fix);
//   a < 1 SHRINKS toward the base rate (the over-confidence fix); b shifts the whole curve.
// PURE + gated: fitRecalibration returns identity (applied:false) unless the ledger has enough
// rows AND already demonstrates skill (skillScore > 0) — it can never make a cold/unskilled
// ledger worse. Wiring into the live confidence path is deliberately deferred (the item-16 per-kind
// rate vs this global transform both write f.confidence — the precedence needs care to avoid
// double-calibration); this ships the instrument + surfaces it via the calibration panel.

import type { ScoredForecast } from './calibration-scoring'
import { CAL_MIN_N } from './calibration-resolve-native'

const EPS = 1e-6
const clamp = (p: number): number => Math.min(1 - EPS, Math.max(EPS, p))
const logit = (p: number): number => Math.log(clamp(p) / (1 - clamp(p)))
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z))

export interface PlattParams {
  a: number
  b: number
}

/** Fit a Platt sigmoid(a·logit(p)+b) by gradient descent minimizing mean log-loss vs outcome.
 *  init {a:1,b:0} (identity); bounded iters + small lr keep it stable on this scale. */
export function fitPlatt(fc: ScoredForecast[], iters = 200, lr = 0.05): PlattParams {
  let a = 1
  let b = 0
  const n = fc.length
  if (n === 0) return { a, b }
  for (let it = 0; it < iters; it++) {
    let ga = 0
    let gb = 0
    for (const r of fc) {
      const z = logit(r.confidence)
      const y = sigmoid(a * z + b)
      const err = y - r.outcome
      ga += err * z
      gb += err
    }
    a -= (lr * ga) / n
    b -= (lr * gb) / n
  }
  return { a, b }
}

/** Apply a fitted Platt transform to a single stated confidence. */
export function recalibrate(p: number, prm: PlattParams): number {
  return clamp(sigmoid(prm.a * logit(p) + prm.b))
}

export interface RecalResult {
  params: PlattParams | null
  applied: boolean
  n: number
}

/** Fit a recalibration ONLY when there is enough resolved data AND the ledger already beats the
 *  base rate (skillScore > 0). Otherwise identity (applied:false) — never harms a cold ledger. */
export function fitRecalibration(fc: ScoredForecast[], skill: number | null, minN = CAL_MIN_N): RecalResult {
  const applied = fc.length >= minN && skill != null && skill > 0
  return applied ? { params: fitPlatt(fc), applied: true, n: fc.length } : { params: null, applied: false, n: fc.length }
}
