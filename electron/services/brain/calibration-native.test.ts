import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { calibration } from './calibration-native'

describe('calibration-native (unification: /state/calibration)', () => {
  let dir: string
  const stateDir = (): string => join(dir, '.duin', '_state')
  const write = (name: string, rows: unknown[]): void =>
    writeFileSync(join(stateDir(), name), rows.map((r) => JSON.stringify(r)).join('\n'), 'utf-8')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-cal-'))
    mkdirSync(stateDir(), { recursive: true })
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('empty vault → zeroed totals, empty domains, passthrough defaults', () => {
    const r = calibration(dir)
    expect(r.min_n).toBe(20)
    expect(r.domains).toEqual({})
    expect(r.totals).toEqual({ predictions: 0, resolved: 0, open: 0, false_alarms: 0, by_domain: {} })
    expect(r.recently_resolved).toEqual([])
    expect(r.generated).toBe('')
    expect(r.patterns).toEqual({})
  })

  it('null vaultDir never throws', () => {
    expect(() => calibration(null)).not.toThrow()
    expect(calibration(null).totals.predictions).toBe(0)
  })

  it('risk-domain aggregation: useful_rate + smoothed + wilson + gating', () => {
    // 3 resolved forecasts: 2 hit (useful), 1 miss (wrong) → observed=3, useful_rate=2/3
    write('risk-predictions.jsonl', [
      { id: 'r1', kind: 'deadline', verdict: 'materialized', outcome: 'hit', resolved: '2026-06-10' },
      { id: 'r2', kind: 'deadline', verdict: 'materialized', outcome: 'hit', resolved: '2026-06-11' },
      { id: 'r3', kind: 'deadline', verdict: 'refuted', outcome: 'miss', resolved: '2026-06-12' },
      { id: 'r4', kind: 'deadline', verdict: null, outcome: null, resolved: '' }, // open → not counted
    ])
    const d = calibration(dir).domains['risk']
    expect(d.total).toBe(4)
    expect(d.resolved).toBe(3)
    expect(d.useful).toBe(2)
    expect(d.wrong).toBe(1)
    expect(d.observed).toBe(3)
    expect(d.useful_rate).toBe(0.667)
    expect(d.smoothed_rate).toBe(0.6) // (2+1)/(3+2)
    expect(d.gated).toBe(true) // 3 < min_n 20
    expect(d.wilson_lo).toBeLessThan(d.useful_rate as number)
    expect(d.wilson_hi).toBeGreaterThan(d.useful_rate as number)
  })

  it('decision-window kind routes to signal mode / its own domain, scored by efficacy', () => {
    write('risk-predictions.jsonl', [
      { id: 'w1', kind: 'decision-window', verdict: 'x', outcome: 'on-time', resolved: '2026-06-10' },
      { id: 'w2', kind: 'decision-window', verdict: 'x', outcome: 'slipped', resolved: '2026-06-11' },
    ])
    const d = calibration(dir).domains['decision-window']
    expect(d.signal).toBe(2)
    expect(d.useful).toBe(1) // on-time
    expect(d.wrong).toBe(1) // slipped
    expect(calibration(dir).domains['risk']).toBeUndefined()
  })

  it('false-alarm feedback re-scores a hit to wrong', () => {
    write('risk-predictions.jsonl', [
      { id: 'r1', kind: 'deadline', verdict: 'materialized', outcome: 'hit', resolved: '2026-06-10' },
    ])
    write('prediction-feedback.jsonl', [{ id: 'r1', mark: 'false_alarm', ts: '2026-06-13' }])
    const d = calibration(dir).domains['risk']
    expect(d.useful).toBe(0)
    expect(d.wrong).toBe(1)
    expect(d.false_alarms).toBe(1)
    expect(calibration(dir).totals.false_alarms).toBe(1)
  })

  it('false-alarm feedback on a signal-mode (decision-window) row scores as wrong, not dropped', () => {
    // Same override as the risk-domain test above ('hit'/'useful'/'on-time' -> 'wrong' when
    // false-alarmed), but on a signal-mode row whose native outcome vocabulary is 'on-time'/
    // 'slipped' rather than 'hit'/'miss'. The aggregator must still land the override on
    // d.wrong, not silently drop the row out of d.observed.
    write('risk-predictions.jsonl', [
      { id: 'w1', kind: 'decision-window', verdict: 'x', outcome: 'on-time', resolved: '2026-06-10' },
    ])
    write('prediction-feedback.jsonl', [{ id: 'w1', mark: 'false_alarm', ts: '2026-06-13' }])
    const d = calibration(dir).domains['decision-window']
    expect(d.resolved).toBe(1)
    expect(d.false_alarms).toBe(1)
    expect(d.useful).toBe(0)
    expect(d.wrong).toBe(1)
    expect(d.observed).toBe(1) // must stay 1, not shrink to 0 — the row still happened
  })

  it('recently_resolved is newest-first (reverse ts) and capped at 25', () => {
    write(
      'risk-predictions.jsonl',
      Array.from({ length: 30 }, (_, i) => ({
        id: `r${i}`,
        kind: 'deadline',
        verdict: 'materialized',
        outcome: 'hit',
        resolved: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
      }))
    )
    const nudge = calibration(dir).recently_resolved as { id: string; resolved: string }[]
    expect(nudge).toHaveLength(25)
    // descending by resolved date
    for (let i = 1; i < nudge.length; i++) expect(nudge[i - 1].resolved >= nudge[i].resolved).toBe(true)
  })

  it('stream step verdicts route to plan-adherence, decisions to stream', () => {
    write('stream-verdicts.jsonl', [
      { id: 's1', kind: 'step', outcome: 'hit', what: 'step: draft', ts: '2026-06-10' },
      { id: 's2', kind: 'decision', outcome: 'miss', what: 'decide: go', ts: '2026-06-11' },
    ])
    const r = calibration(dir)
    expect(r.domains['plan-adherence'].useful).toBe(1)
    expect(r.domains['stream'].wrong).toBe(1)
  })
})
