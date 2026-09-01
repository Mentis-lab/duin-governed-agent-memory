import { describe, it, expect } from 'vitest'
import { proposeImprovements, enact, ENACT_ENABLED, DEFAULT_PROPOSER_POLICY, type ProposerInputs } from './improvement-proposer'

const empty: ProposerInputs = { revertedFacts: [], pruneCandidates: [], overGeneralFacts: [] }

describe('ENACT_ENABLED (shadow gate)', () => {
  it('is hard-false and enact() throws — nothing auto-applies', () => {
    expect(ENACT_ENABLED).toBe(false)
    expect(() => enact()).toThrow(/SHADOW-ONLY/)
  })
})

describe('proposeImprovements', () => {
  it('proposes RETIRE for repeat-reverted rules (past minReverts), skips a single revert', () => {
    const out = proposeImprovements({
      ...empty,
      revertedFacts: [
        { id: 'a', text: 'flaky rule', reverts: 3 },
        { id: 'b', text: 'one-off', reverts: 1 } // < minReverts(2) → skipped
      ]
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'retire-rule', targetId: 'a', reversible: true })
    expect(out[0].rationale).toContain('3')
  })

  it('proposes PRUNE for measured dead-weight facts', () => {
    const out = proposeImprovements({ ...empty, pruneCandidates: [{ id: 'p', text: 'inert fact' }] })
    expect(out[0]).toMatchObject({ type: 'prune-fact', targetId: 'p' })
  })

  it('proposes SHARPEN for over-general facts', () => {
    const out = proposeImprovements({ ...empty, overGeneralFacts: [{ id: 'g', text: 'sprawling rule' }] })
    expect(out[0]).toMatchObject({ type: 'sharpen-rule', targetId: 'g' })
  })

  it('orders by signal strength (retire → prune → sharpen) and caps at maxProposals', () => {
    const out = proposeImprovements(
      {
        revertedFacts: [{ id: 'r', text: 'x', reverts: 2 }],
        pruneCandidates: [{ id: 'p', text: 'y' }],
        overGeneralFacts: [{ id: 'g', text: 'z' }]
      },
      { minReverts: 2, maxProposals: 2 }
    )
    expect(out.map((o) => o.type)).toEqual(['retire-rule', 'prune-fact']) // sharpen dropped by the cap
  })

  it('empty inputs → no proposals', () => {
    expect(proposeImprovements(empty, DEFAULT_PROPOSER_POLICY)).toEqual([])
  })
})
