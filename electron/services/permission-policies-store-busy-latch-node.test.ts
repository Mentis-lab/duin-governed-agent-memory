// permission-policies-store must NOT latch its process-wide memory fallback when a *live*
// database throws.
//
// The defect: `activateFallback` — a permanent process-wide latch, cleared only by the test-only
// `__resetPolicyStore` — was reachable from six catch sites that wrapped ordinary SQL calls, not
// just from a failing `getDb()`. The module's own header scoped the fallback to "when a getDb()
// call throws", so the implementation was provably wider than its stated contract.
//
// Why that is a security defect and not just lost data: once latched, `listPolicies()` returns the
// empty `memoryFallback` forever. An empty policy set is indistinguishable from "the user never
// saved a deny". `resolveDecision` returns null → `resolveAguiGate` sets policy = null →
// `decideAguiGate` never reaches its `input.policy === 'deny'` branch and falls through to the
// trusted-afk auto-allow. A saved global DENY on a host-exec tool silently stops being enforced,
// and nothing surfaces on that path. One transient SQLITE_BUSY was enough to trip it: the headless
// CLI is exempt from the single-instance lock (database.ts busy_timeout comment) and the periodic
// TRUNCATE checkpoint can outrun busy_timeout.
//
// The guard already existed next door — `withWriteRetry` (PS3) — and rag/store.ts had already been
// fixed for the identical bug (see rag/store-busy-fallback-node.test.ts, which this file mirrors).
//
// This file EXECUTES the SQL path. The sibling permission-policies-store.test.ts calls
// `__forceMemoryFallback()` in beforeEach, so it never runs a line of it, and the real
// better-sqlite3 ABI is not what we want to depend on here. So we drive real statements through
// Node's built-in `node:sqlite` behind a mocked `./database` whose getDb() hands back that handle
// and which can inject SQLITE_BUSY on demand.
//
// `withWriteRetry` is re-implemented in the mock WITHOUT the sleep (the production one busy-waits
// via Atomics.wait, which would add seconds to this suite). The retry contract it models — BUSY
// only, 3 attempts, everything else rethrown — is the real one, and database-retry.test.ts covers
// the production implementation itself. What this file certifies is the store's side of the
// contract: that it routes statements through the retry at all, and that a failure surviving the
// retries propagates instead of silently downgrading persistence to memory.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const state = vi.hoisted(() => ({
  db: null as unknown,
  getDbThrows: false,
  /** Number of upcoming statement executions that should raise SQLITE_BUSY. */
  busyCountdown: 0,
  retryCalls: 0
}))

vi.mock('./database', () => ({
  getDb: () => {
    if (state.getDbThrows) throw new Error('electron app not available in test environment')
    return state.db
  },
  transactional: <T>(fn: () => T): T => fn(),
  withWriteRetry: <T>(fn: () => T, opts: { maxRetries?: number } = {}): T => {
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
  __resetPolicyStore,
  clearPoliciesForScope,
  deletePolicy,
  getPolicy,
  isUsingMemoryFallback,
  listPolicies,
  resolveDecision,
  upsertPolicy
} from './permission-policies-store'

// Mirrors schema-init.ts's permission_policies segment, CHECK constraints included — the
// constraint is what the non-BUSY failure case below trips.
const SCHEMA = `
  CREATE TABLE permission_policies (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK(scope IN ('conversation','workspace','global')),
    subject_kind TEXT NOT NULL CHECK(subject_kind IN ('tool','risk')),
    subject TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('allow','deny')),
    conversation_id TEXT,
    workspace_path TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`

let real: DatabaseSync

/** better-sqlite3-shaped facade over node:sqlite that can raise SQLITE_BUSY on demand. */
function makeHandle(db: DatabaseSync): unknown {
  const busyGuard = (): void => {
    if (state.busyCountdown > 0) {
      state.busyCountdown--
      const err = new Error('database is locked') as Error & { code: string }
      err.code = 'SQLITE_BUSY'
      throw err
    }
  }
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql)
      return {
        run: (...args: unknown[]) => {
          busyGuard()
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
    }
  }
}

/** The saved global DENY on a host-exec tool that the whole scenario is about. */
function seedDeny(): string {
  return upsertPolicy({
    scope: 'global',
    subjectKind: 'tool',
    subject: 'run_command',
    decision: 'deny'
  }).id
}

const runCommandCtx = { toolId: 'run_command', risks: [] as never[] }

beforeEach(() => {
  real = new DatabaseSync(':memory:')
  real.exec(SCHEMA)
  state.db = makeHandle(real)
  state.getDbThrows = false
  state.busyCountdown = 0
  state.retryCalls = 0
  __resetPolicyStore()
})

describe('permission-policies-store: a transient SQLITE_BUSY on a live DB', () => {
  it('retries the read instead of latching the process onto memory', () => {
    const id = seedDeny()

    // Contention lands on listPolicies' SELECT — the site the report names. Two BUSY, then free.
    state.busyCountdown = 2
    const policies = listPolicies()

    expect(policies.map((p) => p.id)).toEqual([id])
    expect(state.retryCalls).toBeGreaterThan(0)
    expect(isUsingMemoryFallback()).toBe(false)
  })

  it('retries a write rather than diverting it into a volatile array', () => {
    state.busyCountdown = 2
    const policy = upsertPolicy({
      scope: 'global',
      subjectKind: 'tool',
      subject: 'run_command',
      decision: 'deny'
    })

    // On disk, not in memoryFallback.
    const rows = real
      .prepare('SELECT id FROM permission_policies WHERE id = ?')
      .all(policy.id) as unknown[]
    expect(rows).toHaveLength(1)
    expect(isUsingMemoryFallback()).toBe(false)
  })
})

describe('permission-policies-store: a SQLITE_BUSY that outlives the retries', () => {
  it('propagates from listPolicies instead of returning a fake-empty policy set', () => {
    seedDeny()

    state.busyCountdown = 999
    // agui-gate.ts wraps its resolveDecision() call in try/catch and logs "policy store
    // unavailable" — it can only do that if the failure actually reaches it. Pre-fix the store
    // swallowed it and returned [], which reads as "no deny exists".
    expect(() => listPolicies()).toThrow(/locked|BUSY/i)
  })

  it('THE REGRESSION: one failed read must not permanently erase the saved deny', () => {
    const id = seedDeny()

    state.busyCountdown = 999
    expect(() => listPolicies()).toThrow()
    state.busyCountdown = 0

    // Pre-fix, `useFallback` was now latched forever: every later listPolicies() returned the
    // empty array without touching the DB, resolveDecision() returned null, and the gated
    // host-exec tool ran unprompted under the trusted-afk auto-allow.
    expect(isUsingMemoryFallback()).toBe(false)
    expect(listPolicies().map((p) => p.id)).toEqual([id])

    const decision = resolveDecision(runCommandCtx)
    expect(decision).not.toBeNull()
    expect(decision?.decision).toBe('deny')
    expect(decision?.policyId).toBe(id)
  })

  it('leaves the write path pointed at the database after a failed read', () => {
    seedDeny()

    state.busyCountdown = 999
    expect(() => listPolicies()).toThrow()
    state.busyCountdown = 0

    // Pre-fix this "Always deny" reported success into memoryFallback and vanished at quit.
    const second = upsertPolicy({
      scope: 'global',
      subjectKind: 'tool',
      subject: 'apply_patch',
      decision: 'deny'
    })
    const rows = real
      .prepare('SELECT id FROM permission_policies WHERE id = ?')
      .all(second.id) as unknown[]
    expect(rows).toHaveLength(1)
  })

  it('does not latch on a non-BUSY SQL failure either', () => {
    const id = seedDeny()

    // A CHECK-constraint violation: the DB is perfectly healthy, this one statement is invalid.
    expect(() =>
      upsertPolicy({
        scope: 'global',
        subjectKind: 'tool',
        subject: 'run_command',
        decision: 'maybe' as never
      })
    ).toThrow()

    expect(isUsingMemoryFallback()).toBe(false)
    expect(listPolicies().map((p) => p.id)).toEqual([id])
    expect(resolveDecision(runCommandCtx)?.decision).toBe('deny')
  })

  it('does not latch when a delete or a scope-clear fails', () => {
    const id = seedDeny()

    state.busyCountdown = 999
    expect(() => deletePolicy(id)).toThrow()
    state.busyCountdown = 0
    expect(isUsingMemoryFallback()).toBe(false)

    state.busyCountdown = 999
    expect(() => clearPoliciesForScope('global')).toThrow()
    state.busyCountdown = 0
    expect(isUsingMemoryFallback()).toBe(false)

    // Neither failed statement removed the row, and the deny is still enforced.
    expect(getPolicy(id)?.decision).toBe('deny')
    expect(resolveDecision(runCommandCtx)?.decision).toBe('deny')
  })
})

describe('permission-policies-store: the memory fallback still covers its designed case', () => {
  it('engages when getDb() itself is unavailable', () => {
    state.getDbThrows = true

    const created = upsertPolicy({
      scope: 'global',
      subjectKind: 'tool',
      subject: 'run_command',
      decision: 'deny'
    })

    expect(isUsingMemoryFallback()).toBe(true)
    expect(listPolicies().map((p) => p.id)).toEqual([created.id])
    expect(resolveDecision(runCommandCtx)?.decision).toBe('deny')
  })
})
