import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runForecastLoop } from './forecast-loop'

// The close that matters: a forecast logged pre-act, once past its eval_after, MUST get
// resolved and scored into the track record without any UI interaction — otherwise the
// calibration ledger never fills and every confidence-weighted surface stays neutral.
describe('runForecastLoop (calibration close)', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-fcloop-'))
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('returns zeros for a null vault', () => {
    expect(runForecastLoop(null)).toEqual({ generated: 0, logged: 0, resolved: 0, patterns: 0, preResolved: 0, labelScored: 0 })
  })

  it('resolves an owed forecast and writes the track record — with no UI in the loop', () => {
    // Seed one owed, subjects-bearing forecast past its eval_after. No task files exist,
    // so its subject id is NOT open → it must resolve to 'averted' (a useful, observed row).
    const ledger = join(vault, '.duin', '_state', 'risk-predictions.jsonl')
    writeFileSync(
      ledger,
      JSON.stringify({
        id: 'fc:driver:test',
        kind: 'driver',
        predicted: 'test forecast',
        eval_after: { by: '2020-01-01' }, // long past
        verdict: null,
        subjects: ['nonexistent-subject'],
        confidence: 0.7
      }) + '\n',
      'utf-8'
    )

    const res = runForecastLoop(vault, new Date('2026-07-03T00:00:00Z'))

    expect(res.resolved).toBe(1) // the owed row got adjudicated
    // The ledger row now carries a verdict…
    const rows = readFileSync(ledger, 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(rows[0].verdict).toBe('averted')
    // …and the track record was written (the calibration surface β_conf reads).
    const track = join(vault, '.duin', '_state', 'forecast-track-record.json')
    expect(existsSync(track)).toBe(true)
    const parsed = JSON.parse(readFileSync(track, 'utf-8'))
    expect(parsed.patterns.driver).toBeTruthy()
    expect(parsed.patterns.driver.fired).toBe(1)
  })

  it('is idempotent — a second pass resolves nothing new', () => {
    const ledger = join(vault, '.duin', '_state', 'risk-predictions.jsonl')
    writeFileSync(
      ledger,
      JSON.stringify({
        id: 'fc:driver:test',
        kind: 'driver',
        eval_after: { by: '2020-01-01' },
        verdict: null,
        subjects: ['x'],
        confidence: 0.7
      }) + '\n',
      'utf-8'
    )
    runForecastLoop(vault, new Date('2026-07-03T00:00:00Z'))
    const second = runForecastLoop(vault, new Date('2026-07-03T00:00:00Z'))
    expect(second.resolved).toBe(0) // already resolved → no double count
  })
})
