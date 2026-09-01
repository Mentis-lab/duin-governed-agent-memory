import { describe, it, expect } from 'vitest'
import { preResolutionSignal, preResolutionSignals, type OpenForecast } from './pre-resolution'

// Measure — leading pre-resolution signal on open forecasts (Milkyway). Pure.

const f = (over: Partial<OpenForecast> = {}): OpenForecast => ({
  id: 'f1',
  subjects: ['s1', 's2'],
  created: '2026-07-01',
  evalAfter: '2026-07-31',
  confidence: 0.6,
  ...over
})

describe('preResolutionSignal', () => {
  it('all subjects closed near the deadline → strongly AVERTING', () => {
    const s = preResolutionSignal(f(), new Set(), new Date('2026-07-29')) // none open → all closed
    expect(s.closedFraction).toBe(1)
    expect(s.timeProgress).toBeGreaterThan(0.9)
    expect(s.lean).toBe('averting')
    expect(s.leadingIndicator).toBeGreaterThan(0.9)
  })

  it('all subjects still open near the deadline → strongly MATERIALIZING', () => {
    const s = preResolutionSignal(f(), new Set(['s1', 's2']), new Date('2026-07-29'))
    expect(s.closedFraction).toBe(0)
    expect(s.lean).toBe('materializing')
    expect(s.leadingIndicator).toBeLessThan(-0.9)
  })

  it('EARLY in the window the signal is weak/undetermined (temporal contrast sharpens later)', () => {
    // day 2 of a 30-day window, all still open: strong closedFraction=0 but timeProgress~0
    const s = preResolutionSignal(f(), new Set(['s1', 's2']), new Date('2026-07-03'))
    expect(s.timeProgress).toBeLessThan(0.15)
    expect(Math.abs(s.leadingIndicator)).toBeLessThan(0.25)
    expect(s.lean).toBe('undetermined')
  })

  it('a split near the deadline lands between the leans', () => {
    const s = preResolutionSignal(f({ subjects: ['s1', 's2', 's3', 's4'] }), new Set(['s1', 's2']), new Date('2026-07-29'))
    expect(s.closedFraction).toBe(0.5) // 2 of 4 closed
    expect(s.leadingIndicator).toBeCloseTo(0, 1) // (2*0.5-1)=0 → ~0
    expect(s.lean).toBe('undetermined')
  })

  it('no subjects → undetermined, not scoreable', () => {
    const s = preResolutionSignal(f({ subjects: [] }), new Set(), new Date('2026-07-29'))
    expect(s).toMatchObject({ lean: 'undetermined', subjectCount: 0, leadingIndicator: 0 })
  })

  it('malformed dates → timeProgress 0 (no fabricated urgency)', () => {
    const s = preResolutionSignal(f({ created: 'x', evalAfter: 'y' }), new Set(), new Date('2026-07-29'))
    expect(s.timeProgress).toBe(0)
    expect(s.leadingIndicator).toBe(0)
  })

  it('clamps time progress past the deadline to 1', () => {
    const s = preResolutionSignal(f(), new Set(), new Date('2026-09-01')) // past evalAfter
    expect(s.timeProgress).toBe(1)
  })
})

describe('preResolutionSignals', () => {
  it('maps over every open forecast', () => {
    const out = preResolutionSignals([f({ id: 'a' }), f({ id: 'b', subjects: ['x'] })], new Set(['x']), new Date('2026-07-29'))
    expect(out.map((s) => s.id)).toEqual(['a', 'b'])
    expect(out[1].lean).toBe('materializing') // x still open near deadline
  })
})
