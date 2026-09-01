// calibration-replay — a LABELED synthetic proper-scoring replay (gap-closure C+).
//
// The organic forecast ledger is EMPTY of resolved probabilistic forecasts (they take weeks to
// mature), so /state/calibration-score honestly returns null today. This module DEMONSTRATES the
// Brier instrument end-to-end NOW on a synthetic, clearly-labeled well-calibrated cohort — WITHOUT
// ever touching the real ledger. It imports NO fs by construction, so it CANNOT write real state.
// Opt-in only (/state/calibration-score?replay=synthetic); the organic path is unchanged. This is
// operator decision 4: demonstrable now, honestly labeled, never conflated with real data.

import { properScore, type ScoredForecast, type ProperScore } from './calibration-scoring'
import { CAL_MIN_N } from './calibration-resolve-native'

export const SYNTHETIC_LABEL = 'SYNTHETIC — replay only; never written to the ledger' as const

/** A deterministic, well-calibrated cohort: per confidence bucket, round(c·n) forecasts
 *  materialize (outcome 1) and the rest avert (0) — so the forecaster is skilled (Brier well
 *  below the base-rate baseline → skillScore > 0), reproducibly, with no randomness. */
export function syntheticLedger(): ScoredForecast[] {
  const buckets: { confidence: number; n: number }[] = [
    { confidence: 0.9, n: 15 },
    { confidence: 0.7, n: 15 },
    { confidence: 0.3, n: 15 },
    { confidence: 0.1, n: 15 }
  ]
  const out: ScoredForecast[] = []
  for (const b of buckets) {
    const ones = Math.round(b.confidence * b.n)
    for (let i = 0; i < b.n; i++) out.push({ confidence: b.confidence, outcome: i < ones ? 1 : 0 })
  }
  return out
}

/** Proper score over the synthetic cohort, tagged synthetic. Never reads or writes the ledger. */
export function syntheticReplayScore(minN: number = CAL_MIN_N): ProperScore & { synthetic: true; label: string } {
  return { ...properScore(syntheticLedger(), minN), synthetic: true, label: SYNTHETIC_LABEL }
}
