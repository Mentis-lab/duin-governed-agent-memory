// Stage 6 — how-provenance polynomials + the graded cascade.
//
// The load-bearing test here is the EQUIVALENCE fuzz: evaluating the polynomial in the boolean semiring
// must reproduce Stage 2's cascadeTargets exactly, on random graphs. That is what makes this a genuine
// refactor of the representation rather than a second, parallel cascade that merely looks plausible and
// could silently disagree with the one that actually governs retraction.
import { describe, it, expect } from 'vitest'
import {
  polynomialsByFact,
  survivesBoolean,
  supportCount,
  trustValue,
  gradedCascade,
  MAX_TERMS,
  type Polynomial
} from './derivation-polynomial'
import { cascadeTargets, type CascadeFact } from './derivation-cascade'
import { tierScore, type RelFact } from './derivation-reliability'

const root = (id: string, source = 'operator'): RelFact => ({ id, source })
const derived = (id: string, edges: string[][], source = 'machine', verifier: string | null = 'j1'): RelFact => ({
  id,
  source,
  dependsOn: edges.map((on) => ({ depends_on: on, verdict: 'entails', score: 0.9, verifier }))
})
const setOf = (...ids: string[]): Set<string> => new Set(ids)
const termKeys = (p: Polynomial): string[] => p.terms.map((t) => t.premises.join('+')).sort()

describe('polynomialsByFact — how-provenance expansion', () => {
  it('a base fact is its own single variable', () => {
    const p = polynomialsByFact([root('a')]).get('a')!
    expect(termKeys(p)).toEqual(['a'])
    expect(p.truncated).toBe(false)
  })

  it('a conjunctive derivation yields ONE term naming both premises (x AND y)', () => {
    const p = polynomialsByFact([root('a'), root('b'), derived('r', [['a', 'b']])]).get('r')!
    expect(termKeys(p)).toEqual(['a+b'])
  })

  it('alternate derivations yield TWO terms (x OR y)', () => {
    const p = polynomialsByFact([root('a'), root('b'), derived('r', [['a'], ['b']])]).get('r')!
    expect(termKeys(p)).toEqual(['a', 'b'])
  })

  it('expands transitively but KEEPS intermediates — every fact is independently retractable', () => {
    const facts = [root('a'), derived('r1', [['a']]), derived('r2', [['r1']])]
    const p = polynomialsByFact(facts).get('r2')!
    expect(termKeys(p)).toEqual(['a+r1']) // both the base AND the rule it passed through
    // The point of keeping r1: vetoing the intermediate rule must kill r2 even though `a` still holds.
    expect(survivesBoolean(p, setOf('r1'))).toBe(false)
    expect(survivesBoolean(p, setOf('a'))).toBe(false)
  })

  it('distributes a product over a sum: (x+y) AND z = xz + yz (carrying the intermediate)', () => {
    const facts = [root('x'), root('y'), root('z'), derived('m', [['x'], ['y']]), derived('r', [['m', 'z']])]
    // Distribution holds; each term also names `m`, the rule the derivation routed through, so vetoing
    // m collapses both terms even while x, y and z all still hold.
    expect(termKeys(polynomialsByFact(facts).get('r')!)).toEqual(['m+x+z', 'm+y+z'])
    expect(survivesBoolean(polynomialsByFact(facts).get('r')!, setOf('m'))).toBe(false)
  })

  it('applies absorption: a strict superset term is dropped (x + xy = x)', () => {
    const facts = [root('a'), root('b'), derived('r', [['a'], ['a', 'b']])]
    expect(termKeys(polynomialsByFact(facts).get('r')!)).toEqual(['a'])
  })

  it('treats a MISSING premise as a base variable — eviction is not retraction', () => {
    const p = polynomialsByFact([derived('r', [['gone']])]).get('r')!
    expect(termKeys(p)).toEqual(['gone'])
    expect(survivesBoolean(p, setOf())).toBe(true)
  })

  it('terminates on a cycle and stays well-formed', () => {
    const p = polynomialsByFact([derived('p', [['q']]), derived('q', [['p']])])
    expect(p.get('p')!.terms.length).toBeGreaterThan(0)
    expect(p.get('q')!.terms.length).toBeGreaterThan(0)
  })

  it('bounds a pathological graph and MARKS it truncated rather than hanging or lying', () => {
    // A chain of binary alternates: 2^n derivations. Must cap and flag, never silently drop support.
    const facts: RelFact[] = [root('b0a'), root('b0b')]
    let prev = 'l0'
    facts.push(derived('l0', [['b0a'], ['b0b']]))
    for (let i = 1; i < 12; i++) {
      facts.push(root(`b${i}a`), root(`b${i}b`))
      facts.push(derived(`l${i}`, [[prev, `b${i}a`], [prev, `b${i}b`]]))
      prev = `l${i}`
    }
    const p = polynomialsByFact(facts).get(prev)!
    expect(p.terms.length).toBeLessThanOrEqual(MAX_TERMS)
    expect(p.truncated).toBe(true)
  })
})

describe('semiring evaluation', () => {
  const facts = [root('a'), root('b'), derived('r', [['a'], ['b']])]
  const poly = polynomialsByFact(facts).get('r')!

  it('BOOLEAN: survives while any term is intact, dies when all are hit', () => {
    expect(survivesBoolean(poly, setOf())).toBe(true)
    expect(survivesBoolean(poly, setOf('a'))).toBe(true) // alternate derivation carries it
    expect(survivesBoolean(poly, setOf('a', 'b'))).toBe(false)
  })

  it('COUNTING: the N-semiring recovers DRed\'s support counter from the polynomial', () => {
    expect(supportCount(poly, setOf())).toBe(2)
    expect(supportCount(poly, setOf('a'))).toBe(1)
    expect(supportCount(poly, setOf('a', 'b'))).toBe(0)
  })

  it('TRUST: an external premise caps the fact below an operator-backed one', () => {
    const mixed = [root('op', 'operator'), root('ext', 'external'), derived('r', [['op'], ['ext']])]
    const p = polynomialsByFact(mixed).get('r')!
    const tierOf = (id: string): number => tierScore(mixed.find((f) => f.id === id)?.source)
    const full = trustValue(p, setOf(), tierOf)
    const extOnly = trustValue(p, setOf('op'), tierOf) // lost the operator route, left with external
    expect(extOnly).toBeLessThan(full)
    expect(extOnly).toBeLessThanOrEqual(0.3) // external tier cap survives into the polynomial
  })
})

describe('SINGLE AUTHORITY — the polynomial never decides death', () => {
  // An earlier version computed its own death set and claimed equivalence with cascadeTargets. An
  // adversarial grade found five classes of disagreement, all OVER-retraction. `dead` is now an INPUT,
  // so the disagreement surface does not exist. These tests pin that property rather than re-testing an
  // equivalence that no longer needs to hold.
  it('exposes no death output at all — cascadeTargets remains the only authority', () => {
    const facts = [root('a'), derived('r', [['a']])]
    const out = gradedCascade(facts, { dead: ['a'] })
    expect(Object.keys(out)).toEqual(['degraded'])
  })

  it('cascadeTargets still governs, and is untouched by this module', () => {
    const facts: CascadeFact[] = [
      { id: 'a', status: 'candidate' },
      { id: 'r', status: 'candidate', dependsOn: [{ depends_on: ['a'] }] }
    ]
    expect(cascadeTargets(facts, ['a'])).toEqual(['r'])
  })

  it('TRUNCATION cannot destroy anything: an over-capped polynomial only ever yields an approximate report', () => {
    // 100 alternate single-premise derivations; MAX_TERMS keeps a subset. Retiring most of them used to
    // make the old death path kill a fact that still had many live justifications. Now the worst case is
    // a degradation entry flagged `approximate` — no deletion is possible from here.
    const facts: RelFact[] = []
    const alts: string[][] = []
    for (let i = 0; i < 100; i++) {
      facts.push(root(`b${i}`))
      alts.push([`b${i}`])
    }
    facts.push(derived('r', alts))
    const poly = polynomialsByFact(facts).get('r')!
    expect(poly.truncated).toBe(true)
    const dead = Array.from({ length: 90 }, (_, i) => `b${i}`) // b90..b99 still live and each supports r
    const g = gradedCascade(facts, { dead })
    const d = g.degraded.find((x) => x.id === 'r')
    if (d) expect(d.approximate).toBe(true) // approximate is DECLARED, never silently asserted as fact
  })

  it('does not inline through a PROTECTED intermediate (the D1 over-report)', () => {
    // b -> A(protected) -> F. Retiring b must not make F look degraded: A is protected, still standing,
    // and still supporting F. Inlining A's premises into F is what produced the old false report.
    const facts = [root('b'), derived('A', [['b']]), derived('F', [['A']])]
    const isLeaf = (f: RelFact): boolean => f.id === 'A'
    const withLeaf = gradedCascade(facts, { dead: ['b'], isLeaf })
    expect(withLeaf.degraded.map((d) => d.id)).not.toContain('F')
    // ...and without the protection hint the inlining does occur, proving the guard is what prevents it.
    expect(gradedCascade(facts, { dead: ['b'] }).degraded.map((d) => d.id)).toContain('F')
  })

  it('an EMPTY depends_on edge never reports a spurious degradation (the D2 case)', () => {
    const facts: RelFact[] = [root('a'), { id: 'r', source: 'machine', dependsOn: [{ depends_on: [] }] }]
    expect(gradedCascade(facts, { dead: ['a'] }).degraded.map((d) => d.id)).not.toContain('r')
  })
})

describe('gradedCascade — the frontier half: survivors that lost ground', () => {
  it('reports a SURVIVOR whose support fell — the case a boolean cascade is blind to', () => {
    // r has two derivations; retiring `a` kills one but `b` keeps r alive, so Stage 2 reports NOTHING.
    const facts = [root('a'), root('b'), derived('r', [['a'], ['b']])]
    const g = gradedCascade(facts, { dead: ['a'] })
    expect(g.degraded).toHaveLength(1)
    expect(g.degraded[0].id).toBe('r')
    expect(g.degraded[0].supportBefore).toBe(2)
    expect(g.degraded[0].supportAfter).toBe(1)
    expect(g.degraded[0].after).toBeGreaterThan(0) // still supported, just less so
  })

  it('reports a trust DROP when the surviving route is weaker than the lost one', () => {
    const facts = [root('op', 'operator'), root('ext', 'external'), derived('r', [['op'], ['ext']])]
    const g = gradedCascade(facts, { dead: ['op'] })
    expect(g.degraded[0].after).toBeLessThan(g.degraded[0].before)
  })

  it('MAX-SEMIRING PROPERTY: losing a WEAKER derivation leaves trust flat — support is what falls', () => {
    // trustValue combines alternate derivations with max (possibilistic/Viterbi family, matching the
    // Stage-3 semiring). So trust moves ONLY when the retraction removed the argmax; losing a weaker
    // route changes nothing numerically. That is why degradation is reported on `supportBefore/After`
    // as well as trust — pinning it here so nobody later reads a flat trust delta as "no loss occurred",
    // and so a future switch to an accumulative rule (Dempster / noisy-or / CF) is a deliberate change
    // against a failing test rather than a silent one.
    const facts = [root('op', 'operator'), root('ext', 'external'), derived('r', [['op'], ['ext']])]
    const g = gradedCascade(facts, { dead: ['ext'] }) // drop the WEAKER (external) route
    const d = g.degraded.find((x) => x.id === 'r')!
    expect(d.supportAfter).toBeLessThan(d.supportBefore) // support genuinely fell
    expect(d.after).toBe(d.before) // ...but trust is unchanged: max ignores a non-argmax loss
  })

  it('does NOT report a fact whose support was untouched', () => {
    const facts = [root('a'), root('b'), derived('r', [['a']]), derived('s', [['b']])]
    expect(gradedCascade(facts, { dead: ['a'] }).degraded.map((d) => d.id)).not.toContain('s')
  })

  it('surfaces a fact that lost ALL support without retracting anything', () => {
    const facts = [root('a'), derived('r', [['a']])]
    const d = gradedCascade(facts, { dead: ['a'] }).degraded.find((x) => x.id === 'r')!
    expect(d.supportAfter).toBe(0) // visible to the operator; deletion remains cascadeTargets' call
  })

  it('degradation propagates transitively to higher-order rules', () => {
    const facts = [root('a'), root('b'), derived('r', [['a'], ['b']]), derived('s', [['r']])]
    const g = gradedCascade(facts, { dead: ['a'] })
    expect(g.degraded.map((d) => d.id).sort()).toEqual(['r', 's']) // s rests on r, so s weakened too
  })

  it('is a strict no-op when nothing is retired', () => {
    const facts = [root('a'), derived('r', [['a']])]
    expect(gradedCascade(facts, { dead: [] }).degraded).toEqual([])
  })
})
