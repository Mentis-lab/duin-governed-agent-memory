// foresight-rank — turn a rollout into a RANKING (world-model Stage 3).
//
// decision-simulator rolls every option forward but stops there: it never ranks and never
// recommends, which is why the foresight axis sat at L2-L3 and why M1 (policy-ranking agreement)
// was unmeasurable — there was no ranking to agree with. This module is the missing step.
//
// Deterministic and model-free: it scores the rollout the simulator already produced. Two signals,
// both already computed upstream:
//   * SUPPORT — the fraction of an option's consequences the consistency gate found grounded in
//     real state. An option whose story is mostly speculation should not win on story quality.
//   * RISK    — net direction of its risk deltas (down good, up/new bad), normalised to [-1, 1].
//
// Calibration honesty: the risk term is scaled by how much the risk forecaster has EARNED trust.
// When that domain is uncalibrated (gated / unknown), the term is damped to a floor rather than
// trusted at face value — an unmeasured signal must not decide a ranking.
//
// It also refuses to fake a winner: when the top two are within EPS the result is reported as a
// TIE, because a confident #1 that is really a coin flip is worse than an honest abstention.

import type { DecisionSimResult, OptionForecast } from './decision-simulator'

/** Weight of the support term vs the risk term. Support dominates: it is the falsifiable one. */
const W_SUPPORT = 0.65
const W_RISK = 0.35
/** Floor the risk term is damped to when its domain is uncalibrated. */
const UNCALIBRATED_RISK_TRUST = 0.25
/** Scores closer than this are a tie, not a ranking. */
const EPS = 0.02

export interface RankedOption {
  optionId: string
  label: string
  rank: number
  score: number
  supportRate: number
  riskScore: number
  supported: number
  flagged: number
  why: string
}

export interface RankResult {
  ranked: RankedOption[]
  /** The recommendation — null when the field is empty or the top two tie. */
  top: RankedOption | null
  decisive: boolean
  riskTrust: number
  note?: string
}

const round = (x: number): number => +x.toFixed(4)

function scoreOption(o: OptionForecast, riskTrust: number): Omit<RankedOption, 'rank'> {
  const total = o.consequences.length
  const supported = o.consequences.filter((c) => c.supported).length
  // No consequences at all = no evidence, not perfect evidence.
  const supportRate = total ? supported / total : 0

  const deltas = o.riskDeltas ?? []
  const good = deltas.filter((d) => d.direction === 'down').length
  const bad = deltas.filter((d) => d.direction === 'up' || d.direction === 'new').length
  const riskScore = deltas.length ? (good - bad) / deltas.length : 0

  const score = W_SUPPORT * supportRate + W_RISK * riskTrust * riskScore
  const why =
    `${supported}/${total || 0} consequences grounded` +
    (deltas.length ? `; risk ${good} down / ${bad} up` : '; no risk deltas') +
    (riskTrust < 1 ? ` (risk term damped to ${round(riskTrust)} — domain not fully calibrated)` : '')

  return {
    optionId: o.optionId,
    label: o.label,
    score: round(score),
    supportRate: round(supportRate),
    riskScore: round(riskScore),
    supported,
    flagged: o.flagged,
    why
  }
}

/**
 * Rank a rollout's options.
 *
 * `riskTrust` is the earned trust of the risk-forecasting domain in [0,1] — pass the calibration
 * layer's rate for the domain, or null when it is gated/unknown (the common case on a young vault),
 * which damps the risk term rather than dropping it.
 */
export function rankOptions(result: DecisionSimResult, opts?: { riskTrust?: number | null }): RankResult {
  const raw = opts?.riskTrust
  const riskTrust =
    typeof raw === 'number' && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : UNCALIBRATED_RISK_TRUST

  const scored = result.options.map((o) => scoreOption(o, riskTrust))
  // Stable: equal scores keep the order the simulator produced.
  const ordered = scored
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.score - a.s.score || a.i - b.i)
    .map(({ s }, idx) => ({ ...s, rank: idx + 1 }))

  if (!ordered.length) {
    return { ranked: [], top: null, decisive: false, riskTrust, note: 'no options to rank' }
  }
  const decisive = ordered.length === 1 || ordered[0].score - ordered[1].score > EPS
  return {
    ranked: ordered,
    top: decisive ? ordered[0] : null,
    decisive,
    riskTrust,
    note: decisive
      ? undefined
      : `top two are within ${EPS} — reported as a TIE rather than a false recommendation`
  }
}

/** M1 input: does the ranking AGREE with a naive baseline (the option the simulator listed first)?
 *  Agreement is not correctness — it measures whether ranking changes the answer at all. A ranking
 *  that always agrees with "pick the first one" adds nothing. */
export function agreesWithNaive(result: DecisionSimResult, ranked: RankResult): boolean | null {
  const naive = result.options[0]
  if (!naive || !ranked.top) return null
  return ranked.top.optionId === naive.optionId
}
