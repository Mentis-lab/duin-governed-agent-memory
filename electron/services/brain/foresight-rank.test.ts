import { describe, it, expect } from 'vitest'
import { rankOptions, agreesWithNaive } from './foresight-rank'
import type { DecisionSimResult, OptionForecast, SimConsequence, SimRiskDelta } from './decision-simulator'

const conseq = (supported: boolean): SimConsequence => ({
  text: 't',
  horizon: 'near' as SimConsequence['horizon'],
  basis: supported ? 'a real risk' : '',
  supported
})

function option(
  optionId: string,
  { supported = 0, unsupported = 0, down = 0, up = 0 }: { supported?: number; unsupported?: number; down?: number; up?: number }
): OptionForecast {
  const consequences = [
    ...Array.from({ length: supported }, () => conseq(true)),
    ...Array.from({ length: unsupported }, () => conseq(false))
  ]
  const riskDeltas: SimRiskDelta[] = [
    ...Array.from({ length: down }, () => ({ risk: 'r', direction: 'down' as const, why: 'w' })),
    ...Array.from({ length: up }, () => ({ risk: 'r', direction: 'up' as const, why: 'w' }))
  ]
  return { optionId, label: optionId, consequences, riskDeltas, flagged: unsupported, forecast: { predicted: '', track: '' } }
}

const sim = (options: OptionForecast[]): DecisionSimResult => ({
  decision: 'd',
  grounded: { risks: [], entities: [] },
  options,
  modelUsed: true
})

describe('rankOptions', () => {
  it('ranks a well-grounded option above a speculative one', () => {
    const r = rankOptions(sim([option('spec', { supported: 0, unsupported: 4 }), option('solid', { supported: 4 })]))
    expect(r.ranked[0].optionId).toBe('solid')
    expect(r.top?.optionId).toBe('solid')
    expect(r.decisive).toBe(true)
  })

  it('an option with NO consequences scores as no-evidence, not perfect evidence', () => {
    const r = rankOptions(sim([option('empty', {}), option('grounded', { supported: 2 })]))
    expect(r.ranked[0].optionId).toBe('grounded')
    expect(r.ranked.find((o) => o.optionId === 'empty')!.supportRate).toBe(0)
  })

  it('reports a TIE instead of inventing a winner when the top two are level', () => {
    const r = rankOptions(sim([option('a', { supported: 2 }), option('b', { supported: 2 })]))
    expect(r.decisive).toBe(false)
    expect(r.top).toBeNull()
    expect(r.note).toMatch(/tie/i)
    expect(r.ranked).toHaveLength(2) // still ranked, just not recommended
  })

  it('risk direction breaks a support tie once the domain is trusted', () => {
    const r = rankOptions(
      sim([option('risky', { supported: 2, up: 2 }), option('derisking', { supported: 2, down: 2 })]),
      { riskTrust: 1 }
    )
    expect(r.top?.optionId).toBe('derisking')
  })

  it('an UNCALIBRATED risk domain is damped, so risk alone cannot decide', () => {
    const options = [option('risky', { supported: 2, up: 2 }), option('derisking', { supported: 2, down: 2 })]
    const trusted = rankOptions(sim(options), { riskTrust: 1 })
    const untrusted = rankOptions(sim(options), { riskTrust: null })
    // Same ordering, but a much smaller margin when the signal has not earned trust.
    const gap = (x: typeof trusted) => Math.abs(x.ranked[0].score - x.ranked[1].score)
    expect(gap(untrusted)).toBeLessThan(gap(trusted))
    expect(untrusted.riskTrust).toBeLessThan(1)
  })

  it('riskTrust is clamped to [0,1] and a bad value falls back to the damped floor', () => {
    expect(rankOptions(sim([option('a', {})]), { riskTrust: 5 }).riskTrust).toBe(1)
    expect(rankOptions(sim([option('a', {})]), { riskTrust: -2 }).riskTrust).toBe(0)
    expect(rankOptions(sim([option('a', {})]), { riskTrust: NaN }).riskTrust).toBeGreaterThan(0)
  })

  it('an empty field ranks nothing and recommends nothing', () => {
    const r = rankOptions(sim([]))
    expect(r.ranked).toEqual([])
    expect(r.top).toBeNull()
    expect(r.decisive).toBe(false)
  })

  it('a single option is decisive by default', () => {
    expect(rankOptions(sim([option('only', { supported: 1 })])).decisive).toBe(true)
  })
})

describe('agreesWithNaive (M1 input)', () => {
  it('detects when ranking merely reproduces "pick the first option"', () => {
    const s = sim([option('first', { supported: 4 }), option('second', { unsupported: 4 })])
    expect(agreesWithNaive(s, rankOptions(s))).toBe(true)
  })

  it('detects when ranking actually changes the answer', () => {
    const s = sim([option('first', { unsupported: 4 }), option('second', { supported: 4 })])
    expect(agreesWithNaive(s, rankOptions(s))).toBe(false)
  })

  it('is null when there is no recommendation to compare', () => {
    const s = sim([option('a', { supported: 2 }), option('b', { supported: 2 })])
    expect(agreesWithNaive(s, rankOptions(s))).toBeNull()
  })
})
