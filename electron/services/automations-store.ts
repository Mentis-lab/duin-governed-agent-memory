import { randomUUID } from 'crypto'
import { getDb } from './database'
import { describeCron } from './cron-expr'
import {
  initialNextRunAt,
  legacyCronTrigger,
  parseAutomationTrigger,
  parseStoredAutomationTrigger,
  serializeAutomationTrigger,
  type AutomationTrigger,
  type AutomationTriggerKind
} from './automation-trigger'

// Automations store — MERGE of DUIN's cron+deliver_to model with upstream Lamprey's
// trigger taxonomy (one_shot/schedule/event/monitor), goal binding, per-automation
// loop ceilings, and the durable automation_runs idempotency ledger.
//
// DUIN-SPECIFIC (kept, not in upstream): `deliverTo` — the JSON ChannelRef that the
// runner delivers each reply to. Upstream dropped it; DUIN's proactive delivery + the
// digest short-circuit depend on it, so it stays.

export interface AutomationRow {
  id: string
  label: string
  cron: string
  prompt: string
  model: string | null
  enabled: 0 | 1
  created_at: number
  last_run_at: number | null
  last_result: string | null
  /** DUIN: JSON-encoded ChannelRef {kind,target} for cron→channel delivery, or NULL. */
  deliver_to: string | null
  // Trigger taxonomy (v34).
  trigger_kind: AutomationTriggerKind
  trigger_config_json: string
  next_run_at: number | null
  last_trigger_key: string | null
  retry_attempt: number
  retry_at: number | null
  disabled_reason: string | null
  // Goal binding + loop-ceiling overrides (v35).
  goal_id: string | null
  goal_conversation_id: string | null
  loop_max_iterations: number | null
  loop_max_wallclock_ms: number | null
  loop_token_budget: number | null
}

export interface Automation {
  id: string
  label: string
  cron: string
  prompt: string
  model: string | null
  enabled: boolean
  createdAt: number
  lastRunAt: number | null
  lastResult: string | null
  /** The schedule in words ("Every Sunday 21:00"), or null when the cron won't parse. */
  scheduleLabel: string | null
  /** DUIN: JSON-encoded ChannelRef {kind,target} for cron→channel delivery, or null. */
  deliverTo: string | null
  trigger: AutomationTrigger
  nextRunAt: number | null
  lastTriggerKey: string | null
  retryAttempt: number
  retryAt: number | null
  disabledReason: string | null
  goalId: string | null
  goalConversationId: string | null
  loopMaxIterations: number | null
  loopMaxWallclockMs: number | null
  loopTokenBudget: number | null
}

export interface AutomationRun {
  id: string
  automationId: string
  triggerKey: string
  triggerKind: AutomationTriggerKind | 'manual'
  scheduledAt: number | null
  startedAt: number
  finishedAt: number | null
  attempt: number
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  result: string | null
  error: string | null
}

interface AutomationRunRow {
  id: string
  automation_id: string
  trigger_key: string
  trigger_kind: AutomationTriggerKind | 'manual'
  scheduled_at: number | null
  started_at: number
  finished_at: number | null
  attempt: number
  status: AutomationRun['status']
  result: string | null
  error: string | null
}

function cronForTrigger(trigger: AutomationTrigger, fallback = ''): string {
  return trigger.kind === 'schedule' && trigger.cron ? trigger.cron : fallback
}

function fromRow(r: AutomationRow): Automation {
  const trigger = parseStoredAutomationTrigger(r.trigger_config_json, r.cron)
  return {
    id: r.id,
    label: r.label,
    cron: r.cron,
    prompt: r.prompt,
    model: r.model,
    enabled: !!r.enabled,
    createdAt: r.created_at,
    lastRunAt: r.last_run_at,
    lastResult: r.last_result,
    // Computed here so there is ONE humanizer. The renderer showed the raw expression
    // because describeCron lives in the main process — and a second copy in the renderer
    // is exactly how this repo ended up with two cron parsers that drifted apart.
    scheduleLabel: describeCron(r.cron),
    deliverTo: r.deliver_to ?? null,
    trigger,
    nextRunAt: r.next_run_at ?? null,
    lastTriggerKey: r.last_trigger_key ?? null,
    retryAttempt: r.retry_attempt ?? 0,
    retryAt: r.retry_at ?? null,
    disabledReason: r.disabled_reason ?? null,
    goalId: r.goal_id ?? null,
    goalConversationId: r.goal_conversation_id ?? null,
    loopMaxIterations: r.loop_max_iterations ?? null,
    loopMaxWallclockMs: r.loop_max_wallclock_ms ?? null,
    loopTokenBudget: r.loop_token_budget ?? null
  }
}

function runFromRow(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    triggerKey: row.trigger_key,
    triggerKind: row.trigger_kind,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    attempt: row.attempt,
    status: row.status,
    result: row.result,
    error: row.error
  }
}

export function listAutomations(): Automation[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM automations ORDER BY created_at DESC')
    .all() as AutomationRow[]
  return rows.map(fromRow)
}

export function getAutomation(id: string): Automation | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as
    | AutomationRow
    | undefined
  return row ? fromRow(row) : null
}

export function createAutomation(input: {
  label: string
  cron?: string
  prompt: string
  model?: string | null
  /** DUIN: JSON-encoded ChannelRef {kind,target}; when set, each run delivers its
   *  reply to that channel after recording. */
  deliverTo?: string | null
  trigger?: AutomationTrigger
  goalId?: string | null
  goalConversationId?: string | null
  loopMaxIterations?: number | null
  loopMaxWallclockMs?: number | null
  loopTokenBudget?: number | null
  now?: number
}): Automation {
  const db = getDb()
  const id = randomUUID()
  const now = input.now ?? Date.now()
  const trigger = input.trigger
    ? parseAutomationTrigger(input.trigger)
    : legacyCronTrigger(input.cron ?? '')
  const cron = cronForTrigger(trigger, input.cron ?? '')
  const nextRunAt = initialNextRunAt(trigger, now)
  db.prepare(
    `INSERT INTO automations (
       id, label, cron, prompt, model, enabled, created_at, deliver_to,
       trigger_kind, trigger_config_json, next_run_at,
       goal_id, goal_conversation_id, loop_max_iterations, loop_max_wallclock_ms, loop_token_budget
     ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.label,
    cron,
    input.prompt,
    input.model ?? null,
    now,
    input.deliverTo ?? null,
    trigger.kind,
    serializeAutomationTrigger(trigger),
    nextRunAt,
    input.goalId ?? null,
    input.goalConversationId ?? null,
    input.loopMaxIterations ?? null,
    input.loopMaxWallclockMs ?? null,
    input.loopTokenBudget ?? null
  )
  return getAutomation(id)!
}

export function updateAutomation(
  id: string,
  patch: Partial<{
    label: string
    cron: string
    prompt: string
    model: string | null
    enabled: boolean
    deliverTo: string | null
    trigger: AutomationTrigger
    goalId: string | null
    goalConversationId: string | null
    loopMaxIterations: number | null
    loopMaxWallclockMs: number | null
    loopTokenBudget: number | null
    now: number
  }>
): Automation | null {
  const db = getDb()
  const current = db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as
    | AutomationRow
    | undefined
  if (!current) return null

  const now = patch.now ?? Date.now()
  const currentTrigger = parseStoredAutomationTrigger(current.trigger_config_json, current.cron)
  const nextTrigger = patch.trigger
    ? parseAutomationTrigger(patch.trigger)
    : patch.cron !== undefined
      ? legacyCronTrigger(patch.cron)
      : currentTrigger
  const triggerChanged = patch.trigger !== undefined || patch.cron !== undefined
  const enabled = patch.enabled === undefined ? !!current.enabled : patch.enabled
  const nextRunAt = triggerChanged ? initialNextRunAt(nextTrigger, now) : current.next_run_at

  db.prepare(
    `UPDATE automations
        SET label = ?, cron = ?, prompt = ?, model = ?, enabled = ?, deliver_to = ?,
            trigger_kind = ?, trigger_config_json = ?, next_run_at = ?,
            retry_attempt = ?, retry_at = ?, disabled_reason = ?,
            goal_id = ?, goal_conversation_id = ?, loop_max_iterations = ?,
            loop_max_wallclock_ms = ?, loop_token_budget = ?
      WHERE id = ?`
  ).run(
    patch.label ?? current.label,
    cronForTrigger(nextTrigger, patch.cron ?? current.cron),
    patch.prompt ?? current.prompt,
    patch.model !== undefined ? patch.model : current.model,
    enabled ? 1 : 0,
    patch.deliverTo !== undefined ? patch.deliverTo : current.deliver_to,
    nextTrigger.kind,
    serializeAutomationTrigger(nextTrigger),
    nextRunAt,
    triggerChanged ? 0 : current.retry_attempt,
    triggerChanged ? null : current.retry_at,
    enabled ? null : (current.disabled_reason ?? 'disabled'),
    patch.goalId !== undefined ? patch.goalId : current.goal_id,
    patch.goalConversationId !== undefined
      ? patch.goalConversationId
      : current.goal_conversation_id,
    patch.loopMaxIterations !== undefined ? patch.loopMaxIterations : current.loop_max_iterations,
    patch.loopMaxWallclockMs !== undefined
      ? patch.loopMaxWallclockMs
      : current.loop_max_wallclock_ms,
    patch.loopTokenBudget !== undefined ? patch.loopTokenBudget : current.loop_token_budget,
    id
  )
  return getAutomation(id)
}

export function recordRun(id: string, result: string): void {
  const db = getDb()
  db.prepare('UPDATE automations SET last_run_at = ?, last_result = ? WHERE id = ?').run(
    Date.now(),
    result,
    id
  )
}

export function deleteAutomation(id: string): void {
  getDb().prepare('DELETE FROM automations WHERE id = ?').run(id)
}

/**
 * Arm a backoff retry for an automation whose run just failed transiently. Persists the
 * wall-clock time the next attempt becomes due (`retryAt`, from the trigger's exponential
 * backoff) and the attempt number that retry will run as. The runner's tick scans for
 * `retry_at <= now` and fires attempt `retry_attempt`. Bounded by the caller (retryAt()
 * returns null once maxAttempts is spent), so this is never an unbounded re-enqueue.
 */
export function armAutomationRetry(id: string, retryAt: number, retryAttempt: number): void {
  getDb()
    .prepare('UPDATE automations SET retry_at = ?, retry_attempt = ? WHERE id = ?')
    .run(retryAt, retryAttempt, id)
}

/**
 * Advance (or clear) the persisted next-fire time for a NON-cron trigger.
 *
 * `next_run_at` was written by create/update and read by nothing — which is half of
 * why one_shot / schedule{everySeconds} / monitor never fired: the runner only ever
 * matched `parseCron(a.cron)`, and `cronForTrigger` stores '' for those kinds, so
 * parseCron threw and the automation was skipped forever. It is now the dueness
 * cursor for the interval-shaped triggers: the runner advances it after every fire
 * (via nextRunAfterSettlement) and writes NULL for a spent one_shot so it cannot
 * re-attempt a claim on every subsequent tick.
 */
export function setAutomationNextRun(id: string, nextRunAt: number | null): void {
  getDb().prepare('UPDATE automations SET next_run_at = ? WHERE id = ?').run(nextRunAt, id)
}

/**
 * Disable an automation and RECORD WHY. Used by the runner when a trigger cannot be
 * scheduled at all (an unreadable row, an invalid cron, a trigger kind this build does
 * not dispatch). The alternative — skipping it every tick — is the silent no-op that
 * let an automation sit in the panel looking healthy while it could never fire.
 * `disabled_reason` is surfaced on the card.
 */
export function disableAutomation(id: string, reason: string): void {
  getDb()
    .prepare('UPDATE automations SET enabled = 0, disabled_reason = ? WHERE id = ?')
    .run(reason, id)
}

/** Clear any pending backoff retry (the run finally succeeded, was aborted, or the
 *  retry budget is exhausted) so a stale `retry_at` never re-fires a settled job. */
export function clearAutomationRetry(id: string): void {
  getDb()
    .prepare('UPDATE automations SET retry_at = NULL, retry_attempt = 0 WHERE id = ?')
    .run(id)
}

// ─── automation_runs — durable idempotency ledger (v33) ──────────────────────

/**
 * Claim a run for (automationId, triggerKey, attempt). INSERT OR IGNORE against the
 * UNIQUE(automation_id, trigger_key, attempt) constraint: exactly one caller wins the
 * claim; every duplicate (a second tick this minute, or a post-restart re-fire of the
 * same trigger) loses and gets null. Returns the run id on claim, null when already
 * claimed. This is the durable replacement for the in-memory lastFiredMinute map.
 *
 * `consumeRetryFor` makes the claim and the disarming of the retry that produced it a
 * SINGLE transaction. They used to be two un-transacted statements in the runner, and
 * the window between them was fatal: crash after the INSERT and before the clear, boot
 * recovery flips the row to 'interrupted', and `retry_at` stays armed at a timestamp
 * permanently in the past. Every later tick then takes the retry branch, loses the
 * claim to its own orphaned row, and never reaches the cron match — a daily automation
 * that fails once and crashes during the retry never runs again, with `disabled_reason`
 * unset so the UI still shows it healthy. Committing both together removes the window.
 */
export function beginAutomationRun(input: {
  automationId: string
  triggerKey: string
  triggerKind: AutomationTriggerKind | 'manual'
  scheduledAt: number | null
  attempt: number
  startedAt: number
  /** Automation id whose armed retry this claim consumes. Cleared in the SAME
   *  transaction as the claim INSERT, and only when the claim is won. */
  consumeRetryFor?: string
}): string | null {
  const db = getDb()
  const id = randomUUID()
  const claim = db.prepare(
    `INSERT OR IGNORE INTO automation_runs (
       id, automation_id, trigger_key, trigger_kind, scheduled_at, started_at, attempt, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`
  )
  const disarm = db.prepare(
    'UPDATE automations SET retry_at = NULL, retry_attempt = 0 WHERE id = ?'
  )
  const claimAndDisarm = db.transaction(() => {
    const result = claim.run(
      id,
      input.automationId,
      input.triggerKey,
      input.triggerKind,
      input.scheduledAt,
      input.startedAt,
      input.attempt
    )
    if (result.changes !== 1) return null
    if (input.consumeRetryFor) disarm.run(input.consumeRetryFor)
    return id
  })
  return claimAndDisarm()
}

/** Settle a claimed run row to completed/failed. Best-effort; only flips a row still
 *  'running' so a late writer can't resurrect a settled run. */
export function settleAutomationRun(input: {
  runId: string
  status: 'completed' | 'failed'
  finishedAt: number
  result?: string | null
  error?: string | null
}): void {
  getDb()
    .prepare(
      `UPDATE automation_runs
          SET status = ?, finished_at = ?, result = ?, error = ?
        WHERE id = ? AND status = 'running'`
    )
    .run(input.status, input.finishedAt, input.result ?? null, input.error ?? null, input.runId)
}

export function listAutomationRuns(automationId: string, limit = 20): AutomationRun[] {
  const bounded = Math.max(1, Math.min(100, Math.floor(limit)))
  return (
    getDb()
      .prepare(
        `SELECT * FROM automation_runs
          WHERE automation_id = ?
          ORDER BY started_at DESC, attempt DESC
          LIMIT ?`
      )
      .all(automationId, bounded) as AutomationRunRow[]
  ).map(runFromRow)
}

/**
 * Retention sweep for the automation_runs ledger. Deletes TERMINAL rows
 * (completed/failed/interrupted) whose started_at is older than `olderThanMs`,
 * bounding the unbounded growth this table would otherwise suffer in an always-on
 * app — a `* * * * *` automation claims ~1,440 durable rows/day/automation that
 * nothing ever deletes, and both indexes grow with it. Mirrors pruneDelivered/
 * pruneInteractions, which bound the sibling proactive stores from the same tick.
 * Returns the number of rows deleted.
 *
 * SAFETY — the row doubles as the idempotency LEASE (UNIQUE(automation_id,
 * trigger_key, attempt)); deleting a key that could still be re-fired this window
 * would let the same (trigger, attempt) run twice. Two guards keep that safe:
 *   1. a still-'running' row is NEVER touched — it is an open claim/lease.
 *   2. only rows aged well past any live trigger window are dropped. trigger_key is
 *      a date-inclusive per-MINUTE key, so any `olderThanMs` >> 60s leaves every
 *      recent fire-lease intact; the caller passes the 24h proactive-retention
 *      window — orders of magnitude past the minute granularity. The status+started_at
 *      predicate is served directly by idx_automation_runs_status(status, started_at).
 */
export function pruneAutomationRuns(olderThanMs: number, now = Date.now()): number {
  const res = getDb()
    .prepare(
      `DELETE FROM automation_runs
        WHERE status IN ('completed', 'failed', 'interrupted')
          AND started_at < ?`
    )
    .run(now - olderThanMs)
  return res.changes
}

/** Boot recovery: mark any run still 'running' (a run interrupted by an app crash/quit)
 *  as 'interrupted' so it never blocks a fresh claim and the ledger stays truthful. */
export function recoverInterruptedAutomationRuns(now = Date.now()): number {
  const db = getDb()
  const res = db
    .prepare(
      "UPDATE automation_runs SET status = 'interrupted', finished_at = ?, error = 'app restarted during run' WHERE status = 'running'"
    )
    .run(now)
  return res.changes
}
