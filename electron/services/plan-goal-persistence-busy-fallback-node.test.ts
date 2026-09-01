// plan-goal-persistence must NOT latch its process-wide memory fallback when a *live* database
// throws.
//
// The defect: `activateFallback` (a permanent process-wide latch — only the test-only
// `__resetPlanGoalPersistence` clears it) was reachable from every catch site that wrapped an
// ordinary `getDb().prepare()...` call. A transient SQLITE_BUSY thrown at statement execution —
// not at getDb() — landed inside that try and flipped the whole module onto empty in-memory
// buckets for the rest of the process. From that moment loadGoals/loadPlanSteps returned
// `{ planSteps: [], goals: [] }` for any conversation not yet hydrated this session (the user's
// persisted goals/plan appeared to have vanished), and new create_goal/update_plan writes went
// only to the volatile bucket while reporting success — lost at app quit. The headless CLI writer
// is exempt from the single-instance lock and the periodic TRUNCATE checkpoint can outrun
// busy_timeout, so a transient BUSY is a real event.
//
// The guard already existed next door: database.ts exports `withWriteRetry` (PS3), and
// permission-policies-store / rag/store fixed the identical latch by routing statements through it
// and rethrowing whatever survives the retries.
//
// This file EXECUTES the SQL path. The sibling plan-goal-persistence.test.ts forces the memory
// fallback in beforeEach, so it never runs a line of the DB path, and the real better-sqlite3 ABI
// does not load under vitest. So, like rag/store-busy-fallback-node.test.ts, we drive real
// statements through Node's built-in `node:sqlite` behind a mocked `./database` module whose
// getDb() hands back that handle and which can inject SQLITE_BUSY on demand.
//
// `withWriteRetry` is re-implemented in the mock WITHOUT the sleep (the production one busy-waits
// via Atomics.wait, which would add seconds to this suite). The retry contract it models — BUSY
// only, 3 attempts, everything else rethrown — is the real one, and the production implementation
// is covered by database-retry.test.ts. What this file certifies is plan-goal-persistence's side
// of the contract: that it routes statements through the retry at all, and that a failure
// surviving the retries propagates instead of silently downgrading persistence to memory.
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
  __resetPlanGoalPersistence,
  clearConversation,
  isUsingMemoryFallback,
  listAllPlanGoalState,
  loadGoals,
  loadPlanSteps,
  savePlanSteps,
  upsertGoal
} from './plan-goal-persistence'
import type { Goal, PlanStep } from './plan-goal-store'
import { applyOperationalGoalSchema } from './goal-lifecycle-schema'
import { applyGoalLoopBridgeSchema } from './goal-automation-bridge-schema'

// Mirrors the plan_steps + goals segment of schema-init.ts (the columns the store binds).
// The base `goals` table below is the pre-v32 shape; the operational-goal lifecycle
// columns (v32) and the goal-owned loop bridge (v36) are layered on in beforeEach via
// the EXACT production DDL, because upsertGoal now binds all of them. A minimal `loops`
// table exists only so applyGoalLoopBridgeSchema — which also back-references loops —
// can run unmodified; nothing in this file reads it.
const SCHEMA = `
  CREATE TABLE plan_steps (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','in_progress','done')),
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE goals (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    due_date TEXT,
    status TEXT NOT NULL CHECK(status IN ('open','in_progress','done','abandoned')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE loops (
    id TEXT PRIMARY KEY
  );
`

const A = 'conv-a'
const B = 'conv-b'

const step = (id: string, text: string, status: PlanStep['status'] = 'pending'): PlanStep => ({
  id,
  text,
  status
})

// The lifecycle/budget/loop fields became required on `Goal` with the UA operational-goal
// control plane (v32/v36). This fixture is about the BUSY-retry contract, not the state
// machine, so it seeds each goal at the neutral freshly-created state — exactly what the
// v32 backfill produces for a legacy `status: 'open'` row.
const goal = (id: string, overrides: Partial<Goal> = {}): Goal => ({
  id,
  title: `goal ${id}`,
  status: 'open',
  lifecycleStatus: 'open',
  lastActor: 'system',
  tokenBudget: null,
  tokenUsed: 0,
  timeBudgetMs: null,
  elapsedMs: 0,
  activeSince: null,
  pausedAt: null,
  completedAt: null,
  abortedAt: null,
  blocker: null,
  completion: null,
  transitionReason: null,
  loopId: null,
  loopMaxIterations: null,
  loopMaxWallclockMs: null,
  loopTokenBudget: null,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

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
          // node:sqlite binds named params from a plain object; better-sqlite3's
          // `@name` placeholders map to `name` keys, which node:sqlite accepts.
          return stmt.run(...(args as never[]))
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
    transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => {
      db.exec('BEGIN')
      try {
        const out = fn(...a)
        db.exec('COMMIT')
        return out
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    }
  }
}

beforeEach(() => {
  real = new DatabaseSync(':memory:')
  real.exec(SCHEMA)
  // Layer the v32 + v36 goal columns on with the production DDL, so upsertGoal's
  // full column bind resolves against the same schema the app migrates to.
  applyOperationalGoalSchema(real)
  applyGoalLoopBridgeSchema(real)
  state.db = makeHandle(real)
  state.getDbThrows = false
  state.busyCountdown = 0
  state.retryCalls = 0
  __resetPlanGoalPersistence()
})

describe('plan-goal-persistence: a transient SQLITE_BUSY on a live DB', () => {
  it('retries the read instead of latching the process onto empty memory', () => {
    // A plan the user already saved this session, on disk.
    savePlanSteps(A, [step('1', 'a', 'done'), step('2', 'b')])
    upsertGoal(A, goal('g1', { title: 'ship it' }))

    // The next read hits lock contention. Two BUSY errors, then the lock frees.
    state.busyCountdown = 2
    const plan = loadPlanSteps(A)

    expect(plan.map((s) => s.id)).toEqual(['1', '2'])
    expect(state.retryCalls).toBeGreaterThan(0)
    // The store never latched: it is still reading the disk, not an empty bucket.
    expect(isUsingMemoryFallback()).toBe(false)
    expect(loadGoals(A).map((g) => g.title)).toEqual(['ship it'])
  })

  it('retries a write transaction instead of dropping it into volatile memory', () => {
    state.busyCountdown = 2
    savePlanSteps(A, [step('1', 'a'), step('2', 'b')])

    expect(state.retryCalls).toBeGreaterThan(0)
    expect(isUsingMemoryFallback()).toBe(false)
    // The steps are on disk, not in a volatile array that vanishes at quit.
    const onDisk = real
      .prepare('SELECT COUNT(*) AS n FROM plan_steps WHERE conversation_id = ?')
      .get(A) as { n: number }
    expect(Number(onDisk.n)).toBe(2)
  })
})

describe('plan-goal-persistence: a SQLITE_BUSY that outlives the retries', () => {
  it('propagates to the caller instead of silently serving an empty plan', () => {
    savePlanSteps(A, [step('1', 'a')])
    upsertGoal(A, goal('g1'))

    // THE regression this fix prevents: pre-fix, this single failure permanently latched the
    // module and every later loadGoals/loadPlanSteps returned the empty memory bucket — the user's
    // saved goals/plan appeared to have vanished — while new writes were silently lost.
    state.busyCountdown = 999
    expect(() => loadGoals(A)).toThrow(/locked|BUSY/i)

    // The failure did NOT downgrade persistence to memory.
    expect(isUsingMemoryFallback()).toBe(false)

    // Once the lock frees, the still-on-disk state is fully readable — nothing was dropped.
    state.busyCountdown = 0
    expect(loadPlanSteps(A).map((s) => s.id)).toEqual(['1'])
    expect(loadGoals(A).map((g) => g.id)).toEqual(['g1'])
    // And a subsequent write still reaches the database rather than a volatile bucket.
    upsertGoal(B, goal('g2'))
    const rows = real.prepare('SELECT id FROM goals WHERE conversation_id = ?').all(B) as unknown[]
    expect(rows).toHaveLength(1)
  })

  it('does not latch on a non-BUSY SQL failure either', () => {
    // A CHECK-constraint violation: an illegal status value. The DB is perfectly healthy.
    expect(() =>
      savePlanSteps(A, [step('1', 'a', 'bogus-status' as PlanStep['status'])])
    ).toThrow()
    expect(isUsingMemoryFallback()).toBe(false)
  })
})

describe('plan-goal-persistence: the memory fallback still covers the case it was designed for', () => {
  it('engages only when getDb() itself is unavailable', () => {
    state.getDbThrows = true

    // Total failure: no database in this process at all. Serving process-local state beats throwing.
    savePlanSteps(A, [step('1', 'a')])
    upsertGoal(A, goal('g1'))

    expect(isUsingMemoryFallback()).toBe(true)
    expect(loadPlanSteps(A).map((s) => s.id)).toEqual(['1'])
    expect(loadGoals(A).map((g) => g.id)).toEqual(['g1'])
    expect(listAllPlanGoalState().map((s) => s.conversationId)).toEqual([A])

    clearConversation(A)
    expect(loadPlanSteps(A)).toHaveLength(0)
  })
})
