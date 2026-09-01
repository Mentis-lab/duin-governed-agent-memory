import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateForecasts } from './forecast-generator'

describe('generateForecasts (graph-derived, gated)', () => {
  let vault: string
  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-fc-'))
    const sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
    // driver behind 2 streams → correlated forecast
    writeFileSync(join(sd, 'causal-drivers.json'), JSON.stringify({ drivers: [{ driver: '资源到位', explains: ['s1', 's2'] }] }))
    writeFileSync(
      join(sd, 'future-nodes.jsonl'),
      [
        JSON.stringify({ id: 's1', title: 'stream one', track: '北澜', anchor_id: 'future-evt' }),
        JSON.stringify({ id: 's2', title: 'stream two', track: '北澜', anchor_id: 'future-evt' })
      ].join('\n')
    )
    mkdirSync(join(vault, '北澜'), { recursive: true })
    // a FUTURE anchor (kept) + a PAST anchor (must be dropped)
    writeFileSync(join(vault, '北澜', '(C) anchor-future.md'), '---\ntype: anchor\nanchor-id: future-evt\nname: Future Event\ntrack: 北澜\ndate: 2099-01-01\nbinds-keywords: stream\n---\n')
    writeFileSync(join(vault, '北澜', '(C) anchor-past.md'), '---\ntype: anchor\nanchor-id: past-evt\nname: Past Event\ntrack: 北澜\ndate: 2000-01-01\nbinds-keywords: overdue\n---\n')
    // an overdue task bound to the PAST anchor — its cascade must NOT surface
    writeFileSync(join(vault, '北澜', 'Tasks.md'), '- [ ] overdue thing {{priority:: 1}} {{dateDue:: 2000-01-01}}\n')
  })
  afterAll(() => rmSync(vault, { recursive: true, force: true }))

  it('emits a driver (correlated) forecast for a common cause behind ≥2 streams', () => {
    const fc = generateForecasts(vault, new Date('2026-07-01T00:00:00Z'))
    const d = fc.find((f) => f.kind === 'driver')
    expect(d).toBeTruthy()
    expect(d!.subject).toBe('资源到位')
    expect(d!.basis.length).toBe(2)
    expect(d!.statement).toContain('common cause')
  })

  it('drops forecasts pointing at PAST anchors (the stale-anchor gate)', () => {
    const fc = generateForecasts(vault, new Date('2026-07-01T00:00:00Z'))
    expect(fc.some((f) => f.subject === 'Past Event')).toBe(false)
    // and no cascade for the overdue task bound only to the past anchor
    expect(fc.some((f) => f.kind === 'cascade' && f.subject === 'Past Event')).toBe(false)
  })

  it('sorts by severity (most urgent first) + null vault → empty', () => {
    const fc = generateForecasts(vault, new Date('2026-07-01T00:00:00Z'))
    for (let i = 1; i < fc.length; i++) expect(fc[i - 1].severity).toBeGreaterThanOrEqual(fc[i].severity)
    expect(generateForecasts(null)).toEqual([])
  })
})

describe('generateForecasts — calibration feedback (adjust over time)', () => {
  let vault: string
  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-fccal-'))
    const sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
    writeFileSync(join(sd, 'causal-drivers.json'), JSON.stringify({ drivers: [{ driver: '资源', explains: ['s1', 's2'] }] }))
    writeFileSync(
      join(sd, 'future-nodes.jsonl'),
      [JSON.stringify({ id: 's1', title: 'a', track: '北澜' }), JSON.stringify({ id: 's2', title: 'b', track: '北澜' })].join('\n')
    )
    // track record: driver is a COUPLING kind → it never materializes; its empirical success
    // rate is useful_rate = averted/(averted+refuted) (co-moved-to-resolution vs diverged).
    // PROVEN (observed 25 ≥ min_n) with useful_rate 0.6 (averted 15 / observed 25) → the
    // override calibrates confidence DOWN to 0.6.
    writeFileSync(
      join(sd, 'forecast-track-record.json'),
      JSON.stringify({
        patterns: { driver: { mode: 'forecast', materialized: 0, averted: 15, refuted: 10, unobserved: 0, useful_rate: 0.6 } }
      })
    )
    // Item 16: a SKILLED resolved ledger so proper-score skillScore > 0 and the calibration
    // override is TRUSTED to fire. Structural coupling (convergence) never `materialize`s — it
    // resolves `averted` (the coupling HELD → outcome 1) or `refuted` (it BROKE → outcome 0). A
    // well-calibrated ledger: high-confidence predictions held, low-confidence ones broke.
    const skilled = [
      ...Array.from({ length: 10 }, () => ({ kind: 'convergence', confidence: 0.9, verdict: 'averted' })),
      ...Array.from({ length: 10 }, () => ({ kind: 'convergence', confidence: 0.1, verdict: 'refuted' }))
    ]
    writeFileSync(join(sd, 'risk-predictions.jsonl'), skilled.map((r) => JSON.stringify(r)).join('\n') + '\n')
  })
  afterAll(() => rmSync(vault, { recursive: true, force: true }))

  it('calibrates confidence to the proven rate for a non-gated kind (keeps the prior as baseConfidence)', () => {
    const fc = generateForecasts(vault, new Date('2026-07-01T00:00:00Z'))
    const d = fc.find((f) => f.kind === 'driver')!
    expect(d.baseConfidence).toBe(0.7) // the prior
    expect(d.confidence).toBe(0.6) // calibrated DOWN to the proven useful_rate (coupling success rate)
    expect(d.calibration).toMatchObject({ rate: 0.6, observed: 25, gated: false })
  })

  it('leaves confidence at the prior for a gated kind (insufficient data)', () => {
    // cascade/convergence have NO track record here → gated → prior kept
    const fc = generateForecasts(vault, new Date('2026-07-01T00:00:00Z'))
    for (const f of fc.filter((x) => x.kind !== 'driver')) {
      expect(f.confidence).toBe(f.baseConfidence)
      expect(f.calibration?.gated).toBe(true)
    }
  })

  it('does NOT calibrate when the ledger is unskilled/absent (skill-gated, item 16)', () => {
    const v2 = mkdtempSync(join(tmpdir(), 'duin-fcunskilled-'))
    const sd2 = join(v2, '.duin', '_state')
    mkdirSync(sd2, { recursive: true })
    writeFileSync(join(sd2, 'causal-drivers.json'), JSON.stringify({ drivers: [{ driver: '资源', explains: ['s1', 's2'] }] }))
    writeFileSync(
      join(sd2, 'future-nodes.jsonl'),
      [JSON.stringify({ id: 's1', title: 'a', track: '北澜' }), JSON.stringify({ id: 's2', title: 'b', track: '北澜' })].join('\n')
    )
    writeFileSync(
      join(sd2, 'forecast-track-record.json'),
      JSON.stringify({ patterns: { driver: { mode: 'forecast', materialized: 0, averted: 15, refuted: 10, unobserved: 0, useful_rate: 0.6 } } })
    )
    // No risk-predictions.jsonl → skillScore null → the override must NOT fire (prior kept).
    const d = generateForecasts(v2, new Date('2026-07-01T00:00:00Z')).find((f) => f.kind === 'driver')!
    expect(d.confidence).toBe(d.baseConfidence) // 0.7, NOT the 0.6 empirical rate
    expect(d.calibration?.skill).toBeNull()
    rmSync(v2, { recursive: true, force: true })
  })
})

// Locks the CONVERGENCE contract: a future anchor carrying ≥3 dependent feeder streams
// (in_degree≥3) must surface a `convergence` forecast. This proves empty live convergence
// output is data-driven (no anchor happens to carry ≥3 feeders), not a broken branch.
describe('generateForecasts — convergence (future anchor, ≥3 feeders)', () => {
  let vault: string
  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-fcconv-'))
    const sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
    writeFileSync(join(sd, 'causal-drivers.json'), JSON.stringify({ drivers: [] }))
    // THREE streams all explicitly feeding one future anchor → in_degree 3
    writeFileSync(
      join(sd, 'future-nodes.jsonl'),
      [
        JSON.stringify({ id: 's1', title: 'stream one', track: '北澜', anchor_id: 'conv-evt' }),
        JSON.stringify({ id: 's2', title: 'stream two', track: '北澜', anchor_id: 'conv-evt' }),
        JSON.stringify({ id: 's3', title: 'stream three', track: '北澜', anchor_id: 'conv-evt' })
      ].join('\n')
    )
    mkdirSync(join(vault, '北澜'), { recursive: true })
    // a FUTURE anchor the three streams converge on
    writeFileSync(
      join(vault, '北澜', '(C) anchor-conv.md'),
      '---\ntype: anchor\nanchor-id: conv-evt\nname: Convergence Event\ntrack: 北澜\ndate: 2099-06-01\nbinds-keywords: stream\n---\n'
    )
  })
  afterAll(() => rmSync(vault, { recursive: true, force: true }))

  it('emits ≥1 convergence forecast for a future anchor carrying ≥3 feeder streams', () => {
    const fc = generateForecasts(vault, new Date('2026-07-01T00:00:00Z'))
    const conv = fc.filter((f) => f.kind === 'convergence')
    expect(conv.length).toBeGreaterThanOrEqual(1)
    expect(conv[0].subject).toBe('Convergence Event')
    expect(conv[0].basis.length).toBeGreaterThanOrEqual(3)
  })
})
