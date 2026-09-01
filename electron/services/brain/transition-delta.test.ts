import { describe, it, expect } from 'vitest'
import { predictDelta, predictDeltaPure, actualDeltaFor, scoreDelta, ratesFrom, transitionScore } from './transition-delta'
import { classifyMutability, type Claim } from './claim-metabolism'

const NOW = Date.UTC(2026, 6, 4)
const DAY = 86_400_000

function claim(id: string, over: Partial<Claim> = {}): Claim {
  return {
    id,
    chunkId: `c-${id}`,
    notePath: `${id}.md`,
    subject: 's',
    relation: 'status',
    object: 'o',
    validFrom: NOW - 10 * DAY,
    validTo: null,
    observedAt: NOW - 10 * DAY,
    supersededBy: null,
    mutability: classifyMutability('status'),
    justifications: [],
    verdict: 'current',
    verdictBy: null,
    ...over
  }
}

/** A claim the live metabolism already retired BECAUSE dec-1 resolved. */
const retiredByDec1 = (id: string) =>
  claim(id, { subject: 'dec-1', validTo: NOW - DAY, verdict: 'stale', verdictBy: 'temporal' })

describe('ratesFrom / scoreDelta', () => {
  it('an empty denominator yields null, never 0', () => {
    expect(ratesFrom(0, 0, 0)).toMatchObject({ precision: null, recall: null, f1: null })
    expect(scoreDelta([], []).f1).toBeNull()
  })

  it('computes precision/recall/F1 over id sets', () => {
    const s = scoreDelta(['a', 'b', 'c'], ['b', 'c', 'd'])
    expect(s).toMatchObject({ tp: 2, fp: 1, fn: 1 })
    expect(s.precision).toBeCloseTo(2 / 3)
    expect(s.recall).toBeCloseTo(2 / 3)
    expect(s.f1).toBeCloseTo(2 / 3)
  })

  it('deduplicates — a repeated prediction is not two hits', () => {
    expect(scoreDelta(['a', 'a'], ['a'])).toMatchObject({ tp: 1, fp: 0, fn: 0 })
  })
})

describe('actualDeltaFor — ground truth', () => {
  it('picks up only claims retired as stale-by-temporal that cite the decision', () => {
    const claims = [
      retiredByDec1('hit'),
      claim('active', { subject: 'dec-1' }), // still active
      claim('other-cause', { subject: 'dec-1', validTo: NOW, verdict: 'contradicted', verdictBy: 'temporal' }),
      claim('other-decision', { subject: 'dec-2', validTo: NOW, verdict: 'stale', verdictBy: 'temporal' })
    ]
    expect(actualDeltaFor(claims, 'dec-1')).toEqual(['hit'])
  })

  it('matches a decision cited in object or justifications, not just subject', () => {
    const viaObject = claim('o', { object: 'dec-9', validTo: NOW, verdict: 'stale', verdictBy: 'temporal' })
    const viaJust = claim('j', { justifications: ['dec-9'], validTo: NOW, verdict: 'stale', verdictBy: 'temporal' })
    expect(actualDeltaFor([viaObject, viaJust], 'dec-9').sort()).toEqual(['j', 'o'])
  })
})

describe('predictDelta — the transition function scored', () => {
  it('predicts exactly the claims the decision actually invalidated (perfect replay)', () => {
    const claims = [retiredByDec1('a'), retiredByDec1('b'), claim('unrelated', { subject: 'other' })]
    const r = predictDelta(claims, 'dec-1', NOW)
    expect(r.actual.sort()).toEqual(['a', 'b'])
    expect(r.predicted.sort()).toEqual(['a', 'b'])
    expect(r.score.f1).toBe(1)
  })

  it('does NOT mutate the input ledger — the counterfactual runs on clones', () => {
    const claims = [retiredByDec1('a')]
    const before = JSON.stringify(claims)
    predictDelta(claims, 'dec-1', NOW)
    expect(JSON.stringify(claims)).toBe(before)
  })

  it('rewinds ONLY the rows this decision retired, so the model must re-derive them', () => {
    // 'x' was retired by a DIFFERENT decision; it must stay retired and out of the prediction.
    const claims = [
      retiredByDec1('a'),
      claim('x', { subject: 'dec-2', validTo: NOW - DAY, verdict: 'stale', verdictBy: 'temporal' })
    ]
    const { predicted } = predictDeltaPure(claims, 'dec-1', NOW)
    expect(predicted).toEqual(['a'])
  })

  it('an evergreen claim is exempt — a decision cannot stale it (false positives stay out)', () => {
    const claims = [
      retiredByDec1('a'),
      claim('ever', { subject: 'dec-1', mutability: 'evergreen' })
    ]
    const r = predictDelta(claims, 'dec-1', NOW)
    expect(r.predicted).toEqual(['a'])
    expect(r.score.fp).toBe(0)
  })

  it('a decision that invalidated nothing scores null rates rather than a fake zero', () => {
    const r = predictDelta([claim('idle', { subject: 'other' })], 'dec-1', NOW)
    expect(r.actual).toEqual([])
    expect(r.score.recall).toBeNull()
  })
})

describe('transitionScore — aggregate', () => {
  it('scores only decisions with real ground truth, and reports the exclusion', () => {
    const claims = [retiredByDec1('a'), claim('idle', { subject: 'dec-empty' })]
    const r = transitionScore(claims, ['dec-1', 'dec-empty'], NOW)
    expect(r.n).toBe(2)
    expect(r.scoredDecisions).toBe(1) // dec-empty had nothing to predict
    expect(r.micro.f1).toBe(1)
    expect(r.macroF1).toBe(1)
  })

  it('with no ground truth anywhere it says so instead of reporting a score', () => {
    const r = transitionScore([claim('idle', { subject: 'x' })], ['dec-1'], NOW)
    expect(r.scoredDecisions).toBe(0)
    expect(r.macroF1).toBeNull()
    expect(r.note).toMatch(/no ground truth|no decision/i)
  })
})
