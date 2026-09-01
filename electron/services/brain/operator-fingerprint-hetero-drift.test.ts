import { describe, it, expect } from 'vitest'
import { detectScopedIdioms, detectReversibilityDrift } from './operator-fingerprint'
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
const oneWayIn = (n: number, extra: Partial<DecisionRow> = {}): DecisionRow[] =>
  Array.from({ length: n }, () => dec({ oneWay: true, reversibility: 'one-way', ...extra }))
const reversibleIn = (n: number, extra: Partial<DecisionRow> = {}): DecisionRow[] =>
  Array.from({ length: n }, () => dec({ oneWay: false, reversibility: 'reversible', ...extra }))

describe('detectScopedIdioms — Simpson-guarded sub-idioms', () => {
  it('returns [] when the pooled sample is below the gate (no headline to compare)', () => {
    expect(detectScopedIdioms([...oneWayIn(3, { domain: 'finance' })])).toEqual([])
  })

  it('surfaces a domain whose band is separated from the pooled band', () => {
    // finance: 20/20 one-way (band high) · personal: 0/20 one-way (band low) · pooled 20/40 ≈ 0.5
    const decisions = [...oneWayIn(20, { domain: 'finance' }), ...reversibleIn(20, { domain: 'personal' })]
    const idioms = detectScopedIdioms(decisions)
    const domains = idioms.filter((i) => i.scopeKey === 'domain').map((i) => i.scopeValue).sort()
    expect(domains).toEqual(['finance', 'personal'])
    const finance = idioms.find((i) => i.scopeValue === 'finance')!
    expect(finance.ci[0]!).toBeGreaterThan(0.5) // separated ABOVE pooled
  })

  it('folds a sub-idiom whose band overlaps the pooled headline (no Simpson false-split)', () => {
    // every domain mirrors the pooled 50/50 → bands overlap → nothing surfaces
    const decisions = [
      ...oneWayIn(10, { domain: 'finance' }),
      ...reversibleIn(10, { domain: 'finance' }),
      ...oneWayIn(10, { domain: 'personal' }),
      ...reversibleIn(10, { domain: 'personal' })
    ]
    expect(detectScopedIdioms(decisions)).toEqual([])
  })

  it('ignores a scoped group below the gate even if extreme', () => {
    const decisions = [
      ...oneWayIn(20, { domain: 'work' }),
      ...reversibleIn(20, { domain: 'work' }),
      ...oneWayIn(3, { domain: 'wild' }) // n=3 < gate → never surfaces
    ]
    expect(detectScopedIdioms(decisions).some((i) => i.scopeValue === 'wild')).toBe(false)
  })
})

describe('detectReversibilityDrift — dual recency/older lens', () => {
  const NOW = Date.parse('2026-07-01')
  const RECENT = '2026-06-15' // ~16d old → weight ≈ 1
  const OLD = '2023-07-01' // ~1096d ≈ 3 half-lives → weight ≈ 0.125

  it('reports drift: recent one-way, older reversible, bands separate, n_eff ≥ gate', () => {
    const decisions = [
      ...oneWayIn(20, { date: RECENT }),
      ...reversibleIn(20, { date: OLD })
    ]
    const v = detectReversibilityDrift(decisions, NOW)
    expect(v.recent.n).toBeGreaterThanOrEqual(12) // Kish effective n cleared the gate
    expect(v.drifting).toBe(true)
    expect(v.recent.ci[0]!).toBeGreaterThan(v.older.ci[1]!) // recent band sits above older band
  })

  it('no drift when behavior is stationary over time', () => {
    const decisions = [...oneWayIn(20, { date: RECENT }), ...oneWayIn(20, { date: OLD })]
    const v = detectReversibilityDrift(decisions, NOW)
    expect(v.drifting).toBe(false)
  })

  it('no drift on thin recent data (n_eff below the gate → stay silent)', () => {
    const decisions = [...oneWayIn(3, { date: RECENT }), ...reversibleIn(3, { date: OLD })]
    const v = detectReversibilityDrift(decisions, NOW)
    expect(v.drifting).toBe(false)
  })

  it('unrecorded reversibility is excluded from both lenses', () => {
    const decisions = [
      ...oneWayIn(15, { date: RECENT }),
      ...Array.from({ length: 30 }, () => dec({ oneWay: false, reversibility: '—', date: OLD }))
    ]
    const v = detectReversibilityDrift(decisions, NOW)
    // only the 15 recorded one-way rows count; the 30 unrecorded ('—') never enter either lens
    expect(v.recent.n).toBeLessThanOrEqual(15) // Kish n_eff over ≤15 classifiable rows
    expect(v.older.n).toBeLessThanOrEqual(7) // older half of ≤15 rows
  })
})
