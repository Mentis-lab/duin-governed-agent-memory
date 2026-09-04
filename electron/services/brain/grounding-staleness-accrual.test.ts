// grounding-staleness-accrual.test.ts — the accrual must ACCRUE, and must never manufacture trust.
//
// The gate it feeds is fail-safe by design: an unproven staleness signal must never bury a valid
// operator preference. So the tests that matter are the ones proving the accrual cannot cheat that —
// a judge with no model, a throwing judge, and a disabled flag all have to leave the calibration
// ledger untouched.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runStalenessAccrual, stalenessAccrualEnabled, type StalenessAccrualDeps } from './grounding-staleness-accrual'
import type { Topic } from './learning-metabolism'

const ledger = (v: string): string => join(v, '.duin', '_state', 'grounding-staleness.jsonl')

// matchStale flags a fact when it mentions a resolved topic; the deps hand it one real-looking topic.
// A REAL Topic: matchStale matches on `tokens`, not on the label string. The first draft of this
// fixture omitted tokens and every pass died on `topic.tokens is not iterable` — caught only
// because the accrual reports its failures instead of swallowing them silently.
const TOPICS: Topic[] = [{ id: 'd1', label: 'neighborhood clean-up', tokens: new Set(['neighborhood', 'clean', 'cleanup']) }]

function deps(over: Partial<StalenessAccrualDeps> = {}): StalenessAccrualDeps {
  return {
    activeFacts: () => [
      { id: 'f1', text: 'Most of my attention is on the neighborhood clean-up plans.' },
      { id: 'f2', text: 'I prefer concise answers.' }
    ],
    topics: () => TOPICS,
    judge: { judgeStale: async () => 'stale' } as never,
    now: () => 1_700_000_000_000,
    ...over
  }
}

let vault: string
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'stale-accrual-'))
  delete process.env.DUIN_STALENESS_ACCRUAL
})
afterEach(() => {
  rmSync(vault, { recursive: true, force: true })
  delete process.env.DUIN_STALENESS_ACCRUAL
  vi.restoreAllMocks()
})

describe('runStalenessAccrual', () => {
  it('writes calibration rows when the judge labels a flagged fact — this is the gap it exists to close', async () => {
    const r = await runStalenessAccrual(vault, deps())
    expect(r.ran).toBe(true)
    expect(r.recorded).toBeGreaterThan(0)
    expect(existsSync(ledger(vault))).toBe(true)
    const rows = readFileSync(ledger(vault), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(rows.every((x) => x.kind === 'grounding-staleness')).toBe(true)
    expect(rows.some((x) => x.verdict === 'materialized')).toBe(true)
  })

  it('a judge that abstains everywhere (no model) records NOTHING — it cannot fabricate precision', async () => {
    const r = await runStalenessAccrual(vault, deps({ judge: { judgeStale: async () => null } as never }))
    expect(r.recorded).toBe(0)
    expect(existsSync(ledger(vault))).toBe(false)
  })

  it('a judge that throws is fail-open: the pass still returns and records nothing for that fact', async () => {
    const r = await runStalenessAccrual(vault, deps({
      judge: { judgeStale: async () => { throw new Error('model down') } } as never
    }))
    expect(r.ran).toBe(true)
    expect(r.recorded).toBe(0)
  })

  it('a judge label of "valid" records a REFUTED outcome — a false flag must lower measured precision', async () => {
    await runStalenessAccrual(vault, deps({ judge: { judgeStale: async () => 'valid' } as never }))
    const rows = readFileSync(ledger(vault), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(rows.some((x) => x.verdict === 'refuted')).toBe(true)
    expect(rows.some((x) => x.verdict === 'materialized')).toBe(false)
  })

  it('is a no-op with no vault, and with no active facts', async () => {
    expect((await runStalenessAccrual(null, deps())).reason).toBe('no-vault')
    expect((await runStalenessAccrual(vault, deps({ activeFacts: () => [] }))).reason).toBe('no-facts')
    expect(existsSync(ledger(vault))).toBe(false)
  })

  it('honours the kill switch', async () => {
    process.env.DUIN_STALENESS_ACCRUAL = '0'
    expect(stalenessAccrualEnabled()).toBe(false)
    const r = await runStalenessAccrual(vault, deps())
    expect(r.ran).toBe(false)
    expect(r.reason).toBe('disabled')
    expect(existsSync(ledger(vault))).toBe(false)
  })

  it('is batch-capped so a recurring pass stays bounded', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, text: 'the neighborhood clean-up again' }))
    const seen: string[] = []
    const r = await runStalenessAccrual(vault, deps({
      activeFacts: () => many,
      judge: { judgeStale: async (t: string) => { seen.push(t); return 'stale' } } as never
    }), 7)
    expect(r.scored).toBe(7)
    expect(seen.length).toBe(7)
  })

  it('never throws — a broken topics source degrades to a recorded error, not a crash', async () => {
    const r = await runStalenessAccrual(vault, deps({
      topics: () => { throw new Error('vault unreadable') }
    }))
    expect(r.ran).toBe(false)
    expect(r.reason).toBe('error')
  })
})
