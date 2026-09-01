// transition-delta — the world model's TRANSITION function, scored (world-model Stage 2b/2c).
//
// A world model needs f(state, action) -> state'. DUIN already HAS that function: runVerdicts is a
// deterministic, pure state-transition over the claim ledger. It was only ever fed the REAL world,
// so it was never scored as a predictor. This module feeds it a COUNTERFACTUAL world — "suppose
// decision D resolves" — and diffs the predicted claim-delta against what actually happened.
//
// Deterministic and LLM-free: same ledger + same decision => same prediction, every time. That is
// what makes offline replay exact rather than approximate.
//
// MUTATION WARNING: runVerdicts retires claims IN PLACE. Everything here runs on deep clones, so a
// counterfactual can never corrupt the live in-memory ledger.

import { runVerdicts, type Claim, type Correction } from './claim-metabolism'
import type { WorldState } from './claim-metabolism'

/** The corrections runVerdicts emits for the world-state temporal rule name their cause. */
const DECISION_REASON = /resolved decision/i

export interface DeltaScore {
  tp: number
  fp: number
  fn: number
  precision: number | null
  recall: number | null
  f1: number | null
}

export interface PredictDeltaResult {
  decisionId: string
  predicted: string[]
  actual: string[]
  score: DeltaScore
  /** Claims eligible to be invalidated by this decision (the scoring denominator's universe). */
  candidates: number
}

const clone = (c: Claim): Claim => ({ ...c, justifications: [...c.justifications] })

/** Every string a claim cites, matching gatherWorldState's exact-string rule. */
const refsOf = (c: Claim): string[] => [c.subject, c.object, ...c.justifications]

/** Claims the LIVE ledger actually retired as stale because this decision resolved. This is the
 *  ground truth the prediction is scored against — it is what the running metabolism did. */
export function actualDeltaFor(claims: Claim[], decisionId: string): string[] {
  return claims
    .filter(
      (c) =>
        c.validTo !== null &&
        c.verdict === 'stale' &&
        c.verdictBy === 'temporal' &&
        refsOf(c).includes(decisionId)
    )
    .map((c) => c.id)
}

/** PURE. Predict which claims resolving `decisionId` invalidates.
 *
 *  Replay discipline: the claims this decision already retired are first RESTORED to active in the
 *  clone, so the transition function is asked to predict from the pre-decision state rather than
 *  being handed its own answer. Then the ONLY world signal supplied is "this decision is resolved",
 *  which isolates the decision-transition arm from supersession and JTMS. */
export function predictDeltaPure(claims: Claim[], decisionId: string, now: number): { predicted: string[]; candidates: number } {
  const already = new Set(actualDeltaFor(claims, decisionId))
  const world: WorldState = {
    pastAnchors: new Set(),
    resolvedDecisions: new Set([decisionId]),
    passedStreams: new Set()
  }
  const pre = claims.map((c) => {
    const k = clone(c)
    if (already.has(k.id)) {
      // Rewind exactly the rows this decision retired — nothing else.
      k.validTo = null
      k.verdict = 'current'
      k.verdictBy = null
      k.supersededBy = null
    }
    return k
  })
  const candidates = pre.filter((c) => c.validTo === null && c.mutability === 'mutable').length
  const { corrections } = runVerdicts(pre, world, now)
  const predicted = corrections
    .filter((x: Correction) => x.verdict === 'stale' && DECISION_REASON.test(x.reason ?? ''))
    .map((x) => x.claimId)
  return { predicted: [...new Set(predicted)], candidates }
}

/** PURE: rates from raw counts. Each rate is null when its denominator is empty — an undefined
 *  rate is never reported as 0, which would read as "predicted everything wrong". */
export function ratesFrom(tp: number, fp: number, fn: number): DeltaScore {
  const precision = tp + fp > 0 ? tp / (tp + fp) : null
  const recall = tp + fn > 0 ? tp / (tp + fn) : null
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null
  return { tp, fp, fn, precision, recall, f1 }
}

/** PURE set-comparison: precision/recall/F1 of a predicted id set against the actual one. */
export function scoreDelta(predicted: string[], actual: string[]): DeltaScore {
  const P = new Set(predicted)
  const A = new Set(actual)
  let tp = 0
  for (const id of P) if (A.has(id)) tp++
  return ratesFrom(tp, P.size - tp, A.size - tp)
}

/** Score one decision's transition prediction. PURE over the supplied ledger. */
export function predictDelta(claims: Claim[], decisionId: string, now: number): PredictDeltaResult {
  const actual = actualDeltaFor(claims, decisionId)
  const { predicted, candidates } = predictDeltaPure(claims, decisionId, now)
  return { decisionId, predicted, actual, score: scoreDelta(predicted, actual), candidates }
}

export interface TransitionScoreResult {
  n: number
  scoredDecisions: number
  micro: DeltaScore
  macroF1: number | null
  perDecision: PredictDeltaResult[]
  note?: string
}

/** Aggregate the transition score across decisions.
 *
 *  Only decisions with a non-empty ACTUAL delta are scored: a decision that invalidated nothing has
 *  no signal to predict, and counting them would inflate the denominator with free wins. That
 *  exclusion is reported in `n` vs `scoredDecisions` rather than left implicit. */
export function transitionScore(claims: Claim[], decisionIds: string[], now: number): TransitionScoreResult {
  const all = decisionIds.map((id) => predictDelta(claims, id, now))
  const scored = all.filter((r) => r.actual.length > 0)
  const tp = scored.reduce((s, r) => s + r.score.tp, 0)
  const fp = scored.reduce((s, r) => s + r.score.fp, 0)
  const fn = scored.reduce((s, r) => s + r.score.fn, 0)
  const micro = ratesFrom(tp, fp, fn)
  const f1s = scored.map((r) => r.score.f1).filter((x): x is number => x !== null)
  return {
    n: decisionIds.length,
    scoredDecisions: scored.length,
    micro,
    macroF1: f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : null,
    perDecision: scored,
    note: scored.length
      ? undefined
      : 'no decision in this vault has retired a claim yet — the transition function has no ground truth to be scored against'
  }
}
