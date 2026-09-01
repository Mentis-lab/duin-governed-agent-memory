import { describe, it, expect, beforeEach } from 'vitest'
import { applyOperationalGoalSchema } from './goal-lifecycle-schema'
import { AUTOMATION_RUN_SCHEMA_SQL } from './automation-run-schema'
import { applyAutomationTriggerSchema } from './automation-trigger-schema'
import {
  applyAutomationGoalBindingSchema,
  applyGoalLoopBridgeSchema
} from './goal-automation-bridge-schema'

// UA-AUTO (v32-v36) schema integration — runs the EXACT production migration DDL
// against node:sqlite (loads under vitest where the Electron better-sqlite3 ABI
// cannot). Catches DDL typos, backfill logic, idempotency, and the automation_runs
// UNIQUE(automation_id,trigger_key,attempt) idempotency constraint at gate time.

type DB = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number | bigint }
    get(...args: unknown[]): Record<string, unknown> | undefined
    all(...args: unknown[]): Record<string, unknown>[]
  }
}

let DatabaseSync: (new (path: string) => DB) | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  DatabaseSync = (require('node:sqlite') as { DatabaseSync: new (path: string) => DB })
    .DatabaseSync
} catch {
  DatabaseSync = null
}
const hasNodeSqlite = !!DatabaseSync

// Minimal pre-UA-AUTO baseline of the two tables the migrations ALTER.
const BASELINE_SQL = `
  CREATE TABLE goals (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    due_date TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE automations (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    cron TEXT NOT NULL,
    prompt TEXT NOT NULL,
    model TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_run_at INTEGER,
    last_result TEXT,
    deliver_to TEXT
  );
  CREATE TABLE loops (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`

let db: DB
beforeEach(() => {
  if (!hasNodeSqlite) return
  db = new DatabaseSync!(':memory:')
  db.exec(BASELINE_SQL)
})

const runAll = (): void => {
  applyOperationalGoalSchema(db) // v32
  db.exec(AUTOMATION_RUN_SCHEMA_SQL) // v33
  applyAutomationTriggerSchema(db) // v34
  applyAutomationGoalBindingSchema(db) // v35
  applyGoalLoopBridgeSchema(db) // v36
}

describe.skipIf(!hasNodeSqlite)('UA-AUTO schema (v32-v36) against node:sqlite', () => {
  it('applies all five migrations cleanly on an empty baseline', () => {
    expect(() => runAll()).not.toThrow()
  })

  it('is idempotent — re-running every migration is a no-op', () => {
    runAll()
    expect(() => runAll()).not.toThrow()
  })

  // Gate finding F2 — v32 only ALTERs `goals`; it cannot create it. Before this
  // guard the precondition failure surfaced as a bare `no such table: goals`
  // raised from inside an ALTER, with nothing naming the actual precondition.
  it('v32 fails loudly and legibly when the goals table is absent', () => {
    const bare = new DatabaseSync!(':memory:')
    try {
      expect(() => applyOperationalGoalSchema(bare)).toThrowError(
        /table "goals" does not exist.*initLegacySchema/s
      )
    } finally {
      ;(bare as unknown as { close?: () => void }).close?.()
    }
  })

  it('v32 backfills lifecycle_status from the legacy status column', () => {
    db.prepare(
      "INSERT INTO goals (id, conversation_id, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?)"
    ).run('g1', 'c', 'legacy done', 'done', 10, 20)
    db.prepare(
      "INSERT INTO goals (id, conversation_id, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?)"
    ).run('g2', 'c', 'legacy running', 'in_progress', 10, 20)
    applyOperationalGoalSchema(db)
    const g1 = db.prepare('SELECT lifecycle_status, completed_at FROM goals WHERE id = ?').get('g1')!
    expect(g1.lifecycle_status).toBe('completed')
    expect(g1.completed_at).toBe(20)
    const g2 = db.prepare('SELECT lifecycle_status, active_since FROM goals WHERE id = ?').get('g2')!
    expect(g2.lifecycle_status).toBe('active')
    expect(g2.active_since).toBe(20)
  })

  it('v34 wraps a legacy cron automation as a schedule trigger', () => {
    db.prepare(
      "INSERT INTO automations (id, label, cron, prompt, created_at) VALUES (?,?,?,?,?)"
    ).run('a1', 'brief', '0 8 * * *', 'go', 1)
    db.exec(AUTOMATION_RUN_SCHEMA_SQL)
    applyAutomationTriggerSchema(db)
    const row = db
      .prepare('SELECT trigger_kind, trigger_config_json FROM automations WHERE id = ?')
      .get('a1')! as { trigger_kind: string; trigger_config_json: string }
    expect(row.trigger_kind).toBe('schedule')
    const cfg = JSON.parse(row.trigger_config_json)
    expect(cfg).toMatchObject({ kind: 'schedule', cron: '0 8 * * *', maxAttempts: 3 })
  })

  it('automation_runs enforces UNIQUE(automation_id, trigger_key, attempt) — the idempotency claim', () => {
    runAll()
    db.prepare(
      "INSERT INTO automations (id, label, cron, prompt, created_at) VALUES ('a1','l','* * * * *','p',1)"
    ).run()
    const claim = (id: string): number =>
      Number(
        db
          .prepare(
            "INSERT OR IGNORE INTO automation_runs (id, automation_id, trigger_key, trigger_kind, started_at, attempt, status) VALUES (?, 'a1', 'schedule:m1', 'schedule', 1, 1, 'running')"
          )
          .run(id).changes
      )
    expect(claim('r1')).toBe(1) // first claim wins
    expect(claim('r2')).toBe(0) // duplicate (same trigger_key+attempt) is ignored
    // a new attempt is a distinct claim
    const claim2 = Number(
      db
        .prepare(
          "INSERT OR IGNORE INTO automation_runs (id, automation_id, trigger_key, trigger_kind, started_at, attempt, status) VALUES ('r3','a1','schedule:m1','schedule',1,2,'running')"
        )
        .run().changes
    )
    expect(claim2).toBe(1)
  })

  it('automation_runs retention sweep drops old TERMINAL rows but keeps running + recent (idempotency lease)', () => {
    runAll()
    db.prepare(
      "INSERT INTO automations (id, label, cron, prompt, created_at) VALUES ('a1','l','* * * * *','p',1)"
    ).run()
    const ins = (id: string, key: string, status: string, startedAt: number): void => {
      db.prepare(
        "INSERT INTO automation_runs (id, automation_id, trigger_key, trigger_kind, started_at, attempt, status) VALUES (?, 'a1', ?, 'schedule', ?, 1, ?)"
      ).run(id, key, startedAt, status)
    }
    const now = 100_000_000
    const window = 24 * 60 * 60_000
    ins('old-done', 'k1', 'completed', now - window - 1) // old + terminal → pruned
    ins('old-failed', 'k2', 'failed', now - window - 5) // old + terminal → pruned
    ins('old-interrupted', 'k3', 'interrupted', now - window - 9) // old + terminal → pruned
    ins('old-running', 'k4', 'running', now - window - 20) // old but LIVE lease → kept
    ins('recent-done', 'k5', 'completed', now - 60_000) // terminal but recent → kept

    // The exact production DELETE from pruneAutomationRuns (getDb() can't load here).
    const deleted = Number(
      db
        .prepare(
          "DELETE FROM automation_runs WHERE status IN ('completed','failed','interrupted') AND started_at < ?"
        )
        .run(now - window).changes
    )
    expect(deleted).toBe(3)
    const surviving = (db.prepare('SELECT id FROM automation_runs ORDER BY id').all() as { id: string }[]).map(
      (r) => r.id
    )
    expect(surviving).toEqual(['old-running', 'recent-done'])
  })

  it('v36 gives loops + goals their bridge columns and a unique loop-owner index', () => {
    runAll()
    // one goal can own a loop; a second goal claiming the same loop violates the unique index
    db.prepare(
      "INSERT INTO goals (id, conversation_id, title, status, created_at, updated_at, loop_id) VALUES ('g1','c','t','open',1,1,'loopX')"
    ).run()
    expect(() =>
      db
        .prepare(
          "INSERT INTO goals (id, conversation_id, title, status, created_at, updated_at, loop_id) VALUES ('g2','c','t','open',1,1,'loopX')"
        )
        .run()
    ).toThrow()
    // loops carries the goal back-reference
    db.prepare(
      "INSERT INTO loops (id, conversation_id, status, created_at, updated_at, goal_id, goal_conversation_id) VALUES ('loopX','c','running',1,1,'g1','c')"
    ).run()
    const loop = db.prepare('SELECT goal_id FROM loops WHERE id = ?').get('loopX')!
    expect(loop.goal_id).toBe('g1')
  })
})
