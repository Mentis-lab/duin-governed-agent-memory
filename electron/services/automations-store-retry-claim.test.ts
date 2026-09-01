import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Database } from 'better-sqlite3'
import { AUTOMATION_RUN_SCHEMA_SQL } from './automation-run-schema'

// The store half of the "a lost retry claim silences the automation forever" fix.
//
// The claim INSERT and the retry disarm used to be two un-transacted statements in the
// runner. Crash between them, boot recovery flips the claimed row to 'interrupted', and
// retry_at is left armed at a timestamp permanently in the past — after which every tick
// takes the retry branch, loses the claim to its own orphaned row, and returns before the
// cron match is ever evaluated.
//
// These tests run the production SQL against real SQLite (node:sqlite — the Electron
// better-sqlite3 ABI will not load under vitest) and prove the two statements now commit
// or roll back together.

type RawDb = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...a: unknown[]): { changes: number }
    get(...a: unknown[]): unknown
    all(...a: unknown[]): unknown[]
  }
}

let DatabaseSync: (new (path: string) => RawDb) | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  DatabaseSync = (require('node:sqlite') as { DatabaseSync: new (path: string) => RawDb })
    .DatabaseSync
} catch {
  DatabaseSync = null
}

let raw: RawDb

function shim(db: RawDb): Database {
  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => db.prepare(sql),
    transaction: (fn: (...a: unknown[]) => unknown) =>
      ((...a: unknown[]) => {
        db.exec('BEGIN')
        try {
          const out = fn(...a)
          db.exec('COMMIT')
          return out
        } catch (err) {
          db.exec('ROLLBACK')
          throw err
        }
      }) as unknown
  } as unknown as Database
}

vi.mock('./database', () => ({ getDb: () => shim(raw) }))

const { beginAutomationRun } = await import('./automations-store')

const AUTOMATIONS = `
  CREATE TABLE automations (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    cron TEXT NOT NULL,
    prompt TEXT NOT NULL,
    model TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    retry_attempt INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER
  );
`

function retryState(): { retry_at: number | null; retry_attempt: number } {
  return raw
    .prepare('SELECT retry_at, retry_attempt FROM automations WHERE id = ?')
    .get('a1') as { retry_at: number | null; retry_attempt: number }
}

function ledgerRows(): number {
  return (raw.prepare('SELECT COUNT(*) AS n FROM automation_runs').get() as { n: number }).n
}

beforeEach(() => {
  if (!DatabaseSync) return
  raw = new DatabaseSync(':memory:')
  raw.exec('PRAGMA foreign_keys = ON;')
  raw.exec(AUTOMATIONS)
  raw.exec(AUTOMATION_RUN_SCHEMA_SQL)
  raw
    .prepare(
      'INSERT INTO automations (id,label,cron,prompt,created_at,retry_attempt,retry_at) VALUES (?,?,?,?,?,?,?)'
    )
    .run('a1', 'Nightly', '0 8 * * *', 'p', 0, 2, 1_700_000_000_000)
})

const claim = { automationId: 'a1', triggerKind: 'schedule' as const, scheduledAt: 1, attempt: 2 }

describe.skipIf(!DatabaseSync)('beginAutomationRun — claim + retry disarm are one transaction', () => {
  it('disarms the armed retry in the SAME commit as the winning claim', () => {
    const runId = beginAutomationRun({
      ...claim,
      triggerKey: 'retry:1700000000000',
      startedAt: 5,
      consumeRetryFor: 'a1'
    })
    expect(runId).toBeTruthy()
    expect(ledgerRows()).toBe(1)
    expect(retryState()).toEqual({ retry_at: null, retry_attempt: 0 })
  })

  it('leaves retry state untouched when the claim is LOST (the runner reconciles it)', () => {
    // Pre-existing ledger row: the crash-window survivor, flipped to 'interrupted'.
    raw
      .prepare(
        `INSERT INTO automation_runs (id,automation_id,trigger_key,trigger_kind,scheduled_at,started_at,attempt,status)
         VALUES ('pre','a1','retry:1700000000000','schedule',1,1,2,'interrupted')`
      )
      .run()

    const runId = beginAutomationRun({
      ...claim,
      triggerKey: 'retry:1700000000000',
      startedAt: 5,
      consumeRetryFor: 'a1'
    })
    expect(runId).toBeNull()
    expect(ledgerRows()).toBe(1) // no second row
    expect(retryState().retry_at).toBe(1_700_000_000_000)
  })

  it('rolls the CLAIM back when the disarm fails — never one without the other', () => {
    // Force the UPDATE half to throw after the INSERT half has run.
    raw.exec('DROP TABLE automations;')
    expect(() =>
      beginAutomationRun({
        ...claim,
        triggerKey: 'retry:1700000000000',
        startedAt: 5,
        consumeRetryFor: 'a1'
      })
    ).toThrow()
    // The claim must NOT be left behind: an orphaned claim with the retry still armed
    // is precisely the state that silenced the automation forever.
    expect(ledgerRows()).toBe(0)
  })

  it('does not touch retry state for a non-retry (cron) claim', () => {
    const runId = beginAutomationRun({
      ...claim,
      attempt: 1,
      triggerKey: 'schedule:2026-0-1-8-0',
      startedAt: 5
    })
    expect(runId).toBeTruthy()
    expect(retryState()).toEqual({ retry_at: 1_700_000_000_000, retry_attempt: 2 })
  })
})
