import { describe, it, expect } from 'vitest'
import { tierScore, edgeTrust, reliabilityByFact, type RelFact } from './derivation-reliability'

const root = (id: string, source: string): RelFact => ({ id, source })
const derived = (id: string, source: string, edges: { on: string[]; verdict?: string; score?: number; verifier?: string | null }[]): RelFact => ({
  id,
  source,
  dependsOn: edges.map((e) => ({ depends_on: e.on, verdict: e.verdict, score: e.score, verifier: e.verifier ?? null }))
})

describe('tierScore + edgeTrust — the trust primitives', () => {
  it('source tier: operator > machine > external', () => {
    expect(tierScore('operator')).toBe(1.0)
    expect(tierScore('machine')).toBe(0.7)
    expect(tierScore(undefined)).toBe(0.7)
    expect(tierScore('external')).toBe(0.3)
  })
  it('edge trust: verified entails earns its score; unverified only neutral; contradicts near-zero', () => {
    expect(edgeTrust({ depends_on: [], verdict: 'entails', score: 0.9, verifier: 'j1' })).toBe(0.9)
    expect(edgeTrust({ depends_on: [], verdict: 'entails', score: 0.9, verifier: null })).toBe(0.5) // UNVERIFIED → neutral, not 0.9
    expect(edgeTrust({ depends_on: [], verdict: 'neutral', score: 0.9, verifier: 'j1' })).toBe(0.4) // capped low
    expect(edgeTrust({ depends_on: [], verdict: 'contradicts', score: 0.9, verifier: 'j1' })).toBe(0.1)
  })
})

describe('reliabilityByFact — trust semiring over the derivation graph', () => {
  it('a root fact = its source tier', () => {
    const m = reliabilityByFact([root('p', 'operator')])
    expect(m.get('p')).toBe(1.0)
  })
  it('a verified derivation from operator premises = score × premise-min, capped by own tier', () => {
    const facts = [root('p1', 'operator'), root('p2', 'operator'), derived('r', 'machine', [{ on: ['p1', 'p2'], verdict: 'entails', score: 0.8, verifier: 'j1' }])]
    const m = reliabilityByFact(facts)
    // best derivation = 0.8 × min(1.0,1.0) = 0.8; capped by own tier 0.7 (machine) → 0.7
    expect(m.get('r')).toBe(0.7)
  })
  it('POISONING CAP: a rule folded from an EXTERNAL premise cannot exceed 0.3, however confident the edge', () => {
    const facts = [root('junk', 'external'), derived('r', 'operator', [{ on: ['junk'], verdict: 'entails', score: 1.0, verifier: 'j1' }])]
    const m = reliabilityByFact(facts)
    // premise-min = 0.3 (external); 1.0 × 0.3 = 0.3; the fluent edge can't launder it past its source
    expect(m.get('r')).toBe(0.3)
  })
  it('an UNVERIFIED edge caps derivation trust at ≤0.5 × premise-min', () => {
    const facts = [root('p', 'operator'), derived('r', 'operator', [{ on: ['p'], verifier: null }])]
    expect(reliabilityByFact(facts).get('r')).toBe(0.5) // 0.5 (unverified) × 1.0
  })
  it('picks the BEST of multiple derivations', () => {
    const facts = [
      root('weak', 'external'),
      root('strong', 'operator'),
      derived('r', 'operator', [
        { on: ['weak'], verdict: 'entails', score: 0.9, verifier: 'j1' }, // 0.9 × 0.3 = 0.27
        { on: ['strong'], verdict: 'entails', score: 0.9, verifier: 'j1' } // 0.9 × 1.0 = 0.9
      ])
    ]
    expect(reliabilityByFact(facts).get('r')).toBe(0.9) // takes the strong derivation
  })
  it('is cycle-safe (a→b→a) and terminates', () => {
    const facts: RelFact[] = [
      { id: 'a', source: 'operator', dependsOn: [{ depends_on: ['b'], verdict: 'entails', score: 0.9, verifier: 'j1' }] },
      { id: 'b', source: 'operator', dependsOn: [{ depends_on: ['a'], verdict: 'entails', score: 0.9, verifier: 'j1' }] }
    ]
    expect(() => reliabilityByFact(facts)).not.toThrow()
    expect(reliabilityByFact(facts).get('a')).toBeGreaterThan(0)
  })
  it('a missing/evicted premise is NEUTRAL (0.5), never a false zero', () => {
    const facts = [derived('r', 'operator', [{ on: ['gone'], verdict: 'entails', score: 1.0, verifier: 'j1' }])]
    expect(reliabilityByFact(facts).get('r')).toBe(0.5) // 1.0 × 0.5(missing) = 0.5
  })
})
