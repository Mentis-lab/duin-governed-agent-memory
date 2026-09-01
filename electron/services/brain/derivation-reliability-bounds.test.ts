// Stage 5 — distributional reliability bounds + the learned verifier weight.
// The Stage-3 point tests live in derivation-reliability.test.ts and are left untouched: this suite is
// about the INTERVAL layer and, above all, about the safety invariant that makes it riskless to consume
// (hi never exceeds the Stage-3 point ⇒ every consumer is tighten-only by construction).
import { describe, it, expect } from 'vitest'
import {
  reliabilityByFact,
  reliabilityBoundsByFact,
  verifierBounds,
  rankByEstablishedTrust,
  COLD_VERIFIER,
  type RelFact
} from './derivation-reliability'

const root = (id: string, source: string): RelFact => ({ id, source })
const derived = (
  id: string,
  source: string,
  edges: { on: string[]; verdict?: string; score?: number; verifier?: string | null }[]
): RelFact => ({
  id,
  source,
  dependsOn: edges.map((e) => ({
    depends_on: e.on,
    verdict: e.verdict,
    score: e.score,
    verifier: e.verifier ?? null
  }))
})

describe('verifierBounds — the LEARNED weight', () => {
  it('cold or under-sampled ⇒ the honest wide prior (we have not measured this verifier)', () => {
    expect(verifierBounds(undefined)).toEqual(COLD_VERIFIER)
    expect(verifierBounds({ correct: 5, observed: 5 })).toEqual(COLD_VERIFIER) // below VERIFIER_MIN_N
    expect(verifierBounds({ correct: 19, observed: 19 })).toEqual(COLD_VERIFIER)
  })
  it('past min-n the Wilson-95 interval on measured precision replaces the prior', () => {
    const b = verifierBounds({ correct: 90, observed: 100 })
    expect(b.lo).toBeGreaterThan(0.8)
    expect(b.hi).toBeLessThan(1.0) // a verifier measured fallible can no longer imply certainty
    expect(b.lo).toBeLessThan(b.hi)
  })
  it('more evidence at the same rate NARROWS the interval — width IS evidence quantity', () => {
    const few = verifierBounds({ correct: 18, observed: 20 })
    const many = verifierBounds({ correct: 900, observed: 1000 })
    expect(many.hi - many.lo).toBeLessThan(few.hi - few.lo)
  })
  it('a nonsense ledger (correct > observed) falls back to the prior, never a bogus interval', () => {
    expect(verifierBounds({ correct: 50, observed: 20 })).toEqual(COLD_VERIFIER)
  })
})

describe('reliabilityBoundsByFact — the interval semiring', () => {
  const cal = { correct: 90, observed: 100 }
  const mixed: RelFact[] = [
    root('a', 'operator'),
    root('x', 'external'),
    derived('r1', 'machine', [{ on: ['a'], verdict: 'entails', score: 0.9, verifier: 'j1' }]),
    derived('r2', 'machine', [{ on: ['x'], verdict: 'entails', score: 0.9, verifier: 'j1' }]),
    derived('r3', 'machine', [{ on: ['a'], verdict: 'entails', score: 0.9, verifier: null }]),
    derived('r4', 'machine', [{ on: ['a'], verdict: 'contradicts', score: 0.9, verifier: 'j1' }]),
    derived('r5', 'operator', [{ on: ['r1'], verdict: 'entails', score: 0.8, verifier: 'j1' }]),
    derived('r6', 'machine', [{ on: ['gone'], verdict: 'entails', score: 1.0, verifier: 'j1' }])
  ]

  it('THE SAFETY INVARIANT: hi never exceeds the Stage-3 point, so consumers are tighten-only', () => {
    const pt = reliabilityByFact(mixed)
    for (const c of [undefined, cal, { correct: 20, observed: 20 }, { correct: 0, observed: 40 }]) {
      const b = reliabilityBoundsByFact(mixed, c)
      for (const f of mixed) {
        const { lo, hi } = b.get(f.id)!
        expect(lo).toBeLessThanOrEqual(hi) // never inverted
        expect(hi).toBeLessThanOrEqual(pt.get(f.id)!) // EXACT — no epsilon: hi may never exceed the point
        expect(lo).toBeGreaterThanOrEqual(0)
      }
    }
  })

  // Regression: an adversarial grade found hi exceeding the point by exactly one grid unit (0.631 vs
  // 0.630) because the bounds path rounded twice — once per edge, once per fact — while the point path
  // rounds only at the fact. An un-round score like 0.9005 is what surfaces it.
  it('does not round twice: an un-round edge score cannot push hi past the point', () => {
    const facts = [root('a', 'machine'), derived('r', 'machine', [{ on: ['a'], verdict: 'entails', score: 0.9005, verifier: 'j1' }])]
    expect(reliabilityBoundsByFact(facts, undefined).get('r')!.hi).toBeLessThanOrEqual(reliabilityByFact(facts).get('r')!)
  })

  it('FUZZ: the invariant holds across thousands of random derivation graphs', () => {
    // Deterministic LCG — no Math.random, so a failure is always reproducible.
    let seed = 12345
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const sources = ['operator', 'machine', 'external', undefined]
    const verdicts = ['entails', 'neutral', 'contradicts']
    let checked = 0
    for (let trial = 0; trial < 3000; trial++) {
      const n = 2 + Math.floor(rnd() * 5)
      const facts: RelFact[] = []
      for (let i = 0; i < n; i++) {
        const src = sources[Math.floor(rnd() * sources.length)]
        // Only depend on EARLIER facts, so the graph is a DAG; ids are dense so premises resolve.
        if (i === 0 || rnd() < 0.3) {
          facts.push({ id: `f${i}`, source: src })
        } else {
          const edges = []
          for (let e = 0; e < 1 + Math.floor(rnd() * 2); e++) {
            const prem = [`f${Math.floor(rnd() * i)}`]
            if (rnd() < 0.3) prem.push(`f${Math.floor(rnd() * i)}`)
            edges.push({
              depends_on: prem,
              verdict: verdicts[Math.floor(rnd() * verdicts.length)],
              score: Math.round(rnd() * 10000) / 10000, // deliberately un-round, 4dp
              verifier: rnd() < 0.25 ? null : 'j1'
            })
          }
          facts.push({ id: `f${i}`, source: src, dependsOn: edges })
        }
      }
      for (const c of [undefined, { correct: 90, observed: 100 }, { correct: 33, observed: 40 }]) {
        const pt = reliabilityByFact(facts)
        const b = reliabilityBoundsByFact(facts, c)
        for (const f of facts) {
          const { lo, hi } = b.get(f.id)!
          expect(hi).toBeLessThanOrEqual(pt.get(f.id)!)
          expect(lo).toBeLessThanOrEqual(hi)
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(10000)
  })

  it('an UNMEASURED verifier reproduces the Stage-3 point exactly as the upper bound', () => {
    const facts = [root('a', 'operator'), derived('r', 'machine', [{ on: ['a'], verdict: 'entails', score: 0.6, verifier: 'j1' }])]
    expect(reliabilityBoundsByFact(facts, undefined).get('r')!.hi).toBe(reliabilityByFact(facts).get('r'))
  })

  it('measuring the verifier fallible pulls the bound DOWN — the point was over-optimistic', () => {
    const facts = [root('a', 'operator'), derived('r', 'machine', [{ on: ['a'], verdict: 'entails', score: 0.9, verifier: 'j1' }])]
    const cold = reliabilityBoundsByFact(facts, undefined).get('r')!
    const warm = reliabilityBoundsByFact(facts, { correct: 60, observed: 100 }).get('r')!
    expect(warm.hi).toBeLessThan(cold.hi)
  })

  it('a root fact is its source tier with ZERO width — the tier is known, not estimated', () => {
    const b = reliabilityBoundsByFact([root('a', 'operator'), root('x', 'external')], cal)
    expect(b.get('a')).toEqual({ lo: 1, hi: 1 })
    expect(b.get('x')).toEqual({ lo: 0.3, hi: 0.3 })
  })

  it('an UNVERIFIED edge widens DOWNWARD only — being unchecked never earns MORE trust', () => {
    const facts = [root('a', 'operator'), derived('r', 'operator', [{ on: ['a'], verdict: 'entails', score: 0.9, verifier: null }])]
    const b = reliabilityBoundsByFact(facts, cal).get('r')!
    expect(reliabilityByFact(facts).get('r')).toBe(0.5) // Stage 3: unverified ⇒ neutral
    expect(b.hi).toBe(0.5) // at BEST neutral — the band tops out AT the point, never above it
    expect(b.lo).toBe(0.3) // and may be considerably worse
  })

  it('a CHECKED derivation outranks an unchecked one — uncertainty must not beat evidence', () => {
    const checked = [root('a', 'operator'), derived('r', 'operator', [{ on: ['a'], verdict: 'entails', score: 0.9, verifier: 'j1' }])]
    const unchecked = [root('a', 'operator'), derived('r', 'operator', [{ on: ['a'], verdict: 'entails', score: 0.9, verifier: null }])]
    expect(reliabilityBoundsByFact(checked, cal).get('r')!.lo).toBeGreaterThan(
      reliabilityBoundsByFact(unchecked, cal).get('r')!.lo
    )
  })

  it('the external-premise poisoning cap survives into the bounds (laundering stays gated)', () => {
    const facts = [root('x', 'external'), derived('r', 'machine', [{ on: ['x'], verdict: 'entails', score: 1.0, verifier: 'j1' }])]
    expect(reliabilityBoundsByFact(facts, cal).get('r')!.hi).toBeLessThanOrEqual(0.3)
  })

  it('a strong alternate derivation rescues a fact that a weak one alone would not support', () => {
    const both = reliabilityBoundsByFact(
      [
        root('a', 'operator'),
        root('x', 'external'),
        derived('r', 'machine', [
          { on: ['x'], verdict: 'entails', score: 0.9, verifier: 'j1' },
          { on: ['a'], verdict: 'entails', score: 0.9, verifier: 'j1' }
        ])
      ],
      cal
    ).get('r')!
    const weakOnly = reliabilityBoundsByFact(
      [root('x', 'external'), derived('r', 'machine', [{ on: ['x'], verdict: 'entails', score: 0.9, verifier: 'j1' }])],
      cal
    ).get('r')!
    expect(both.lo).toBeGreaterThan(weakOnly.lo)
  })

  it('a derivation CYCLE terminates and stays well-formed', () => {
    const cyc = [
      derived('p', 'operator', [{ on: ['q'], verdict: 'entails', score: 0.9, verifier: 'j1' }]),
      derived('q', 'operator', [{ on: ['p'], verdict: 'entails', score: 0.9, verifier: 'j1' }])
    ]
    const c = reliabilityBoundsByFact(cyc, cal)
    expect(c.get('p')!.lo).toBeLessThanOrEqual(c.get('p')!.hi)
    expect(c.get('q')!.lo).toBeLessThanOrEqual(c.get('q')!.hi)
  })

  it('is deterministic — the same graph yields the same intervals', () => {
    expect([...reliabilityBoundsByFact(mixed, cal)]).toEqual([...reliabilityBoundsByFact(mixed, cal)])
  })
})

describe('rankByEstablishedTrust — the consumer', () => {
  const bounds = new Map([
    ['weak', { lo: 0.2, hi: 0.4 }],
    ['strong', { lo: 0.9, hi: 0.95 }],
    ['mid', { lo: 0.5, hi: 0.6 }]
  ])
  const items = [{ id: 'weak' }, { id: 'strong' }, { id: 'mid' }]

  it('is a strict NO-OP when the cap does not bind — grounding stays byte-identical', () => {
    expect(rankByEstablishedTrust(items, 3, bounds)).toBe(items) // same reference, order untouched
    expect(rankByEstablishedTrust(items, 99, bounds)).toBe(items)
  })
  it('when the cap BINDS, scarce slots go to the best-established, not to list position', () => {
    expect(rankByEstablishedTrust(items, 2, bounds).map((i) => i.id)).toEqual(['strong', 'mid'])
    expect(rankByEstablishedTrust(items, 1, bounds).map((i) => i.id)).toEqual(['strong'])
  })
  it('never mutates the caller array, and admits nothing that was not already eligible', () => {
    const out = rankByEstablishedTrust(items, 2, bounds)
    expect(items.map((i) => i.id)).toEqual(['weak', 'strong', 'mid']) // input untouched
    for (const o of out) expect(items).toContain(o)
  })
  it('ties keep their existing relative order (stable) — unbounded facts sort first', () => {
    const tied = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(rankByEstablishedTrust(tied, 2, new Map()).map((i) => i.id)).toEqual(['a', 'b'])
  })
})
