// grounding-staleness-accrual.ts — the BACKGROUND ACCRUAL that makes the staleness-fusion gate
// reachable.
//
// THE GAP THIS CLOSES (recorded in coherence-map.ts as a standing gap, and measured on 2026-09-03):
//   agui-grounding down-weights facts the learning metabolism flags as currency-stale ONLY when
//   `shouldFuseStaleness(stalenessTrust(vault))` is true, i.e. once the grounding-staleness
//   calibration domain has enough judged samples for its Wilson lower bound to clear 0.7. That gate
//   is fail-safe and correct — an unproven signal must never bury a valid operator preference.
//   But nothing in production ever WROTE that domain: `recordGroundingStalenessOutcomes` had exactly
//   one caller, the manual POST /debug/grounding-eval-live. So on every real vault the trust was
//   perpetually null, fusion never engaged, and the measured-precision gate was dead weight.
//
//   Observed consequence (STALE benchmark, bench/stale): DUIN was BETTER than a naive BM25 baseline
//   at noticing a remembered fact had gone stale (+18.8 points on state resolution) and WORSE at
//   acting on it (-16.0 on implicit policy adaptation) — it flagged the fact in the claim ledger and
//   then grounded the answer on it anyway. Read failures included recommending a wrist wearable to a
//   user who had said they stopped wearing one, and opening an answer with "given what you've
//   described before about the morning haze" after the user reported the haze had gone.
//
// WHAT THIS DOES: exactly what the debug route does, on the measure tick's clock and under the same
// cost discipline — score the ACTIVE grounding set with a local-first judge, let any operator
// adjudication override the judge label, and append the resulting precision outcomes to the
// calibration domain. Over successive ticks the domain accrues samples, and the gate opens (or stays
// shut) on MEASURED precision, which is what it was always designed to do.
//
// SAFETY, mirroring measure-tick.ts:
//   • KEYLESS-SAFE — a judge with no model abstains on every fact ⇒ 0 labels ⇒ 0 rows written ⇒ the
//     gate stays shut. It can never fabricate precision.
//   • BATCH-CAPPED — the debug route scores the whole active set; a recurring pass must not, so this
//     caps facts per pass (DUIN_STALENESS_ACCRUAL_BATCH, default 25). Coverage grows across ticks.
//   • FAILURE-ISOLATED — never throws to the caller; a bad pass is a no-op.
//   • ADDITIVE ONLY — appends calibration rows and adjudication-queue rows. It NEVER flips fusion on
//     by itself and never edits a fact: whether fusion engages remains shouldFuseStaleness's call on
//     the accrued evidence.
import { appendJudgeLabels, loadAdjudicatedLabels, outcomesFromScore, recordGroundingStalenessOutcomes,
         scoreStalenessJudged, stalenessTrust, type JudgeDeps, type JudgedFact, type StalenessTrust } from './grounding-eval-live'
import { gatherTopics, matchStale, type Topic } from './learning-metabolism'
import { listByStatus } from './operator-model'
import { localFirstJudgeDeps, localOnlyJudgeDeps } from './judgment-measure-live'

/** Facts per pass. The active grounding set can be large and each fact costs a judge call. */
const BATCH = (() => {
  const raw = Number(process.env.DUIN_STALENESS_ACCRUAL_BATCH)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 25
})()

/** Enabled unless DUIN_STALENESS_ACCRUAL is explicitly '0'/'false'. */
export function stalenessAccrualEnabled(): boolean {
  const raw = process.env.DUIN_STALENESS_ACCRUAL
  return raw !== '0' && raw !== 'false'
}

export interface StalenessAccrualDeps {
  /** The ACTIVE grounding set — the facts fusion could down-weight. */
  activeFacts: () => JudgedFact[]
  /** Resolved decisions + passed streams, the topics matchStale keys on. */
  topics: (vault: string, now: number) => Topic[]
  judge: JudgeDeps
  now: () => number
}

export interface StalenessAccrualResult {
  ran: boolean
  reason?: 'disabled' | 'no-vault' | 'no-facts' | 'error'
  scored: number
  labeled: number
  flagged: number
  queued: number
  recorded: number
  trust: StalenessTrust | null
}

const EMPTY = (reason: StalenessAccrualResult['reason']): StalenessAccrualResult => ({
  ran: false, reason, scored: 0, labeled: 0, flagged: 0, queued: 0, recorded: 0, trust: null
})

/** The deps a scheduled pass uses: LOCAL-ONLY unless the operator opted into unattended billable
 *  work, matching measure-tick's rule. Resolved fresh per pass so toggling autonomy takes effect on
 *  the next tick. */
export function accrualDeps(autonomyOn: boolean): StalenessAccrualDeps {
  return {
    activeFacts: () => [...listByStatus('promoted'), ...listByStatus('provisional')].map((f) => ({ id: f.id, text: f.fact })),
    topics: (vault, now) => gatherTopics(vault, now),
    judge: autonomyOn ? localFirstJudgeDeps : localOnlyJudgeDeps,
    now: () => Date.now()
  }
}

/**
 * One batch-capped accrual pass over `vault`. Returns what it did; never throws.
 *
 * Prioritises facts with no calibration row yet is deliberately NOT done here — the judge label is
 * cheap to recompute and a fact's staleness genuinely changes as decisions resolve, so re-scoring
 * the head of the active set each tick keeps the signal current rather than frozen at first sight.
 */
export async function runStalenessAccrual(
  vault: string | null,
  deps: StalenessAccrualDeps,
  limit: number = BATCH
): Promise<StalenessAccrualResult> {
  if (!stalenessAccrualEnabled()) return EMPTY('disabled')
  if (!vault) return EMPTY('no-vault')
  try {
    const now = deps.now()
    const facts = deps.activeFacts().slice(0, Math.max(1, limit))
    if (facts.length === 0) return EMPTY('no-facts')
    const topics = deps.topics(vault, now)
    const score = await scoreStalenessJudged(facts, (text) => matchStale(text, topics), deps.judge, now)
    const queued = appendJudgeLabels(vault, score.labels)
    const recorded = recordGroundingStalenessOutcomes(vault, outcomesFromScore(score, loadAdjudicatedLabels(vault)))
    return {
      ran: true,
      scored: facts.length,
      labeled: score.labeled,
      flagged: score.flagged,
      queued,
      recorded,
      trust: stalenessTrust(vault)
    }
  } catch (e) {
    console.warn('[staleness-accrual] pass failed (non-fatal):', (e as Error)?.message)
    return EMPTY('error')
  }
}
