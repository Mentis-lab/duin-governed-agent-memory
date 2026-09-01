import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { forecastRecord } from './forecast-record-native'

describe('forecast-record-native (unification: /state/forecast-record)', () => {
  let dir: string
  const stateDir = (): string => join(dir, '.duin', '_state')
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-fr-'))
    mkdirSync(stateDir(), { recursive: true })
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('returns the file contents verbatim when present', () => {
    const rec = { patterns: { 'deadline-collision': { hit_rate: 0.72, n: 18 } }, resolved_this_run: 3 }
    writeFileSync(join(stateDir(), 'forecast-track-record.json'), JSON.stringify(rec), 'utf-8')
    expect(forecastRecord(dir)).toEqual(rec)
  })

  it('returns the empty fallback when the file is absent', () => {
    expect(forecastRecord(dir)).toEqual({ patterns: {}, resolved_this_run: 0 })
  })

  it('returns the fallback on corrupt JSON (never throws)', () => {
    writeFileSync(join(stateDir(), 'forecast-track-record.json'), '{ not json', 'utf-8')
    expect(forecastRecord(dir)).toEqual({ patterns: {}, resolved_this_run: 0 })
  })

  it('returns a fresh fallback object (no shared mutable state)', () => {
    const a = forecastRecord(null)
    a.patterns['x'] = 1
    expect(forecastRecord(null).patterns).toEqual({})
  })
})
