// improvement-proposer — the self-improvement META-loop (legacy harness evolution_engine),
// in hard SHADOW mode. The other loops each emit a signal about what's not working; this
// reads those outputs and proposes concrete improvements to DUIN's OWN memory — so the
// system improves itself, not just self-calibrates. It NEVER applies anything: ENACT_ENABLED
// is false and enact() throws (defense-in-depth, exactly like evolution_engine). Proposals
// surface for the human / the ANS governor to ratify.
//
// The signals it consumes are the loops built earlier:
//   • govern auto-reverts       → a rule that keeps failing verification → RETIRE it
//   • judgment_measure prunes    → a promoted fact proven not to flip behavior → PRUNE it
//   • re-abstraction lens        → a sprawling over-general fact → SHARPEN (split/tighten) it
//
// The classification + selection are PURE + unit-tested.

import { listByStatus, getOperatorFacts } from './operator-model'
import { reAbstractionCandidates } from './consolidation-lenses'
import { messageOf } from '../guarded'

/** HARD shadow gate. The proposer generates candidates; nothing is ever auto-applied.
 *  Flipping this is a deliberate, at-machine human act — do not wire it to a flag.
 *
 *  READ THIS BEFORE TRUSTING THE CONST: `enact()` (:94) throws UNCONDITIONALLY and never reads
 *  this value, so the real gate is stronger than the flag suggests — flipping this to `true`
 *  enables nothing. Kept as documentation of stance, not as the mechanism. */
export const ENACT_ENABLED = false

export type ProposalType = 'retire-rule' | 'prune-fact' | 'sharpen-rule'

export interface Improvement {
  type: ProposalType
  targetId: string
  target: string
  rationale: string
  /** Every proposal here is a reversible store edit (Tier-B) — an add/prune/retire that
   *  can be undone; recorded so a downstream gate can reason about it. */
  reversible: boolean
}

export interface ProposerInputs {
  /** Facts the govern loop auto-reverted (jury-failed). */
  revertedFacts: { id: string; text: string; reverts: number }[]
  /** Promoted facts judgment_measure found don't flip behavior. */
  pruneCandidates: { id: string; text: string }[]
  /** Over-general facts the re-abstraction lens flagged. */
  overGeneralFacts: { id: string; text: string }[]
}

export interface ProposerPolicy {
  /** A reverted fact needs at least this many reverts before proposing retirement
   *  (one revert can be noise; a repeat is a pattern). */
  minReverts: number
  /** Cap the proposals per pass so the review queue never floods. */
  maxProposals: number
}
export const DEFAULT_PROPOSER_POLICY: ProposerPolicy = { minReverts: 2, maxProposals: 10 }

/** Turn the loops' signals into improvement proposals. PURE. Ordered by confidence:
 *  repeat-reverts first (strongest signal), then measured prunes, then sprawl. */
export function proposeImprovements(
  inputs: ProposerInputs,
  policy: ProposerPolicy = DEFAULT_PROPOSER_POLICY
): Improvement[] {
  const out: Improvement[] = []
  for (const f of inputs.revertedFacts) {
    if (f.reverts >= policy.minReverts) {
      out.push({
        type: 'retire-rule',
        targetId: f.id,
        target: f.text,
        rationale: `auto-reverted ${f.reverts}× — repeatedly fails verification`,
        reversible: true
      })
    }
  }
  for (const f of inputs.pruneCandidates) {
    out.push({
      type: 'prune-fact',
      targetId: f.id,
      target: f.text,
      rationale: 'A/B measure: does not change behavior (dead weight)',
      reversible: true
    })
  }
  for (const f of inputs.overGeneralFacts) {
    out.push({
      type: 'sharpen-rule',
      targetId: f.id,
      target: f.text,
      rationale: 're-abstraction lens: sprawling / over-general — split or tighten',
      reversible: true
    })
  }
  return out.slice(0, policy.maxProposals)
}

/** The enact path — permanently unreachable while ENACT_ENABLED is false. Any call is a
 *  programming error (the loop is shadow-only). */
export function enact(): never {
  throw new Error('improvement-proposer is SHADOW-ONLY: ENACT_ENABLED is false; proposals are never auto-applied')
}

/** Live (shadow, read-only): read the loop stores and emit proposals. `pruneCandidates`
 *  come from an on-demand judgment_measure run (not persisted), so they're passed in;
 *  reverts + over-general are read from the store. Never mutates anything. */
export function getImprovementProposals(
  pruneCandidates: { id: string; text: string }[] = [],
  policy: ProposerPolicy = DEFAULT_PROPOSER_POLICY
): Improvement[] {
  let revertedFacts: ProposerInputs['revertedFacts'] = []
  let overGeneralFacts: ProposerInputs['overGeneralFacts'] = []
  try {
    revertedFacts = listByStatus('reverted').map((f) => ({ id: f.id, text: f.fact, reverts: f.reverts ?? 0 }))
    const lensFacts = getOperatorFacts().map((f) => ({ id: f.id, text: f.fact, status: f.status, ts: f.ts }))
    overGeneralFacts = reAbstractionCandidates(lensFacts).map((f) => ({ id: f.id, text: f.text }))
  } catch (e) { console.debug('[improvement-proposer] best-effort:', messageOf(e)) }
  return proposeImprovements({ revertedFacts, pruneCandidates, overGeneralFacts }, policy)
}
