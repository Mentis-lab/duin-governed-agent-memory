// event-log must NOT latch its process-wide memory fallback when a *live* database throws.
//
// The defect: `activateFallback` — a permanent, process-wide, one-way latch cleared only by the
// test-only `__resetEventLog` — was reachable from five catch sites that wrapped ordinary SQL
// statements (recordEvent's INSERT, pruneEvents' transaction, getEvent, listEvents,
// listFailedEventCounts), not just from a failing `getDb()`. The module's own docblock scoped the
// fallback to "when getDb() throws (headless tests without an Electron app)", so the implementation
// was provably wider than its stated contract.
//
// Why one failed statement is expensive: the latch covers the READ path too. Once set,
// `listEvents()` serves only `memoryFallback`, so the Activity Timeline (ActivityTimeline.tsx →
// events:list → ipc/events.ts → listEvents) renders the user's entire on-disk event history as
// EMPTY — indistinguishable from "my audit log was wiped" — while every row is still intact in the
// `events` table. Simultaneously every later security.decision / proof.gate.waived / tool-approval
// / automation event is pushed to a volatile array and lost at quit, with recordEvent still
// returning a populated EventRecord so every caller reads it as success.
//
// The trigger needs no concurrency: clicking "Continue read-only" on the IntegrityBanner reopens
// the DB `{ readonly: true }` (database.ts), and getDb()'s own startup runIntegrityCheck() records
// a `persistence.integrity` event whose INSERT then raises SQLITE_READONLY. The daily backup tick
// tripped the same latch from pruneEvents on a transient SQLITE_BUSY (the headless CLI is exempt
// from the single-instance lock and the periodic TRUNCATE checkpoint can outrun busy_timeout=5000).
//
// The guard already existed next door — `withWriteRetry` (PS3) — and rag/store.ts and
// permission-policies-store.ts had already been fixed for the identical bug. This file mirrors
// permission-policies-store-busy-latch-node.test.ts.
//
// This file EXECUTES the SQL path. The sibling event-log.test.ts calls `__forceMemoryFallback()` in
// beforeEach so it never runs a line of it, and event-log-prune.test.ts depends on the
// better-sqlite3 native ABI (a mismatch silently SKIPS it). So we drive real statements through
// Node's built-in `node:sqlite` behind a mocked `./database` whose getDb() hands back that handle
// and which can inject SQLITE_BUSY / SQLITE_READONLY on demand.
//
// `withWriteRetry` is re-implemented in the mock WITHOUT the sleep (the production one busy-waits
// via Atomics.wait, which would add seconds to this suite). The retry contract it models — BUSY
// only, 3 attempts, everything else rethrown — is the real one, and database-retry.test.ts covers
// the production implementation itself. What this file certifies is event-log's side of the
// contract: that it routes statements through the retry at all, and that a failure surviving the
// retries stays local to that statement instead of downgrading the whole audit spine to memory.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const state = vi.hoisted(() => ({
  db: null as unknown,
  getDbThrows: false,
  /** Number of upcoming statement executions that should raise SQLITE_BUSY. */
  busyCountdown: 0,
  /** Mirrors a DB opened `{ readonly: true }`: writes fail, reads still work. */
  readonly: false,
  retryCalls: 0
}))

vi.mock('./database', () => ({
  getDb: () => {
    if (state.getDbThrows) throw new Error('electron app not available in test environment')
    return state.db
  },
  transactional: <T,>(fn: () => T): T => fn(),
  withWriteRetry: <T,>(fn: () => T, opts: { maxRetries?: number } = {}): T => {
    state.retryCalls++
    const maxRetries = opts.maxRetries ?? 3
    let attempt = 0
    for (;;) {
      try {
        return fn()
      } catch (err) {
        const code = (err as { code?: string })?.code
        const isBusy =
          code === 'SQLITE_BUSY' || /SQLITE_BUSY/i.test(String((err as Error)?.message))
        if (!isBusy || attempt >= maxRetries) throw err
        attempt++
      }
    }
  }
}))

import {
  __resetEventLog,
  getEvent,
  isUsingMemoryFallback,
  listEvents,
  pruneEvents,
  recordEvent
} from './event-log'

// Mirrors schema-init.ts's `events` segment (same columns event-log's INSERT binds).
const SCHEMA = `
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

let real: DatabaseSync

/** better-sqlite3-shaped facade over node:sqlite that can fail on demand. */
function makeHandle(db: DatabaseSync): unknown {
  const fail = (code: string, message: string): never => {
    const err = new Error(message) as Error & { code: string }
    err.code = code
    throw err
  }
  const busyGuard = (): void => {
    if (state.busyCountdown > 0) {
      state.busyCountdown--
      fail('SQLITE_BUSY', 'database is locked')
    }
  }
  const writeGuard = (): void => {
    if (state.readonly) fail('SQLITE_READONLY', 'attempt to write a readonly database')
  }
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql)
      const isWrite = /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)
      return {
        run: (...args: unknown[]) => {
          busyGuard()
          if (isWrite) writeGuard()
          const r = stmt.run(...(args as never[]))
          return { changes: Number(r.changes) }
        },
        all: (...args: unknown[]) => {
          busyGuard()
          return stmt.all(...(args as never[]))
        },
        get: (...args: unknown[]) => {
          busyGuard()
          return stmt.get(...(args as never[]))
        }
      }
    },
    transaction<T>(fn: () => T) {
      return (): T => {
        db.exec('BEGIN')
        try {
          const out = fn()
          db.exec('COMMIT')
          return out
        } catch (err) {
          try {
            db.exec('ROLLBACK')
          } catch {
            // the failing statement may already have aborted the transaction
          }
          throw err
        }
      }
    }
  }
}

/** Two audit rows already on disk — the history the timeline must keep showing. */
function seedHistory(): string[] {
  const a = recordEvent({
    type: 'security.decision',
    actorKind: 'user',
    payload: { decision: 'deny' }
  }).id
  const b = recordEvent({ type: 'proof.gate.waived', actorKind: 'user' }).id
  return [a, b].sort()
}

function idsOnDisk(): string[] {
  return (real.prepare('SELECT id FROM events').all() as { id: string }[])
    .map((r) => r.id)
    .sort()
}

beforeEach(() => {
  real = new DatabaseSync(':memory:')
  real.exec(SCHEMA)
  state.db = makeHandle(real)
  state.getDbThrows = false
  state.busyCountdown = 0
  state.readonly = false
  state.retryCalls = 0
  __resetEventLog()
})

describe('event-log: the "Continue read-only" path (SQLITE_READONLY on one INSERT)', () => {
  it('drops the un-writable event without blanking the on-disk history', () => {
    const seeded = seedHistory()

    // getDb() re-opens `{ readonly: true }` and, still inside getDb(), runIntegrityCheck()
    // records this event. Its INSERT cannot succeed — that is expected and survivable.
    state.readonly = true
    expect(() =>
      recordEvent({
        type: 'persistence.integrity',
        actorKind: 'system',
        payload: { result: 'corrupt' }
      })
    ).not.toThrow()

    // Pre-fix this single failed INSERT latched `useFallback` for the rest of the process.
    expect(isUsingMemoryFallback()).toBe(false)

    // THE USER-VISIBLE REGRESSION: the Activity Timeline reads through listEvents. Pre-fix it
    // served the (empty) memory buffer and the whole audit history read as deleted.
    expect(listEvents({}).map((e) => e.id).sort()).toEqual(seeded)
    expect(getEvent(seeded[0])?.id).toBe(seeded[0])
  })

  it('resumes writing to disk once the database is writable again', () => {
    seedHistory()

    state.readonly = true
    recordEvent({ type: 'persistence.integrity', actorKind: 'system' })
    // Leaving read-only mode (persistence:restoreFromBackup → setPersistenceReadOnlyMode(false))
    // resets nothing in event-log, so a latch here would have outlived the read-only session.
    state.readonly = false

    const later = recordEvent({ type: 'security.decision', actorKind: 'user' })
    expect(idsOnDisk()).toContain(later.id)
    expect(listEvents({}).map((e) => e.id)).toContain(later.id)
  })
})

describe('event-log: a transient SQLITE_BUSY on a live DB', () => {
  it('retries the INSERT instead of diverting the event into a volatile array', () => {
    state.busyCountdown = 2
    const rec = recordEvent({ type: 'security.decision', actorKind: 'user' })

    expect(state.retryCalls).toBeGreaterThan(0)
    expect(idsOnDisk()).toContain(rec.id)
    expect(isUsingMemoryFallback()).toBe(false)
  })

  it('retries the read instead of latching the process onto memory', () => {
    const seeded = seedHistory()

    state.busyCountdown = 2
    expect(listEvents({}).map((e) => e.id).sort()).toEqual(seeded)
    expect(isUsingMemoryFallback()).toBe(false)
  })
})

describe('event-log: a SQL failure that outlives the retries', () => {
  it('propagates from listEvents instead of returning a fake-empty history', () => {
    seedHistory()

    state.busyCountdown = 999
    // ipc/events.ts wraps listEvents in try/catch and returns { success: false, error } — it can
    // only tell the renderer "the query failed" if the failure actually reaches it. Pre-fix the
    // service swallowed it and returned [], which the timeline renders as "no events".
    expect(() => listEvents({})).toThrow(/locked|BUSY/i)
  })

  it('THE REGRESSION: one failed read must not permanently erase the on-disk history', () => {
    const seeded = seedHistory()

    state.busyCountdown = 999
    expect(() => listEvents({})).toThrow()
    state.busyCountdown = 0

    // Pre-fix `useFallback` was now latched forever: every later listEvents() returned the empty
    // buffer without touching the DB, and every later event was written to memory and lost at quit.
    expect(isUsingMemoryFallback()).toBe(false)
    expect(listEvents({}).map((e) => e.id).sort()).toEqual(seeded)

    const later = recordEvent({ type: 'proof.gate.waived', actorKind: 'user' })
    expect(idsOnDisk()).toContain(later.id)
  })

  it('keeps pruneEvents failure-isolated without latching the log', () => {
    const seeded = seedHistory()

    // The daily backup tick calls pruneEvents(); a BUSY here must report zero deletions...
    state.busyCountdown = 999
    expect(pruneEvents()).toEqual({ deletedByAge: 0, deletedByCap: 0, deleted: 0 })
    state.busyCountdown = 0

    // ...and must not take the audit spine down with it.
    expect(isUsingMemoryFallback()).toBe(false)
    expect(idsOnDisk()).toEqual(seeded)
    expect(listEvents({}).map((e) => e.id).sort()).toEqual(seeded)
  })
})

describe('event-log: the memory fallback still covers its designed case', () => {
  it('engages when getDb() itself is unavailable', () => {
    state.getDbThrows = true

    const created = recordEvent({ type: 'security.decision', actorKind: 'user' })

    expect(isUsingMemoryFallback()).toBe(true)
    expect(listEvents({}).map((e) => e.id)).toEqual([created.id])
    expect(getEvent(created.id)?.id).toBe(created.id)
  })
})
