import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logForecastsToLedger } from './forecast-ledger'
import type { Forecast } from './forecast-generator'

const fc = (id: string, subjects: string[]): Forecast => ({
  id,
  kind: 'driver',
  subject: '资源到位',
  statement: 'common cause behind 2 streams',
  severity: 4,
  confidence: 0.7,
  basis: ['a', 'b'],
  subjects,
  eval_after: '2026-08-01'
})

describe('logForecastsToLedger', () => {
  let vault: string
  let ledger: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-fl-'))
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    ledger = join(vault, '.duin', '_state', 'risk-predictions.jsonl')
    writeFileSync(ledger, '')
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('appends pre-act rows in the resolver schema (verdict null, subjects, eval_after.by)', () => {
    const n = logForecastsToLedger(vault, [fc('fc:driver:x', ['s1', 's2'])], new Date('2026-07-01T00:00:00Z'))
    expect(n).toBe(1)
    const rows = readFileSync(ledger, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(rows[0]).toMatchObject({
      id: 'fc:driver:x',
      created: '2026-07-01',
      source: 'duin-graph-forecast',
      kind: 'driver',
      verdict: null,
      subjects: ['s1', 's2'],
      eval_after: { by: '2026-08-01' }
    })
  })

  it('is idempotent by id (re-logging appends nothing → safe on every surface)', () => {
    logForecastsToLedger(vault, [fc('fc:driver:x', ['s1'])])
    const n2 = logForecastsToLedger(vault, [fc('fc:driver:x', ['s1'])])
    expect(n2).toBe(0)
    expect(readFileSync(ledger, 'utf-8').trim().split('\n').length).toBe(1)
  })

  it('skips forecasts with no subjects (nothing the resolver can adjudicate)', () => {
    expect(logForecastsToLedger(vault, [fc('fc:driver:empty', [])])).toBe(0)
  })

  it('null vault → no-op', () => {
    expect(logForecastsToLedger(null, [fc('fc:driver:x', ['s1'])])).toBe(0)
  })
})
