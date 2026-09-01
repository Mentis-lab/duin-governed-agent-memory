// 60-second tick scheduler for automations. The 5-field cron parser it used to
// carry inline now lives in cron-expr.ts — it was a COPY of the one in
// automation-trigger.ts and the two had drifted apart in both directions (see the
// header there). parseCron / describeCron / nextFireAfter are re-exported so
// electron/ipc/automations.ts keeps its existing import surface, but there is now
// exactly one implementation behind them.

import { randomUUID } from 'crypto'
import {
  listAutomations,
  recordRun,
  beginAutomationRun,
  settleAutomationRun,
  armAutomationRetry,
  clearAutomationRetry,
  pruneAutomationRuns,
  setAutomationNextRun,
  disableAutomation,
  type Automation
} from './automations-store'
import {
  initialNextRunAt,
  nextRunAfterSettlement,
  triggerKey,
  unrunnableTriggerReason,
  type AutomationTriggerKind
} from './automation-trigger'
import { retryAt } from './automation-trigger'
import { matches, parseCron, type CronExpr } from './cron-expr'
// Re-exported so electron/ipc/automations.ts (create / update / validateCron) keeps
// importing its validator from here — but it is now the SAME function the store
// writes and reads with, not a second copy that can drift.
export { parseCron, describeCron, nextFireAfter } from './cron-expr'
import { runHeadlessAgent } from './headless-agent'
import { channelDispatch, type ChannelRef } from './channel-dispatch'
import { readSettings } from './settings-helper'
import { boundedJsonPreview, recordEvent } from './event-log'
import { fireHooks } from './hooks-runner'
import { friendly, messageOf } from './guarded'
import { redeliverDue, pruneDelivered } from './proactive/delivery-queue'
import { pruneNotices } from './proactive/notices-store'
import { sweepExpired, pruneInteractions } from './proactive/pending-interactions'
import { watchJobFailed } from './proactive/watchers'
import { parseDigestDirective, deliverDigest, type DigestMode, type DeliverDigestResult } from './proactive/smart-digest'

/** Tools a cron run may call: read-only vault access. A scheduled job is a real
 *  tool-capable agent, but deny-first — no writes, no host-exec (those aren't in
 *  the allow-list, so the capability gate denies).
 *
 *  `send_message` USED to be listed here and could never once run. It carries the
 *  `network` risk, which is in action-class.ts's CAP_RISKS, so tool-exec's unattended
 *  CAP floor refused every call — the floor sits BELOW the capability allow-list and
 *  overrides it. The list was advertising a tool to the model that the layer beneath
 *  always denied, on the most natural automation anyone would write ("check X, message
 *  me if Y"), and `automation.completed` still fired, so nothing surfaced it.
 *
 *  Removing it rather than exempting it, because the capability is not actually lost:
 *  an automation delivers through its configured `deliver_to` target via channelDispatch
 *  (deliverWithRetry below), which is a different path entirely and never touched the
 *  floor. Delivery is already conditional on the model producing output, so "message me
 *  if Y" is served by the model answering only when Y holds.
 *
 *  The alternative — pre-authorising `send_message` for the automation's own configured
 *  target — would be a real capability gain, but it means putting a hole in a deny-first
 *  security floor, and that is a governance decision rather than a defect fix. */
export const CRON_ALLOWED_TOOLS = ['read_file', 'list_dir']

/** Parse the stored deliver_to JSON into a ChannelRef, or null if absent/bad. */
export function parseDeliverTo(raw: string | null | undefined): ChannelRef | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (o && typeof o === 'object' && typeof o.kind === 'string' && o.kind.trim()) {
      return { kind: o.kind, target: typeof o.target === 'string' ? o.target : '' }
    }
  } catch (e) {
    console.debug('[automations] bad deliver_to JSON, skipping delivery:', messageOf(e))
  }
  return null
}

/** Root a cron agent's read-only vault tools anchor to. The configured notes
 *  dir when set, else process.cwd() (headless-agent requires a workspacePath). */
function vaultPath(): string {
  const dir = readSettings().localBrainNotesDir
  return typeof dir === 'string' && dir.trim() ? dir : process.cwd()
}

/** Deliver `text` to `ref` with ONE bounded retry on failure. */
async function deliverWithRetry(ref: ChannelRef, text: string): Promise<void> {
  let res = await channelDispatch(ref, text)
  if (!res.ok) {
    console.debug('[automations] delivery failed, retrying once:', res.error)
    res = await channelDispatch(ref, text)
    if (!res.ok) console.error('[automations] delivery failed after retry:', res.error)
  }
}

let timer: NodeJS.Timeout | null = null
// Idempotency is now the DURABLE automation_runs ledger (beginAutomationRun's
// UNIQUE(automation_id,trigger_key,attempt) claim), NOT an in-memory map. The old
// `lastFiredMinute` Map lost its dedup guarantee on every process restart — a daily
// cron whose minute straddled a relaunch could double-fire. The ledger survives
// restarts, so exactly-once holds across the process boundary too.

/** SAFETY: ids of automations whose runOne is currently executing. The per-minute
 *  stamp above only stops a DOUBLE fire inside one minute; it cannot stop an agent
 *  run that OUTLIVES its minute. runHeadlessAgent's default timeout is 120s, so a
 *  slow run spans two ticks: at t+60s the next tick sees a fresh minuteKey, passes
 *  the stamp, and dispatches a SECOND concurrent agent for the same automation.
 *  The two then race on recordRun (a stale run's write can overwrite the newer
 *  result) and both hit deliverWithRetry (duplicate channel messages). This set is
 *  the in-flight guard that closes that window — mirroring loop-controller's
 *  runningLoops. Cleared in a finally on the dispatched promise. */
const runningAutomations = new Set<string>()
// When each automation was last DISPATCHED. The cadence floor has to measure from
// here, not from `lastRunAt` — see cadenceFloorPasses. In-process only: across a
// restart the floor falls back to the persisted completion time, which is merely
// conservative (one possibly-skipped tick), never faster than the floor.
// Exported ONLY so a test can clear it between cases, mirroring __claimedRuns.
export const __lastDispatchAt = new Map<string, number>()
const lastDispatchAt = __lastDispatchAt

/** Log-once latch for the backgroundAutonomy kill switch in `tick()`. We warn
 *  on the transition INTO the suppressed state and reset it when autonomy
 *  returns, so an always-on app sitting with autonomy OFF doesn't spam the log
 *  every 60s. */
let autonomyGateLogged = false

/** Floor between two dispatches of the SAME automation, whatever its schedule says.
 *  Cron accepts `* * * * *`, and an automation dispatches a real tool-capable billable
 *  agent — once a minute is the runaway shape, not a use case anyone wants. A tick
 *  inside the floor is skipped, never queued, so a fast cron degrades to this cadence
 *  instead of stacking work. An armed retry is exempt: its own backoff already paces it. */
const MIN_DISPATCH_GAP_MS = 5 * 60_000
/** Log-once per automation so a fast cron does not print every tick. */
const cadenceFloorLogged = new Set<string>()

/** Retention for terminal proactive records (delivered receipts / resolved+expired
 *  interactions) before the tick prunes them. 24h keeps a full day of trail for
 *  inspection while bounding the persisted stores in an always-on app. */
const PROACTIVE_RETENTION_MS = 24 * 60 * 60_000
/** The inbox is a catch-up surface, so it holds a week rather than a day. */
const NOTICE_RETENTION_MS = 7 * 24 * 60 * 60_000

/** The home channel ref from settings (fallback delivery target for a digest job
 *  with no explicit deliver_to). OS push if unset. */
function homeChannelRef(): ChannelRef {
  const h = readSettings().homeChannel
  if (h && typeof h === 'object') {
    const o = h as Record<string, unknown>
    return { kind: String(o.kind ?? 'push'), target: String(o.target ?? '') }
  }
  return { kind: 'push', target: '' }
}

/**
 * Run a DETERMINISTIC digest automation (a #duin-digest:{mode} job). Composes the live
 * Home digest + calibration into a brief and delivers it — no model, no prompt. The
 * digest readers are lazily required so a plain automations run (or a test) never drags
 * in the brain graph. Records the run's rendered text.
 *
 * Returns the DeliverDigestResult so the caller can tell a genuine failure from a
 * success. deliverDigest is documented "never throws" — a reader/format/enqueue
 * exception (e.g. getHomeDigest throwing on a corrupt ontology) resolves to
 * {delivered:false, error} rather than propagating. If this function swallowed that
 * into a void return, runOne's try would succeed, the catch would be unreachable, and
 * a digest that fails every morning would emit automation.completed / exit 0. Handing
 * the result back is what lets runOne emit automation.failed instead.
 */
async function runDigestJob(a: { id: string; deliverTo: string | null }, mode: DigestMode): Promise<DeliverDigestResult> {
  const ref = parseDeliverTo(a.deliverTo) ?? homeChannelRef()
  const vault = vaultPath()

  // Lazy dynamic import (not a static top-level import) keeps the brain graph out of a
  // plain automations run's load path — same intent the old `require` had, but a dynamic
  // import is interceptable by the test runner where a native require is not, so the
  // failure-propagation wiring below is actually exercisable. Mirrors the lazy
  // `await import('./output/gmail-send')` seam in channel-dispatch.
  const brain = await import('./brain/index')
  const res = await deliverDigest(mode, {
    getDigest: () => brain.getHomeDigest(vault),
    getCalibration: () => brain.getCalibration(vault),
    ref
  })
  recordRun(a.id, (res.text ?? (res.error ? `[digest error] ${res.error}` : '')).slice(0, 4000))
  return res
}

/**
 * The observable outcome of one automation run.
 *
 * runOne is fire-and-forget for the cron tick, so for a long time it returned void and
 * swallowed every outcome into the event log. That is fine for the scheduler but it left
 * `duin run --automation <id>` unable to tell success from failure: runHeadlessAgent
 * RETURNS {status:'error'} rather than throwing, so nothing propagated out of runOne and
 * the CLI reported "Status: success" / exit 0 for a run that never produced output.
 * Returning the status makes the failure observable to callers that need it; callers that
 * don't (tick) simply ignore it.
 */
export type AutomationRunOutcome =
  | { status: 'ok' }
  | { status: 'truncated'; error: string }
  | { status: 'error'; error: string }
  | { status: 'aborted'; error: string }

async function runOne(autoId: string): Promise<AutomationRunOutcome> {
  const list = listAutomations()
  const a = list.find((x) => x.id === autoId)
  if (!a) return { status: 'error', error: `automation not found: ${autoId}` }

  // Deterministic digest jobs short-circuit the LLM path: a #duin-digest:{mode} prompt
  // is composed + delivered as a grounded brief, not run as a completion.
  const digestMode = parseDigestDirective(a.prompt)
  if (digestMode) {
    const correlationId = randomUUID()
    const startedAt = Date.now()
    emitAutomationEvent('automation.started', { automationId: a.id, label: a.label, cron: a.cron, model: 'digest', correlationId, startedAt })
    try {
      const res = await runDigestJob(a, digestMode)
      // A FAILED DIGEST MUST NOT REPORT AS COMPLETED. deliverDigest never throws — a
      // compose/reader failure (getHomeDigest/getCalibration/render/enqueue raising)
      // comes back as {delivered:false, error}, so the catch below cannot see it. Treat
      // a present `error` as a hard failure and mirror the headless branch: emit
      // automation.failed (severity 'error'), fire the opt-in jobFail watcher, and
      // return {status:'error'} so `duin run --automation` exits non-zero. A merely
      // un-acked delivery receipt (delivered:false with no error) is a transient queue
      // condition the delivery-queue retries — that is NOT a compose failure and, like
      // the non-digest branch's delivery retries, does not fail the run.
      if (res.error) {
        void watchJobFailed({ automationId: a.id, label: a.label, error: res.error })
        emitAutomationEvent('automation.failed', { automationId: a.id, label: a.label, cron: a.cron, model: 'digest', correlationId, startedAt, durationMs: Date.now() - startedAt, error: res.error, errorClass: 'DigestComposeError' })
        return { status: 'error', error: res.error }
      }
      emitAutomationEvent('automation.completed', { automationId: a.id, label: a.label, cron: a.cron, model: 'digest', correlationId, startedAt, durationMs: Date.now() - startedAt, replyPreview: `digest:${digestMode}` })
    } catch (err) {
      recordRun(a.id, `[error] ${friendly(err, 'unknown')}`)
      void watchJobFailed({ automationId: a.id, label: a.label, error: friendly(err, 'unknown') })
      emitAutomationEvent('automation.failed', { automationId: a.id, label: a.label, cron: a.cron, model: 'digest', correlationId, startedAt, durationMs: Date.now() - startedAt, error: friendly(err, 'unknown'), errorClass: (err as { name?: string })?.name })
      return { status: 'error', error: friendly(err, 'unknown') }
    }
    return { status: 'ok' }
  }

  const model = a.model || 'deepseek-v4-flash'
  // Per-run correlation id so the model.request.* events emitted from within
  // chatOnce join the automation.started/completed event-log row group. Each
  // run is its own logical "turn" — they do NOT share an id across cron firings.
  const correlationId = randomUUID()
  const startedAt = Date.now()
  emitAutomationEvent('automation.started', {
    automationId: a.id,
    label: a.label,
    cron: a.cron,
    model,
    correlationId,
    startedAt
  })
  // F3 (A7) — fire user hooks on the automation lifecycle (not just interactive chat).
  void fireHooks('automationStarted', { trigger: 'automation', sourceId: a.id, label: a.label, promptBody: a.prompt })
  try {
    // A cron job is a REAL tool-capable agent now, not a text-only completion:
    // runHeadlessAgent runs the model→tool→feedback loop de-privileged (capability
    // allow-list only; deny-first for anything not in CRON_ALLOWED_TOOLS), scoped
    // to the vault so read_file/list_dir anchor there.
    const result = await runHeadlessAgent({
      prompt: a.prompt,
      workspacePath: vaultPath(),
      allowedTools: CRON_ALLOWED_TOOLS,
      model,
      label: a.label
    })
    // Only the model's own words become the reply. The old fallback stitched the status into
    // the text, so `[ok] stopped: hit maxToolCalls (24)` was stored as last_result and — with
    // a delivery target set — sent to the operator's channel as though the automation had
    // said it. When there is genuinely no output, say so as a note rather than as an answer.
    const reply =
      result.output ||
      (result.error ? `(no answer — ${result.error})` : '')
    recordRun(a.id, reply.slice(0, 4000))
    // Cron→channel delivery: when the automation has a deliver_to target, push
    // the reply out (one bounded retry). Runs AFTER recordRun so a delivery
    // failure never loses the recorded result.
    const ref = parseDeliverTo(a.deliverTo)
    if (ref && reply.trim()) {
      await deliverWithRetry(ref, reply)
    }
    // A FAILED RUN MUST NOT REPORT AS COMPLETED.
    //
    // runHeadlessAgent catches everything and RETURNS {status:'error'|'aborted', error} — it never
    // throws (headless-agent.ts:157-165). So once the runner migrated from chatOnce (which threw)
    // to the agent loop, the catch block below became unreachable for any failure originating
    // inside the agent, and a model outage / tool error / timeout emitted automation.completed with
    // severity 'info'. Three things went blind: watchJobFailed never fired, automationDone fired as
    // if the run succeeded, and capability-gap's event-log mining — which looks for exactly the
    // "a single automation failed 170x" pattern — could not see the most common failure mode.
    //
    // 'aborted' is kept DISTINCT from 'error' rather than folded in: a deliberate cancellation is
    // not a fault and should not page anyone, but it is also not a completion, so it emits neither
    // the failure watcher nor the success hook.
    if (result.status === 'error') {
      const detail = result.error || 'headless agent reported an error with no message'
      void watchJobFailed({ automationId: a.id, label: a.label, error: detail })
      emitAutomationEvent('automation.failed', {
        automationId: a.id,
        label: a.label,
        cron: a.cron,
        model,
        correlationId,
        startedAt,
        durationMs: Date.now() - startedAt,
        error: detail,
        errorClass: 'HeadlessAgentError'
      })
      return { status: 'error', error: detail }
    }
    // Budget exhaustion. NOT a completion — the task stopped halfway — but not a fault
    // either, so it does not page the failure watcher and does NOT arm a retry: re-running
    // a job that ran out of turns just spends the same budget to stop in the same place.
    // It is emitted as automation.failed so the event-log failure mining that looks for
    // "this automation keeps not working" can actually see it.
    if (result.status === 'truncated') {
      const detail = result.error || 'the agent ran out of budget before finishing'
      // File it in the inbox too. An unattended job that stopped halfway is precisely the
      // "what did I miss" case the notice surface exists for — and the event alone is not
      // that, because nothing routinely reads the event log. watchJobFailed dedups per
      // automation, so a job that truncates every tick alerts once per window rather than
      // every 60 seconds.
      void watchJobFailed({ automationId: a.id, label: a.label, error: detail })
      emitAutomationEvent('automation.failed', {
        automationId: a.id,
        label: a.label,
        cron: a.cron,
        model,
        correlationId,
        startedAt,
        durationMs: Date.now() - startedAt,
        error: detail,
        errorClass: 'HeadlessAgentTruncated'
      })
      return { status: 'truncated', error: detail }
    }
    if (result.status === 'aborted') {
      emitAutomationEvent('automation.failed', {
        automationId: a.id,
        label: a.label,
        cron: a.cron,
        model,
        correlationId,
        startedAt,
        durationMs: Date.now() - startedAt,
        error: result.error || 'run aborted (timeout or cancellation)',
        errorClass: 'HeadlessAgentAborted'
      })
      return { status: 'aborted', error: result.error || 'run aborted (timeout or cancellation)' }
    }
    emitAutomationEvent('automation.completed', {
      automationId: a.id,
      label: a.label,
      cron: a.cron,
      model,
      correlationId,
      startedAt,
      durationMs: Date.now() - startedAt,
      replyPreview: reply
    })
    void fireHooks('automationDone', { trigger: 'automation', sourceId: a.id, label: a.label, result: reply.slice(0, 4000) })
    return { status: 'ok' }
  } catch (err) {
    recordRun(a.id, `[error] ${friendly(err, 'unknown')}`)
    // Proactive watch/notify (#2): a scheduled job just FAILED. Push the (opt-in,
    // default-OFF) job-fail watcher as a post-step call — best-effort, never throws,
    // and does not alter the failure handling below.
    void watchJobFailed({ automationId: a.id, label: a.label, error: friendly(err, 'unknown') })
    emitAutomationEvent('automation.failed', {
      automationId: a.id,
      label: a.label,
      cron: a.cron,
      model,
      correlationId,
      startedAt,
      durationMs: Date.now() - startedAt,
      error: friendly(err, 'unknown'),
      errorClass: (err as { name?: string })?.name
    })
    return { status: 'error', error: friendly(err, 'unknown') }
  }
}

interface AutomationEventDetail {
  automationId: string
  label?: string
  cron?: string
  model: string
  correlationId: string
  startedAt: number
  durationMs?: number
  replyPreview?: string
  error?: string
  errorClass?: string
}

function emitAutomationEvent(
  type: 'automation.started' | 'automation.completed' | 'automation.failed',
  detail: AutomationEventDetail
): void {
  try {
    recordEvent({
      type,
      actorKind: 'system',
      severity: type === 'automation.failed' ? 'error' : 'info',
      automationId: detail.automationId,
      correlationId: detail.correlationId,
      entityKind: 'automation',
      entityId: detail.automationId,
      payload: {
        automationId: detail.automationId,
        label: detail.label,
        cron: detail.cron,
        model: detail.model,
        startedAt: detail.startedAt,
        durationMs: detail.durationMs,
        replyPreview: boundedJsonPreview(detail.replyPreview),
        errorPreview: boundedJsonPreview(detail.error),
        errorClass: detail.errorClass
      }
    })
  } catch (err) {
    console.error(`[automations] ${type} event failed:`, err)
  }
}

export async function runAutomation(id: string): Promise<AutomationRunOutcome> {
  // Honour the SAME in-flight guard the scheduled tick uses.
  //
  // "Run now" called runOne directly, bypassing runningAutomations entirely — so
  // clicking it while the scheduled tick had that automation in flight (or clicking it
  // twice) ran the agent concurrently against one automation. Both runs recorded to the
  // same row, last-write-wins, and a long job could be running two model conversations
  // for one job the operator thinks fired once.
  //
  // Refused rather than queued: "Run now" means now, and silently deferring it would
  // look like the click did nothing. The caller gets a real answer instead.
  if (runningAutomations.has(id)) {
    return { status: 'error', error: 'already running' }
  }
  runningAutomations.add(id)
  lastDispatchAt.set(id, Date.now())
  try {
    return await runOne(id)
  } finally {
    runningAutomations.delete(id)
  }
}

/**
 * Arm the next backoff attempt for a run that just failed transiently, or leave the
 * retry cleared once the trigger's maxAttempts budget is spent. retryAt() returns null
 * at/after the last attempt, so this is strictly bounded — never an unbounded re-fire.
 */
function scheduleRetry(a: Automation, attempt: number): void {
  const next = retryAt(a.trigger, attempt, Date.now())
  if (next != null) armAutomationRetry(a.id, next, attempt + 1)
}

/**
 * What a claimed fire actually DOES.
 *
 * For an ordinary automation that is the headless agent run. For an automation BOUND
 * TO A GOAL it is the loop wake instead: `wakeGoalFromAutomation` never calls a
 * provider, it makes the goal's owned loop due. That link is the whole point of the
 * automation → goal → loop path and it had no runtime caller at all — the bridge
 * function existed, only tests reached it, and a goal-bound automation quietly ran a
 * plain agent as if the binding were not there.
 *
 * The bridge is imported LAZILY (main.ts already imports it at startup for its
 * transition-handler side effect) so a plain automations run — or a test — never drags
 * the loop controller into its load path. Mirrors the `await import('./brain/index')`
 * seam in runDigestJob.
 *
 * A refused wake — loops disabled, backgroundAutonomy off, goal not active — is a
 * POLICY outcome, not a transient fault, so it settles 'aborted': recorded and
 * surfaced, but never retried with backoff.
 */
async function executeDispatch(a: Automation): Promise<AutomationRunOutcome> {
  if (!a.goalId || !a.goalConversationId) return await runOne(a.id)
  try {
    const bridge = await import('./goal-automation-loop-bridge')
    const woken = bridge.wakeGoalFromAutomation(a)
    recordRun(a.id, `[goal wake] made loop ${woken.loopId} due for goal ${woken.goalId}`)
    return { status: 'ok' }
  } catch (err) {
    const detail = friendly(err, 'goal wake refused')
    recordRun(a.id, `[goal wake refused] ${detail}`)
    return { status: 'aborted', error: detail }
  }
}

/**
 * Claim + dispatch ONE automation run — a fresh cron fire (attempt 1) or a due backoff
 * retry — then wire its settlement. Returns true when a run was actually dispatched, so
 * the caller can distinguish a real fire from a lost claim.
 *   - beginAutomationRun is the durable idempotency claim (UNIQUE automation_id,
 *     trigger_key,attempt); a lost claim (duplicate tick / post-restart re-fire) no-ops.
 *   - A retry fire consumes its armed retry_at ATOMICALLY with winning the claim
 *     (`consumeRetryFor`), so no crash can leave the claim taken and the retry armed.
 *   - A retry whose claim is LOST disarms too — see the comment on that branch.
 *   - On a transient 'error' the next attempt is armed with exponential backoff, capped
 *     at maxAttempts; a success or deliberate 'aborted' arms nothing.
 */
/** Does this automation clear the minimum-dispatch-gap floor?
 *
 *  The floor exists so no schedule can out-run the runner. It was measured from
 *  `lastRunAt`, which automations-store writes on recordRun — at COMPLETION. With a
 *  five-minute cron (the second entry in the built-in preset list) the next tick
 *  lands exactly 5 minutes after the run STARTED, i.e. less than 5 minutes after it
 *  finished, so it was skipped and the automation actually ran every ~10 minutes.
 *  Nothing in the Automations panel said so — the configured schedule and the real
 *  cadence simply disagreed, forever.
 *
 *  Measuring from DISPATCH makes the floor mean what it says: no two dispatches closer
 *  than minGapMs, and a five-minute schedule runs every five minutes. A run that outlasts
 *  the gap is still held off by the separate in-flight guard.
 *
 *  A due retry is exempt: retryAt is already backoff-paced. PURE. */
export function cadenceFloorPasses(input: {
  nowMs: number
  /** In-process dispatch time; null when this process has not dispatched it yet. */
  lastDispatchAt: number | null
  /** Persisted COMPLETION time — the restart fallback. */
  lastRunAt: number | null
  retryDue: boolean
  minGapMs: number
}): boolean {
  if (input.retryDue) return true
  const since = input.lastDispatchAt ?? input.lastRunAt
  if (since == null) return true
  return input.nowMs - since >= input.minGapMs
}

function dispatchAutomationRun(
  a: Automation,
  triggerKey: string,
  attempt: number,
  scheduledAt: number,
  isRetry: boolean,
  triggerKind: AutomationTriggerKind = 'schedule'
): boolean {
  const runId = beginAutomationRun({
    automationId: a.id,
    triggerKey,
    triggerKind,
    scheduledAt,
    attempt,
    startedAt: Date.now(),
    // ATOMIC with the claim: a won claim commits the retry disarm in the same
    // transaction, so there is no window a crash can land in.
    ...(isRetry ? { consumeRetryFor: a.id } : {})
  })
  if (!runId) {
    // Claim lost — this (trigger, attempt) is already in the ledger, so nothing runs.
    // That part was always right. What was missing: for a RETRY the armed retry_at
    // must be consumed ANYWAY. The ledger row is authoritative — its existence means
    // this attempt was already dispatched (or was interrupted and recovered by
    // recoverInterruptedAutomationRuns), so the backoff that produced it is spent.
    // Leaving it armed at a timestamp permanently in the past is exactly what made
    // every later tick take the retry branch, lose the claim, and return before ever
    // reaching the cron match — silencing the automation forever with disabled_reason
    // unset, so the UI still showed it healthy. Reconciling retry_at against the
    // ledger on EVERY observation (not only on the winning path) makes the crash
    // window self-healing instead of permanent.
    if (isRetry) clearAutomationRetry(a.id)
    return false
  }
  // The claim transaction already disarmed it; this is the idempotent re-assert that
  // keeps the consume observable at this seam whichever arm performed it.
  if (isRetry) clearAutomationRetry(a.id)
  runningAutomations.add(a.id)
  lastDispatchAt.set(a.id, Date.now())
  void executeDispatch(a)
    .then((outcome) => {
      settleAutomationRun({
        runId,
        status: outcome.status === 'ok' ? 'completed' : 'failed',
        finishedAt: Date.now(),
        error: outcome.status === 'ok' ? null : outcome.error
      })
      // Only a transient 'error' earns a retry; 'aborted' is a deliberate
      // cancellation/timeout and must not be re-fired.
      if (outcome.status === 'error') scheduleRetry(a, attempt)
    })
    .catch(() => {
      settleAutomationRun({ runId, status: 'failed', finishedAt: Date.now(), error: 'run threw' })
      scheduleRetry(a, attempt)
    })
    .finally(() => runningAutomations.delete(a.id))
  return true
}

export function tick(): void {
  // Proactive reliability substrate rides the same 60s heartbeat: retry any
  // pending dead-letter deliveries whose backoff has elapsed, and expire any
  // stale awaiting-reply interactions. Both are best-effort and isolated from
  // the automations loop below — a failure here never blocks a scheduled run.
  try {
    void redeliverDue().catch((err) =>
      console.error('[automations] redeliverDue failed:', messageOf(err))
    )
    sweepExpired()
    // Bound the two persisted proactive stores in an always-on app: drop terminal
    // (delivered) delivery receipts and terminal (resolved/expired) interactions
    // once they age past the retention window. Neither touches a live record —
    // pending deliveries, dead letters, and open interactions are always kept.
    pruneDelivered(PROACTIVE_RETENTION_MS)
    // Read notices age out on the same window; an unanswered decision is kept regardless.
    pruneNotices(NOTICE_RETENTION_MS)
    pruneInteractions(PROACTIVE_RETENTION_MS)
    // Bound the automation_runs idempotency ledger too: a per-minute cron accretes
    // ~1,440 durable rows/day/automation that nothing else deletes. Only TERMINAL
    // rows aged past the retention window are dropped; still-'running' claims and any
    // recent (< window) fire-lease are left intact so idempotency is never weakened.
    pruneAutomationRuns(PROACTIVE_RETENTION_MS)
  } catch (err) {
    console.error('[automations] proactive tick failed:', messageOf(err))
  }

  // SAFETY (Phase B3) — the backgroundAutonomy kill switch governs automations.
  // A cron automation dispatches a REAL tool-capable, billable agent
  // (runHeadlessAgent via runOne), which is exactly the class of autonomous
  // background activity this switch exists to stop. Gate the AUTOMATIC firing
  // on it, mirroring loop-controller.tickLoops and loop-scheduler.tick which
  // both read the same setting. Previously tick() honored only `a.enabled`, so
  // turning autonomy OFF still left every enabled cron dispatching agents — the
  // class bug behind the "QA every-min" runaway. The proactive substrate above
  // (retry/expire/prune) is delivery plumbing, not agent activity, so it keeps
  // running. The MANUAL "Run now" path (runAutomation → runOne) is deliberately
  // NOT gated here: that's an attended, user-initiated run.
  // TWO switches, deliberately. `backgroundAutonomy` remains the master kill: off means
  // nothing scheduled runs, unchanged. But it ALSO arms the self-improve tick, so on an
  // install that turned it on for self-improvement every enabled cron silently became
  // live again — the same runaway class this gate was added to close, re-opened through
  // the side door. Cron dispatch therefore needs its own explicit `automationsEnabled`,
  // default false. Manual "Run now" stays ungated: that is attended.
  const settings = readSettings()
  const gate =
    settings.backgroundAutonomy !== true
      ? 'backgroundAutonomy is OFF'
      : settings.automationsEnabled !== true
        ? 'automations are not enabled (Settings → Automations)'
        : null
  if (gate) {
    if (!autonomyGateLogged) {
      console.info(`[automations] ${gate} — suppressing all scheduled automation runs`)
      autonomyGateLogged = true
    }
    return
  }
  autonomyGateLogged = false

  let autos
  try {
    autos = listAutomations()
  } catch (err) {
    console.error('[automations] list failed:', err)
    return
  }
  const now = new Date()
  const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`
  for (const a of autos) {
    if (!a.enabled) continue
    // In-flight guard: an automation whose previous dispatch is still running must
    // not be re-launched by a later tick (a >60s agent run spans multiple ticks).
    // Mirrors tickLoops' runningLoops discipline. Cheap in-process check FIRST, so a
    // still-running long job never even attempts a ledger claim.
    if (runningAutomations.has(a.id)) continue
    // Cadence floor. Checked before the cron match so no schedule can out-run it; a due
    // retry is exempt because retryAt is already backoff-paced.
    const retryDue = a.retryAt != null && now.getTime() >= a.retryAt
    if (
      !cadenceFloorPasses({
        nowMs: now.getTime(),
        lastDispatchAt: lastDispatchAt.get(a.id) ?? null,
        lastRunAt: a.lastRunAt,
        retryDue,
        minGapMs: MIN_DISPATCH_GAP_MS
      })
    ) {
      if (!cadenceFloorLogged.has(a.id)) {
        cadenceFloorLogged.add(a.id)
        console.info(
          `[automations] "${a.label}" is scheduled faster than the ${MIN_DISPATCH_GAP_MS / 60_000}-minute floor — extra ticks are being skipped`
        )
      }
      continue
    }
    cadenceFloorLogged.delete(a.id)
    // DUE BACKOFF RETRY: a prior run that failed transiently armed retry_at (+ the
    // next attempt number). When that backoff has elapsed, fire the retry on a
    // distinct, restart-stable trigger key (`retry:<due-ts>`) so the ledger admits it
    // exactly once. Checked BEFORE the cron match so a retry happens even in a minute
    // the cron itself doesn't match — the whole point of the retry policy. This is the
    // consumer of retryAt()/retry_at/retry_attempt, which were parsed + stored but
    // previously had no code path that ever re-fired a failed run.
    if (a.retryAt != null && now.getTime() >= a.retryAt) {
      // `continue` ONLY when the retry actually fired. A lost claim used to `continue`
      // too, which is what let a single stale claim STARVE the schedule: the retry
      // branch is evaluated before the cron match, so an un-consumable retry_at
      // swallowed every tick and the cron below was unreachable. A lost claim has now
      // disarmed the retry (above) and falls through, so this same tick still gets to
      // evaluate the schedule.
      if (dispatchAutomationRun(a, `retry:${a.retryAt}`, a.retryAttempt || 1, a.retryAt, true)) {
        continue
      }
    }

    // TRIGGER TAXONOMY DISPATCH. This loop used to do nothing but
    // `parseCron(a.cron)` with `catch { continue }`, while automations-store's
    // cronForTrigger writes '' for one_shot / event / monitor / schedule{everySeconds}.
    // parseCron('') throws, so every one of those kinds was skipped on every tick,
    // forever, with no error anywhere — the v34-v36 taxonomy was inert and only bare
    // cron ever fired.
    const blocked = triggerBlockReason(a)
    if (blocked) {
      // FAIL LOUDLY. A trigger this build cannot schedule becomes a DISABLED
      // automation carrying the reason, not an enabled one that silently never runs.
      console.error(`[automations] disabling "${a.label}" (${a.id}): ${blocked}`)
      try {
        disableAutomation(a.id, blocked)
      } catch (err) {
        console.error('[automations] could not persist disabled_reason:', messageOf(err))
      }
      // TELL SOMEONE. "DUIN switched off one of your automations" is the single most
      // important thing this runner can have to say, and until the notice inbox existed
      // it had nowhere to say it: the reason went into a column no screen rendered, and
      // the automation simply stopped happening. Dedup is per-automation, and the tick
      // `continue`s below, so this fires once per window rather than every minute.
      void watchJobFailed({
        automationId: a.id,
        label: a.label,
        error: `turned off — ${blocked}`
      })
      continue
    }

    const due = dueDispatch(a, now, minuteKey)
    if (!due) continue
    // DURABLE idempotency: claim this fire in the automation_runs ledger. For cron the
    // trigger_key is the date-inclusive minute so a daily/weekly cron gets a fresh key
    // each fire (unlike a date-less hour+minute stamp); for the interval-shaped kinds
    // it is triggerKey(trigger, scheduledAt), i.e. the boundary being consumed. INSERT
    // OR IGNORE against UNIQUE(automation_id,trigger_key,attempt): a duplicate tick —
    // or a re-fire after a restart — loses the claim and gets null.
    dispatchAutomationRun(a, due.triggerKey, 1, due.scheduledAt, false, a.trigger.kind)
    // Advance the cursor whether or not the claim was won. A due-and-unclaimable
    // next_run_at that never advanced would re-attempt on every tick forever — the
    // same starvation shape as the stale retry claim above.
    if (due.advanceCursor) {
      try {
        setAutomationNextRun(a.id, nextRunAfterSettlement(a.trigger, now.getTime()))
      } catch (err) {
        console.error('[automations] could not advance next_run_at:', messageOf(err))
      }
    }
  }
}

/**
 * Why this automation's trigger cannot be scheduled AT ALL, or null when it can.
 *
 * Everything this returns becomes a `disabled_reason` on the card. Nothing here is
 * allowed to resolve to "skip it quietly".
 */
function triggerBlockReason(a: Automation): string | null {
  const unreadable = unrunnableTriggerReason(a.trigger)
  if (unreadable) return `This automation was turned off because ${unreadable}.`

  switch (a.trigger.kind) {
    case 'one_shot':
      return null
    case 'schedule': {
      const cron = cronTextFor(a)
      if (!cron) return null // interval schedule — handled by next_run_at
      try {
        parseCron(cron)
        return null
      } catch (err) {
        return `This automation was turned off because its schedule "${cron}" is not a valid cron expression (${messageOf(err) ?? 'parse error'}).`
      }
    }
    // NOT WIRED IN THIS BUILD. Both need machinery the runner does not have: `event`
    // needs an event bus to subscribe to and a stable per-event id for the ledger key
    // (triggerKey() requires one and there is no producer); `monitor` needs a condition
    // to evaluate and change-detection over it — firing it as a plain interval agent
    // run would be inventing semantics, not wiring them. Rather than let either sit
    // enabled and never fire, they are disabled with a reason that says so.
    case 'event':
      return `This automation was turned off because event triggers ("${a.trigger.eventName}") are not dispatched by this build yet.`
    case 'monitor':
      return 'This automation was turned off because monitor triggers are not dispatched by this build yet.'
    default:
      return `This automation was turned off because its trigger kind is not recognised.`
  }
}

/**
 * The cron expression to schedule on, or undefined when this trigger is not
 * cron-shaped. The `cron` COLUMN wins when set: it is what create/update persist via
 * cronForTrigger and what every existing row and every existing test carries, so
 * reading the trigger JSON first would silently re-time live automations.
 */
function cronTextFor(a: Automation): string | undefined {
  const column = a.cron?.trim()
  if (column) return column
  return a.trigger.kind === 'schedule' ? a.trigger.cron : undefined
}

/**
 * Is this automation due THIS tick, and under which ledger key?
 *
 *   • schedule{cron} keeps the exact minute-match semantics it always had.
 *   • one_shot and schedule{everySeconds} are driven by the persisted `next_run_at`
 *     cursor — the column create/update already wrote and nothing ever read.
 *
 * A row whose cursor is missing (created before the column was populated, or a
 * backfilled legacy row) is SEEDED here rather than skipped, so it starts firing
 * instead of waiting on a write that never comes.
 */
function dueDispatch(
  a: Automation,
  now: Date,
  minuteKey: string
): { triggerKey: string; scheduledAt: number; advanceCursor: boolean } | null {
  const cron = cronTextFor(a)
  if (a.trigger.kind === 'schedule' && cron) {
    let expr: CronExpr
    try {
      expr = parseCron(cron)
    } catch {
      return null // unreachable: triggerBlockReason already disabled it
    }
    if (!matches(expr, now)) return null
    return { triggerKey: `schedule:${minuteKey}`, scheduledAt: now.getTime(), advanceCursor: false }
  }

  const ms = now.getTime()
  let cursor = a.nextRunAt
  if (cursor == null) {
    // A SPENT one_shot also has a null cursor (nextRunAfterSettlement clears it), and
    // initialNextRunAt would happily re-seed it to `max(at, now)` — i.e. due again,
    // immediately, forever. A one_shot is never re-seeded: createAutomation always
    // writes its cursor, so null means spent.
    if (a.trigger.kind === 'one_shot') return null
    cursor = initialNextRunAt(a.trigger, ms)
    if (cursor == null) return null
    try {
      setAutomationNextRun(a.id, cursor)
    } catch (err) {
      console.error('[automations] could not seed next_run_at:', messageOf(err))
    }
  }
  if (ms < cursor) return null
  // A one_shot keys the ledger on its DECLARED time, not on the tick that noticed it,
  // so the claim is stable even if the cursor is lost — the ledger, not the cursor, is
  // the last line of defence against a second fire.
  const scheduledAt = a.trigger.kind === 'one_shot' ? a.trigger.at : cursor
  return {
    triggerKey: triggerKey(a.trigger, scheduledAt),
    scheduledAt,
    advanceCursor: true
  }
}

export function startAutomations(): void {
  if (timer) return
  // Align first tick to the next ~minute boundary, then every 60s.
  const msUntilNextMinute = (60 - new Date().getSeconds()) * 1000
  timer = setTimeout(function tickLoop() {
    tick()
    timer = setTimeout(tickLoop, 60_000)
  }, msUntilNextMinute)
}

export function stopAutomations(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

