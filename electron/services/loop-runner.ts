import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { getDb } from './database'
import { saveMessage, getConversation } from './conversation-store'
import { boundedJsonPreview, recordEvent } from './event-log'
import { readSettings } from './settings-helper'

export type LoopWakeupStatus = 'pending' | 'fired' | 'cancelled' | 'error'

export interface LoopWakeup {
  id: string
  conversationId: string
  fireAt: number
  prompt: string
  reason: string | null
  status: LoopWakeupStatus
  createdAt: number
  firedAt: number | null
  error: string | null
}

export interface ScheduleWakeupInput {
  conversationId: string
  delaySeconds: number
  prompt: string
  reason?: string | null
}

const WAKEUP_PREFIX = '[scheduled wake-up]'
let timer: NodeJS.Timeout | null = null

// LP-1 (Loop Phase) — injected headless turn runner. `chat.ts` wires this at
// handler-registration time via setLoopTurnRunner. Injection (rather than a
// direct import) avoids a service→ipc cycle: loop-runner is a service, while
// runHeadlessTurn lives in ipc/chat.ts. When unset (unit tests, or before
// wiring) a fired wake-up still persists its user message — it just won't
// auto-run a turn, which is the pre-LP-1 behaviour.
export type LoopTurnRunner = (input: {
  conversationId: string
  model: string
  promptBody?: string
  /** External cancel signal (the loop's per-iteration watchdog). When wired,
   *  the production runner threads it into runHeadlessTurn → runChatRound so an
   *  iteration-timeout abort actually interrupts the turn (Bug 2). */
  signal?: AbortSignal
}) => Promise<unknown>

/** Wall-clock ceiling for a wake-up turn. Mirrors loop-controller's
 *  DEFAULT_ITERATION_TIMEOUT_MS rather than importing it: loop-controller imports this
 *  module's scheduleWakeup, so reaching back would close a cycle. */
const WAKEUP_TURN_TIMEOUT_MS = 10 * 60_000

let turnRunner: LoopTurnRunner | null = null

export function setLoopTurnRunner(fn: LoopTurnRunner | null): void {
  turnRunner = fn
}

export function getLoopTurnRunner(): LoopTurnRunner | null {
  return turnRunner
}

function rowToWakeup(row: any): LoopWakeup {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    fireAt: row.fire_at,
    prompt: row.prompt,
    reason: row.reason ?? null,
    status: row.status,
    createdAt: row.created_at,
    firedAt: row.fired_at ?? null,
    error: row.error ?? null
  }
}

function emit(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

export function formatWakeupMessage(wakeup: LoopWakeup): string {
  const reason = wakeup.reason?.trim()
  return `${WAKEUP_PREFIX}${reason ? ` ${reason}` : ''}\n\n${wakeup.prompt}`
}

export function isWakeupMessage(content: string): boolean {
  return content.startsWith(WAKEUP_PREFIX)
}

export function scheduleWakeup(input: ScheduleWakeupInput): LoopWakeup {
  if (!input.conversationId || typeof input.conversationId !== 'string') {
    throw new Error('conversationId required')
  }
  if (!getConversation(input.conversationId)) {
    throw new Error('conversation not found')
  }
  if (!Number.isFinite(input.delaySeconds) || input.delaySeconds < 0) {
    throw new Error('delaySeconds must be a non-negative number')
  }
  if (!input.prompt || typeof input.prompt !== 'string') {
    throw new Error('prompt required')
  }
  const now = Date.now()
  const row = {
    id: randomUUID(),
    conversation_id: input.conversationId,
    fire_at: now + Math.round(input.delaySeconds * 1000),
    prompt: input.prompt,
    reason: input.reason?.trim() || null,
    status: 'pending',
    created_at: now,
    fired_at: null,
    error: null
  }
  getDb()
    .prepare(
      `INSERT INTO loop_wakeups
       (id, conversation_id, fire_at, prompt, reason, status, created_at, fired_at, error)
       VALUES (@id, @conversation_id, @fire_at, @prompt, @reason, @status, @created_at, @fired_at, @error)`
    )
    .run(row)
  const wakeup = rowToWakeup(row)
  emit('loop:wakeup:scheduled', wakeup)
  recordLoopEvent('loop.wakeup.scheduled', wakeup)
  return wakeup
}

export function cancelWakeup(id: string): boolean {
  const now = Date.now()
  const result = getDb()
    .prepare(
      "UPDATE loop_wakeups SET status = 'cancelled', fired_at = ? WHERE id = ? AND status = 'pending'"
    )
    .run(now, id)
  const changed = result.changes > 0
  if (changed) emit('loop:wakeup:cancelled', { id, cancelledAt: now })
  return changed
}

export function listWakeups(filter?: {
  conversationId?: string
  status?: LoopWakeupStatus | LoopWakeupStatus[]
  limit?: number
}): LoopWakeup[] {
  const where: string[] = []
  const params: unknown[] = []
  if (filter?.conversationId) {
    where.push('conversation_id = ?')
    params.push(filter.conversationId)
  }
  if (filter?.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
    where.push(`status IN (${statuses.map(() => '?').join(',')})`)
    params.push(...statuses)
  }
  const limit = Math.min(Math.max(filter?.limit ?? 100, 1), 500)
  const sql =
    'SELECT * FROM loop_wakeups' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY fire_at ASC LIMIT ?'
  return getDb()
    .prepare(sql)
    .all(...params, limit)
    .map(rowToWakeup)
}

export function fireDueWakeups(now = Date.now()): LoopWakeup[] {
  const db = getDb()
  const rows = db
    .prepare(
      "SELECT * FROM loop_wakeups WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at ASC LIMIT 50"
    )
    .all(now) as any[]
  const fired: LoopWakeup[] = []
  for (const raw of rows) {
    const wakeup = rowToWakeup(raw)
    try {
      const msg = saveMessage({
        id: randomUUID(),
        conversationId: wakeup.conversationId,
        role: 'user',
        content: formatWakeupMessage(wakeup)
      })
      db.prepare(
        "UPDATE loop_wakeups SET status = 'fired', fired_at = ?, error = NULL WHERE id = ?"
      ).run(now, wakeup.id)
      const done = { ...wakeup, status: 'fired' as const, firedAt: now }
      fired.push(done)
      emit('loop:wakeup:fired', { wakeup: done, message: msg })
      recordLoopEvent('loop.wakeup.fired', done)
      // LP-1 — actually RUN the turn. Before this, a fired wake-up only
      // injected the user message and the renderer reloaded it; nothing
      // answered (G1). Now the injected prompt drives a real headless turn.
      // Fire-and-forget: a long turn must not block the 30s wake-up tick.
      //
      // SAFETY — the `backgroundAutonomy` kill switch governs UNATTENDED agent
      // turns, and this dispatch is one: chat.ts wires turnRunner straight to
      // runHeadlessTurn({ unattended: true }) with the whole model→tool→feedback
      // loop live, and each fired turn can schedule the NEXT wake-up. Without
      // this gate an operator who switched background autonomy OFF still got
      // billable, tool-capable turns indefinitely. Every sibling scheduler reads
      // the same flag (automations-runner, loop-scheduler, loop-controller,
      // loop-agent); loop-runner was the single path that never did.
      //
      // What made it invisible: the wake-up is scheduled by an auto-approved
      // tool (loop-tool-pack declares risks:['write'], and 'write' is not in
      // GATING_RISKS, so no approval modal ever appears), and because a wake-up
      // is not an automation it surfaces in no Automations panel.
      //
      // Gate the TURN only, not the row: we still persist the injected user
      // message and consume the pending row, so the operator sees the wake-up in
      // the conversation and can answer it by hand — and so re-enabling autonomy
      // later does not stampede a backlog of stale rows all at once.
      // `=== true` (not `!== false`) keeps a missing key default-safe.
      if (turnRunner && readSettings().backgroundAutonomy === true) {
        const conv = getConversation(wakeup.conversationId)
        const model = conv?.model ?? 'deepseek-v4-pro'
        // BOUND the wake-up turn. LoopTurnRunner takes a signal precisely so an
        // iteration timeout can interrupt a turn, and this call passed neither a signal
        // nor any deadline — so a self-paced loop's auto-approved schedule_wakeup fired a
        // turn that could run forever with nothing able to cancel it. Every OTHER loop
        // turn goes through runLoopIteration, which is watchdogged; this path was the
        // one that was not.
        const ctl = new AbortController()
        const watchdog = setTimeout(() => ctl.abort(), WAKEUP_TURN_TIMEOUT_MS)
        void turnRunner({
          conversationId: wakeup.conversationId,
          model,
          promptBody: wakeup.prompt,
          signal: ctl.signal
        })
          .catch((err) => {
            console.error('[loops] wake-up turn failed:', err)
          })
          .finally(() => clearTimeout(watchdog))
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      db.prepare(
        "UPDATE loop_wakeups SET status = 'error', fired_at = ?, error = ? WHERE id = ?"
      ).run(now, error, wakeup.id)
      emit('loop:wakeup:error', { id: wakeup.id, error })
    }
  }
  return fired
}

/**
 * How long after start* the first tick runs. Long enough that the window is up
 * and painted; short enough that a due wake-up still feels like it fired at
 * launch.
 */
const FIRST_TICK_DELAY_MS = 8_000

export function startLoopWakeups(): void {
  if (timer) return
  const tick = (): void => {
    try {
      fireDueWakeups()
    } catch (err) {
      console.error('[loops] wake-up tick failed:', err)
    }
  }
  // The first tick used to run inline. startLoopWakeups() is called from the
  // synchronous app.whenReady() block, so a due wake-up ran an entire turn
  // before the window existed — the user waited on work they could not see.
  // Still fire promptly (a due wake-up should not wait a full interval), just
  // not before the app is on screen.
  setTimeout(tick, FIRST_TICK_DELAY_MS).unref?.()
  timer = setInterval(tick, 30_000)
}

export function stopLoopWakeups(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

function recordLoopEvent(type: 'loop.wakeup.scheduled' | 'loop.wakeup.fired', wakeup: LoopWakeup): void {
  try {
    recordEvent({
      type,
      actorKind: type === 'loop.wakeup.scheduled' ? 'model' : 'system',
      severity: 'info',
      conversationId: wakeup.conversationId,
      entityKind: 'loop_wakeup',
      entityId: wakeup.id,
      payload: {
        id: wakeup.id,
        fireAt: wakeup.fireAt,
        reason: wakeup.reason,
        status: wakeup.status,
        promptPreview: boundedJsonPreview(wakeup.prompt)
      }
    })
  } catch (err) {
    console.error('[loops] event write failed:', err)
  }
}
