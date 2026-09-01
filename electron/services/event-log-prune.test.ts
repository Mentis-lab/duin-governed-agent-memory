import { describe, it, expect, beforeEach, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type Database from 'better-sqlite3'

// Inject a real in-memory SQLite so pruneEvents runs its actual DELETE path (not the
// memory fallback). Mocking `./database` also keeps electron out of the test process.
let testDb: Database.Database
vi.mock('./database', () => ({
  getDb: () => testDb,
  // event-log now routes every statement through withWriteRetry so a transient
  // SQLITE_BUSY is retried instead of latching the whole log onto the memory
  // fallback. Pass-through here — the retry contract itself is covered by
  // database-retry.test.ts and event-log-busy-latch-node.test.ts.
  withWriteRetry: <T,>(fn: () => T): T => fn()
}))

import {
  pruneEvents,
  recordEvent,
  listEvents,
  __resetEventLog,
  __forceMemoryFallback,
  EVENT_RETENTION_DAYS
} from './event-log'

// CI (and this worktree's Electron-ABI better-sqlite3 binary under vitest's Node) may lack a
// loadable native binding. Detect once and skip the DB-backed cases — matches the pattern in
// snip/tracking.test.ts and database-checkpoint.test.ts.
const HAS_NATIVE_SQLITE: boolean = (() => {
  try {
    const probe = new BetterSqlite3(':memory:')
    probe.close()
    return true
  } catch {
    return false
  }
})()

const EVENTS_SCHEMA = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    conversation_id TEXT, project_id TEXT, workspace_path TEXT,
    automation_id TEXT, tool_call_id TEXT, parent_event_id TEXT, correlation_id TEXT,
    actor_kind TEXT NOT NULL, actor_id TEXT, entity_kind TEXT, entity_id TEXT,
    payload_json TEXT NOT NULL, redaction TEXT NOT NULL DEFAULT 'metadata'
  );
`
const FAILURE_LEDGER_SCHEMA = `
  CREATE TABLE failure_ledger (
    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, kind TEXT NOT NULL,
    event_id TEXT, message TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
    first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
`

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

function insertEvent(id: string, createdAt: number): void {
  testDb
    .prepare(
      `INSERT INTO events (id, type, created_at, severity, actor_kind, payload_json, redaction)
       VALUES (?, 'guarded.failure', ?, 'info', 'system', '{}', 'metadata')`
    )
    .run(id, createdAt)
}

function eventIds(): string[] {
  return (testDb.prepare(`SELECT id FROM events ORDER BY created_at ASC`).all() as { id: string }[]).map(
    (r) => r.id
  )
}

beforeEach(() => {
  if (!HAS_NATIVE_SQLITE) return
  __resetEventLog() // useFallback = false → DB path
  testDb = new BetterSqlite3(':memory:')
  testDb.exec(EVENTS_SCHEMA)
})

describe.skipIf(!HAS_NATIVE_SQLITE)('pruneEvents', () => {
  it('deletes old events, keeps recent ones', () => {
    insertEvent('old-1', NOW - 40 * DAY)
    insertEvent('old-2', NOW - 31 * DAY)
    insertEvent('recent-1', NOW - 5 * DAY)
    insertEvent('recent-2', NOW - 1 * DAY)

    const res = pruneEvents({ retentionDays: EVENT_RETENTION_DAYS, now: NOW })

    expect(res.deletedByAge).toBe(2)
    expect(res.deleted).toBe(2)
    expect(eventIds()).toEqual(['recent-1', 'recent-2'])
  })

  it('is SCOPED — only touches events, never other tables', () => {
    testDb.exec(FAILURE_LEDGER_SCHEMA)
    testDb
      .prepare(
        `INSERT INTO failure_ledger (id, fingerprint, kind, event_id, message, count,
           first_seen_at, last_seen_at, created_at, updated_at)
         VALUES ('fl-x', 'fp-x', 'runtime_failed', NULL, 'boom', 1, ?, ?, ?, ?)`
      )
      .run(NOW - 40 * DAY, NOW - 40 * DAY, NOW - 40 * DAY, NOW - 40 * DAY)
    insertEvent('old-1', NOW - 40 * DAY)

    pruneEvents({ now: NOW })

    // The (unrelated, NULL event_id) ledger row is untouched.
    const ledgerCount = (testDb.prepare(`SELECT COUNT(*) AS c FROM failure_ledger`).get() as { c: number }).c
    expect(ledgerCount).toBe(1)
  })

  it('does NOT orphan an event a failure_ledger row references', () => {
    testDb.exec(FAILURE_LEDGER_SCHEMA)
    insertEvent('old-referenced', NOW - 50 * DAY) // old BUT referenced
    insertEvent('old-orphan', NOW - 50 * DAY) // old, nothing depends on it
    insertEvent('recent', NOW - 2 * DAY)
    testDb
      .prepare(
        `INSERT INTO failure_ledger (id, fingerprint, kind, event_id, message, count,
           first_seen_at, last_seen_at, created_at, updated_at)
         VALUES ('fl-1', 'fp-1', 'runtime_failed', 'old-referenced', 'boom', 1, ?, ?, ?, ?)`
      )
      .run(NOW - 50 * DAY, NOW - 50 * DAY, NOW - 50 * DAY, NOW - 50 * DAY)

    const res = pruneEvents({ now: NOW })

    // The orphan is pruned; the referenced old event is PRESERVED (no dangling ledger ref).
    expect(res.deletedByAge).toBe(1)
    expect(eventIds()).toEqual(['old-referenced', 'recent'])
  })

  it('caps runaway growth by row count, preserving referenced rows', () => {
    testDb.exec(FAILURE_LEDGER_SCHEMA)
    // 10 recent rows (inside retention), oldest first.
    for (let i = 0; i < 10; i++) insertEvent(`e-${i}`, NOW - (10 - i) * 1000)
    // The OLDEST row is referenced — the cap prune must skip it even though it's oldest.
    testDb
      .prepare(
        `INSERT INTO failure_ledger (id, fingerprint, kind, event_id, message, count,
           first_seen_at, last_seen_at, created_at, updated_at)
         VALUES ('fl-1', 'fp-1', 'runtime_failed', 'e-0', 'boom', 1, ?, ?, ?, ?)`
      )
      .run(NOW, NOW, NOW, NOW)

    const res = pruneEvents({ now: NOW, maxRows: 5 })

    // 10 rows, cap 5 → drop 5 oldest UNREFERENCED. e-0 (referenced) survives despite being oldest.
    expect(res.deletedByCap).toBe(5)
    const ids = eventIds()
    expect(ids).toContain('e-0')
    expect(ids.length).toBe(5)
    // e-1..e-5 were the next-oldest unreferenced victims.
    expect(ids).not.toContain('e-1')
    expect(ids).toContain('e-9')
  })

  it('works without a failure_ledger table (unit DB with events only)', () => {
    insertEvent('old', NOW - 40 * DAY)
    insertEvent('recent', NOW - 1 * DAY)
    // No failure_ledger table exists — the preserve clause is simply omitted, no throw.
    const res = pruneEvents({ now: NOW })
    expect(res.deleted).toBe(1)
    expect(eventIds()).toEqual(['recent'])
  })
})

// The memory-fallback path exercises the SAME retention policy (age window + row-count cap)
// with no native SQLite, so the age/cap arithmetic is validated even where the binding is absent.
describe('pruneEvents (memory fallback)', () => {
  beforeEach(() => {
    __resetEventLog()
    __forceMemoryFallback()
  })

  const seed = (n: number): void => {
    for (let i = 0; i < n; i++) recordEvent({ type: 'guarded.failure', actorKind: 'system' })
  }

  it('age-prunes stale events (cutoff after them) and reports the count', () => {
    seed(5)
    // Events were just recorded (~now); a cutoff far in the FUTURE makes them all stale.
    const far = Date.now() + 40 * DAY
    const res = pruneEvents({ retentionDays: 1, now: far })
    expect(res.deletedByAge).toBe(5)
    expect(listEvents()).toEqual([])
  })

  it('keeps fresh events (cutoff before them)', () => {
    seed(3)
    const res = pruneEvents({ now: Date.now() }) // 30-day window; events are seconds old
    expect(res.deleted).toBe(0)
    expect(listEvents().length).toBe(3)
  })

  it('caps the buffer by row count, dropping the overflow', () => {
    seed(10)
    const res = pruneEvents({ maxRows: 4 })
    expect(res.deletedByCap).toBe(6)
    expect(listEvents().length).toBe(4)
  })
})
