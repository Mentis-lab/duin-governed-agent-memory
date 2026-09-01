import { describe, it, expect, beforeEach } from 'vitest'
import {
  noteProviderRefusal,
  noteProviderSuccess,
  isProviderCoolingDown,
  availableProviders,
  anyCoolingDown,
  coolingDownReason,
  __resetProviderHealth
} from './provider-health'

// What this fixes: `isUsableModel` only ever asked "is there a key", and a drained account keeps
// its key forever — so routing re-picked a provider that had been refusing for weeks while a
// funded key sat unused. The operator's requirement: use whatever account is PRIORITY, then
// whatever is AVAILABLE. Priority is the list order; this module supplies availability.

const MIN = 60_000
const t0 = Date.parse('2026-08-25T12:00:00.000Z')

beforeEach(() => __resetProviderHealth())

describe('cooldown', () => {
  it('parks a provider that refused, and lets it back after the cooldown', () => {
    noteProviderRefusal('zhipu', '402 Insufficient Balance', t0)
    expect(isProviderCoolingDown('zhipu', t0 + 10 * MIN)).toBe(true)
    expect(isProviderCoolingDown('zhipu', t0 + 60 * MIN)).toBe(false)
  })

  it('never parks a provider that has not refused', () => {
    expect(isProviderCoolingDown('deepseek', t0)).toBe(false)
  })

  it('a SUCCESS clears it immediately — better evidence than a timer, so a top-up is seen at once', () => {
    noteProviderRefusal('zhipu', '402', t0)
    expect(isProviderCoolingDown('zhipu', t0 + MIN)).toBe(true)
    noteProviderSuccess('zhipu')
    expect(isProviderCoolingDown('zhipu', t0 + MIN)).toBe(false)
  })

  it('keeps the reason, so a log line can say WHY the model changed', () => {
    noteProviderRefusal('zhipu', '402 Insufficient Balance', t0)
    expect(coolingDownReason('zhipu')).toMatch(/Insufficient Balance/)
    expect(coolingDownReason('deepseek')).toBeNull()
  })
})

describe('availableProviders — priority order preserved', () => {
  const ORDER = ['zhipu', 'deepseek', 'moonshot'] as const

  it('drops the parked one and KEEPS the rest in their priority order', () => {
    noteProviderRefusal('zhipu', '402', t0)
    expect(availableProviders(ORDER, t0 + MIN)).toEqual(['deepseek', 'moonshot'])
  })

  it('returns everything untouched when nothing is parked', () => {
    expect(availableProviders(ORDER, t0)).toEqual(['zhipu', 'deepseek', 'moonshot'])
  })

  it('returns the FULL list when every candidate is parked — a degraded estate still routes', () => {
    // Failing closed here would turn "all my accounts are dry" into "the app does nothing and
    // says nothing", which is strictly worse than trying and reporting the real refusal.
    for (const p of ORDER) noteProviderRefusal(p, '402', t0)
    expect(availableProviders(ORDER, t0 + MIN)).toEqual(['zhipu', 'deepseek', 'moonshot'])
  })

  it('reports whether anything is parked, so the change of model can be announced once', () => {
    expect(anyCoolingDown(ORDER, t0)).toBe(false)
    noteProviderRefusal('deepseek', '429 rate limit', t0)
    expect(anyCoolingDown(ORDER, t0 + MIN)).toBe(true)
  })
})
