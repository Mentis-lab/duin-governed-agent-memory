// End-to-end proof that the forecast loop CLOSES: generate → log → resolve → score.
// This is the composition the /state/forecasts/refresh handler now runs. The individual
// links are unit-tested (forecast-generator / forecast-ledger / calibration-store);
// this locks that they compose — a fired forecast actually moves a calibration
// tier's `observed` off zero (the "empty loop" the strategy doc flagged: every tier
// read fired:0/observed:0 because the resolve step was built but never wired).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateForecasts } from './forecast-generator'
import { logForecastsToLedger } from './forecast-ledger'
import { runCalibration } from './calibration-store'

describe('forecast loop e2e — generate → log → resolve → score', () => {
  let vault: string
  let sd: string
  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-loop-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
    // A common cause behind two streams → a `driver` forecast whose subjects are the
    // two stream ids. Both open at generation (a driver needs ≥2 streams); the test
    // then closes one before resolution so the streams DIVERGE → the coupling forecast
    // resolves 'refuted' (a falsifiable outcome). See the resolve step below.
    writeFileSync(
      join(sd, 'causal-drivers.json'),
      JSON.stringify({ drivers: [{ driver: '资源到位', explains: ['s1', 's2'] }] })
    )
    writeFileSync(
      join(sd, 'future-nodes.jsonl'),
      [
        JSON.stringify({ id: 's1', title: 'stream one', track: '北澜', anchor_id: 'future-evt', status: 'open' }),
        JSON.stringify({ id: 's2', title: 'stream two', track: '北澜', anchor_id: 'future-evt', status: 'open' })
      ].join('\n')
    )
    mkdirSync(join(vault, '北澜'), { recursive: true })
    writeFileSync(
      join(vault, '北澜', '(C) anchor-future.md'),
      '---\ntype: anchor\nanchor-id: future-evt\nname: Future Event\ntrack: 北澜\ndate: 2099-01-01\nbinds-keywords: stream\n---\n'
    )
  })
  afterAll(() => rmSync(vault, { recursive: true, force: true }))

  it('a generated forecast, once logged, resolves and moves a tier off zero', () => {
    // 1) generate + 2) log (what POST /state/forecasts/refresh does).
    const fc = generateForecasts(vault, new Date('2026-07-01T00:00:00Z'))
    expect(fc.length).toBeGreaterThan(0)
    logForecastsToLedger(vault, fc)
    expect(existsSync(join(sd, 'risk-predictions.jsonl'))).toBe(true)

    // Time passes: stream two resolves (closes) while stream one stays open. The two
    // streams the driver claimed "move together" DIVERGED → the coupling is falsifiable
    // and resolves 'refuted'. (Under the old openness rule any still-open subject made
    // this a trivial hit; the honest loop now scores a real observation either way.)
    writeFileSync(
      join(sd, 'future-nodes.jsonl'),
      [
        JSON.stringify({ id: 's1', title: 'stream one', track: '北澜', anchor_id: 'future-evt', status: 'open' }),
        JSON.stringify({ id: 's2', title: 'stream two', track: '北澜', anchor_id: 'future-evt', status: 'done' })
      ].join('\n')
    )

    // 3) resolve+score far enough in the future that every eval window has passed.
    const out = runCalibration(vault, new Date('2099-12-31T00:00:00Z'))
    expect(out.resolved).toBeGreaterThan(0) // at least one forecast scored

    // 4) the scoreboard is no longer all-zeros — some tier's observed climbed.
    const track = JSON.parse(readFileSync(join(sd, 'forecast-track-record.json'), 'utf-8'))
    const tiers = track.confidence_calibration as Record<string, { observed?: number }>
    const totalObserved = Object.values(tiers).reduce((n, t) => n + (t.observed ?? 0), 0)
    expect(totalObserved).toBeGreaterThan(0)
  })

  it('re-running the loop is idempotent — no double-scoring', () => {
    const before = JSON.parse(readFileSync(join(sd, 'forecast-track-record.json'), 'utf-8'))
    const beforeObs = Object.values(
      before.confidence_calibration as Record<string, { observed?: number }>
    ).reduce((n, t) => n + (t.observed ?? 0), 0)
    // second resolve pass over already-resolved rows must not re-score them
    const out = runCalibration(vault, new Date('2099-12-31T00:00:00Z'))
    expect(out.resolved).toBe(0)
    const after = JSON.parse(readFileSync(join(sd, 'forecast-track-record.json'), 'utf-8'))
    const afterObs = Object.values(
      after.confidence_calibration as Record<string, { observed?: number }>
    ).reduce((n, t) => n + (t.observed ?? 0), 0)
    expect(afterObs).toBe(beforeObs)
  })
})
