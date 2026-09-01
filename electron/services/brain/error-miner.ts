// error-miner — turn prediction ERRORS into candidate rules (world-model Stage 4b).
//
// This is the missing half of self-correction. DUIN measures its error honestly and then does
// nothing with it: there is no episodic -> semantic step, so a forecast that was wrong the same way
// five times teaches the system nothing. This mines those repeats.
//
// SHADOW BY CONSTRUCTION. It emits candidates in the existing Improvement shape and they go into the
// SAME human-gated funnel every other proposal uses (improvement-proposer, whose enact() throws
// while ENACT_ENABLED is false). Nothing here writes a rule, promotes anything, or acts. The whole
// point of Stage 4 is that the compounding slope becomes real WITHOUT touching enactment.
//
// Grouping is by (kind, track) because that is the unit a corrective rule can actually address —
// "my ProjectA deadline forecasts slip" is actionable; "some forecast was wrong" is not.

import type { Improvement } from './improvement-proposer'

export interface ErrorRow {
  id?: string
  kind?: string
  track?: string
  verdict?: string
  outcome?: string
  confidence?: number
  predicted?: string
}

export interface ErrorCluster {
  key: string
  kind: string
  track: string
  /** Errors of this shape. */
  errors: number
  /** Resolved rows of this shape — the denominator. */
  resolved: number
  errorRate: number
  /** Mean stated confidence on the ones that were WRONG — high means confidently wrong. */
  meanConfidenceWhenWrong: number | null
  examples: string[]
}

export interface MinerPolicy {
  /** A cluster needs this many errors before it is a pattern rather than noise. */
  minErrors: number
  /** And this much of its own population, so a big-but-mostly-right domain is not indicted. */
  minErrorRate: number
  maxCandidates: number
}
export const DEFAULT_MINER_POLICY: MinerPolicy = { minErrors: 3, minErrorRate: 0.34, maxCandidates: 10 }

/** Rows that count as a prediction ERROR. `unobserved` is NOT an error — nobody looked, which is a
 *  coverage failure, not a wrong belief. Counting it would let inattention masquerade as inaccuracy. */
function isError(r: ErrorRow): boolean {
  const v = String(r.verdict ?? '').toLowerCase()
  const o = String(r.outcome ?? '').toLowerCase()
  return v === 'refuted' || o === 'slipped' || o === 'wrong' || o === 'false-alarm'
}

function isResolved(r: ErrorRow): boolean {
  const v = String(r.verdict ?? '').toLowerCase()
  if (!v || v === 'unobserved') return false
  const o = String(r.outcome ?? '').toLowerCase()
  return o !== 'moot' && o !== 'unresolved'
}

/** PURE: group resolved rows by (kind, track) and score each cluster's error shape. */
export function clusterErrors(rows: ErrorRow[]): ErrorCluster[] {
  const groups = new Map<string, ErrorRow[]>()
  for (const r of rows) {
    if (!isResolved(r)) continue
    const kind = String(r.kind ?? 'unknown')
    const track = String(r.track ?? 'unknown')
    const key = `${kind}::${track}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(r)
  }
  const out: ErrorCluster[] = []
  for (const [key, rs] of groups) {
    const errs = rs.filter(isError)
    const confs = errs.map((e) => e.confidence).filter((c): c is number => typeof c === 'number' && Number.isFinite(c))
    const [kind, track] = key.split('::')
    out.push({
      key,
      kind,
      track,
      errors: errs.length,
      resolved: rs.length,
      errorRate: rs.length ? +(errs.length / rs.length).toFixed(4) : 0,
      meanConfidenceWhenWrong: confs.length ? +(confs.reduce((a, b) => a + b, 0) / confs.length).toFixed(4) : null,
      examples: errs.slice(0, 3).map((e) => e.predicted ?? e.id ?? '').filter(Boolean)
    })
  }
  // Worst pattern first: most errors, then highest rate.
  return out.sort((a, b) => b.errors - a.errors || b.errorRate - a.errorRate)
}

/** PURE: clusters -> candidate improvements for the EXISTING human-gated funnel.
 *
 *  Deliberately emits 'sharpen-rule' rather than 'retire-rule': a repeated forecast error says the
 *  model of that domain is miscalibrated, not that some rule must die. Retirement is a heavier claim
 *  than the evidence supports. */
export function mineErrorRules(rows: ErrorRow[], policy: MinerPolicy = DEFAULT_MINER_POLICY): Improvement[] {
  return clusterErrors(rows)
    .filter((c) => c.errors >= policy.minErrors && c.errorRate >= policy.minErrorRate)
    .slice(0, policy.maxCandidates)
    .map((c) => ({
      type: 'sharpen-rule' as const,
      targetId: `error-cluster:${c.key}`,
      target: `${c.kind} forecasts on track "${c.track}"`,
      rationale:
        `${c.errors}/${c.resolved} resolved forecasts of this shape were wrong (${Math.round(c.errorRate * 100)}%)` +
        (c.meanConfidenceWhenWrong !== null
          ? ` at mean stated confidence ${c.meanConfidenceWhenWrong} — confidently wrong, so the miscalibration is in the model of this domain, not in the sampling`
          : '') +
        (c.examples.length ? `; e.g. ${c.examples[0]}` : ''),
      reversible: true
    }))
}
