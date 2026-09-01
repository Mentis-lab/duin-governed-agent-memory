import type { Database } from 'better-sqlite3'
import { getDb, withWriteRetry } from './database'
import type {
  Goal,
  GoalActor,
  GoalLifecycleStatus,
  GoalStatus,
  PlanStep,
  PlanStepStatus
} from './plan-goal-store'
import { friendly, messageOf } from './guarded'

// Write-through SQLite persistence for per-conversation plan steps + goals.
// Mirrors permission-policies-store / rag/store: the database is the durable
// layer, and the in-memory fallback engages for exactly ONE condition — getDb()
// itself is unavailable (headless tests, no Electron app, disk failure). That is
// a TOTAL failure with no persistence to lose. A failure *inside* a SQL call is
// a PARTIAL failure (the DB is open, the rows are still on disk): those are
// retried through withWriteRetry (PS3) and anything surviving the retries
// propagates to the caller rather than silently downgrading to an empty
// in-memory read. plan-goal-store keeps its own per-session cache on top of this
// and hydrates from here on the first access to a conversation.

interface PlanRow {
  id: string
  conversation_id: string
  text: string
  status: PlanStepStatus
  position: number
}

interface GoalRow {
  id: string
  conversation_id: string
  title: string
  description: string | null
  due_date: string | null
  status: GoalStatus
  lifecycle_status: GoalLifecycleStatus
  last_actor: GoalActor
  token_budget: number | null
  token_used: number
  time_budget_ms: number | null
  elapsed_ms: number
  active_since: number | null
  paused_at: number | null
  completed_at: number | null
  aborted_at: number | null
  blocker: string | null
  completion: string | null
  transition_reason: string | null
  loop_id: string | null
  loop_max_iterations: number | null
  loop_max_wallclock_ms: number | null
  loop_token_budget: number | null
  created_at: number
  updated_at: number
}

interface ConvBucket {
  planSteps: PlanStep[]
  goals: Goal[]
}

/** One conversation's full plan + goal state, for the inspect/clear settings UI. */
export interface ConversationPlanGoalState {
  conversationId: string
  planSteps: PlanStep[]
  goals: Goal[]
}

// In-memory fallback, keyed by conversation key (the '__global__' sentinel for
// the shared bucket). Only used once persistence is known to be unavailable.
const memoryFallback = new Map<string, ConvBucket>()
let useFallback = false

function activateFallback(reason: string): void {
  if (!useFallback) {
    useFallback = true
    console.warn(
      `[plan-goal-persistence] persistence unavailable, falling back to memory: ${reason}`
    )
  }
}

/**
 * Acquire the DB handle for one store call.
 *
 * Returns `null` only when the memory fallback should be used — i.e. it is
 * already latched, or `getDb()` itself threw (no database in this process). A
 * non-null handle means the DB is open; the caller runs its statements through
 * {@link runDb} and lets anything surviving the retries propagate.
 *
 * Why this matters: the previous shape wrapped a live `getDb().prepare()...`
 * call in a catch that called `activateFallback` directly, so a single transient
 * SQLITE_BUSY thrown at statement execution — not at getDb() — permanently
 * latched the whole module onto an EMPTY memory bucket. Thereafter loadGoals /
 * loadPlanSteps returned `{ planSteps: [], goals: [] }` for any conversation not
 * yet hydrated this session (the user's saved goals/plan appeared to vanish),
 * and new writes went only to the volatile bucket while reporting success —
 * lost at quit. What made it invisible: the latch is quiet and permanent (one
 * console.warn scrolls past, every later call takes the fast `useFallback`
 * return and never re-checks the DB). The headless CLI writer is exempt from the
 * single-instance lock and the periodic TRUNCATE checkpoint can outrun
 * busy_timeout, so transient BUSY is a real event, not a hypothetical.
 */
function acquireDb(op: string): Database | null {
  if (useFallback) return null
  try {
    return getDb()
  } catch (err) {
    activateFallback(`${op}: ${friendly(err, 'unknown')}`)
    return null
  }
}

/**
 * Run one statement group against a live DB, retrying a transient SQLITE_BUSY.
 * Anything still failing after the retries is rethrown — the rows are on disk,
 * and a caller must learn this operation did not happen rather than be handed a
 * fake-empty result that reads as "the user never saved anything".
 */
function runDb<T>(op: string, fn: () => T): T {
  try {
    return withWriteRetry(fn, { label: `plan-goal-persistence.${op}` })
  } catch (err) {
    console.error(
      `[plan-goal-persistence] ${op} failed against the database: ${friendly(
        err,
        'unknown'
      )} — surfacing to the caller (persistence is NOT being downgraded to memory)`
    )
    throw err
  }
}

export function isUsingMemoryFallback(): boolean {
  return useFallback
}

function memBucket(key: string): ConvBucket {
  let b = memoryFallback.get(key)
  if (!b) {
    b = { planSteps: [], goals: [] }
    memoryFallback.set(key, b)
  }
  return b
}

// Backward-compatible mappers: a goal row from a DB migrated to v32 but not yet v36
// (goal-owned loop bridge partial) has no loop_* columns; `?? null`/`?? default`
// keeps rowToGoal total. Same for a lifecycle default that predates a backfill.
function rowToGoal(r: GoalRow): Goal {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? undefined,
    dueDate: r.due_date ?? undefined,
    status: r.status,
    lifecycleStatus: r.lifecycle_status ?? 'open',
    lastActor: r.last_actor ?? 'system',
    tokenBudget: r.token_budget ?? null,
    tokenUsed: r.token_used ?? 0,
    timeBudgetMs: r.time_budget_ms ?? null,
    elapsedMs: r.elapsed_ms ?? 0,
    activeSince: r.active_since ?? null,
    pausedAt: r.paused_at ?? null,
    completedAt: r.completed_at ?? null,
    abortedAt: r.aborted_at ?? null,
    blocker: r.blocker ?? null,
    completion: r.completion ?? null,
    transitionReason: r.transition_reason ?? null,
    loopId: r.loop_id ?? null,
    loopMaxIterations: r.loop_max_iterations ?? null,
    loopMaxWallclockMs: r.loop_max_wallclock_ms ?? null,
    loopTokenBudget: r.loop_token_budget ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export function loadPlanSteps(key: string): PlanStep[] {
  const db = acquireDb('loadPlanSteps')
  if (db) {
    return runDb('loadPlanSteps', () => {
      const rows = db
        .prepare(`SELECT * FROM plan_steps WHERE conversation_id = ? ORDER BY position ASC`)
        .all(key) as PlanRow[]
      return rows.map((r) => ({ id: r.id, text: r.text, status: r.status }))
    })
  }
  return memBucket(key).planSteps.map((s) => ({ ...s }))
}

export function loadGoals(key: string): Goal[] {
  const db = acquireDb('loadGoals')
  if (db) {
    return runDb('loadGoals', () => {
      const rows = db
        .prepare(`SELECT * FROM goals WHERE conversation_id = ?`)
        .all(key) as GoalRow[]
      return rows.map(rowToGoal)
    })
  }
  return memBucket(key).goals.map((g) => ({ ...g }))
}

/**
 * Replace the persisted plan for a conversation with `steps`. The in-memory
 * plan is a small ordered array that update_plan rewrites wholesale, so a
 * delete-then-insert inside one transaction is the simplest faithful mirror;
 * `position` preserves order on reload.
 */
export function savePlanSteps(key: string, steps: PlanStep[]): void {
  const db = acquireDb('savePlanSteps')
  if (db) {
    runDb('savePlanSteps', () => {
      const now = Date.now()
      // A better-sqlite3 transaction rolls back automatically if it throws, so
      // retrying the whole delete-then-insert on a transient BUSY is safe.
      const replace = db.transaction((rows: PlanStep[]) => {
        db.prepare(`DELETE FROM plan_steps WHERE conversation_id = ?`).run(key)
        const insert = db.prepare(
          `INSERT INTO plan_steps
             (id, conversation_id, text, status, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        rows.forEach((s, i) => insert.run(s.id, key, s.text, s.status, i, now, now))
      })
      replace(steps)
    })
    return
  }
  memBucket(key).planSteps = steps.map((s) => ({ ...s }))
}

/** Insert or update a single goal (goals carry stable ids + their own timestamps). */
export function upsertGoal(key: string, goal: Goal): void {
  const db = acquireDb('upsertGoal')
  if (db) {
    runDb('upsertGoal', () => {
      db.prepare(
        `INSERT INTO goals
             (id, conversation_id, title, description, due_date, status,
              lifecycle_status, last_actor, token_budget, token_used, time_budget_ms,
              elapsed_ms, active_since, paused_at, completed_at, aborted_at,
              blocker, completion, transition_reason, loop_id, loop_max_iterations,
              loop_max_wallclock_ms, loop_token_budget, created_at, updated_at)
           VALUES (@id, @conversation_id, @title, @description, @due_date, @status,
              @lifecycle_status, @last_actor, @token_budget, @token_used, @time_budget_ms,
              @elapsed_ms, @active_since, @paused_at, @completed_at, @aborted_at,
              @blocker, @completion, @transition_reason, @loop_id, @loop_max_iterations,
              @loop_max_wallclock_ms, @loop_token_budget, @created_at, @updated_at)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             description = excluded.description,
             due_date = excluded.due_date,
             status = excluded.status,
             lifecycle_status = excluded.lifecycle_status,
             last_actor = excluded.last_actor,
             token_budget = excluded.token_budget,
             token_used = excluded.token_used,
             time_budget_ms = excluded.time_budget_ms,
             elapsed_ms = excluded.elapsed_ms,
             active_since = excluded.active_since,
             paused_at = excluded.paused_at,
             completed_at = excluded.completed_at,
             aborted_at = excluded.aborted_at,
             blocker = excluded.blocker,
             completion = excluded.completion,
             transition_reason = excluded.transition_reason,
             loop_id = excluded.loop_id,
             loop_max_iterations = excluded.loop_max_iterations,
             loop_max_wallclock_ms = excluded.loop_max_wallclock_ms,
             loop_token_budget = excluded.loop_token_budget,
             updated_at = excluded.updated_at`
      ).run({
        id: goal.id,
        conversation_id: key,
        title: goal.title,
        description: goal.description ?? null,
        due_date: goal.dueDate ?? null,
        status: goal.status,
        lifecycle_status: goal.lifecycleStatus,
        last_actor: goal.lastActor,
        token_budget: goal.tokenBudget,
        token_used: goal.tokenUsed,
        time_budget_ms: goal.timeBudgetMs,
        elapsed_ms: goal.elapsedMs,
        active_since: goal.activeSince,
        paused_at: goal.pausedAt,
        completed_at: goal.completedAt,
        aborted_at: goal.abortedAt,
        blocker: goal.blocker,
        completion: goal.completion,
        transition_reason: goal.transitionReason,
        loop_id: goal.loopId,
        loop_max_iterations: goal.loopMaxIterations,
        loop_max_wallclock_ms: goal.loopMaxWallclockMs,
        loop_token_budget: goal.loopTokenBudget,
        created_at: goal.createdAt,
        updated_at: goal.updatedAt
      })
    })
    return
  }
  const bucket = memBucket(key)
  const idx = bucket.goals.findIndex((g) => g.id === goal.id)
  if (idx >= 0) bucket.goals[idx] = { ...goal }
  else bucket.goals.push({ ...goal })
}

/** Delete a single goal (the `clear` terminal action). */
export function removeGoal(key: string, goalId: string): void {
  const db = acquireDb('removeGoal')
  if (db) {
    runDb('removeGoal', () => {
      db.prepare('DELETE FROM goals WHERE conversation_id = ? AND id = ?').run(key, goalId)
    })
    return
  }
  const bucket = memBucket(key)
  bucket.goals = bucket.goals.filter((goal) => goal.id !== goalId)
}

/** Every conversation that has any plan or goal state, with that state loaded. */
export function listAllPlanGoalState(): ConversationPlanGoalState[] {
  const db = acquireDb('listAllPlanGoalState')
  if (db) {
    const keys = runDb(
      'listAllPlanGoalState',
      () =>
        db
          .prepare(
            `SELECT conversation_id FROM plan_steps
           UNION
           SELECT conversation_id FROM goals`
          )
          .all() as Array<{ conversation_id: string }>
    )
    return keys.map((r) => ({
      conversationId: r.conversation_id,
      planSteps: loadPlanSteps(r.conversation_id),
      goals: loadGoals(r.conversation_id)
    }))
  }
  return [...memoryFallback.entries()]
    .filter(([, b]) => b.planSteps.length > 0 || b.goals.length > 0)
    .map(([key, b]) => ({
      conversationId: key,
      planSteps: b.planSteps.map((s) => ({ ...s })),
      goals: b.goals.map((g) => ({ ...g }))
    }))
}

/** Remove all plan + goal state for one conversation. */
export function clearConversation(key: string): void {
  const db = acquireDb('clearConversation')
  if (db) {
    runDb('clearConversation', () => {
      db.prepare(`DELETE FROM plan_steps WHERE conversation_id = ?`).run(key)
      db.prepare(`DELETE FROM goals WHERE conversation_id = ?`).run(key)
    })
    return
  }
  memoryFallback.delete(key)
}

/** Remove all plan + goal state across every conversation. */
export function clearAllPlanGoalState(): void {
  const db = acquireDb('clearAllPlanGoalState')
  if (db) {
    runDb('clearAllPlanGoalState', () => {
      db.prepare(`DELETE FROM plan_steps`).run()
      db.prepare(`DELETE FROM goals`).run()
    })
    return
  }
  memoryFallback.clear()
}

/** Test-only: drop the in-memory fallback so tests start from a clean slate. */
export function __resetPlanGoalPersistence(): void {
  memoryFallback.clear()
  useFallback = false
}

/** Test-only: force the in-memory fallback path (no real database available). */
export function __forceMemoryFallback(): void {
  useFallback = true
}
