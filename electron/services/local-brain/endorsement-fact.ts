// endorsement-fact — the PURE guard for positive-governed capture (SIA activation).
//
// Kept in its own module (type-only imports, no electron/server graph) so it unit-tests standalone.
// An operator ENDORSEMENT carrying a distilled rule should mint a GOVERNED operator candidate — so
// positives enter the same candidate→promote→govern lifecycle as corrections, instead of being
// quarantined as taste/exemplars (the asymmetry the SIA benchmark flagged). handleLearnCorrection
// calls this and, when non-null, recordFacts() the result.
import type { Correction } from '../brain/learn-native'
import type { FactSource } from '../brain/operator-model'

/** Returns the fact to record, or null when the row is not a governable operator endorsement:
 *  excludes machine rows (`source`), non-positive polarity, the operator-model promote WELD (its
 *  rule is already a governed fact), and rows without a distilled rule. */
export function endorsementFact(payload: Correction): { fact: string; kind: string; source: FactSource } | null {
  if (payload.source) return null // machine row — never governs
  if (payload.polarity !== 'positive') return null // only endorsements (corrections have their own path)
  if (payload.skill === 'operator-model') return null // the promote-weld: rule is already a governed fact
  const rule = String(payload.candidate_rule ?? '').trim()
  // Correct boundary (confirmed by adversarial verify): a bare endorsement with no distilled rule
  // ("yes, keep doing that") has nothing to GOVERN — it stays a success-miner exemplar. Only an
  // endorsement that carries a reusable rule enters the operator-fact lifecycle. This is deliberate,
  // not a gap: minting the raw endorsed behaviour as a "fact" would double the exemplar store.
  if (rule.length < 3) return null
  return { fact: rule, kind: 'preference', source: 'operator' }
}
