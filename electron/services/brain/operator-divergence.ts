// operator-divergence — THE PRIZE (plan §1, §5): the prescribed-vs-actual mirror. A pure
// join that crosses a PROMOTED operator preference ("you said you prefer reversible") against
// the measured behavior on that axis ("your record shows one-way") and reports the gap —
// never as a verdict, always as "you said X; your record shows Y."
//
// ⛔ LOAD-BEARING BOUNDARY (plan §5): a divergence is a MIRROR, not an actor. This function is
// PURE — it reads facts + a fingerprint and returns descriptors. It NEVER creates, promotes,
// or vetoes a fact, and NEVER touches calibration. The stated preference may be aspirational-
// and-correct (behavior is the bug) or the fact may be stale — only the human decides. It
// feeds the EXISTING human review gate as a new evidence TYPE, not a competing channel.
import { wilson } from './calibration-resolve-native'
import { DECISION_AXES } from './decision-axes'
import type { OperatorFingerprint, FingerprintAxis } from './operator-fingerprint'

/** Minimal promoted-fact shape (structurally OperatorFact — only id + text are read). */
export interface PromotedFactLike {
  id: string
  fact: string
}

export interface Divergence {
  factId: string
  factText: string
  axis: string
  claimedPole: string // the pole the operator's words endorse
  contradictingPole: string // the pole their record would have to show to contradict them
  againstShare: number | null // measured share of the contradicting pole (on the honest denom)
  ci: [number | null, number | null] // Wilson band of the contradicting-pole share
  n: number // the inference denominator actually used (explicitN for reversibility)
  status: 'aligned' | 'diverges' | 'cannot-prove'
}

export interface DivergenceOptions {
  minN?: number // norm/divergence-eligibility floor; defaults to fingerprint.minN
}

/** The honest inference denominator + contradicting-pole count for an axis.
 *  Reversibility leans on explicitN (excludes writer-defaulted reversible); forecast uses n.
 *  countA is the pole-A tally; the pole-B tally on the honest denom is (denom − countA), which
 *  for reversibility correctly counts ONLY explicitly-reversible notes (the bias guard). */
function inferenceCounts(ax: FingerprintAxis, contradictingSide: 'A' | 'B'): { k: number; n: number } {
  const n = ax.explicitN ?? ax.n
  const kA = ax.countA
  return { k: contradictingSide === 'A' ? kA : Math.max(0, n - kA), n }
}

/**
 * Detect divergences between promoted preferences and measured decision behavior. PURE.
 * For each promoted fact × each binary axis: match the fact's text to a pole; the
 * contradicting pole is the other one. Below the norm floor → 'cannot-prove' (honest
 * silence, never a false alarm). Otherwise fire 'diverges' iff τ=0.5 lies entirely below
 * the Wilson band of the contradicting-pole share (the record is confidently the opposite of
 * the words); else 'aligned'. Thin data → wide band → band swallows τ → no false alarm.
 */
export function detectDivergences(
  facts: PromotedFactLike[],
  fingerprint: OperatorFingerprint,
  opts: DivergenceOptions = {}
): Divergence[] {
  const minN = opts.minN ?? fingerprint.minN
  const out: Divergence[] = []
  for (const fact of facts) {
    for (const axisDesc of DECISION_AXES) {
      if (!axisDesc.binary) continue // only binary axes are divergence-eligible
      const m = axisDesc.matchClaim(fact.fact)
      if (!m) continue
      const fpAxis = fingerprint.axes.find((a) => a.id === axisDesc.id)
      if (!fpAxis || fpAxis.derivable !== 'now') continue // no behavior to test against

      const claimedPole = m.pole
      // claim at pole A → contradiction is pole B, and vice-versa
      const claimIsA = claimedPole === fpAxis.poles[0]
      const contradictingSide: 'A' | 'B' = claimIsA ? 'B' : 'A'
      const contradictingPole = fpAxis.poles[claimIsA ? 1 : 0]
      const { k, n } = inferenceCounts(fpAxis, contradictingSide)

      if (n < minN) {
        out.push({
          factId: fact.id,
          factText: fact.fact,
          axis: axisDesc.id,
          claimedPole,
          contradictingPole,
          againstShare: null,
          ci: [null, null],
          n,
          status: 'cannot-prove'
        })
        continue
      }
      const ci = wilson(k, n)
      const diverges = ci[0] != null && ci[0] > 0.5 // τ=0.5 entirely below the band
      out.push({
        factId: fact.id,
        factText: fact.fact,
        axis: axisDesc.id,
        claimedPole,
        contradictingPole,
        againstShare: n > 0 ? k / n : null,
        ci,
        n,
        status: diverges ? 'diverges' : 'aligned'
      })
    }
  }
  return out
}
