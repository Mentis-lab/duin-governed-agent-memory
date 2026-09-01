// decision-utility — the foresight axis scored (world-model Stage 3, M1/M2/M3).
//
// Mirrors bench/world-model/score-foresight.mjs so the in-app number and the offline baseline agree.
//
// Honesty rules carried over from the harness, because they decide whether the numbers mean anything:
//   * M1/M2 report a STATUS, never a fake 0. A 0 would say "we ranked and scored badly"; the truth
//     is "no ranked rollout has been logged yet". rankOptions now exists, so these become live
//     numbers as soon as rollouts are recorded — they are awaiting data, not awaiting code.
//   * M3 excludes decisions that PREDATE the forecast ledger. They could never have been caught, and
//     scoring them as misses manufactures a low baseline. The exclusion is reported, not hidden.
//   * The M3 join is workstream-level (prediction.track vs decision tag, created before the decision
//     date). That is coverage, not semantic recall, and it says so in the payload.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface UtilityMetric {
  value: number | null
  status: 'measured' | 'awaiting-data' | 'no-eligible-decisions'
  reason?: string
}

export interface DecisionUtilityResult {
  M1_policyRankingAgreement: UtilityMetric & { loggedRollouts: number }
  M2_downstreamUtilityLift: UtilityMetric & { loggedRollouts: number }
  M3_preCommitCatchRate: UtilityMetric & {
    oneWayValue: number | null
    decisionsTotal: number
    decisionsInWindow: number
    decisionsExcludedPreLedger: number
    ledgerStart: string | null
    join: string
    caveat: string
  }
}

interface PredRow {
  created?: string
  track?: string
}
export interface DecisionRow {
  id: string
  date?: string
  reversibility?: string
  tags?: string[]
}

function readPredictions(vaultDir: string): PredRow[] {
  try {
    const txt = readFileSync(join(vaultDir, '.duin', '_state', 'risk-predictions.jsonl'), 'utf-8')
    const out: PredRow[] = []
    for (const ln of txt.split(/\r?\n/)) {
      const s = ln.trim()
      if (!s) continue
      try {
        out.push(JSON.parse(s) as PredRow)
      } catch {
        /* malformed row — skip, never abort the score */
      }
    }
    return out
  } catch {
    return []
  }
}

/** PURE: M3 over supplied rows, so it is testable without a vault. */
export function preCommitCatchRate(
  preds: PredRow[],
  decisions: DecisionRow[],
  ledgerStart: string | null
): DecisionUtilityResult['M3_preCommitCatchRate'] {
  const dated = decisions.filter((d) => d.date)
  const inWindow = ledgerStart ? dated.filter((d) => (d.date as string) >= ledgerStart) : []
  const caught = (d: DecisionRow): boolean => {
    const tags = new Set((d.tags ?? []).map((t) => t.toLowerCase()))
    return preds.some((p) => {
      if (!p.created || !d.date || p.created >= d.date) return false
      const track = String(p.track ?? '').toLowerCase()
      return !!track && tags.has(track)
    })
  }
  const rate = (set: DecisionRow[]): number | null =>
    set.length ? +(set.filter(caught).length / set.length).toFixed(4) : null
  const oneWay = inWindow.filter((d) => d.reversibility && d.reversibility !== 'reversible')
  return {
    value: rate(inWindow),
    oneWayValue: rate(oneWay),
    status: inWindow.length ? 'measured' : 'no-eligible-decisions',
    decisionsTotal: dated.length,
    decisionsInWindow: inWindow.length,
    decisionsExcludedPreLedger: dated.length - inWindow.length,
    ledgerStart,
    join: 'prediction.track == decision tag AND prediction.created < decision.date',
    caveat:
      'workstream-level coverage, not semantic recall: a forward signal was active in the same workstream before the commit, not necessarily about this decision.'
  }
}

export function decisionUtility(vaultDir: string | null, decisions: DecisionRow[]): DecisionUtilityResult {
  const preds = vaultDir ? readPredictions(vaultDir) : []
  const ledgerStart = preds.map((p) => p.created).filter((x): x is string => !!x).sort()[0] ?? null

  // No rollout persistence exists yet, so there is nothing to score M1/M2 over. Stated as a status
  // rather than a zero — see the header.
  const loggedRollouts = 0
  const awaiting = (what: string): UtilityMetric & { loggedRollouts: number } => ({
    value: null,
    status: 'awaiting-data',
    reason: `${what} requires logged ranked rollouts; rankOptions exists but no rollout has been persisted yet (loggedRollouts=0)`,
    loggedRollouts
  })

  return {
    M1_policyRankingAgreement: awaiting('policy-ranking agreement'),
    M2_downstreamUtilityLift: awaiting('downstream-utility lift'),
    M3_preCommitCatchRate: preCommitCatchRate(preds, decisions, ledgerStart)
  }
}
