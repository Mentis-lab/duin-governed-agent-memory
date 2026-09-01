import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { calibrationTick } from './calibration-tick'

describe('calibrationTick (the background resolver pass)', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-caltick-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('is best-effort: a throwing vault getter never propagates', () => {
    expect(() =>
      calibrationTick(() => {
        throw new Error('settings read blew up')
      })
    ).not.toThrow()
  })

  it('no-ops on a null/empty vault (nothing to resolve)', () => {
    expect(() => calibrationTick(() => null)).not.toThrow()
    expect(() => calibrationTick(() => '')).not.toThrow()
  })

  it('resolves a due forecast without needing a panel view (clock-driven)', () => {
    // A fired forecast whose eval window is far in the past → resolves on any real
    // "now" the tick runs at (runCalibration uses new Date() internally).
    writeFileSync(
      join(sd, 'risk-predictions.jsonl'),
      JSON.stringify({
        id: 'f1',
        kind: 'driver',
        verdict: null,
        subjects: ['x'],
        confidence: 0.85,
        eval_after: { by: '2020-01-01' }
      }) + '\n'
    )
    calibrationTick(() => vault)
    expect(existsSync(join(sd, 'forecast-track-record.json'))).toBe(true)
    const track = JSON.parse(readFileSync(join(sd, 'forecast-track-record.json'), 'utf-8'))
    const observed = Object.values(
      track.confidence_calibration as Record<string, { observed?: number }>
    ).reduce((n, t) => n + (t.observed ?? 0), 0)
    expect(observed).toBeGreaterThan(0) // the tier moved off zero — the loop advanced
  })
})
