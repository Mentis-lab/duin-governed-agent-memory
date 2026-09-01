import { describe, it, expect } from 'vitest'
import { cascadeTargets, type CascadeFact } from './derivation-cascade'

// helper: a derived fact with one or more derivations (each = a premise-id set)
const d = (id: string, derivations: string[][], status = 'candidate'): CascadeFact => ({
  id,
  status,
  dependsOn: derivations.map((premises) => ({ depends_on: premises }))
})
const claim = (id: string, over?: Partial<CascadeFact>): CascadeFact => ({ id, status: 'candidate', ...over })

describe('cascadeTargets — foundational belief-base contraction (Stage 2)', () => {
  it('retiring a premise invalidates the derived rule that loses its last support', () => {
    const facts = [claim('p1'), claim('p2'), d('rule', [['p1', 'p2']])]
    expect(cascadeTargets(facts, ['p1'])).toEqual(['rule']) // rule's only derivation lost p1 → falls
  })

  it('a rule with an ALTERNATE intact derivation SURVIVES (no over-deletion)', () => {
    // rule derivable from (p1,p2) OR (p3) — retiring p1 leaves the p3 derivation intact
    const facts = [claim('p1'), claim('p2'), claim('p3'), d('rule', [['p1', 'p2'], ['p3']])]
    expect(cascadeTargets(facts, ['p1'])).toEqual([]) // survives on the alternate derivation
  })

  it('propagates RECURSIVELY: base claim → rule → higher-order principle', () => {
    const facts = [claim('c'), d('rule', [['c']]), d('principle', [['rule']])]
    expect(cascadeTargets(facts, ['c']).sort()).toEqual(['principle', 'rule']) // whole chain falls
  })

  it('PROTECTS human-confirmed rules (promoted/provisional never auto-cascade)', () => {
    const facts = [claim('c'), d('earned', [['c']], 'promoted'), d('unearned', [['c']], 'candidate')]
    expect(cascadeTargets(facts, ['c'])).toEqual(['unearned']) // promoted rule survives; a human retires it explicitly
  })

  it('a MISSING (evicted) premise counts as LIVE — eviction is not retraction', () => {
    // 'gone' is not in the store; the rule cited it but eviction must not cascade the rule out
    const facts = [claim('p1'), d('rule', [['p1', 'gone']])]
    expect(cascadeTargets(facts, ['p1'])).toEqual(['rule']) // falls because p1 was RETIRED, not because 'gone' is missing
    expect(cascadeTargets([claim('p1'), d('rule', [['p1', 'gone']])], [])).toEqual([]) // nothing retired → nothing falls
  })

  it('treats an already-vetoed premise as not-live', () => {
    const facts = [claim('bad', { status: 'vetoed' }), claim('p2'), d('rule', [['bad', 'p2']])]
    expect(cascadeTargets(facts, ['p2'])).toEqual(['rule']) // both premises dead (bad vetoed, p2 retired)
  })

  it('TERMINATES on a dependency cycle (visited-guard)', () => {
    const facts = [claim('c'), d('a', [['c', 'b']]), d('b', [['a']])]
    expect(() => cascadeTargets(facts, ['c'])).not.toThrow()
    expect(cascadeTargets(facts, ['c']).sort()).toEqual(['a', 'b'])
  })

  it('a fact with NO derivations is never cascaded (it is a root premise, not derived)', () => {
    const facts = [claim('p1'), claim('p2')] // p2 has no dependsOn
    expect(cascadeTargets(facts, ['p1'])).toEqual([])
  })
})
