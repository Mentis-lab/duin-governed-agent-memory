import { join, dirname } from 'path'
import { elideMiddle } from './elide-middle'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { openSync, writeSync, fsyncSync, closeSync, existsSync, readFileSync, mkdirSync } from 'fs'
import { statfs as statfsPromise } from 'fs/promises'
import * as store from './loop-store'
import { getLoopTurnRunner } from './loop-runner'
import { recordEvent, boundedJsonPreview } from './event-log'
import { gcSpillDir } from './tool-result-spill'
import { readLoopConfig } from './loop-config'
import { readLongRunConfig, type LongRunConfig } from './longrun-config'
import { readSettings } from './settings-helper'
import { trustScore, snapshotFor, type TrustSnapshot } from './ans/trust-score'
import { getCapability, classify } from './ans/capability-ledger'
import { BrowserWindow } from 'electron'
import type {
  Loop,
  LoopStatus,
  BacklogItem,
  BacklogStatus,
  LoopRun
} from './loop-store'
// Long-run L1-L8 modules — all pure / seam-injected. The controller is the sole
// integration seam that folds them into the iteration lifecycle. Every wire-in
// is GATED on the relevant injected dep (and loop.artifactDir where it needs
// git/disk): when the long-run deps are absent the iteration behaves exactly as
// it did before L1-L8 (the existing controller tests exercise that path).
import {
  appendEntry,
  readEntries,
  type JournalFs,
  type TokenUsage
} from './longrun/run-journal'
import { commitStep, stageStep, currentSha, type ExecSeam } from './longrun/artifact-checkpoint'
import { reconcile } from './longrun/reconcile'
import { buildBoundedContext, updateRollingSummary } from './longrun/loop-context'
import {
  hashState,
  trackProgress,
  detectRepeat,
  shouldEscalate as stallShouldEscalate,
  type StateActionHash
} from './longrun/progress-watchdog'
import {
  costOfUsage,
  accrue,
  burnRatePerHour,
  checkCostCeiling,
  type PriceTable
} from './longrun/cost-budget'
import {
  withRetry,
  CircuitBreaker,
  classifyError,
  nextProviderInChain
} from './longrun/resilience'
import {
  diskFreeBytes,
  processRssBytes,
  check as resourceCheck,
  shouldRestartToRecover,
  type StatfsSeam,
  type RssSeam,
  type ResourceThresholds
} from './longrun/resource-monitor'
import { buildDigest } from './longrun/loop-digest'
import { verifyBeforeCommit, type VerifyReceipt } from './longrun/verify-gate'
import { evaluateDoD, seedDefinitionOfDone, type DefinitionOfDone } from './longrun/dod-seed'
// PURE observation parsers (no electron import → safe at module top-level). The heavy
// brain substrates (computeBrainHealthLive, loadOntology) are lazy-imported INSIDE the
// prod seam closures below so they never load under vitest (the test-load trap).
import {
  parseCitedNotes,
  orphanCitations,
  coveredTracksIn,
  expectsCoverage as instructionExpectsCoverage
} from './brain/verify-observations'
import { escalate, type DeliverSeam } from './longrun/escalation'
import {
  requiresApproval,
  requestApproval,
  productionIrreversibilityFloor,
  type GatedAction,
  type IrreversibilityFloorSeam,
  type ApprovalSeam
} from './longrun/gated-action'

// Loop Phase LP-3 — the loop controller. Owns the per-iteration lifecycle:
// pre-flight ceilings → pull next backlog item → run a turn → record + advance
// → schedule next or stop. The CORE (`runLoopIteration`) takes an injected
// store + runTurn seam so its ceiling / stop-authority logic is unit-tested as
// pure logic that ACTUALLY RUNS (no DB, no native binding, no skip). The pure
// helpers below are tested directly.
//
// LP-3 implements interval mode + all ceilings + stop authorities. Self-paced
// (LP-4) and autonomous (LP-5) extend `computeNextFire` + the backlog-empty
// handling; they reuse this same core.

export const DEFAULT_INTERVAL_SECONDS = 300
export const MIN_INTERVAL_SECONDS = 30 // runaway floor (LP-7 makes it a setting)
export const DEFAULT_ITERATION_TIMEOUT_MS = 10 * 60_000 // per-iteration wall-clock budget
const SPILL_GC_THROTTLE_MS = 60 * 60_000 // GC spill dir at most hourly while loops run

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable, no DB)
// ---------------------------------------------------------------------------

export interface CeilingDecision {
  stop: boolean
  status?: LoopStatus
  reason?: string
}

/**
 * Hard ceilings. Checked BEFORE an iteration (so a loop that already hit a cap
 * never runs another turn) and AFTER (so the cap that the just-finished turn
 * crossed stops the loop). Returns `{stop:false}` when the loop may continue.
 */
export function checkCeilings(
  loop: Pick<
    Loop,
    'iteration' | 'maxIterations' | 'maxWallclockMs' | 'tokenBudget' | 'tokensUsed' | 'startedAt'
  >,
  now: number
): CeilingDecision {
  if (loop.maxIterations != null && loop.iteration >= loop.maxIterations) {
    return { stop: true, status: 'done', reason: 'max-iterations' }
  }
  if (
    loop.maxWallclockMs != null &&
    loop.startedAt != null &&
    now - loop.startedAt >= loop.maxWallclockMs
  ) {
    return { stop: true, status: 'done', reason: 'max-wallclock' }
  }
  if (loop.tokenBudget != null && loop.tokenBudget > 0 && loop.tokensUsed >= loop.tokenBudget) {
    return { stop: true, status: 'done', reason: 'token-budget' }
  }
  return { stop: false }
}

// Item 19 — reliability-proportional loop ceilings. The user-set maxIterations/tokenBudget are the
// CAP; the ENFORCED ceiling scales by earned trust (trustScore of the autonomous-loop capability)
// toward — never past — the cap, with a hard floor so a cold/low-trust loop still gets a few turns.
// Pure: getCapability→undefined (unwired / in a unit test) yields a cold snapshot → mult = floor.
export const TRUST_ITER_FLOOR = 3
export const TRUST_TOKEN_FLOOR = 50_000
export const LOOP_CAP_ID = 'autonomous-loop'
const COLD_SNAP: TrustSnapshot = { ratifyN: 0, ratifyK: 0, reverts: 0, revertsHandled: 0, updatedAt: 0, skillScore: null }

/** Optional live goal/automation ceiling caps folded INTO the trust-scaled result as
 *  an ADDITIONAL Math.min term (upstream Lamprey's tightest()). These may only tighten
 *  — never loosen — the trust-scaled ceiling, so a goal-owned loop is bounded by the
 *  MIN of {its earned trust ceiling, the goal cap, the bound-automation cap}. */
export interface ExtraCeilingCaps {
  maxIterations?: number | null
  tokenBudget?: number | null
}

export function effectiveCeilings(
  loop: Pick<Loop, 'maxIterations' | 'tokenBudget'>,
  skillScore: number | null,
  snap?: TrustSnapshot,
  extraCaps?: ExtraCeilingCaps
): { maxIterations: number | null; tokenBudget: number | null; multiplier: number } {
  const cap = getCapability(LOOP_CAP_ID)
  const s = snap ?? (cap ? snapshotFor(cap, skillScore) : { ...COLD_SNAP, skillScore })
  const mult = trustScore(s).score
  const scale = (c: number | null, floor: number): number | null =>
    c == null ? null : Math.min(c, Math.max(floor, Math.round(c * mult)))
  // Fold the extra cap as an additional Math.min term WITHOUT replacing the
  // trust-scaled term: collect all positive finite caps and take the tightest.
  const fold = (scaled: number | null, extra: number | null | undefined): number | null => {
    const caps = [scaled, extra].filter(
      (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
    )
    return caps.length ? Math.min(...caps) : null
  }
  return {
    maxIterations: fold(scale(loop.maxIterations, TRUST_ITER_FLOOR), extraCaps?.maxIterations),
    tokenBudget: fold(scale(loop.tokenBudget, TRUST_TOKEN_FLOOR), extraCaps?.tokenBudget),
    multiplier: mult
  }
}

// Phase 3b (self-improve bridge) — merit-proportional autonomy ENFORCEMENT. Flag-gated + default
// OFF (DUIN_MERIT_AUTONOMY=1 to activate). Activating only TIGHTENS autonomy: a cold/low-trust loop
// gets the floor few iterations (effectiveCeilings enforced, not just surfaced) and must EARN the
// 'autonomous-loop' capability's reflexive rung to run silently — otherwise it pauses for human
// confirmation. Off ⇒ the iteration behaves EXACTLY as before (raw caps, static loopsEnabled), so
// no other install changes. Safe-direction by construction (never loosens a cap).
export function meritAutonomyEnabled(): boolean {
  return process.env.DUIN_MERIT_AUTONOMY === '1'
}

/** When merit-autonomy is on, scale a loop's caps by earned trust before the ceiling check. No-op
 *  otherwise. `effectiveCeilings` reads the live 'autonomous-loop' capability (getCapability). */
function meritCeilingLoop<
  T extends Pick<Loop, 'iteration' | 'maxIterations' | 'maxWallclockMs' | 'tokenBudget' | 'tokensUsed' | 'startedAt'>
>(loop: T): T {
  if (!meritAutonomyEnabled()) return loop
  const eff = effectiveCeilings(loop, null)
  return { ...loop, maxIterations: eff.maxIterations, tokenBudget: eff.tokenBudget }
}

/**
 * When the next iteration should fire. Interval mode = now + interval (clamped
 * to the runaway floor). Self-paced (LP-4) defers to the model's schedule, so a
 * short default keeps the loop alive until then. Autonomous (LP-5) fires
 * promptly while the backlog has work.
 */
export function computeNextFire(
  loop: Pick<Loop, 'mode' | 'intervalSeconds'>,
  now: number,
  minIntervalSeconds: number = MIN_INTERVAL_SECONDS
): number {
  const floor = Math.max(1, minIntervalSeconds)
  if (loop.mode === 'interval') {
    const secs = Math.max(floor, loop.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS)
    return now + secs * 1000
  }
  if (loop.mode === 'autonomous') {
    // Prompt re-fire, but never faster than the floor (runaway guard).
    return now + floor * 1000
  }
  // self_paced — a default heartbeat; the model's schedule_wakeup (LP-4) sets
  // the real cadence by re-scheduling within the turn.
  const secs = Math.max(floor, loop.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS)
  return now + secs * 1000
}

/** Rough token estimate (~4 chars/token). Real usage accounting is approximate
 *  in v1; iteration + wall-clock caps are the hard guards. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

export interface LedgerInfo {
  iteration: number
  remaining: number
  /** Recently-completed tasks + their outcomes — the idempotency ledger. */
  completed?: Array<{ task: string; result: string | null }>
}

/** Cap on how much ledger text we inject, so a long-running loop's prompt
 *  stays bounded regardless of how many tasks it has completed. */
export const LEDGER_RESULT_MAX_CHARS = 240

/**
 * The per-iteration prompt: the loop's standing instruction + the current task
 * + a progress ledger. The ledger lists recently-completed tasks with their
 * outcomes so the model does not redo settled work (idempotency). For
 * autonomous loops it also reminds the model it may enqueue follow-up work and
 * declare the mission complete when nothing remains.
 */
export function buildIterationPrompt(
  loop: Pick<Loop, 'instruction' | 'mode'>,
  item: BacklogItem | null,
  ledger: LedgerInfo
): string {
  const parts: string[] = []
  if (loop.instruction?.trim()) parts.push(loop.instruction.trim())
  parts.push(
    `Loop iteration ${ledger.iteration}. ${ledger.remaining} task(s) remain in the backlog after this one.`
  )
  if (ledger.completed && ledger.completed.length > 0) {
    const lines = ledger.completed.map((c) => {
      // Keep the end of the outcome. This ledger is captioned "Already done (do NOT repeat)",
      // so a tail like "…but the migration is still incomplete" is the one part the next
      // iteration must not lose — head-slicing it turned a partial result into a settled one.
      const outcome = elideMiddle((c.result ?? '').trim(), LEDGER_RESULT_MAX_CHARS)
      return `- ${c.task}${outcome ? ` → ${outcome}` : ' → (done)'}`
    })
    parts.push(`Already done (do NOT repeat):\n${lines.join('\n')}`)
  }
  if (item) parts.push(`Current task:\n${item.task}`)
  const tail = [
    'Complete this task, then call loop_complete_task with a one-line outcome.'
  ]
  if (loop.mode === 'autonomous') {
    tail.push(
      'If you discover follow-up work, add it with loop_enqueue. When nothing worthwhile remains, call loop_control with action "mission_complete".'
    )
  }
  parts.push(tail.join(' '))
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

export interface LoopStoreSeam {
  getLoop(id: string): Loop | null
  updateLoop(id: string, patch: Parameters<typeof store.updateLoop>[1]): Loop | null
  nextBacklogItem(loopId: string): BacklogItem | null
  updateBacklogItem(id: string, patch: Parameters<typeof store.updateBacklogItem>[1]): BacklogItem | null
  countBacklog(loopId: string, status?: BacklogStatus): number
  listRecentDone(loopId: string, limit: number): BacklogItem[]
  recordLoopRun(input: { loopId: string; iteration: number; backlogId?: string | null; startedAt?: number }): LoopRun
  finishLoopRun(id: string, patch: { status: 'running' | 'done' | 'error' | 'timeout'; tokensUsed?: number | null; finishedAt?: number }): LoopRun | null
  listDueLoops(now: number): Loop[]
  /** L2 reconcile — the item currently in_progress (if any), so a restart can
   *  close out a step whose commit already landed. Optional: absent in the
   *  legacy fake stores; production wires store.inProgressBacklogItem. */
  inProgressBacklogItem?(loopId: string): BacklogItem | null
}

export type LoopTurnFn = (input: {
  conversationId: string
  model: string
  promptBody: string
  signal?: AbortSignal
}) => Promise<{ tokensUsed?: number } | unknown>

export interface LoopIterationDeps {
  store: LoopStoreSeam
  runTurn: LoopTurnFn
  clock?: () => number
  minIntervalSeconds?: number
  /** Per-iteration wall-clock budget (ms). 0/undefined disables the watchdog. */
  iterationTimeoutMs?: number
  emit?: (channel: string, payload: unknown) => void

  // ---- Long-run L1-L8 seams (all OPTIONAL). Each layer is skipped unless its
  // dep is present; loop.artifactDir === null additionally disables the git/disk
  // layers (L1/L2/L7-disk/L3-artifact-state). Absent everywhere ⇒ legacy path. ----

  /** L1 durable run journal (append-only, fsync'd JSONL). */
  journalFs?: JournalFs
  /** L1/L2/L3/L4 git exec boundary (args-array, no shell). */
  exec?: ExecSeam
  /** L7 disk-stat boundary. */
  statfs?: StatfsSeam
  /** L7 RSS reader. */
  rssSeam?: RssSeam
  /** L5 model→price table (unknown model ⇒ cost 0). */
  priceTable?: PriceTable
  /** L4/L5/L7 operator escalation channel. */
  deliver?: DeliverSeam
  /** VERIFY (2BRAIN). Gathers the turn's BRAIN-output verify RECEIPT (before/after
   *  identity-integrity snapshot + notes the digest cited) so the gate can refuse to
   *  self-attest `done` on a corrupting write or a hallucinated citation. Absent ⇒ the
   *  verify layer is skipped and commit→done behaves exactly as before. Returning null
   *  ⇒ no evidence this turn ⇒ the gate passes (fail-safe-open on absent evidence). */
  brainVerify?: (input: {
    loop: Loop
    item: BacklogItem
    result: unknown
  }) => Promise<VerifyReceipt | null> | VerifyReceipt | null
  /** VERIFY regression tolerance (identity-axis points) before a write is deemed
   *  corrupting. Forwarded to verifyBeforeCommit; undefined ⇒ its default. */
  verifyRegressionTolerance?: number
  /** DoD-SEED (2BRAIN). Seeds a brain-checkable definition-of-done AT TASK START
   *  from live brain state (active tracks) — the SEED half of the falsifiable
   *  contract the verify gate checks at commit. Absent ⇒ no DoD is seeded and the
   *  DoD half of the gate is inert. Returning null ⇒ this task carries no DoD. */
  seedDoD?: (input: {
    loop: Loop
    item: BacklogItem
  }) => Promise<DefinitionOfDone | null> | DefinitionOfDone | null
  /** L8 gated-action operator approval round-trip (fail-closed). */
  approval?: ApprovalSeam
  /** L8 gated-action irreversibility classifier. */
  irreversibilityFloor?: IrreversibilityFloorSeam
  /** L6 injected retry jitter (deterministic in tests). */
  jitterFn?: (attempt: number, baseMs: number) => number
  /** L6 injected retry sleep (deterministic in tests). */
  sleepFn?: (ms: number) => Promise<void>
  /** L7 pause/alert floors. */
  resourceThresholds?: ResourceThresholds
  /** L7 restart-to-recover RSS ceiling (0 disables). */
  rssRecycleBytes?: number
  /** L8 digest cadence (iterations); 0 disables the by-iteration trigger. */
  digestEveryIters?: number
  /** L8 digest cadence (ms); 0 disables the by-time trigger. */
  digestEveryMs?: number
  /** L4 consecutive-stall escalation threshold (0 disables). */
  stallK?: number
  /** L4 repeat-detection trailing window. */
  repeatWindow?: number
  /** L6 breakers by provider key (lazily populated). */
  breakers?: Map<string, CircuitBreaker>
  /** L6 breaker construction knobs (used when lazily creating a breaker). */
  breakerThreshold?: number
  breakerCooldownMs?: number
  /** L6 retry attempts / base backoff. */
  retries?: number
  backoffMs?: number
  /** L3 bounded-context char budget. */
  contextMaxChars?: number
  /** L5 burn-rate alert threshold (USD/hour, non-stopping). 0 disables. */
  burnAlertPerHour?: number
}

export interface IterationOutcome {
  ran: boolean
  stopped: boolean
  reason?: string
  error?: string
  timedOut?: boolean
  /** Governor 4a: the iteration ran but its output was HELD (staged) for human
   *  ratification rather than landed. Set only on the awaiting-ratification stop. */
  staged?: boolean
}

function tokensFrom(result: unknown): number {
  if (result && typeof result === 'object' && 'tokensUsed' in result) {
    const t = (result as { tokensUsed?: unknown }).tokensUsed
    if (typeof t === 'number' && Number.isFinite(t)) return t
  }
  return 0
}

// ---------------------------------------------------------------------------
// Long-run helpers (L1-L8 glue). Pure or thin adapters over the injected seams.
// ---------------------------------------------------------------------------

/** The per-loop journal path, or null when the loop has no artifact dir. */
function journalPath(loop: Pick<Loop, 'artifactDir'>): string | null {
  if (!loop.artifactDir) return null
  return join(loop.artifactDir, '.duin', 'run-journal.jsonl')
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Best-effort JSON string[] parse for Loop.providerChain. */
function parseChain(raw: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Derive a canonical TokenUsage for cost accounting from a turn result. Prefer
 *  an explicit `usage` object; otherwise synthesize from the token estimate as
 *  output tokens under the active provider so the price table can resolve it. */
function usageFrom(result: unknown, model: string): TokenUsage {
  if (result && typeof result === 'object' && 'usage' in result) {
    const u = (result as { usage?: unknown }).usage
    if (
      u &&
      typeof u === 'object' &&
      typeof (u as TokenUsage).inputTokens === 'number' &&
      typeof (u as TokenUsage).outputTokens === 'number'
    ) {
      const uu = u as TokenUsage
      return {
        model: uu.model ?? model,
        inputTokens: uu.inputTokens,
        outputTokens: uu.outputTokens,
        cachedInputTokens: uu.cachedInputTokens
      }
    }
  }
  return { model, inputTokens: 0, outputTokens: tokensFrom(result) }
}

/** A one-line human outcome for the journal note / rolling summary. */
function outcomeFrom(result: unknown): string {
  if (result && typeof result === 'object' && 'outcome' in result) {
    const o = (result as { outcome?: unknown }).outcome
    if (typeof o === 'string' && o.trim()) return o.trim().slice(0, 240)
  }
  return 'done'
}

/** Bounded artifact-state snapshot (git status + tracked files) for L3 context
 *  and the L4 progress hash. Empty string on any git error (unborn repo, no git). */
async function readArtifactState(dir: string, exec: ExecSeam, cap: number): Promise<string> {
  try {
    const status = await exec('git', ['status', '--porcelain'], { cwd: dir })
    const files = await exec('git', ['ls-files'], { cwd: dir })
    let s = `# git status\n${status.stdout}\n# files\n${files.stdout}`
    if (cap > 0 && s.length > cap) s = s.slice(0, cap)
    return s
  } catch {
    return ''
  }
}

// Cross-tick, in-process state the pure L-modules need carried between ticks.
// Keyed by loop id; only ever touched on the git-backed (production) path.
const loopBreakers = new Map<string, CircuitBreaker>()
const stateActionHistory = new Map<string, StateActionHash[]>()
const STATE_ACTION_HISTORY_CAP = 16
/** Loop ids that requested a restart-to-recover (L7); tickLoops reads + clears. */
export const loopRecycleRequests = new Set<string>()

// Per-loop live iteration abort handle. Populated for the duration of a running
// iteration's turn (registered next to the watchdog controller) so the goal-loop
// bridge can ABORT an in-flight iteration when its owning goal is paused/blocked/
// cleared, rather than waiting out the turn. Absent handle ⇒ nothing to abort.
const loopAbortControllers = new Map<string, AbortController>()

/** Abort the currently-running iteration of `loopId`, if one is in flight. Used by
 *  the goal-automation-loop-bridge when a goal-owned loop must stop NOW (goal paused,
 *  blocked, aborted, or cleared). Returns true when an in-flight turn was signalled.
 *  Stopping the loop's SCHEDULING (status/nextFireAt) is the caller's job — this only
 *  cancels the live turn. */
export function abortLoopIteration(loopId: string): boolean {
  const controller = loopAbortControllers.get(loopId)
  if (!controller) return false
  try {
    controller.abort()
  } catch {
    // AbortController.abort() does not throw in practice; guard defensively.
  }
  return true
}

function getBreaker(deps: LoopIterationDeps, provider: string): CircuitBreaker | undefined {
  if (!deps.breakers) return undefined
  let b = deps.breakers.get(provider)
  if (!b) {
    b = new CircuitBreaker({
      key: provider,
      failureThreshold: deps.breakerThreshold ?? 5,
      cooldownMs: deps.breakerCooldownMs ?? 60_000,
      clock: deps.clock
    })
    deps.breakers.set(provider, b)
  }
  return b
}

// ---------------------------------------------------------------------------
// Core iteration (pure-logic, injected deps)
// ---------------------------------------------------------------------------

export async function runLoopIteration(
  loop: Loop,
  deps: LoopIterationDeps
): Promise<IterationOutcome> {
  const now = () => (deps.clock ?? Date.now)()
  const emit = deps.emit ?? (() => {})

  // 1. Pre-flight ceilings — never run a turn past a cap (merit-scaled when enabled).
  const pre = checkCeilings(meritCeilingLoop(loop), now())
  if (pre.stop) {
    deps.store.updateLoop(loop.id, { status: pre.status, stopReason: pre.reason, nextFireAt: null })
    emit('loop:stopped', { id: loop.id, reason: pre.reason })
    return { ran: false, stopped: true, reason: pre.reason }
  }

  // 1.1 Merit-proportional autonomy gate (Phase 3b/4a, flag-gated). Three rungs, three fates:
  //   - 'run' (earned reflexive): run the turn AND land its output normally.
  //   - 'stage' (probation): run the turn but HOLD its output for human ratification (4a).
  //   - 'hold' (human-only): don't run at all — pause + escalate.
  // Safe direction — earned autonomy, not a static loopsEnabled toggle. Flag-off ⇒ holdOutput
  // stays false and this whole block is skipped ⇒ byte-identical to pre-merit behavior.
  let holdOutput = false
  if (meritAutonomyEnabled()) {
    // Never run ANOTHER iteration while a prior one's output awaits ratification — for
    // ANY rung, not just 'stage'. A landing ('run') iteration would advance the branch
    // and strand the staged item (its ratify ff-only base would have moved); a 'stage'
    // iteration would stack held commits on the same base. Resolve the pending
    // ratification first. (Guards both a human resuming mid-ratify AND a stage→run rung
    // change while an item is held.)
    if (deps.store.countBacklog(loop.id, 'awaiting-ratification') > 0) {
      deps.store.updateLoop(loop.id, { status: 'paused', stopReason: 'awaiting-ratification', nextFireAt: null })
      emit('loop:stopped', { id: loop.id, reason: 'awaiting-ratification' })
      return { ran: false, stopped: true, reason: 'awaiting-ratification' }
    }
    const rung = classify(LOOP_CAP_ID)
    if (rung === 'hold') {
      deps.store.updateLoop(loop.id, { status: 'paused', stopReason: 'autonomy-not-earned', nextFireAt: null })
      emit('loop:stopped', { id: loop.id, reason: 'autonomy-not-earned' })
      return { ran: false, stopped: true, reason: 'autonomy-not-earned' }
    }
    holdOutput = rung === 'stage'
  }

  // 1.5 (L2). Idempotent resumability: on a restart the artifact's git HEAD is
  // reconciled against the durable run journal. A divergence (HEAD unknown to the
  // journal) pauses + escalates rather than corrupting forward; an already-landed
  // last commit closes out its in-progress item so step 2 pulls the NEXT one.
  // Only meaningful when the loop has an artifact dir + a journal file exists.
  {
    const jp = journalPath(loop)
    if (loop.artifactDir && deps.exec && deps.journalFs && jp && deps.journalFs.exists(jp)) {
      try {
        const journal = readEntries(jp, deps.journalFs)
        const head = await currentSha(loop.artifactDir, deps.exec)
        const r = reconcile({ loopId: loop.id, journal, gitSha: head })
        if (!r.replaySafe) {
          deps.store.updateLoop(loop.id, {
            status: 'paused',
            stopReason: 'reconcile-divergence',
            nextFireAt: null
          })
          if (deps.deliver) await escalate('permanent-error', loop, deps.deliver)
          emit('loop:stopped', { id: loop.id, reason: 'reconcile-divergence' })
          return { ran: false, stopped: true, reason: 'reconcile-divergence' }
        }
        if (deps.store.inProgressBacklogItem) {
          const ip = deps.store.inProgressBacklogItem(loop.id)
          if (ip) {
            // Per-ITEM resolution (NOT the loop-level r.alreadyCommitted flag, which
            // is not per-item): did THIS in-progress item's own commit land in the
            // journal at the current git HEAD? If so it finished before the DB
            // `done` flag was written (crash in the Finding-1 window) → mark it done.
            // Otherwise it was interrupted BEFORE its durable commit → reset it to
            // pending so nextBacklogItem re-runs it (idempotent resume, L2).
            let lastCommitIdx = -1
            for (let i = journal.length - 1; i >= 0; i--) {
              const e = journal[i]
              if (e.kind === 'commit' && e.itemId === ip.id && e.gitSha === head) {
                lastCommitIdx = i
                break
              }
            }
            const committed = lastCommitIdx !== -1
            // VERIFY/DoD interaction: the durable `commit` entry is written BEFORE
            // the 2BRAIN verify gate runs, so a gate-REJECTED item also has a commit
            // at HEAD. Without this guard the reconcile would mark that rejected item
            // `done` on the next iteration — silently defeating the gate across a
            // restart. A verify-reject entry AFTER the item's commit means the gate
            // withheld done, so re-run (pending) rather than close it out.
            const verifyRejectedAfterCommit =
              committed &&
              journal
                .slice(lastCommitIdx + 1)
                .some(
                  (e) =>
                    e.itemId === ip.id &&
                    e.kind === 'verify' &&
                    /verify-reject/.test(e.note ?? '')
                )
            if (committed && !verifyRejectedAfterCommit) {
              deps.store.updateBacklogItem(ip.id, { status: 'done', finishedAt: now() })
            } else {
              deps.store.updateBacklogItem(ip.id, { status: 'pending', startedAt: undefined })
            }
          }
        }
      } catch (err) {
        // A reconcile read failure must not wedge the loop — log and proceed as a
        // fresh iteration (the pending-queue order still yields the right item).
        emit('loop:reconcile:error', { id: loop.id, error: msgOf(err) })
      }
    }
  }

  // 2. Pull the next backlog item.
  const item = deps.store.nextBacklogItem(loop.id)
  if (!item) {
    deps.store.updateLoop(loop.id, {
      status: 'done',
      stopReason: 'backlog-empty',
      nextFireAt: null
    })
    emit('loop:stopped', { id: loop.id, reason: 'backlog-empty' })
    return { ran: false, stopped: true, reason: 'backlog-empty' }
  }

  // 3. Mark in-progress + open a run audit row.
  const startedAt = now()
  deps.store.updateBacklogItem(item.id, { status: 'in_progress', startedAt })
  const nextIteration = loop.iteration + 1

  // DoD-SEED (2BRAIN). Seed the brain-checkable definition-of-done NOW, at task
  // start, from live brain state — captured here (not re-derived at commit, when a
  // gone-quiet track could hide an omission). Carried in-scope to the verify gate
  // below, where evaluateDoD checks the turn's output against these criteria.
  let definitionOfDone: DefinitionOfDone | null = null
  if (deps.seedDoD) {
    try {
      definitionOfDone = await deps.seedDoD({ loop, item })
    } catch (err) {
      // A seed-gathering throw must not block the task — absent DoD is fail-safe-
      // open (the gate simply has no DoD to check). Logged, non-fatal.
      emit('loop:dod:error', { id: loop.id, iteration: nextIteration, error: msgOf(err) })
    }
    if (definitionOfDone) {
      emit('loop:dod:seed', {
        id: loop.id,
        iteration: nextIteration,
        itemId: item.id,
        criteria: definitionOfDone.acceptanceCriteria.map((c) => c.kind),
        tracks: definitionOfDone.seededFromTracks
      })
    }
  }
  const run = deps.store.recordLoopRun({
    loopId: loop.id,
    iteration: nextIteration,
    backlogId: item.id,
    startedAt
  })

  // 3.5 (L8 HITL). Gate an irreversible step behind explicit operator approval.
  // FAIL-CLOSED: the gate runs whenever the irreversibility classifier is wired
  // and the step requires approval. If an approval channel is wired we request a
  // verdict; if NONE is wired we must NOT run the irreversible step unattended —
  // the absence of a channel is treated as a denial ('no-approval-channel').
  // Either way a denial skips the step + journals it. Reversible / read tasks
  // (requiresApproval false) never reach the skip path and proceed normally.
  if (deps.irreversibilityFloor) {
    const action: GatedAction = {
      verb: item.task.trim().split(/\s+/)[0],
      summary: item.task
    }
    if (requiresApproval(action, deps.irreversibilityFloor)) {
      const verdict = deps.approval
        ? await requestApproval(action, loop, deps.approval)
        : 'deny'
      if (verdict === 'deny') {
        const denyReason = deps.approval ? 'operator-denied' : 'no-approval-channel'
        const finishedAt = now()
        deps.store.updateBacklogItem(item.id, {
          status: 'skipped',
          result: denyReason,
          finishedAt
        })
        deps.store.finishLoopRun(run.id, { status: 'done', finishedAt })
        const jp = journalPath(loop)
        if (jp && deps.journalFs) {
          try {
            appendEntry(
              jp,
              { loopId: loop.id, itemId: item.id, kind: 'stop', gitSha: null, usage: null, cost: null, note: denyReason },
              deps.journalFs,
              now
            )
          } catch (err) {
            emit('loop:journal:error', { id: loop.id, error: msgOf(err) })
          }
        }
        const nextFire = computeNextFire(loop, now(), deps.minIntervalSeconds)
        deps.store.updateLoop(loop.id, { nextFireAt: nextFire })
        emit('loop:iteration:skipped', {
          id: loop.id,
          iteration: nextIteration,
          backlogId: item.id,
          reason: denyReason
        })
        return { ran: false, stopped: false, reason: denyReason }
      }
    }
  }

  // 3.6 (L7 pre-iteration disk guard). Running the artifact volume out of disk
  // mid-turn corrupts the commit, so we PAUSE before the turn (not just after).
  // stop-not-corrupt: the just-claimed item is reset to pending and the audit row
  // closed so a resume (after disk is freed) re-runs it cleanly.
  if (deps.resourceThresholds && deps.statfs && loop.artifactDir) {
    const diskFree = await diskFreeBytes(loop.artifactDir, deps.statfs)
    const diskDecision = resourceCheck(deps.resourceThresholds, {
      diskFreeBytes: diskFree,
      rssBytes: 0
    })
    if (diskDecision.action === 'pause') {
      const finishedAt = now()
      deps.store.updateBacklogItem(item.id, { status: 'pending', startedAt: undefined })
      deps.store.finishLoopRun(run.id, { status: 'done', finishedAt })
      deps.store.updateLoop(loop.id, {
        status: 'paused',
        stopReason: diskDecision.reason,
        nextFireAt: null
      })
      if (deps.deliver) await escalate('resource-exhaustion', loop, deps.deliver)
      emit('loop:stopped', { id: loop.id, reason: diskDecision.reason })
      return { ran: false, stopped: true, reason: diskDecision.reason }
    }
  }

  // 4. Build the iteration prompt. When the loop has a git artifact + exec seam,
  // L3 feeds a FRESH, bounded context {plan + rolling summary + artifact state}
  // instead of an ever-growing transcript; the ledger stays as a compact
  // idempotency hint. Without those seams this is byte-identical to the legacy
  // instruction+task+ledger prompt.
  const remainingAfter = deps.store.countBacklog(loop.id, 'pending')
  const completed = deps.store
    .listRecentDone(loop.id, 5)
    .map((c) => ({ task: c.task, result: c.result }))
  const ledgerPrompt = buildIterationPrompt(loop, item, {
    iteration: nextIteration,
    remaining: remainingAfter,
    completed
  })
  let prompt = ledgerPrompt
  if (loop.artifactDir && deps.exec) {
    const contextMax = deps.contextMaxChars ?? 12_000
    const artifactState = await readArtifactState(loop.artifactDir, deps.exec, contextMax)
    const messages = buildBoundedContext({
      plan: loop.instruction ?? '',
      rollingSummary: loop.rollingSummary ?? '',
      artifactState,
      maxChars: contextMax
    })
    const contextBody = messages.map((m) => `${m.role}: ${m.content}`).join('\n\n')
    prompt = contextBody ? `${contextBody}\n\n${ledgerPrompt}` : ledgerPrompt
  }
  emit('loop:iteration:start', { id: loop.id, iteration: nextIteration, backlogId: item.id })

  // 5 (L6). Provider selection + circuit breaker. `provider` is the persisted
  // active provider (survives restart) or the loop model. If its breaker is open
  // (in cooldown) we switch to the next entry of the persisted fallback chain;
  // an exhausted chain pauses + escalates instead of hammering a dead provider.
  let provider = loop.currentProvider ?? loop.model ?? 'duin-brain'
  let breaker = getBreaker(deps, provider)
  if (deps.breakers && breaker && !breaker.canRequest(now())) {
    const next = nextProviderInChain(parseChain(loop.providerChain), [provider])
    if (next) {
      provider = next
      deps.store.updateLoop(loop.id, { currentProvider: next })
      breaker = getBreaker(deps, provider)
    } else {
      const finishedAt = now()
      deps.store.finishLoopRun(run.id, { status: 'error', finishedAt })
      deps.store.updateBacklogItem(item.id, {
        status: 'error',
        result: 'all providers unavailable (circuit open)',
        finishedAt
      })
      deps.store.updateLoop(loop.id, {
        status: 'paused',
        stopReason: 'permanent-error',
        nextFireAt: null
      })
      if (deps.deliver) await escalate('permanent-error', loop, deps.deliver)
      emit('loop:stopped', { id: loop.id, reason: 'permanent-error' })
      return { ran: false, stopped: true, reason: 'permanent-error' }
    }
  }

  // Run the turn under a per-iteration stall watchdog. If the turn exceeds the
  // wall-clock budget, abort it via the signal and treat it as a timeout — the
  // item is marked error so the loop advances rather than wedging. When the L6
  // retry seams are wired, transient failures are retried (deterministic jitter)
  // WITHIN this same watchdog window before the catch path takes over.
  const iterationTimeoutMs = deps.iterationTimeoutMs ?? 0
  const watchdog = new AbortController()
  // Register the live abort handle so the goal-loop bridge can cancel this turn
  // mid-flight (goal paused/blocked/cleared). Cleared in the finally below.
  loopAbortControllers.set(loop.id, watchdog)
  let timedOut = false
  const watchdogTimer =
    iterationTimeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          watchdog.abort()
        }, iterationTimeoutMs)
      : null
  try {
    // F3 (A5) — loop turns run through the BRAIN by default (grounded, tools,
    // governance), not a raw model. An explicit loop.model / persisted provider
    // still wins.
    const doTurn = (): Promise<{ tokensUsed?: number } | unknown> =>
      deps.runTurn({
        conversationId: loop.conversationId,
        model: provider,
        promptBody: prompt,
        signal: watchdog.signal
      })
    const result =
      deps.jitterFn && deps.sleepFn
        ? await withRetry(doTurn, {
            retries: deps.retries ?? 3,
            baseMs: deps.backoffMs ?? 500,
            jitterFn: deps.jitterFn,
            sleepFn: deps.sleepFn,
            // Never retry once the watchdog aborted the turn — that is a timeout,
            // not a transient dependency blip, and must fall through to the
            // timeout path rather than burning the backoff budget.
            isTransient: (e) => !watchdog.signal.aborted && classifyError(e) === 'transient'
          })
        : await doTurn()
    if (breaker) breaker.onSuccess()

    // BUG-1 (turn-incomplete). runChatRound returns null (it does NOT throw)
    // when it hits its tool-round cap; the watchdog sets `timedOut` when it
    // aborts a resolved-but-overrun turn. Either way the turn did NOT finish
    // this item — committing it here would record a partial / empty artifact as
    // a SUCCESSFUL iteration (the reported defect). So do NOT commit and do NOT
    // mark the item done. But — for an unattended long run — one over-budget
    // item must NOT halt the whole loop: mark it error and ADVANCE to the next
    // backlog item (same behaviour as the throw+timedOut catch branch below, so
    // an abort behaves identically whether the turn throws or resolves), while
    // firing an escalation so the operator is TOLD an item was skipped without
    // the run stalling. The iteration / cost / stall ceilings still bound a
    // persistently-truncating loop. lastGitSha stays UNCHANGED (nothing durable
    // committed); tokens spent are still accrued. breaker.onSuccess() stays
    // as-is: a truncated turn is not a provider failure.
    const incomplete = result == null || timedOut
    if (incomplete) {
      const finishedAt = now()
      deps.store.finishLoopRun(run.id, { status: timedOut ? 'timeout' : 'error', finishedAt })
      deps.store.updateBacklogItem(item.id, {
        status: 'error',
        result: timedOut
          ? `iteration timed out after ${iterationTimeoutMs} ms`
          : 'turn-incomplete — item hit the turn budget before finishing',
        finishedAt
      })
      // Advance: tick the iteration counter (bounds the loop toward maxIterations)
      // and schedule the next fire so the loop keeps making progress. Persist the
      // tokens spent; do NOT advance lastGitSha — no durable artifact landed.
      const nextFire = computeNextFire(loop, now(), deps.minIntervalSeconds)
      const advancedItem: Loop = { ...loop, iteration: nextIteration }
      deps.store.updateLoop(loop.id, {
        iteration: nextIteration,
        tokensUsed: loop.tokensUsed + tokensFrom(result),
        lastIterationAt: finishedAt,
        nextFireAt: nextFire
      })
      // Notify (option 3): the loop keeps running, but the operator gets a
      // heads-up that this item was skipped. Escalation only delivers a message
      // here — it does NOT pause the loop.
      if (deps.deliver) await escalate('turn-incomplete', advancedItem, deps.deliver)
      emit('loop:iteration:error', {
        id: loop.id,
        iteration: nextIteration,
        error: timedOut ? 'timeout' : 'turn-incomplete'
      })
      return { ran: true, stopped: false, error: 'turn-incomplete', timedOut }
    }

    const turnTokens = tokensFrom(result)
    const finishedAt = now()
    deps.store.finishLoopRun(run.id, { status: 'done', tokensUsed: turnTokens, finishedAt })

    const newTokens = loop.tokensUsed + turnTokens
    const outcome = outcomeFrom(result)

    // L1 + L5. Durable commit-per-step + cost accrual. Ordering is load-bearing:
    // the git commit + its fsync'd journal entry land FIRST (durable), and ONLY
    // THEN is the backlog item flagged done in the DB. A crash in between leaves
    // the item `in_progress` (never a bare DB `done` with no durable commit) so
    // the L2 reconcile re-runs it. Cost accrues via the price table with a
    // DEFAULT_PROVIDER_PRICE fallback so unknown models still cost (never inert).
    const usage = usageFrom(result, provider)
    const costThisTurn = costOfUsage(usage, deps.priceTable ?? {})
    const newCostSpent = accrue(loop.costSpent, costThisTurn)

    // ── Governor 4a: HOLD output instead of landing it (stage rung) ──────────────
    // The turn already ran; now its durable output is HELD, not landed. For an
    // artifact loop the git output is parked on a side ref (stageStep) so the branch
    // shows NOTHING until ratify; the backlog item goes to awaiting-ratification. The
    // loop PAUSES here — one iteration is staged at a time — so we RETURN before any
    // of the downstream landing/continue logic (that is why no work-completing return
    // below needs a `staged` marker: none is reachable while holding). Fail-safe: if
    // holding throws we PAUSE and never fall through to a normal commit (which would
    // land the very output we meant to hold). Flag-off ⇒ holdOutput false ⇒ skipped.
    if (holdOutput) {
      let stagedSha: string | null = null
      if (loop.artifactDir && deps.exec) {
        try {
          const held = await stageStep(
            loop.artifactDir,
            `iter ${nextIteration}: ${item.task}`,
            item.id,
            deps.exec
          )
          stagedSha = held.stagedSha
          const jp = journalPath(loop)
          if (jp && deps.journalFs) {
            appendEntry(
              jp,
              { loopId: loop.id, itemId: item.id, kind: 'staged', gitSha: stagedSha, usage, cost: costThisTurn, note: outcome },
              deps.journalFs,
              now
            )
          }
        } catch (err) {
          // Holding FAILED → fail SAFE. Leave the item in_progress (L2 reconcile
          // re-runs it), pause the loop, surface the error. NEVER land the output.
          deps.store.updateLoop(loop.id, { status: 'paused', stopReason: 'stage-failed', nextFireAt: null })
          emit('loop:commit:error', { id: loop.id, iteration: nextIteration, error: msgOf(err) })
          emit('loop:stopped', { id: loop.id, reason: 'stage-failed' })
          return { ran: true, stopped: true, reason: 'stage-failed', staged: false }
        }
      }
      // Hold the backlog completion: awaiting-ratification (NOT done) — invisible to the
      // pending/in_progress/done filters until a human ratifies (lands) or reverts (discards).
      deps.store.updateBacklogItem(item.id, { status: 'awaiting-ratification' })
      deps.store.updateLoop(loop.id, {
        iteration: nextIteration,
        tokensUsed: newTokens,
        lastIterationAt: finishedAt,
        status: 'paused',
        stopReason: 'awaiting-ratification',
        nextFireAt: null,
        // Cost accrues (the turn really ran + billed); lastGitSha is UNCHANGED because the
        // branch did not advance — the output is held on the side ref, not on HEAD.
        costSpent: newCostSpent,
        lastGitSha: loop.lastGitSha
      })
      emit('loop:staged', { id: loop.id, iteration: nextIteration, backlogId: item.id, gitSha: stagedSha })
      emit('loop:stopped', { id: loop.id, reason: 'awaiting-ratification' })
      // W2 (posture 2026-08-21): a held iteration is a QUESTION — file it in the Needs-you
      // inbox with the ratify handle (actionId = backlog item id; loops:ratify answers it and
      // resolveByActionId clears the card). Without this the stage rung parked work into a
      // surface nothing rendered — the exact bricking the merit-autonomy clear documents.
      // Best-effort + dynamic import, same as the failure-notice producer below.
      void (async () => {
        try {
          const { recordNotice } = await import('./proactive/notices-store')
          recordNotice({
            kind: 'loop',
            severity: 'info',
            needsDecision: true,
            title: 'A loop iteration is staged — your call',
            body: `${(loop.instruction ?? '').trim().slice(0, 140) || loop.id} (iteration ${nextIteration})`,
            actionId: item.id,
            dedupKey: `loop-staged:${loop.id}`,
            deepLink: 'duin://tool/homeStatus'
          })
        } catch (err) {
          console.debug('[loop-controller] staged notice best-effort:', msgOf(err))
        }
      })()
      return { ran: true, stopped: true, reason: 'awaiting-ratification', staged: true }
    }

    let newGitSha = loop.lastGitSha
    if (loop.artifactDir && deps.exec) {
      try {
        newGitSha = await commitStep(
          loop.artifactDir,
          `iter ${nextIteration}: ${item.task}`,
          deps.exec
        )
        const jp = journalPath(loop)
        if (jp && deps.journalFs) {
          appendEntry(
            jp,
            {
              loopId: loop.id,
              itemId: item.id,
              kind: 'commit',
              gitSha: newGitSha,
              usage,
              cost: costThisTurn,
              note: outcome
            },
            deps.journalFs,
            now
          )
        }
      } catch (err) {
        // A commit/journal failure must not lose the turn — log and continue.
        // The item is NOT yet marked done, so a crash here leaves it in_progress
        // and the next restart re-runs it (durability > a premature DB flag).
        emit('loop:commit:error', { id: loop.id, iteration: nextIteration, error: msgOf(err) })
      }
    }

    // VERIFY (2BRAIN). The durable artifact is committed; before we self-attest
    // this item `done`, gate on a BRAIN-output verify receipt (memory-write
    // non-corrupting + digest-cites-real-notes, judged via the reused brain-health
    // detectors). A PROVEN-bad output blocks the done-flag: the item stays
    // in_progress so the L2 reconcile re-runs it (stop-not-corrupt), never a
    // durable self-attested false success. Absent seam / null receipt ⇒ skip
    // (fail-safe-open) so an ungoverned loop behaves exactly as before.
    if (deps.brainVerify) {
      let receipt: VerifyReceipt | null = null
      try {
        receipt = await deps.brainVerify({ loop, item, result })
      } catch (err) {
        // A verify-gathering throw must not fabricate a pass, but absent evidence
        // is fail-safe-open — treat the throw as "no receipt" (logged, non-fatal).
        emit('loop:verify:error', {
          id: loop.id,
          iteration: nextIteration,
          error: msgOf(err)
        })
      }
      if (receipt) {
        const decision = verifyBeforeCommit(receipt, {
          regressionTolerance: deps.verifyRegressionTolerance
        })
        // Fold the seeded DoD (dod-seed) into the SAME gate: the contract's seed
        // half (was the output faithful to what "done" meant at task start?) and
        // check half (was the write non-corrupting + grounded?) block done together.
        const dod = definitionOfDone
          ? evaluateDoD(definitionOfDone, {
              coveredTracks: receipt.coveredTracks,
              orphanClaims: receipt.orphanClaims
            })
          : null
        const failures = [...decision.failures, ...(dod ? dod.failures : [])]
        if (failures.length > 0) {
          const jp = journalPath(loop)
          if (jp && deps.journalFs) {
            appendEntry(
              jp,
              {
                loopId: loop.id,
                itemId: item.id,
                kind: 'verify',
                gitSha: newGitSha,
                usage,
                cost: costThisTurn,
                note: `verify-reject: ${failures.join('; ')}`
              },
              deps.journalFs,
              now
            )
          }
          emit('loop:verify:reject', {
            id: loop.id,
            iteration: nextIteration,
            itemId: item.id,
            failures,
            checks: decision.checks,
            dod: dod ? dod.perCriterion : undefined
          })
          // Withholding the SUCCESS ATTESTATION must not also withhold the
          // ACCOUNTING. This was the only non-throwing exit that persisted no loop
          // state, and the omission was invisible because the gate "correctly"
          // refuses the done-flag: skipping updateLoop froze `iteration` (so
          // maxIterations never advanced), never accrued tokensUsed/costSpent (so
          // tokenBudget and costBudgetUsd never tripped) and left nextFireAt at its
          // stale past value — listDueLoops selects next_fire_at <= now, so a
          // persistently-mis-citing loop re-fired on every 30s tick, ignoring
          // intervalSeconds, with every ceiling frozen. Persist the same carried
          // state the turn-incomplete branch does (and BEFORE escalate, so a
          // delivery throw cannot lose it). The item stays in_progress and `done`
          // stays withheld — that half of the gate is correct and unchanged.
          const nextFire = computeNextFire(loop, now(), deps.minIntervalSeconds)
          deps.store.updateLoop(loop.id, {
            iteration: nextIteration,
            tokensUsed: newTokens,
            costSpent: newCostSpent,
            lastGitSha: newGitSha,
            lastIterationAt: finishedAt,
            nextFireAt: nextFire
          })
          if (deps.deliver) await escalate('verify-failed', loop, deps.deliver)
          // Item left in_progress (not done): the durable commit stands, but the
          // success attestation is withheld for reconcile to re-run.
          //
          // ...except reconcile only runs for a loop that HAS an artifactDir (step 1.5
          // is gated on it, and on a journal file existing). No renderer path has ever
          // sent artifactDir, so every UI-created loop has none — and nextBacklogItem
          // selects `status = 'pending'` only. So on the loop shapes the app can
          // actually create, one verify rejection stranded that item in_progress with
          // no revival path at all, and the loop then reported `backlog-empty` and
          // marked itself done while the task had never finished.
          //
          // When no reconcile will run, do its job here: put the item back to pending
          // so the next iteration re-runs it. Same transition reconcile applies to a
          // verify-rejected item (status pending, startedAt cleared), just reached
          // directly. Loops WITH an artifactDir are untouched — reconcile still owns
          // them, and doing it twice would race its journal-based decision.
          const reconcileWillRevive = Boolean(
            loop.artifactDir && deps.exec && deps.journalFs && jp
          )
          if (!reconcileWillRevive) {
            deps.store.updateBacklogItem(item.id, { status: 'pending', startedAt: undefined })
          }
          return { ran: true, stopped: false, error: 'verify-failed' }
        }
        emit('loop:verify:pass', {
          id: loop.id,
          iteration: nextIteration,
          itemId: item.id,
          checks: decision.checks,
          dod: dod ? dod.perCriterion : undefined
        })
      }
    }

    // Durable progress has landed (or there is no git artifact to commit) — NOW
    // flag the item done. This DB write is intentionally LAST so completion is
    // never guarded by a bare DB flag ahead of the durable commit+journal.
    deps.store.updateBacklogItem(item.id, { status: 'done', finishedAt })

    // L4. Forward-progress fingerprint over the post-commit artifact state.
    let newStateHash = loop.lastStateHash
    let advancedFlag = true
    let newStallCount = loop.stallCount
    let repeat = false
    if (loop.artifactDir && deps.exec) {
      const postState = await readArtifactState(
        loop.artifactDir,
        deps.exec,
        deps.contextMaxChars ?? 12_000
      )
      newStateHash = hashState(postState)
      const prog = trackProgress(loop.lastStateHash, newStateHash, loop.stallCount)
      advancedFlag = prog.advanced
      newStallCount = prog.stallCount
      const hist = stateActionHistory.get(loop.id) ?? []
      // L4 state-revisit: an A→B→A→B oscillation changes the hash every iteration
      // (so trackProgress resets stallCount to 0 and never escalates) yet keeps
      // returning to a state seen earlier in the recent window — a cycle. Detect
      // it BEFORE pushing the new entry. detectRepeat alone misses it because it
      // keys on (state,action) and the action (item.id) differs across items.
      const revisited = hist.some((h) => h.state === newStateHash)
      hist.push({ state: newStateHash, action: item.id })
      while (hist.length > STATE_ACTION_HISTORY_CAP) hist.shift()
      stateActionHistory.set(loop.id, hist)
      repeat = detectRepeat(hist, deps.repeatWindow) || revisited
    }

    // L3/L8. Carry a bounded rolling summary forward instead of transcript growth.
    const newRollingSummary = updateRollingSummary(loop.rollingSummary ?? '', {
      itemTask: item.task,
      outcome,
      gitSha: newGitSha,
      advanced: advancedFlag
    })

    const advanced: Loop = {
      ...loop,
      iteration: nextIteration,
      tokensUsed: newTokens,
      costSpent: newCostSpent,
      lastGitSha: newGitSha,
      stallCount: newStallCount,
      lastStateHash: newStateHash,
      rollingSummary: newRollingSummary
    }
    // The carried-state fields persisted on EVERY exit below (stop or continue).
    const persist = {
      costSpent: newCostSpent,
      lastGitSha: newGitSha,
      stallCount: newStallCount,
      lastStateHash: newStateHash,
      rollingSummary: newRollingSummary
    }

    // 6a. Backlog drained → done.
    if (deps.store.countBacklog(loop.id, 'pending') === 0) {
      deps.store.updateLoop(loop.id, {
        iteration: nextIteration,
        tokensUsed: newTokens,
        lastIterationAt: finishedAt,
        status: 'done',
        stopReason: 'backlog-empty',
        nextFireAt: null,
        ...persist
      })
      emit('loop:iteration:done', { id: loop.id, iteration: nextIteration })
      emit('loop:stopped', { id: loop.id, reason: 'backlog-empty' })
      return { ran: true, stopped: true, reason: 'backlog-empty' }
    }

    // 6b. Post-iteration ceilings (iters/wallclock/tokens) folded with the L5
    // cost ceiling — same stop path. The commit+journal already landed above, so
    // halting here is stop-not-corrupt. A cost breach names 'cost-budget'.
    const post = checkCeilings(meritCeilingLoop(advanced), now())
    const costDec = checkCostCeiling(newCostSpent, loop.costBudgetUsd)
    if (post.stop || costDec.stop) {
      deps.store.updateLoop(loop.id, {
        iteration: nextIteration,
        tokensUsed: newTokens,
        lastIterationAt: finishedAt,
        status: 'done',
        stopReason: costDec.stop ? 'cost-budget' : post.reason,
        nextFireAt: null,
        ...persist
      })
      emit('loop:iteration:done', { id: loop.id, iteration: nextIteration })
      emit('loop:stopped', { id: loop.id, reason: costDec.stop ? 'cost-budget' : post.reason })
      return { ran: true, stopped: true, reason: costDec.stop ? 'cost-budget' : post.reason }
    }

    // L4 (stall/repeat → pause + escalate). K consecutive no-progress iterations
    // or an oscillating (state,action) loop halt rather than burn hours doing
    // nothing. Only evaluated on the git-backed path (a real progress signal).
    if (
      loop.artifactDir &&
      deps.exec &&
      (stallShouldEscalate(newStallCount, deps.stallK ?? 0) || repeat)
    ) {
      deps.store.updateLoop(loop.id, {
        iteration: nextIteration,
        tokensUsed: newTokens,
        lastIterationAt: finishedAt,
        status: 'paused',
        stopReason: 'stalled',
        nextFireAt: null,
        ...persist
      })
      if (deps.deliver) await escalate('stalled', advanced, deps.deliver)
      emit('loop:iteration:done', { id: loop.id, iteration: nextIteration })
      emit('loop:stopped', { id: loop.id, reason: 'stalled' })
      return { ran: true, stopped: true, reason: 'stalled' }
    }

    // L7 (resource guards). Disk below the floor pauses (stop-not-corrupt);
    // high RSS alerts but proceeds; an opt-in RSS recycle flags a restart that
    // tickLoops honours between iterations (safe because L1/L2 make it replayable).
    if (deps.resourceThresholds && (deps.statfs || deps.rssSeam)) {
      const readings = {
        diskFreeBytes:
          loop.artifactDir && deps.statfs
            ? await diskFreeBytes(loop.artifactDir, deps.statfs)
            : Number.MAX_SAFE_INTEGER,
        rssBytes: deps.rssSeam ? processRssBytes(deps.rssSeam) : 0
      }
      const d = resourceCheck(deps.resourceThresholds, readings)
      if (d.action === 'pause') {
        deps.store.updateLoop(loop.id, {
          iteration: nextIteration,
          tokensUsed: newTokens,
          lastIterationAt: finishedAt,
          status: 'paused',
          stopReason: d.reason,
          nextFireAt: null,
          ...persist
        })
        if (deps.deliver) await escalate('resource-exhaustion', advanced, deps.deliver)
        emit('loop:iteration:done', { id: loop.id, iteration: nextIteration })
        emit('loop:stopped', { id: loop.id, reason: d.reason })
        return { ran: true, stopped: true, reason: d.reason }
      }
      if (d.action === 'alert' && deps.deliver) {
        await escalate('resource-exhaustion', advanced, deps.deliver)
      }
      if (shouldRestartToRecover(readings.rssBytes, deps.rssRecycleBytes ?? 0, nextIteration)) {
        loopRecycleRequests.add(loop.id)
      }
    }

    // 6c. The model may have changed loop state DURING the turn via loop_control
    // (pause / stop / mission_complete, or continue to set a self-paced cadence).
    // Re-read before scheduling so we never resurrect a loop the model terminated.
    const fresh = deps.store.getLoop(loop.id)
    if (fresh && fresh.status !== 'running') {
      deps.store.updateLoop(loop.id, {
        iteration: nextIteration,
        tokensUsed: newTokens,
        lastIterationAt: finishedAt,
        ...persist
      })
      emit('loop:iteration:done', { id: loop.id, iteration: nextIteration })
      emit('loop:stopped', { id: loop.id, reason: fresh.stopReason ?? fresh.status })
      return { ran: true, stopped: true, reason: fresh.stopReason ?? fresh.status }
    }

    // Continue — schedule the next iteration. Self-paced honours a future
    // next-fire the model set this turn; otherwise the per-mode default.
    const nextFire =
      loop.mode === 'self_paced' && fresh && fresh.nextFireAt != null && fresh.nextFireAt > now()
        ? fresh.nextFireAt
        : computeNextFire(loop, now(), deps.minIntervalSeconds)

    // L8 (digest). Emit a periodic status line on the iteration/time cadence.
    let digestPatch: { lastDigestAt?: number } = {}
    if (deps.deliver && ((deps.digestEveryIters ?? 0) > 0 || (deps.digestEveryMs ?? 0) > 0)) {
      const everyIters = deps.digestEveryIters ?? 0
      const everyMs = deps.digestEveryMs ?? 0
      const byIter = everyIters > 0 && nextIteration % everyIters === 0
      const byTime = everyMs > 0 && now() - (loop.lastDigestAt ?? 0) >= everyMs
      if (byIter || byTime) {
        const nextForDigest = deps.store.nextBacklogItem(loop.id)
        const md = buildDigest({
          loop: {
            id: loop.id,
            iteration: nextIteration,
            startedAt: loop.startedAt,
            maxIterations: loop.maxIterations
          },
          backlogStats: {
            pending: deps.store.countBacklog(loop.id, 'pending'),
            done: deps.store.countBacklog(loop.id, 'done'),
            error: deps.store.countBacklog(loop.id, 'error'),
            total: deps.store.countBacklog(loop.id)
          },
          usage,
          costUsd: newCostSpent,
          nextItem: nextForDigest?.task ?? null,
          buildStatus: 'unknown'
        })
        try {
          await deps.deliver(md)
        } catch (err) {
          emit('loop:digest:error', { id: loop.id, error: msgOf(err) })
        }
        digestPatch = { lastDigestAt: now() }
      }
    }

    // L5 burn-rate alert (non-stopping): warn when spend/hour crosses the alert.
    if (deps.deliver && (deps.burnAlertPerHour ?? 0) > 0 && loop.startedAt != null) {
      const burn = burnRatePerHour(newCostSpent, now() - loop.startedAt)
      if (burn > (deps.burnAlertPerHour ?? 0)) {
        await escalate('budget-breach', advanced, deps.deliver)
      }
    }

    deps.store.updateLoop(loop.id, {
      iteration: nextIteration,
      tokensUsed: newTokens,
      lastIterationAt: finishedAt,
      nextFireAt: nextFire,
      ...persist,
      ...digestPatch
    })
    emit('loop:iteration:done', { id: loop.id, iteration: nextIteration })
    return { ran: true, stopped: false }
  } catch (err) {
    if (breaker) breaker.onFailure(now())
    const finishedAt = now()
    if (timedOut) {
      // Watchdog tripped and the turn THREW on abort — same event as the
      // resolve-null incomplete path above, so behave identically: record a
      // timeout, mark the item error, advance (iteration still ticks toward
      // maxIterations), escalate a heads-up, and keep the loop running.
      deps.store.finishLoopRun(run.id, { status: 'timeout', finishedAt })
      deps.store.updateBacklogItem(item.id, {
        status: 'error',
        result: `iteration timed out after ${iterationTimeoutMs} ms`,
        finishedAt
      })
      const nextFire = computeNextFire(loop, now(), deps.minIntervalSeconds)
      const advancedItem: Loop = { ...loop, iteration: nextIteration }
      deps.store.updateLoop(loop.id, {
        iteration: nextIteration,
        lastIterationAt: finishedAt,
        nextFireAt: nextFire
      })
      if (deps.deliver) await escalate('turn-incomplete', advancedItem, deps.deliver)
      emit('loop:iteration:error', { id: loop.id, iteration: nextIteration, error: 'timeout' })
      return { ran: true, stopped: false, error: 'iteration timed out', timedOut: true }
    }
    const msg = err instanceof Error ? err.message : String(err)

    // L6 permanent-error routing: a non-transient failure (auth/quota/4xx) is
    // not worth retrying or advancing over — pause + escalate. Only when the L6
    // breaker seams are wired; otherwise fall through to the legacy error path.
    if (deps.breakers && classifyError(err) === 'permanent') {
      deps.store.finishLoopRun(run.id, { status: 'error', finishedAt })
      deps.store.updateBacklogItem(item.id, { status: 'error', result: msg, finishedAt })
      deps.store.updateLoop(loop.id, {
        status: 'paused',
        stopReason: 'permanent-error',
        nextFireAt: null
      })
      if (deps.deliver) await escalate('permanent-error', loop, deps.deliver)
      emit('loop:iteration:error', { id: loop.id, iteration: nextIteration, error: msg })
      emit('loop:stopped', { id: loop.id, reason: 'permanent-error' })
      return { ran: true, stopped: true, error: msg, reason: 'permanent-error' }
    }

    deps.store.finishLoopRun(run.id, { status: 'error', finishedAt })
    deps.store.updateBacklogItem(item.id, { status: 'error', result: msg, finishedAt })
    // A failed iteration marks the item error and advances; the loop keeps
    // going (the iteration counter still ticks toward maxIterations, so a
    // persistently-failing loop can't spin forever). Schedule the next fire.
    const nextFire = computeNextFire(loop, now(), deps.minIntervalSeconds)
    deps.store.updateLoop(loop.id, {
      iteration: nextIteration,
      lastIterationAt: finishedAt,
      nextFireAt: nextFire
    })
    emit('loop:iteration:error', { id: loop.id, iteration: nextIteration, error: msg })
    return { ran: true, stopped: false, error: msg }
  } finally {
    if (watchdogTimer) clearTimeout(watchdogTimer)
    // Only clear the abort handle if it's still OURS — a re-entrant iteration for the
    // same loop (guarded against elsewhere) must not have its handle removed by us.
    if (loopAbortControllers.get(loop.id) === watchdog) loopAbortControllers.delete(loop.id)
  }
}

// ---------------------------------------------------------------------------
// Production wiring (DB-backed deps + 30s timer)
// ---------------------------------------------------------------------------

function emitToAll(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

const execFileAsync = promisify(execFile)

/** Production long-run seams (L1-L8). A loop only exercises the git/disk layers
 *  when it has an `artifactDir`; loops without one keep today's behavior. The
 *  operator-approval seam is intentionally NOT wired here (no per-loop operator
 *  channel yet); this is SAFE because the L8 gate is fail-closed — an irreversible
 *  step with no approval channel is skipped ('no-approval-channel'), never run
 *  unattended. `priceTable` is left empty because costOfUsage now falls back to
 *  DEFAULT_PROVIDER_PRICE, so unknown models still accrue cost. */
function productionLongRunDeps(): Partial<LoopIterationDeps> {
  const lc = readLongRunConfig()

  const journalFs: JournalFs = {
    appendLine(path, line) {
      mkdirSync(dirname(path), { recursive: true })
      const fd = openSync(path, 'a')
      try {
        writeSync(fd, line + '\n')
        fsyncSync(fd) // durability is the whole point of L1
      } finally {
        closeSync(fd)
      }
    },
    readLines(path) {
      return existsSync(path) ? readFileSync(path, 'utf-8').split('\n') : []
    },
    exists(path) {
      return existsSync(path)
    }
  }

  // Args-array only (no shell) so the untrusted-ish commit message can never
  // inject. A non-zero git exit is returned as `code`, not thrown, so
  // currentSha/isClean read it cleanly.
  const exec: ExecSeam = async (cmd, args, opts) => {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd: opts?.cwd,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024
      })
      return { stdout: String(stdout), stderr: String(stderr), code: 0 }
    } catch (err) {
      const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown; code?: unknown }
      return {
        stdout: String(e?.stdout ?? ''),
        stderr: String(e?.stderr ?? e?.message ?? ''),
        code: typeof e?.code === 'number' ? e.code : 1
      }
    }
  }

  const statfs: StatfsSeam = async (path) => {
    const s = await statfsPromise(path)
    return { bavail: Number(s.bavail), bsize: Number(s.bsize) }
  }

  const rssSeam: RssSeam = () => process.memoryUsage().rss

  const deliver: DeliverSeam = async (body) => {
    // An escalation means a loop stalled, blew a budget, or failed to verify — it
    // reaches the user as an OS toast that says only "DUIN" and disappears. Record it
    // first so the reason survives somewhere they can go back to.
    try {
      const { recordNotice } = await import('./proactive/notices-store')
      recordNotice({
        kind: 'loop',
        severity: 'error',
        title: body,
        // LoopsPanel is a TAB inside the Automations hub since the 2026-07-07 surface
        // consolidation — there is no 'loop' surface to open any more.
        deepLink: 'duin://tool/automations'
      })
    } catch (err) {
      console.debug('[loop-controller] notice record best-effort:', msgOf(err))
    }
    try {
      const { channelDispatch } = await import('./channel-dispatch')
      const r = await channelDispatch({ kind: 'push', target: '' }, body, {
        title: 'A loop needs attention',
        deepLink: 'duin://tool/automations'
      })
      return { ok: r.ok, error: r.error }
    } catch (err) {
      return { ok: false, error: msgOf(err) }
    }
  }

  return {
    journalFs,
    exec,
    statfs,
    rssSeam,
    deliver,
    // The irreversibility classifier is wired (reusing the ACT action-tier
    // ladder). `approval` stays unset (no per-loop operator channel yet), which is
    // now SAFE: the L8 gate is fail-closed, so a step classified irreversible is
    // SKIPPED ('no-approval-channel') rather than executed unattended. Reversible /
    // read tasks are unaffected and proceed normally.
    // NOTE: the unknown-verb⇒irreversible fail-safe applies only to DECLARED
    // actions — a free-text backlog task is classified by verb lookup alone. See
    // productionIrreversibilityFloor for why (it used to skip the whole backlog).
    irreversibilityFloor: productionIrreversibilityFloor,
    // Cost is data: an empty table is fine because costOfUsage falls back to
    // DEFAULT_PROVIDER_PRICE, so unknown models still accrue cost (never inert).
    priceTable: {},
    jitterFn: (_attempt, backoff) => backoff / 2 + Math.random() * (backoff / 2),
    sleepFn: (ms) => new Promise((r) => setTimeout(r, ms)),
    breakers: loopBreakers,
    breakerThreshold: lc.breakerThreshold,
    breakerCooldownMs: lc.breakerCooldownMs,
    retries: lc.retries,
    backoffMs: lc.backoffMs,
    stallK: lc.stallK,
    resourceThresholds: { diskMinBytes: lc.diskMinBytes, rssMaxBytes: lc.rssMaxBytes },
    rssRecycleBytes: lc.rssRecycleBytes,
    contextMaxChars: lc.contextMaxChars,
    digestEveryIters: lc.digestEveryIters,
    digestEveryMs: lc.digestEveryMs,
    burnAlertPerHour: lc.burnAlertPerHour
  }
}

// 2BRAIN verify: per-loop identity-integrity snapshot from the PREVIOUS iteration,
// so brainVerify can measure the store-health delta across THIS turn's writes. Coarse
// (other processes also touch the store between iterations) but the tolerance filters
// noise and a corrupting write shows as a sharp drop. Module-level: survives across
// iterations of the same loop within a process.
const loopHealthBefore = new Map<string, { coherence: number; purity: number }>()

/** The vault/notes dir for the 2BRAIN verify providers, or null when unset. */
function vaultDirForVerify(): string | null {
  try {
    const d = readSettings().localBrainNotesDir
    return typeof d === 'string' && d ? d : null
  } catch {
    return null
  }
}

/** CONSERVATIVE note-existence check for orphan-citation detection. Only a cited
 *  vault-relative PATH (has a slash, no traversal) that fails existsSync is treated
 *  as missing; a bare basename can't be safely resolved here, so it's treated as
 *  present (never a false orphan that would needlessly re-run a live task). */
function noteExistsInVault(vault: string, ref: string): boolean {
  if (!ref || ref.includes('..')) return true
  if (!ref.includes('/') && !ref.includes('\\')) return true // bare basename → don't flag
  try {
    return existsSync(join(vault, ref))
  } catch {
    return true
  }
}

function productionDeps(): LoopIterationDeps {
  return {
    store: {
      getLoop: store.getLoop,
      updateLoop: store.updateLoop,
      nextBacklogItem: store.nextBacklogItem,
      updateBacklogItem: store.updateBacklogItem,
      countBacklog: store.countBacklog,
      listRecentDone: store.listRecentDone,
      recordLoopRun: store.recordLoopRun,
      finishLoopRun: store.finishLoopRun,
      listDueLoops: store.listDueLoops,
      inProgressBacklogItem: store.inProgressBacklogItem
    },
    ...productionLongRunDeps(),
    runTurn: async (input) => {
      const runner = getLoopTurnRunner()
      if (!runner) throw new Error('loop turn runner not wired')
      const result = await runner({
        conversationId: input.conversationId,
        model: input.model,
        promptBody: input.promptBody,
        // Bug 2 — forward the iteration watchdog signal so a timeout actually
        // aborts the turn (the runner threads it into runChatRound).
        signal: input.signal
      })
      // Bug 1 — a null runHeadlessTurn result means the turn did NOT complete
      // (deadline / tool-round cap): propagate null so runLoopIteration detects
      // the incomplete turn and refuses to commit it as a successful iteration.
      // (Previously the token-estimate fallback below masked null as a truthy
      // {tokensUsed}, so the incomplete signal was silently lost.)
      if (result == null) return null
      // Carry a BOUNDED text form of the turn's reply so the 2BRAIN verify/DoD
      // providers can observe what the turn produced (cited notes, covered tracks).
      const replyText = ((): string => {
        try {
          return JSON.stringify(result ?? '')
        } catch {
          return ''
        }
      })().slice(0, 8000)
      // runHeadlessTurn returns a context-aware { tokensEstimate } counting the
      // full sent message stack (system prompt + history + prompt) plus reply —
      // prefer it over the prompt-only fallback below.
      if (
        result &&
        typeof result === 'object' &&
        typeof (result as { tokensEstimate?: unknown }).tokensEstimate === 'number'
      ) {
        return { tokensUsed: (result as { tokensEstimate: number }).tokensEstimate, replyText }
      }
      return { tokensUsed: estimateTokens(input.promptBody) + estimateTokens(replyText), replyText }
    },
    // 2BRAIN VERIFY provider (activation 6, wired). Gathers the BRAIN-output verify
    // receipt so the commit→done gate is LOAD-BEARING in prod (not just a seam):
    //  - memory-write non-corrupting → coherence+purity BEFORE (last iteration's
    //    snapshot for this loop) vs AFTER (now), via computeBrainHealthLive. A turn
    //    that sharply drops identity integrity is refused. First iteration ⇒ no
    //    baseline ⇒ corruption check skips (fail-safe-open).
    //  - orphanClaims → cited notes in the reply that don't resolve on disk
    //    (conservative: only a positively-missing note is flagged, so a false orphan
    //    can't stall the loop).
    //  - coveredTracks → which active ontology tracks the reply covered (for the DoD).
    // Best-effort: any failure yields a null receipt → the gate skips, never blocks.
    brainVerify: async ({ loop, result }) => {
      try {
        const vault = vaultDirForVerify()
        const { computeBrainHealthLive } = await import('./brain/brain-health-live')
        const { loadOntology } = await import('./brain/ontology')
        const rep = computeBrainHealthLive(vault)
        const after = { coherence: rep.axes.coherence.score, purity: rep.axes.purity.score }
        const before = loopHealthBefore.get(loop.id) ?? null
        loopHealthBefore.set(loop.id, after)

        const replyText =
          result && typeof result === 'object' && typeof (result as { replyText?: unknown }).replyText === 'string'
            ? (result as { replyText: string }).replyText
            : ''
        const cited = parseCitedNotes(replyText)
        const orphanClaims = vault
          ? orphanCitations(cited, (ref) => noteExistsInVault(vault, ref))
          : []
        const trackKeys = loadOntology(vault).tracks.map((t: { key: string }) => t.key)
        const coveredTracks = coveredTracksIn(replyText, trackKeys)

        const receipt: VerifyReceipt = {
          coherenceBefore: before?.coherence ?? null,
          coherenceAfter: after.coherence,
          purityBefore: before?.purity ?? null,
          purityAfter: after.purity,
          orphanClaims,
          coveredTracks
        }
        return receipt
      } catch {
        return null // no receipt → gate skips (fail-safe-open)
      }
    },
    // 2BRAIN DoD-SEED provider (activation 7, wired). Seeds a brain-checkable
    // definition-of-done from live state at task start: the active ontology tracks
    // (for covers-active-tracks on a covering task) + the always-on no-orphan-claims.
    seedDoD: async ({ loop }) => {
      try {
        const vault = vaultDirForVerify()
        const { loadOntology } = await import('./brain/ontology')
        const activeTracks = loadOntology(vault).tracks.map((t: { key: string }) => t.key)
        return seedDefinitionOfDone({
          instruction: loop.instruction ?? '',
          activeTracks,
          expectsCoverage: instructionExpectsCoverage(loop.instruction)
        })
      } catch {
        return null
      }
    },
    iterationTimeoutMs: DEFAULT_ITERATION_TIMEOUT_MS,
    minIntervalSeconds: readLoopConfig().minIntervalSeconds,
    emit: emitToAll
  }
}

let lastSpillGcAt = 0

/** Bound the spill dir during long-running loop sessions (the app-startup GC
 *  won't run again until restart). Throttled to hourly, best-effort. */
function maybeGcSpill(now: number): void {
  if (now - lastSpillGcAt < SPILL_GC_THROTTLE_MS) return
  lastSpillGcAt = now
  try {
    gcSpillDir()
  } catch (err) {
    console.error('[loops] spill gc failed:', err)
  }
}

/** Dispatch-time admission for a loop that was selected EARLIER in the same tick.
 *
 *  `tickLoops` picks its `due` list once, before its first await, then awaits a whole
 *  iteration per loop — and an iteration may outlast the 30s tick cadence. A later tick
 *  sees only the loop currently being awaited, so it starts the next one from its own
 *  fresh list; when the first tick's await returns, it starts that same loop again.
 *  Re-asking here, per loop, at the moment of dispatch is what closes that window.
 *
 *  Pure, and exported, so the invariant is falsifiable without standing up a turn runner.
 *  Callers must keep the `runningLoops.add` synchronous with this call — no await between
 *  them — or the check-then-act pair stops being atomic against another tick. */
export function admitLoopDispatch(
  loopId: string,
  running: ReadonlySet<string>,
  maxConcurrent: number
): 'run' | 'skip' | 'stop' {
  if (running.has(loopId)) return 'skip'
  if (running.size >= Math.max(1, maxConcurrent)) return 'stop'
  return 'run'
}

export async function tickLoops(now = Date.now()): Promise<void> {
  // No runner wired → nothing can run; skip quietly (e.g. very early boot).
  if (!getLoopTurnRunner()) return
  // SAFETY: honor the kill switches — DB loops must not fire when loops are
  // disabled or background autonomy is off (previously bypassed both).
  if (!readLoopConfig().enabled) return
  if (readSettings().backgroundAutonomy !== true) return
  const deps = productionDeps()
  const maxConcurrent = Math.max(1, readLoopConfig().maxConcurrent)
  // In-flight guard: skip loops whose previous iteration is still running, and
  // count running loops toward the cap so overlapping ticks can't multiply
  // iterations of one loop onto the same conversation.
  const slots = Math.max(0, maxConcurrent - runningLoops.size)
  const due = deps.store
    .listDueLoops(now)
    .filter((l) => !runningLoops.has(l.id))
    .slice(0, slots)
  if (due.length > 0) maybeGcSpill(now)
  for (const loop of due) {
    // Re-check at DISPATCH time, not just at selection time. `due` is computed once,
    // before the first await, but this body awaits a whole iteration per loop — and an
    // iteration is allowed to outlast the 30s tick cadence. A later tick sees only the
    // loop currently being awaited in `runningLoops`, so it happily selects and starts
    // the NEXT loop in this stale list; when the await here finally returns, this tick
    // starts that same loop again. Two concurrent iterations of one loop on one
    // conversation: their counters race last-write-wins, and for a git-artifact loop a
    // racing commit failure is swallowed while the item is still marked done. Raising
    // "Max concurrent loops" above 1 — the setting's stated purpose — is all it takes.
    //
    // Safe as a plain check because add() below is synchronous with it: no await sits
    // between them, so no other tick can interleave within this pair.
    const admission = admitLoopDispatch(loop.id, runningLoops, maxConcurrent)
    if (admission === 'skip') continue
    if (admission === 'stop') break
    runningLoops.add(loop.id)
    try {
      const outcome = await runLoopIteration(loop, deps)
      try {
        recordEvent({
          type: outcome.error ? 'loop.iteration.error' : 'loop.iteration',
          actorKind: 'system',
          severity: outcome.error ? 'warning' : 'info',
          conversationId: loop.conversationId,
          entityKind: 'loop',
          entityId: loop.id,
          payload: {
            iteration: loop.iteration + 1,
            ran: outcome.ran,
            stopped: outcome.stopped,
            reason: outcome.reason,
            error: outcome.error ? boundedJsonPreview(outcome.error) : undefined
          }
        })
      } catch (e) {
        console.error('[loops] iteration event write failed:', e)
      }
    } catch (err) {
      console.error('[loops] iteration failed:', err)
    } finally {
      runningLoops.delete(loop.id)
    }
  }

  // L7 restart-to-recover: a loop signalled its RSS crossed the recycle ceiling
  // BETWEEN iterations. This is opt-in (DUIN_LOOP_RSS_RECYCLE > 0) and safe only
  // because L1/L2 make the last committed step replayable. We surface the request
  // as an event for a higher layer to action rather than force a relaunch here.
  if (loopRecycleRequests.size > 0) {
    const ids = [...loopRecycleRequests]
    loopRecycleRequests.clear()
    emitToAll('loop:recycle:requested', { loopIds: ids })
  }
}

// SAFETY: ids of loops whose iteration is currently executing, so a slow loop
// spanning multiple 30s ticks is never re-launched concurrently (the runaway bug).
const runningLoops = new Set<string>()

let controllerTimer: NodeJS.Timeout | null = null

export function startLoopController(): void {
  if (controllerTimer) return
  const tick = (): void => {
    void tickLoops().catch((err) => console.error('[loops] controller tick failed:', err))
  }
  // Deferred for the same reason as startLoopWakeups(): this is called from the
  // synchronous app.whenReady() block, and tickLoops' own prologue reads the
  // loop config and settings off disk before it can decide it has nothing to do.
  setTimeout(tick, 8_000).unref?.()
  controllerTimer = setInterval(tick, 30_000)
}

export function stopLoopController(): void {
  if (!controllerTimer) return
  clearInterval(controllerTimer)
  controllerTimer = null
}
