import { describe, it, expect } from 'vitest'
import { calibrationTrend, olsSlope, type TrendRow } from './calibration-trend'

const wk = (n: number): string => `2026-06-${String(1 + n * 7).padStart(2, '0')}`

const proper = (conf: number, hit: boolean, week: number, kind = 'anchor-risk'): TrendRow => ({
  kind,
  confidence: conf,
  verdict: hit ? 'materialized' : 'refuted',
  resolved: wk(week)
})
const signal = (ok: boolean, week: number): TrendRow => ({
  kind: 'decision-window',
  confidence: 0.7,
  outcome: ok ? 'on-time' : 'slipped',
  resolved: wk(week)
})

describe('olsSlope', () => {
  it('is null below three points', () => {
    expect(olsSlope([{ x: 0, y: 1 }, { x: 1, y: 2 }])).toBeNull()
  })
  it('recovers a known slope', () => {
    expect(olsSlope([{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 4 }])).toBeCloseTo(2)
  })
  it('weights points — a heavy OFF-CENTRE point drags the fit toward itself', () => {
    // A point at the x-centroid has no leverage, so the weight must sit off-centre to show up.
    // Here the heavy point is the flat early one, which should flatten the climb.
    const pts = [{ x: 0, y: 0, w: 100 }, { x: 1, y: 1, w: 1 }, { x: 2, y: 10, w: 1 }]
    const weighted = olsSlope(pts)!
    const flat = olsSlope(pts.map((p) => ({ x: p.x, y: p.y })))!
    expect(weighted).toBeLessThan(flat)
  })
})

describe('calibrationTrend', () => {
  it('keeps signal-mode OUT of the proper population', () => {
    const r = calibrationTrend([proper(0.8, true, 0), signal(true, 0), signal(false, 1)])
    const all = r.overall.find((t) => t.domain === 'all')!
    const sig = r.overall.find((t) => t.population === 'signal')!
    expect(all.n).toBe(1) // only the probabilistic row
    expect(sig.n).toBe(2)
    expect(all.metric).toMatch(/brier/i)
    expect(sig.metric).toMatch(/efficacy/i)
  })

  it('GATES the slope on a thin sample instead of reporting 0', () => {
    const r = calibrationTrend([proper(0.8, true, 0), proper(0.8, false, 1), proper(0.8, true, 2)])
    const all = r.overall.find((t) => t.domain === 'all')!
    expect(all.gated).toBe(true)
    expect(all.slope).toBeNull() // withheld, NOT zero
    expect(all.gatedReason).toMatch(/minN/)
  })

  it('reports a real improving slope once the sample supports it', () => {
    // Efficacy climbing 0 -> 1 across three well-populated weeks.
    const rows: TrendRow[] = []
    for (let i = 0; i < 10; i++) rows.push(signal(false, 0))
    for (let i = 0; i < 10; i++) rows.push(signal(i < 5, 1))
    for (let i = 0; i < 10; i++) rows.push(signal(true, 2))
    const sig = calibrationTrend(rows).overall.find((t) => t.population === 'signal')!
    expect(sig.gated).toBe(false)
    expect(sig.slope).toBeGreaterThan(0)
    expect(sig.improving).toBe(true)
  })

  it('for the proper population, improving means the Brier goes DOWN', () => {
    const rows: TrendRow[] = []
    // Week 0: confidently wrong. Week 2: confidently right.
    for (let i = 0; i < 8; i++) rows.push(proper(0.9, false, 0))
    for (let i = 0; i < 8; i++) rows.push(proper(0.9, i < 4, 1))
    for (let i = 0; i < 8; i++) rows.push(proper(0.9, true, 2))
    const all = calibrationTrend(rows).overall.find((t) => t.domain === 'all')!
    expect(all.slope).toBeLessThan(0)
    expect(all.improving).toBe(true)
  })

  it('splits per domain so one kind cannot hide inside another', () => {
    const rows = [
      proper(0.8, true, 0, 'anchor-risk'),
      proper(0.8, false, 1, 'anchor-risk'),
      proper(0.8, false, 0, 'cascade')
    ]
    const domains = calibrationTrend(rows).perDomain.map((d) => d.domain).sort()
    expect(domains).toEqual(['anchor-risk', 'cascade'])
  })

  it('flags a sign disagreement between the weighted and unweighted fits', () => {
    const r = calibrationTrend([proper(0.8, true, 0), proper(0.8, false, 1), proper(0.8, true, 2)])
    const all = r.overall.find((t) => t.domain === 'all')!
    expect(all).toHaveProperty('weightingDisagrees')
  })

  it('drops rows with no usable outcome rather than guessing', () => {
    const r = calibrationTrend([{ kind: 'anchor-risk', confidence: 0.8, verdict: 'unobserved', resolved: wk(0) }])
    expect(r.overall.find((t) => t.domain === 'all')!.n).toBe(0)
  })
})
