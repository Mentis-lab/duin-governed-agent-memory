import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logForecast, setForecastVerdict } from './forecast-write-native'

const rows = (sd: string): Record<string, unknown>[] =>
  readFileSync(join(sd, 'risk-predictions.jsonl'), 'utf-8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)

describe('forecast-write-native', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-fw-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
    writeFileSync(
      join(sd, 'risk-predictions.jsonl'),
      JSON.stringify({
        id: 'forecast::test-a',
        created: '2026-06-01',
        source: 'operator-forecast',
        kind: 'forecast',
        trigger_signature: { type: 'forecast', value: '' },
        predicted: 'A happens',
        subjects: [],
        sources: [],
        track: 'orbis',
        confidence: 0.8,
        eval_after: { by: '2026-06-15' },
        verdict: null
      }) + '\n'
    )
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  describe('logForecast', () => {
    it('appends a forecast row with a stable slug id + mirrors the schema', () => {
      const r = logForecast(vault, { predicted: 'New Forecast Y!', confidence: 0.7, evalBy: '2026-09-01', track: 't' })
      expect(r).toMatchObject({ ok: true, id: 'forecast::new-forecast-y', eval_by: '2026-09-01', confidence: 0.7 })
      const added = rows(sd).find((x) => x.id === 'forecast::new-forecast-y')!
      expect(added).toMatchObject({ kind: 'forecast', source: 'operator-forecast', subjects: [], verdict: null, eval_after: { by: '2026-09-01' } })
    })
    it('is idempotent per id (dup → ok:false, no second row)', () => {
      logForecast(vault, { predicted: 'dup me', confidence: 0.5, evalBy: '2026-09-01' })
      const again = logForecast(vault, { predicted: 'dup me', confidence: 0.5, evalBy: '2026-09-01' })
      expect(again.ok).toBe(false)
      expect(rows(sd).filter((x) => x.id === 'forecast::dup-me')).toHaveLength(1)
    })
    it('rejects bad confidence / eval_by / empty text', () => {
      expect(logForecast(vault, { predicted: '', confidence: 0.5, evalBy: '2026-09-01' }).ok).toBe(false)
      expect(logForecast(vault, { predicted: 'x', confidence: 2, evalBy: '2026-09-01' }).ok).toBe(false)
      expect(logForecast(vault, { predicted: 'x', confidence: 'nope', evalBy: '2026-09-01' }).ok).toBe(false)
      expect(logForecast(vault, { predicted: 'x', confidence: 0.5, evalBy: 'not-a-date' }).ok).toBe(false)
    })
  })

  describe('setForecastVerdict', () => {
    it('adjudicates a matured forecast (hit→materialized) + resolve writes the track-record', () => {
      const r = setForecastVerdict(vault, 'forecast::test-a', 'hit', new Date('2026-07-01T00:00:00Z'))
      expect(r).toMatchObject({ ok: true, id: 'forecast::test-a', resolution: 'hit', matched: 1, changed: 1 })
      expect(r.resolved_this_run).toBeGreaterThanOrEqual(1)
      expect(existsSync(join(sd, 'forecast-track-record.json'))).toBe(true)
      const row = rows(sd).find((x) => x.id === 'forecast::test-a')!
      expect(row.resolution).toBe('hit')
    })
    it('is idempotent — same resolution again changes nothing', () => {
      setForecastVerdict(vault, 'forecast::test-a', 'hit', new Date('2026-07-01T00:00:00Z'))
      const again = setForecastVerdict(vault, 'forecast::test-a', 'hit', new Date('2026-07-01T00:00:00Z'))
      expect(again.changed).toBe(0)
    })
    it('rejects a bad resolution / missing id / missing ledger', () => {
      expect(setForecastVerdict(vault, 'forecast::test-a', 'maybe').ok).toBe(false)
      expect(setForecastVerdict(vault, '', 'hit').ok).toBe(false)
      expect(setForecastVerdict(null, 'x', 'hit').ok).toBe(false)
      expect(setForecastVerdict(vault, 'forecast::nope', 'hit').ok).toBe(false)
    })
  })
})
