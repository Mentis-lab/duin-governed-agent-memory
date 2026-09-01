import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { predictedRisks } from './predicted-risks-native'
import { clearOntologyCache } from './ontology'

describe('predictedRisks', () => {
  let vault: string
  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-pr-'))
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    // Cold-start A3 emptied the built-in tracks AND `decideNoun` (they named real projects and
    // carried per-project wording), so the vault declares both — which is the path predictedRisks
    // already reads (loadOntology(vaultDir)).
    writeFileSync(
      join(vault, '.duin', 'ontology.json'),
      JSON.stringify({ tracks: [{ key: 'alpha', match: 'alpha' }], decideNoun: { alpha: '决策窗口' } })
    )
    clearOntologyCache()
    // one open stream with decide_by 10d out → decision-window; one closed → ignored
    writeFileSync(
      join(vault, '.duin', '_state', 'future-nodes.jsonl'),
      [
        JSON.stringify({ id: 's-open', title: 'alpha 渠道决策', track: 'alpha', status: 'open', decide_by: '2026-06-11', target: '2026-07-01', objective: 'obj' }),
        JSON.stringify({ id: 's-far', title: 'later', status: 'open', decide_by: '2026-09-01' }),
        JSON.stringify({ id: 's-closed', title: 'closed', status: 'done', decide_by: '2026-06-11' })
      ].join('\n')
    )
  })
  afterAll(() => {
    clearOntologyCache()
    rmSync(vault, { recursive: true, force: true })
  })

  it('surfaces a decision-window for an open stream inside the 21d horizon', () => {
    const { risks } = predictedRisks(vault, new Date('2026-06-01T00:00:00Z'))
    const dw = risks.find((r) => r.id === 'decide::s-open')
    expect(dw).toBeTruthy()
    expect(dw!.kind).toBe('decision-window')
    expect(dw!.mode).toBe('signal') // demoted: a reminder, not a forecast
    expect(dw!.track).toBe('alpha')
    expect(dw!.title).toContain('决策窗口') // the vault's decideNoun for this track
    expect(dw!.confidence).toBe(0.65) // 10d out (>7) → 0.65
    expect(dw!.key).toMatch(/^[0-9a-f]{12}$/) // md5[:12]
    expect(dw!.summary).toBe(null) // no synth cache
  })

  it('ignores closed streams + streams beyond the 21d horizon', () => {
    const { risks } = predictedRisks(vault, new Date('2026-06-01T00:00:00Z'))
    expect(risks.some((r) => r.id === 'decide::s-closed')).toBe(false)
    expect(risks.some((r) => r.id === 'decide::s-far')).toBe(false)
  })

  it('null vault → empty risks', () => {
    expect(predictedRisks(null).risks).toEqual([])
  })
})

describe('predictedRisks — P4b bounded calibration of decision-window confidence', () => {
  let vault: string
  const at = new Date('2026-06-01T00:00:00Z')
  const seedStream = (v: string): void => {
    mkdirSync(join(v, '.duin', '_state'), { recursive: true })
    writeFileSync(
      join(v, '.duin', '_state', 'future-nodes.jsonl'),
      JSON.stringify({ id: 's1', title: 'decision', status: 'open', decide_by: '2026-06-11', target: 't', objective: 'o' })
    )
  }
  const seedTrackRecord = (v: string, efficacy_rate: number, observed: number): void => {
    // observed = materialized + averted + refuted; keep it ≥ min_n(20) so the rate is NOT gated.
    writeFileSync(
      join(v, '.duin', '_state', 'forecast-track-record.json'),
      JSON.stringify({ patterns: { 'decision-window': { mode: 'signal', efficacy_rate, averted: observed, materialized: 0, refuted: 0 } } })
    )
  }
  const conf = (v: string): number => predictedRisks(v, at).risks.find((r) => r.id === 'decide::s1')!.confidence!

  it('keeps the PRIOR when the rate is gated (below min_n)', () => {
    const v = mkdtempSync(join(tmpdir(), 'duin-cal-gated-'))
    seedStream(v)
    seedTrackRecord(v, 0.9, 5) // observed 5 < 20 → gated
    expect(conf(v)).toBe(0.65) // unchanged prior (10d out)
    rmSync(v, { recursive: true, force: true })
  })

  it('nudges confidence UP toward a healthy honest rate, but stays BOUNDED', () => {
    const v = mkdtempSync(join(tmpdir(), 'duin-cal-hi-'))
    seedStream(v)
    seedTrackRecord(v, 0.9, 40)
    const c = conf(v)
    expect(c).toBeGreaterThan(0.65)
    expect(c).toBeLessThanOrEqual(0.65 + 0.15) // capped shift
    rmSync(v, { recursive: true, force: true })
  })

  it('a LOW honest rate down-weights but never hard-suppresses the nudge', () => {
    const v = mkdtempSync(join(tmpdir(), 'duin-cal-lo-'))
    seedStream(v)
    seedTrackRecord(v, 0.0, 40)
    const c = conf(v)
    expect(c).toBeCloseTo(0.5) // 0.65 − cap(0.15)
    expect(c).toBeGreaterThan(0.05) // floored — informs, does not silence
    rmSync(v, { recursive: true, force: true })
  })
})
