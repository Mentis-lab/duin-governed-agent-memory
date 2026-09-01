import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { gradeForecastError, type EngineFitness } from './self-improve-fitness'
import { recordRsiForecast, readRsiForecasts, forecastByConfig, type RsiForecastRecord } from './rsi-forecast-store'
import { forecastAccuracyByConfig, nextKnobValueQD, jointConfigKey, proposeNextRsiKnob, type KnobVerdict } from './rsi-proposer'
import { loadInflight } from './self-improve-registry'
import { readRsiTunables, rsiTunablesPath } from './rsi-tunables'
import { calibration } from './calibration-native'

const f = (engine: string, score: number | null, gated = false, n = 30): EngineFitness => ({ engine, score, n, gated } as EngineFitness)
const NOW = '2026-07-19T00:00:00.000Z'

describe('gradeForecastError — calibrated-magnitude forecast contract (Apply.RSI P2)', () => {
  it('HITS when the predicted delta lands within tolerance of the actual delta', () => {
    // actual = 0.65-0.60 = 0.05; predicted 0.04 → err 0.01 <= tol 0.02 → hit
    expect(gradeForecastError([f('e', 0.60)], [f('e', 0.65)], 'e', 0.04, 0.02)).toEqual({ err: expect.closeTo(0.01, 5), hit: true })
  })
  it('MISSES when the forecast is off by more than tolerance (accurate direction is not enough)', () => {
    // actual 0.05; predicted 0.20 → err 0.15 > tol → wrong (the magnitude was badly modeled)
    const g = gradeForecastError([f('e', 0.60)], [f('e', 0.65)], 'e', 0.20, 0.02)
    expect(g?.hit).toBe(false)
    expect(g?.err).toBeCloseTo(0.15, 5)
  })
  it('is null (not gradable) when either window is gated/immature or score-null', () => {
    expect(gradeForecastError([f('e', 0.60, true)], [f('e', 0.65)], 'e', 0.04)).toBeNull()
    expect(gradeForecastError([f('e', null)], [f('e', 0.65)], 'e', 0.04)).toBeNull()
    expect(gradeForecastError([f('other', 0.60)], [f('e', 0.65)], 'e', 0.04)).toBeNull()
  })
})

describe('forecastByConfig — per joint-config-cell forecast history', () => {
  const rec = (topK: number, failLimit: number, actualDelta: number, hit: boolean): RsiForecastRecord =>
    ({ id: `c-${topK}-${failLimit}-${actualDelta}`, engine: 'e', topK, failLimit, predictedDelta: 0.03, actualDelta, hit, resolved: NOW })
  it('aggregates mean actual delta + hit-rate per cell', () => {
    const m = forecastByConfig([rec(2, 20, 0.04, true), rec(2, 20, 0.06, false), rec(3, 25, 0.02, true)])
    const a = m.get('2x20')!
    expect(a.n).toBe(2)
    expect(a.meanActual).toBeCloseTo(0.05, 5)
    expect(a.hitRate).toBeCloseTo(0.5, 5)
    expect(m.get('3x25')).toEqual({ meanActual: expect.closeTo(0.02, 5), hitRate: 1, n: 1 })
  })
})

describe('rsi-forecast calibration DOMAIN (grafted onto calibration-native, un-gameable)', () => {
  let vault: string
  beforeEach(() => { vault = mkdtempSync(join(tmpdir(), 'rsi-fc-')); mkdirSync(join(vault, '.duin', '_state'), { recursive: true }) })
  afterEach(() => { try { rmSync(vault, { recursive: true, force: true }) } catch { /* ignore */ } })

  it('surfaces a real Wilson-lo once >= CAL_MIN_N(20) forecasts resolve, gated below it', () => {
    for (let i = 0; i < 10; i++) recordRsiForecast(vault, { id: `h${i}`, engine: 'e', topK: 2, failLimit: 20, predictedDelta: 0.03, actualDelta: 0.03, hit: true, resolved: NOW })
    expect(calibration(vault).domains['rsi-forecast'].gated).toBe(true) // 10 < 20 → noise, gated
    for (let i = 10; i < 22; i++) recordRsiForecast(vault, { id: `h${i}`, engine: 'e', topK: 2, failLimit: 20, predictedDelta: 0.03, actualDelta: 0.03, hit: i % 4 !== 0, resolved: NOW })
    const d = calibration(vault).domains['rsi-forecast']
    expect(d.gated).toBe(false)
    expect(d.wilson_lo).not.toBeNull()
    expect(readRsiForecasts(vault)).toHaveLength(22)
  })

  it('honors the ISO held-out window (a forecast drops out under a non-overlapping since)', () => {
    for (let i = 0; i < 22; i++) recordRsiForecast(vault, { id: `h${i}`, engine: 'e', topK: 2, failLimit: 20, predictedDelta: 0.03, actualDelta: 0.03, hit: true, resolved: '2026-07-19' })
    expect(calibration(vault).domains['rsi-forecast']).toBeDefined()
    // a window that starts AFTER every row's resolved date excludes them all → domain absent
    expect(calibration(vault, '2026-08-01').domains['rsi-forecast']).toBeUndefined()
  })
})

describe('selection prefers well-forecast configs (nextKnobValueQD + proposeNextRsiKnob)', () => {
  let vault: string
  beforeEach(() => { vault = mkdtempSync(join(tmpdir(), 'rsi-sel-')); mkdirSync(join(vault, '.duin', '_state'), { recursive: true }) })
  afterEach(() => { try { rmSync(vault, { recursive: true, force: true }) } catch { /* ignore */ } })

  // fully-explored archive (no novelty left, cur=3 skipped) so the EXPLOIT phase — where the forecast
  // preference lives — actually runs; 2 and 4 are the two improving candidates, 2 is linear-first.
  const single = (): Map<number, KnobVerdict> => new Map<number, KnobVerdict>([[1, 'kept'], [2, 'improved'], [4, 'improved'], [5, 'kept']])
  const joint = (): Map<string, KnobVerdict> => new Map<string, KnobVerdict>([
    [jointConfigKey(1, 20), 'kept'], [jointConfigKey(2, 20), 'improved'],
    [jointConfigKey(4, 20), 'improved'], [jointConfigKey(5, 20), 'kept'],
  ])
  const keyFor = (v: number) => jointConfigKey(v, 20)

  it('among two improved cells, prefers the one with the higher forecast hit-rate (>= FORECAST_PREFER_MIN_N)', () => {
    // cell 4x20 is better-modeled (hitRate 1.0, n=3) than 2x20 (hitRate 0.33, n=3) → pick 4 over linear-first 2
    const forecast = new Map([
      [jointConfigKey(2, 20), { meanActual: 0.03, hitRate: 0.33, n: 3 }],
      [jointConfigKey(4, 20), { meanActual: 0.05, hitRate: 1.0, n: 3 }],
    ])
    expect(nextKnobValueQD(3, { min: 1, max: 5 }, single(), keyFor, joint(), forecast)).toBe(4)
  })

  it('is inert on a cold/thin ledger — falls back to the prior first-improved order', () => {
    expect(nextKnobValueQD(3, { min: 1, max: 5 }, single(), keyFor, joint())).toBe(2) // no forecast arg → unchanged
    // a below-floor cell (n=1) expresses no preference → still linear-first
    const thin = new Map([[jointConfigKey(4, 20), { meanActual: 0.05, hitRate: 1.0, n: 1 }]])
    expect(nextKnobValueQD(3, { min: 1, max: 5 }, single(), keyFor, joint(), thin)).toBe(2)
  })

  it('proposeNextRsiKnob emits a finite ex-ante predictedDelta on every change', () => {
    const r = proposeNextRsiKnob(vault, NOW)
    expect(r?.staged).toBe(true)
    const pd = loadInflight(vault)[0].prediction?.predictedDelta
    expect(typeof pd).toBe('number')
    expect(Number.isFinite(pd)).toBe(true)
  })

  it('forecastAccuracyByConfig reads the live ledger the loop writes', () => {
    writeFileSync(rsiTunablesPath(vault), JSON.stringify({ namedSkillTopK: 3, recallFailureLimit: 20 }))
    recordRsiForecast(vault, { id: 'x', engine: 'e', topK: 2, failLimit: 20, predictedDelta: 0.03, actualDelta: 0.04, hit: true, resolved: NOW })
    expect(forecastAccuracyByConfig(vault).get(jointConfigKey(2, 20))?.hitRate).toBe(1)
    expect(readRsiTunables(vault).namedSkillTopK).toBe(3)
  })
})
