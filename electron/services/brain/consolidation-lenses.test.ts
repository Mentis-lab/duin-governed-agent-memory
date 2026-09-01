import { describe, it, expect } from 'vitest'
import {
  decayWeight,
  staleCandidates,
  clauseCount,
  reAbstractionCandidates,
  consolidationLenses,
  DEFAULT_DECAY_POLICY,
  type LensFact
} from './consolidation-lenses'

const DAY = 86400000
const now = new Date('2026-07-03T00:00:00Z').getTime()
const daysAgo = (n: number): number => now - n * DAY

describe('decayWeight', () => {
  it('is 1 fresh, 0.5 at one half-life, lower beyond', () => {
    expect(decayWeight(0, 30)).toBe(1)
    expect(decayWeight(30, 30)).toBeCloseTo(0.5, 5)
    expect(decayWeight(60, 30)).toBeCloseTo(0.25, 5)
  })
})

describe('staleCandidates', () => {
  it('surfaces unpromoted candidates past the half-life, not fresh or promoted ones', () => {
    const facts: LensFact[] = [
      { id: 'fresh', text: 'a', status: 'candidate', ts: daysAgo(5) }, // too young
      { id: 'stale', text: 'b', status: 'candidate', ts: daysAgo(45) }, // past half-life → stale
      { id: 'stale-prov', text: 'c', status: 'provisional', ts: daysAgo(50) }, // provisional counts
      { id: 'promoted-old', text: 'd', status: 'promoted', ts: daysAgo(90) } // resolved → ignore
    ]
    const stale = staleCandidates(facts, now, DEFAULT_DECAY_POLICY).map((f) => f.id)
    expect(stale).toEqual(['stale', 'stale-prov'])
  })

  it('respects minAgeDays — a candidate just past the half-life but under minAge is spared', () => {
    // With minAgeDays default 21, anything ≥21d AND decay<0.5 (>30d) qualifies.
    const facts: LensFact[] = [{ id: 'x', text: 'a', status: 'candidate', ts: daysAgo(25) }] // 25d: decay(25/30)>0.5
    expect(staleCandidates(facts, now)).toHaveLength(0)
  })
})

describe('clauseCount', () => {
  it('counts bundled clauses across EN and CJK separators', () => {
    expect(clauseCount('answer concisely')).toBe(1)
    expect(clauseCount('answer concisely, and cite sources, but avoid hedging')).toBeGreaterThan(2)
    expect(clauseCount('先确认口径；再改写；最后校验')).toBeGreaterThan(2)
  })
})

describe('reAbstractionCandidates', () => {
  it('flags over-long or multi-clause facts; skips tight ones and dead ones', () => {
    const facts: LensFact[] = [
      { id: 'tight', text: 'prefer concise answers', status: 'promoted', ts: now },
      { id: 'long', text: 'x'.repeat(250), status: 'promoted', ts: now }, // too long
      {
        id: 'bundled',
        text: 'always confirm the term first, and grep the whole vault, but weight source docs, also flag inconsistencies',
        status: 'candidate',
        ts: now
      }, // too many clauses
      { id: 'dead', text: 'x'.repeat(300), status: 'vetoed', ts: now } // dead → skip
    ]
    const flagged = reAbstractionCandidates(facts).map((f) => f.id)
    expect(flagged).toContain('long')
    expect(flagged).toContain('bundled')
    expect(flagged).not.toContain('tight')
    expect(flagged).not.toContain('dead')
  })
})

describe('consolidationLenses', () => {
  it('returns both lens findings without mutating input', () => {
    const facts: LensFact[] = [
      { id: 'stale', text: 'b', status: 'candidate', ts: daysAgo(45) },
      { id: 'long', text: 'y'.repeat(250), status: 'promoted', ts: now }
    ]
    const r = consolidationLenses(facts, now)
    expect(r.stale.map((f) => f.id)).toEqual(['stale'])
    expect(r.overGeneral.map((f) => f.id)).toEqual(['long'])
    expect(facts).toHaveLength(2) // untouched
  })
})
