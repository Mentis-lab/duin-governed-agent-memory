import { describe, it, expect } from 'vitest'
import { DECISION_AXES, decisionAxisById } from './decision-axes'
import { detectDivergences, type PromotedFactLike } from './operator-divergence'
import { computeFingerprint } from './operator-fingerprint'
import type { DecisionRow } from './decisions-native'

const dec = (over: Partial<DecisionRow>): DecisionRow => ({
  id: 'd',
  title: 't',
  date: '2026-01-01',
  status: 'decided',
  oneWay: false,
  reversibility: 'reversible',
  owner: '',
  reviewOn: '',
  links: 0,
  layer: '',
  domain: '',
  ...over
})
const oneWay = (n: number): DecisionRow[] => Array.from({ length: n }, () => dec({ oneWay: true, reversibility: 'one-way' }))
const reversibleExplicit = (n: number): DecisionRow[] => Array.from({ length: n }, () => dec({ oneWay: false, reversibility: 'reversible' }))
const unrecorded = (n: number): DecisionRow[] => Array.from({ length: n }, () => dec({ oneWay: false, reversibility: '—' }))
const fact = (id: string, text: string): PromotedFactLike => ({ id, fact: text })
const NOW = 1_720_000_000_000

describe('decision-axes — matchClaim keyless regex', () => {
  const rev = decisionAxisById('reversibility-lean')!
  it('maps "keep options open" → reversible (pole B)', () => {
    expect(rev.matchClaim('I like to keep my options open')).toEqual({ pole: 'reversible' })
    expect(rev.matchClaim('prefer reversible decisions')).toEqual({ pole: 'reversible' })
  })
  it('maps "burn the boats" / "commit hard" → one-way (pole A)', () => {
    expect(rev.matchClaim('when I decide I burn the boats')).toEqual({ pole: 'one-way' })
    expect(rev.matchClaim('I prefer to commit hard and not look back')).toEqual({ pole: 'one-way' })
  })
  it('returns null for off-axis facts', () => {
    expect(rev.matchClaim('I like dark mode')).toBeNull()
    expect(rev.matchClaim('always ship on Fridays')).toBeNull()
  })
  it('forecast axis maps confident vs hedged', () => {
    const f = decisionAxisById('forecast-optimism')!
    expect(f.matchClaim('I tend to hedge my estimates')).toEqual({ pole: 'hedged' })
    expect(f.matchClaim('I am bullish in my forecasts')).toEqual({ pole: 'confident' })
  })
  it('all descriptors point at a real fingerprint axis id and are binary', () => {
    const fp = computeFingerprint(oneWay(1), [], { now: NOW })
    for (const ax of DECISION_AXES) {
      expect(ax.binary).toBe(true)
      expect(fp.axes.some((a) => a.id === ax.id)).toBe(true)
    }
  })
})

describe('detectDivergences — the prescribed-vs-actual mirror', () => {
  it('fires "diverges": claims reversible, record is confidently one-way', () => {
    const fp = computeFingerprint(oneWay(20), [], { now: NOW }) // one-way norm, band clears 0.5
    const d = detectDivergences([fact('f1', 'I really value keeping my options open')], fp)
    expect(d).toHaveLength(1)
    expect(d[0].status).toBe('diverges')
    expect(d[0].claimedPole).toBe('reversible')
    expect(d[0].contradictingPole).toBe('one-way')
    expect(d[0].againstShare!).toBeGreaterThan(0.5)
  })

  it('claim at pole A too: claims one-way/commit, record is confidently reversible → diverges', () => {
    const fp = computeFingerprint(reversibleExplicit(20), [], { now: NOW })
    const d = detectDivergences([fact('f2', 'I burn the boats once I decide')], fp)
    expect(d[0].status).toBe('diverges')
    expect(d[0].claimedPole).toBe('one-way')
    expect(d[0].contradictingPole).toBe('reversible')
  })

  it('stays "aligned" when the record does not confidently contradict (balanced band swallows τ)', () => {
    const fp = computeFingerprint([...oneWay(6), ...reversibleExplicit(6)], [], { now: NOW }) // 12 explicit, balanced
    const d = detectDivergences([fact('f3', 'prefer reversible options')], fp)
    expect(d[0].status).toBe('aligned')
  })

  it('"cannot-prove" below the norm floor — never a false alarm on thin data', () => {
    const fp = computeFingerprint([...oneWay(3), ...reversibleExplicit(1)], [], { now: NOW }) // explicitN 4 < gate
    const d = detectDivergences([fact('f4', 'keep options open')], fp)
    expect(d[0].status).toBe('cannot-prove')
    expect(d[0].againstShare).toBeNull()
  })

  it('bias guard carries into divergence: unrecorded notes never manufacture a divergence', () => {
    // Claim one-way; record is 2 one-way + 40 UNRECORDED (default-reversible). Naively that
    // looks like a huge reversible majority contradicting the claim — but the honest denom is
    // explicitN=2, well below the gate → cannot-prove, NOT a false "diverges".
    const fp = computeFingerprint([...oneWay(2), ...unrecorded(40)], [], { now: NOW })
    const d = detectDivergences([fact('f5', 'I commit hard, no going back')], fp)
    expect(d[0].n).toBe(2) // leaned on explicitN, not the 42 total
    expect(d[0].status).toBe('cannot-prove')
  })

  it('off-axis promoted facts produce no divergence rows', () => {
    const fp = computeFingerprint(oneWay(20), [], { now: NOW })
    expect(detectDivergences([fact('f6', 'I prefer dark mode and short meetings')], fp)).toEqual([])
  })

  it('MIRROR-NOT-ACTOR: pure — does not mutate the facts it is given', () => {
    const fp = computeFingerprint(oneWay(20), [], { now: NOW })
    const facts = [fact('f7', 'keep options open')]
    const snapshot = JSON.stringify(facts)
    detectDivergences(facts, fp)
    expect(JSON.stringify(facts)).toBe(snapshot) // no fact created/promoted/vetoed/mutated
  })
})
