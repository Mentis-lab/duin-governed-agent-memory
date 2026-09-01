// watchers — the EVENT-DRIVEN proactive layer (#2). Where cron pushes on a CLOCK,
// these push on real INTERNAL EVENTS: a forecast resolving, calibration drifting,
// a task turning high-priority, a scheduled job failing. Each such signal is routed
// as a formatted notice to the home channel via the Stage-1 delivery-queue, so a
// transient channel outage never silently drops the alert (the queue retries it).
//
// This module is a thin, SUBSCRIBE-side registry: the existing loops (calibration
// tick, automations runner, task writer) make a post-step call into one of the
// watch* entry points; those entry points decide whether to emit and hand the text
// to enqueue(). The core brain loops keep their logic unchanged.
//
// GUARDS (all tested, all default-safe):
//   • Individually enable-flagged. settings.watchers.{forecast,calibration,task,
//     jobFail} each default OFF — a fresh install pushes nothing until the operator
//     opts a specific watcher in. A disabled watcher short-circuits before any work.
//   • Debounced / coalesced. A per-(kind,dedupKey) window collapses a burst into a
//     single notice, so a storm of resolutions or repeated failures can't spam the
//     channel.
//   • Quiet-hours respected (cheap, hour-granular). Inside the configured window the
//     notice is suppressed rather than deferred — event-driven alerts are only useful
//     fresh, and the delivery-queue is for outage-retry, not scheduling.
//   • Never throws. Every entry point is best-effort: a bad config, a formatting
//     edge, or an enqueue failure resolves to {emitted:false} — a watcher can never
//     crash the loop that called it.
//
// This module carries NO exec authority: it only forwards text through the delivery
// queue, which forwards through channel-dispatch. It cannot approve, write, or run
// anything.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { mt } from '../main-i18n'
import { join, dirname } from 'path'
import type { ChannelRef } from '../channel-dispatch'
import { enqueue, type DeliveryReceipt } from './delivery-queue'
import { recordNotice } from './notices-store'
import { readSettings } from '../settings-helper'
import { messageOf } from '../guarded'

export type WatchKind = 'forecast' | 'calibration' | 'task' | 'jobFail' | 'forecastOwed' | 'confidentMiss'

/** Quiet-hours window in local-clock HOURS [0..23). start===end disables it. A
 *  window may wrap midnight (e.g. {start:22,end:7}). */
export interface QuietHours {
  start: number
  end: number
}

export interface WatchersConfig {
  /** (a) a forecast resolving / becoming due (the resolution loop). */
  forecast: boolean
  /** (b) calibration drift crossing a threshold. */
  calibration: boolean
  /** (c) a new / newly-elevated high-priority (P0) task. */
  task: boolean
  /** (d) a background automations job failing. */
  jobFail: boolean
  /** (e) a forecast past its review date carrying no verdict (the adjudication backlog).
   *  Replaces the legacy-harness forecast_adjudication_trigger.py. */
  forecastOwed: boolean
  /** (f) a CONFIDENT forecast (conf ≥ 0.6) refuted by reality and not yet consolidated.
   *  Replaces the legacy-harness surprise_consolidation_trigger.py. */
  confidentMiss: boolean
  /** |observed − expected| a tier must exceed for a drift notice. */
  driftThreshold: number
  /** Coalesce window: repeat notices for the same (kind,dedupKey) inside this many
   *  ms collapse into one. */
  debounceMs: number
  quietHours: QuietHours
}

/** Canonical defaults — watchers opt-in EXCEPT jobFail (it only speaks when something
 *  broke; defaulting it off hid a 2-week 705-failure extraction outage — QA 2026-08-24 F3;
 *  keep in sync with DEFAULT_APP_SETTINGS.watchers). */
export const DEFAULT_WATCHERS_CONFIG: WatchersConfig = {
  forecast: false,
  calibration: false,
  task: false,
  jobFail: true,
  forecastOwed: false,
  confidentMiss: false,
  driftThreshold: 0.25,
  debounceMs: 5 * 60_000,
  quietHours: { start: 0, end: 0 }
}

// ──────────────────── config reader ────────────────────

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}
function asNum(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function clampHour(n: number): number {
  if (!Number.isFinite(n)) return 0
  const i = Math.floor(n)
  return ((i % 24) + 24) % 24
}

/** Parse a persisted `settings.watchers` blob into a fully-populated config,
 *  tolerating any missing / mistyped field (each falls back to its default). */
export function parseWatchersConfig(raw: unknown): WatchersConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const q = (o.quietHours && typeof o.quietHours === 'object' ? o.quietHours : {}) as Record<string, unknown>
  const debounceMs = asNum(o.debounceMs, DEFAULT_WATCHERS_CONFIG.debounceMs)
  return {
    forecast: asBool(o.forecast, DEFAULT_WATCHERS_CONFIG.forecast),
    calibration: asBool(o.calibration, DEFAULT_WATCHERS_CONFIG.calibration),
    task: asBool(o.task, DEFAULT_WATCHERS_CONFIG.task),
    jobFail: asBool(o.jobFail, DEFAULT_WATCHERS_CONFIG.jobFail),
    forecastOwed: asBool(o.forecastOwed, DEFAULT_WATCHERS_CONFIG.forecastOwed),
    confidentMiss: asBool(o.confidentMiss, DEFAULT_WATCHERS_CONFIG.confidentMiss),
    driftThreshold: asNum(o.driftThreshold, DEFAULT_WATCHERS_CONFIG.driftThreshold),
    debounceMs: debounceMs > 0 ? debounceMs : DEFAULT_WATCHERS_CONFIG.debounceMs,
    quietHours: {
      start: clampHour(asNum(q.start, DEFAULT_WATCHERS_CONFIG.quietHours.start)),
      end: clampHour(asNum(q.end, DEFAULT_WATCHERS_CONFIG.quietHours.end))
    }
  }
}

export interface WatchersRuntime {
  config: WatchersConfig
  ref: ChannelRef
}

/** Read the watchers config + the home channel from persisted settings. Tolerates a
 *  missing settings file (vitest / first run) → all-OFF defaults + push home. */
export function readWatchersRuntime(env: Record<string, unknown> = readSettings()): WatchersRuntime {
  const config = parseWatchersConfig(env.watchers)
  let ref: ChannelRef = { kind: 'push', target: '' }
  if (env.homeChannel && typeof env.homeChannel === 'object') {
    const h = env.homeChannel as Record<string, unknown>
    ref = { kind: String(h.kind ?? 'push'), target: String(h.target ?? '') }
  }
  return { config, ref }
}

// ──────────────────── quiet hours (pure) ────────────────────

/** True if `now` (local clock) falls inside the quiet window. start===end → the
 *  window is disabled (never quiet). Handles a window that wraps past midnight. PURE. */
export function inQuietHours(now: number, q: QuietHours): boolean {
  if (!q) return false
  const start = clampHour(q.start)
  const end = clampHour(q.end)
  if (start === end) return false
  const hour = new Date(now).getHours()
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

// ──────────────────── debounce / coalesce ────────────────────

const lastEmit = new Map<string, number>()

/** (e) forecast-owed is a LEVEL condition (a backlog that persists across many ticks),
 *  not an EVENT. A pure time-debounce would re-nudge the same backlog every window; the
 *  legacy-harness routine instead skipped while an equivalent nudge was already outstanding. We
 *  mirror that with a per-vault signature of the owed id-set: an UNCHANGED owed set never
 *  re-nudges, a CHANGED set (a newly-owed forecast) re-fires immediately. In-process only
 *  (a fresh process re-nudges once — the fail-safe direction), keyed by vault dir. */
const lastOwedSig = new Map<string, string>()

/** Test/introspection: clear the coalesce + owed-signature memory. */
export function __resetWatchers(): void {
  lastEmit.clear()
  lastOwedSig.clear()
}

/** True if a notice for `key` was emitted within `windowMs` before `now`. PURE-read. */
function isDebounced(key: string, now: number, windowMs: number): boolean {
  const prev = lastEmit.get(key)
  return prev !== undefined && now - prev < windowMs
}
function markEmit(key: string, now: number): void {
  lastEmit.set(key, now)
  // Bound the map: a rare full clear is fine — worst case a stale key emits once more.
  if (lastEmit.size > 512) lastEmit.clear()
}

// ──────────────────── drift evaluation (pure) ────────────────────

/** Expected useful-rate per confidence tier — the midpoint of the tier's band
 *  (high ≥0.85, med 0.5–0.85, low <0.5). 'untagged' has no stated confidence and is
 *  never drift-scored. */
const TIER_EXPECTED: Record<string, number> = { high: 0.925, med: 0.675, low: 0.25 }

export interface DriftFinding {
  tier: string
  observed: number
  expected: number
  drift: number
  /** observed sample size for the tier (informational). */
  n: number
}

/**
 * Scan a calibration `confidence_calibration` map for the worst-drifting UNGATED
 * tier (observed ≥ min_n). Drift = |useful_rate − tier-expected|; returns the tier
 * whose drift is largest AND ≥ threshold, or null if none qualifies. Gated tiers
 * (too few samples) and untagged rows are skipped so noise can't fire a false alert. PURE.
 */
export function evaluateCalibrationDrift(
  confCal: Record<string, unknown> | null | undefined,
  threshold: number
): DriftFinding | null {
  let worst: DriftFinding | null = null
  for (const [tier, statRaw] of Object.entries(confCal ?? {})) {
    const expected = TIER_EXPECTED[tier]
    if (expected === undefined) continue
    const s = (statRaw && typeof statRaw === 'object' ? statRaw : {}) as Record<string, unknown>
    const gated = s.gated === true || s.gated === 1
    if (gated) continue
    const observed = typeof s.useful_rate === 'number' ? s.useful_rate : null
    if (observed === null) continue
    const n = typeof s.observed === 'number' ? s.observed : 0
    const drift = Math.abs(observed - expected)
    if (drift >= threshold && (!worst || drift > worst.drift)) {
      worst = { tier, observed, expected, drift, n }
    }
  }
  return worst
}

// ──────────────────── high-priority detection (pure) ────────────────────

const HIGH_PRIORITY_WORDS = new Set([
  'p0', 'p1', 'high', 'highest', 'urgent', 'critical', 'important',
  '🔴', '🔺', '⏫' // Obsidian/Tasks priority markers (highest / high)
])

/** True when a task's priority value denotes top priority (P0/high/urgent/…). PURE. */
export function isHighPriority(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const v = value.trim().toLowerCase()
  if (!v) return false
  return HIGH_PRIORITY_WORDS.has(v)
}

// ──────────────────── formatters (pure) ────────────────────

export function formatForecastNotice(resolved: number, titles?: string[]): string {
  const head =
    resolved === 1 ? 'A forecast just resolved.' : `${resolved} forecasts just resolved.`
  const sample = (titles ?? []).filter((t) => typeof t === 'string' && t.trim()).slice(0, 3)
  const tail = sample.length ? `\n• ${sample.join('\n• ')}` : ''
  return `📉 ${head} Foresight ledger updated — worth a look at your calibration.${tail}`
}

export function formatDriftNotice(d: DriftFinding): string {
  const obs = Math.round(d.observed * 100)
  const exp = Math.round(d.expected * 100)
  return (
    `⚠️ Calibration drift: your ${d.tier}-confidence forecasts are landing ${obs}% ` +
    `useful vs ~${exp}% expected (n=${d.n}). Time to recalibrate.`
  )
}

export function formatTaskNotice(input: { taskId: string; title?: string; priority: string }): string {
  const title = (input.title ?? '').trim() || input.taskId
  return `🔴 New high-priority task (${input.priority.trim()}): ${title}`
}

export function formatJobFailNotice(input: { automationId: string; label?: string; error: string }): string {
  const label = (input.label ?? '').trim() || input.automationId
  const err = (input.error ?? '').trim() || 'unknown error'
  return `🛑 Scheduled job failed: "${label}" — ${err}`
}

/** One forecast in the adjudication backlog (shape of a simple-reads-native forecastOwed row). */
export interface OwedForecast {
  id?: string
  predicted?: string
  confidence?: number
  eval_by?: string
  days_overdue?: number
  track?: string
}

/** One confident miss (shape of a simple-reads-native confidentMisses row). */
export interface ConfidentMiss {
  id?: string
  predicted?: string
  confidence?: number
  track?: string
  eval_by?: string
}

function owedLabel(o: OwedForecast): string {
  const claim = String(o.predicted ?? '').trim() || String(o.id ?? '').trim() || 'forecast'
  const conf = typeof o.confidence === 'number' ? `conf ${o.confidence}` : 'conf n/a'
  const overdue = typeof o.days_overdue === 'number' ? ` · ${o.days_overdue}d overdue` : ''
  return `${claim} (${conf}${overdue})`
}

export function formatForecastOwedNotice(owed: OwedForecast[]): string {
  const n = owed.length
  const head =
    n === 1
      ? 'A forecast has passed its review date with no verdict.'
      : `${n} forecasts have passed their review date with no verdict.`
  const sample = owed.slice(0, 3).map((o) => `• ${owedLabel(o)}`)
  const tail = sample.length ? `\n${sample.join('\n')}` : ''
  return (
    `📉 ${head} Record hit/miss/moot so calibration can advance — ` +
    `POST /state/forecast-verdict.${tail}`
  )
}

function missLabel(m: ConfidentMiss): string {
  const claim = String(m.predicted ?? '').trim() || String(m.id ?? '').trim() || 'forecast'
  const conf = typeof m.confidence === 'number' ? m.confidence.toFixed(2) : 'n/a'
  return `(conf ${conf}) ${claim}`
}

export function formatConfidentMissNotice(misses: ConfidentMiss[]): string {
  const n = misses.length
  const head =
    n === 1 ? 'A confident forecast was refuted.' : `${n} confident forecasts were refuted.`
  const sample = misses.slice(0, 3).map((m) => `• ${missLabel(m)}`)
  const tail = sample.length ? `\n${sample.join('\n')}` : ''
  return (
    `🎯 ${head} A committed belief reality contradicted — worth reflecting on why it ` +
    `was wrong and capturing the lesson.${tail}`
  )
}

/** Stable signature of an id-set: sorted, deduped, comma-joined. Empty → ''. */
function idSignature(items: { id?: string }[]): string {
  const ids = items.map((x) => String(x.id ?? '').trim()).filter((s) => s.length > 0)
  return [...new Set(ids)].sort().join(',')
}

// ──────────────────── confident-miss consolidated store (persistent) ────────────────────
//
// The confident-miss watcher SURFACES a nudge but MUST NOT write the operator's
// corrections.jsonl (their human-authored learn-loop walls machine writers out). Its
// per-id dedup therefore lives in a DUIN-OWNED state file, mirroring the legacy-harness routine's
// surprise-consolidated.json ({ids:[…]}). Reusing that exact filename + shape means a
// clean handoff: DUIN inherits whatever ids the legacy-harness routine already consolidated, so no
// miss is double-nudged across the migration.

function consolidatedStatePath(vaultDir: string): string {
  return join(vaultDir, '.duin', '_state', 'surprise-consolidated.json')
}

/** Ids already rolled into a surfaced consolidation nudge. Tolerates a missing/garbage
 *  file → empty set. */
export function readConsolidatedIds(vaultDir: string): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(consolidatedStatePath(vaultDir), 'utf-8')) as {
      ids?: unknown
    }
    const ids = Array.isArray(raw?.ids) ? raw.ids : []
    return new Set(ids.filter((x): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

/** Persist the consolidated id-set atomically (tmp + rename), mirroring the routine's
 *  os.replace. Best-effort: a failure just risks one duplicate nudge later. */
export function writeConsolidatedIds(vaultDir: string, ids: Set<string>): void {
  try {
    const p = consolidatedStatePath(vaultDir)
    mkdirSync(dirname(p), { recursive: true })
    const tmp = p + '.tmp'
    writeFileSync(tmp, JSON.stringify({ ids: [...ids].sort() }, null, 0), 'utf-8')
    renameSync(tmp, p)
  } catch (e) {
    console.debug('[watchers] consolidated persist best-effort:', messageOf(e))
  }
}

// ──────────────────── emit core ────────────────────

export interface WatchDeps {
  /** Override the resolved config (else read from settings). */
  config?: WatchersConfig
  /** Override the destination channel (else the settings home channel). */
  ref?: ChannelRef
  /** Override the delivery seam (else the real delivery-queue enqueue). */
  enqueue?: (ref: ChannelRef, text: string, meta: Record<string, unknown>) => Promise<DeliveryReceipt>
  /** Override the clock. */
  now?: number
}

export type WatchSkip = 'disabled' | 'quiet' | 'debounced' | 'nothing' | 'error'

export interface WatchResult {
  emitted: boolean
  skipped?: WatchSkip
  text?: string
  receipt?: DeliveryReceipt
}

function resolveRuntime(deps: WatchDeps): WatchersRuntime {
  if (deps.config && deps.ref) return { config: deps.config, ref: deps.ref }
  const rt = readWatchersRuntime()
  return { config: deps.config ?? rt.config, ref: deps.ref ?? rt.ref }
}

/** A watch notice is worth knowing, not a decision the operator owes — so none of these
 *  set `needsDecision`. Severity is what separates "your foresight resolved" from "a
 *  scheduled job died". */
const NOTICE_SEVERITY: Record<WatchKind, 'info' | 'warning' | 'error'> = {
  forecast: 'info',
  calibration: 'warning',
  task: 'warning',
  jobFail: 'error',
  forecastOwed: 'warning',
  confidentMiss: 'warning'
}

/** What the desktop notification is titled. Every proactive message used to say only
 *  "DUIN", so the toast never told you which of these had happened. */
const NOTICE_TITLE: Record<WatchKind, string> = {
  forecast: 'A forecast resolved',
  calibration: 'Your calibration is drifting',
  task: 'High-priority task',
  jobFail: 'A scheduled job failed',
  forecastOwed: 'Forecasts are waiting to be scored',
  confidentMiss: 'A confident forecast missed'
}

/** Where clicking the row should land. A notice that cannot be followed anywhere is
 *  the failure mode this inbox exists to fix, so every kind names a surface.
 *
 *  The four forecast/calibration kinds pointed at `duin://tool/calibration` until the
 *  2026-07-07 surface consolidation folded CalibrationPanel into the Status hub as a
 *  TAB. There is no longer a 'calibration' surface to open; homeStatus is the hub that
 *  owns it. These strings are hand-written and cross a process boundary, so nothing
 *  type-checks them — the parser's allow-list is the backstop, and it now returns null
 *  for a retired id instead of opening a blank panel. */
const NOTICE_DEEP_LINK: Record<WatchKind, string> = {
  forecast: 'duin://tool/homeStatus',
  calibration: 'duin://tool/homeStatus',
  task: 'duin://tool/homeStatus',
  jobFail: 'duin://tool/automations',
  forecastOwed: 'duin://tool/homeStatus',
  confidentMiss: 'duin://tool/homeStatus'
}

/**
 * The single gate every watcher funnels through. Order: enabled → text-present →
 * quiet-hours → debounce → record → enqueue. Never throws. `dedupKey` scopes the
 * coalesce window within a kind.
 */
async function dispatchNotice(
  kind: WatchKind,
  enabled: boolean,
  dedupKey: string,
  text: string | null,
  rt: WatchersRuntime,
  deps: WatchDeps
): Promise<WatchResult> {
  try {
    if (!enabled) return { emitted: false, skipped: 'disabled' }
    if (text === null) return { emitted: false, skipped: 'nothing' }
    const now = deps.now ?? Date.now()
    const key = `${kind}:${dedupKey}`
    if (isDebounced(key, now, rt.config.debounceMs)) return { emitted: false, skipped: 'debounced' }
    markEmit(key, now)
    // Record BEFORE dispatching, and independently of the result. The default home
    // channel is an OS toast that vanishes in seconds and cannot be replied to, so
    // delivery state can never answer "what did I miss" — the inbox has to.
    recordNotice({
      kind: 'watch',
      severity: NOTICE_SEVERITY[kind],
      title: text,
      deepLink: NOTICE_DEEP_LINK[kind],
      dedupKey: key,
      now
    })
    // Quiet hours suppress the INTERRUPTION, not the record. The notice is already
    // filed above, so a 3am job failure waits in the inbox instead of being lost.
    if (inQuietHours(now, rt.config.quietHours)) return { emitted: false, skipped: 'quiet' }
    const enq =
      deps.enqueue ??
      ((ref: ChannelRef, t: string, meta: Record<string, unknown>) =>
        enqueue(ref, t, {
          meta,
          now,
          deepLink: NOTICE_DEEP_LINK[kind],
          title: mt(NOTICE_TITLE[kind])
        }))
    const receipt = await enq(rt.ref, text, { source: 'watch', kind, dedupKey })
    return { emitted: true, text, receipt }
  } catch (e) {
    console.debug('[watchers] dispatch best-effort:', messageOf(e))
    return { emitted: false, skipped: 'error' }
  }
}

// ──────────────────── public watch entry points ────────────────────

/** (a) One or more forecasts resolved this pass (from the resolution loop). */
export async function watchForecastResolved(
  input: { resolved: number; titles?: string[] },
  deps: WatchDeps = {}
): Promise<WatchResult> {
  const rt = resolveRuntime(deps)
  const text = input.resolved > 0 ? formatForecastNotice(input.resolved, input.titles) : null
  return dispatchNotice('forecast', rt.config.forecast, 'resolved', text, rt, deps)
}

/** (b) Calibration drift — pass the recomputed confidence_calibration map; the
 *  worst ungated tier past driftThreshold (if any) fires one notice. */
export async function watchCalibrationDrift(
  confCal: Record<string, unknown> | null | undefined,
  deps: WatchDeps = {}
): Promise<WatchResult> {
  const rt = resolveRuntime(deps)
  const finding = evaluateCalibrationDrift(confCal, rt.config.driftThreshold)
  const text = finding ? formatDriftNotice(finding) : null
  // Dedup per tier so a med-drift and a high-drift can each surface, but repeat
  // firings of the SAME tier coalesce.
  const dedupKey = finding ? `drift:${finding.tier}` : 'drift'
  return dispatchNotice('calibration', rt.config.calibration, dedupKey, text, rt, deps)
}

/** (c) A task became high-priority (P0). No-op for non-high priority values. */
export async function watchHighPriorityTask(
  input: { taskId: string; title?: string; priority: string },
  deps: WatchDeps = {}
): Promise<WatchResult> {
  const rt = resolveRuntime(deps)
  const text = isHighPriority(input.priority) ? formatTaskNotice(input) : null
  // Dedup per task id so re-touching the same task inside the window doesn't respam.
  return dispatchNotice('task', rt.config.task, `task:${input.taskId}`, text, rt, deps)
}

/** (d) A scheduled automations job failed (the runner's recordRun error path). */
export async function watchJobFailed(
  input: { automationId: string; label?: string; error: string },
  deps: WatchDeps = {}
): Promise<WatchResult> {
  const rt = resolveRuntime(deps)
  const text = formatJobFailNotice(input)
  // Dedup per automation so a job that fails every tick alerts once per window.
  return dispatchNotice('jobFail', rt.config.jobFail, `job:${input.automationId}`, text, rt, deps)
}

/**
 * (e) The adjudication backlog — forecasts past their review date with no recorded
 * verdict (from simple-reads-native forecastOwed). Replaces the legacy-harness
 * forecast_adjudication_trigger.py: emits ONE nudge pointing at POST
 * /state/forecast-verdict. Dedup mirrors the routine's outstanding-signal guard: an
 * unchanged owed id-set (surfaced already) is not re-nudged every tick; a set that
 * gains a newly-owed forecast re-fires. `vaultDir` keys the per-vault signature.
 */
/**
 * SUPERSEDED IN PRACTICE by the conversational path — keep this OFF unless you have a
 * reason. `renderOwedForecastsBlock` (personalization-blocks.ts) puts the same backlog
 * into the turn so the agent can ask about one in passing, and that is the better
 * instrument: this is a question whose entire value is the answer, and a notification
 * cannot collect one. It got dismissed, the loop stayed open, and the calibration data
 * that depends on the verdict never arrived.
 *
 * Enabling both means the operator is told about the same backlog twice, once in a form
 * they cannot act on.
 */
export async function watchForecastOwed(
  input: { owed: OwedForecast[]; vaultDir?: string | null },
  deps: WatchDeps = {}
): Promise<WatchResult> {
  const rt = resolveRuntime(deps)
  const owed = Array.isArray(input.owed) ? input.owed : []
  const sig = idSignature(owed)
  const key = input.vaultDir ?? ''
  // LEVEL-condition dedup (before the emit): the same owed set was already surfaced —
  // don't re-nudge it. Only trips when the watcher is enabled (a disabled watcher must
  // still report 'disabled' via dispatchNotice, not swallow here).
  if (sig && rt.config.forecastOwed && lastOwedSig.get(key) === sig) {
    return { emitted: false, skipped: 'debounced' }
  }
  const text = owed.length ? formatForecastOwedNotice(owed) : null
  const res = await dispatchNotice('forecastOwed', rt.config.forecastOwed, `owed:${sig}`, text, rt, deps)
  // Remember the surfaced set ONLY on a real emit, so a quiet-hours/disabled/failed pass
  // retries on the next tick instead of silently swallowing the backlog.
  if (res.emitted) lastOwedSig.set(key, sig)
  return res
}

/** Deps for the confident-miss watcher: the base WatchDeps plus injectable persistence
 *  seams (tests substitute an in-memory set; production uses the vault state file). */
export interface ConfidentMissDeps extends WatchDeps {
  readConsolidated?: (vaultDir: string) => Set<string>
  writeConsolidated?: (vaultDir: string, ids: Set<string>) => void
}

/**
 * (f) A CONFIDENT forecast (conf ≥ 0.6) refuted by reality and not yet consolidated
 * (from simple-reads-native confidentMisses). Replaces the legacy-harness
 * surprise_consolidation_trigger.py: SURFACES ONE nudge asking the operator to reflect
 * and capture the lesson — it never writes corrections.jsonl (the operator's
 * human-authored learn-loop). Per-id dedup is PERSISTENT in a DUIN-owned state file so a
 * given miss (which stays on the ledger forever) nudges at most once. Ids are marked
 * consolidated ONLY after a successful emit, so a failed/quiet pass retries.
 */
export async function watchConfidentMiss(
  input: { misses: ConfidentMiss[]; vaultDir?: string | null },
  deps: ConfidentMissDeps = {}
): Promise<WatchResult> {
  const rt = resolveRuntime(deps)
  const misses = Array.isArray(input.misses) ? input.misses : []
  const readC = deps.readConsolidated ?? readConsolidatedIds
  const writeC = deps.writeConsolidated ?? writeConsolidatedIds
  const consolidated = input.vaultDir ? readC(input.vaultDir) : new Set<string>()
  const fresh = misses.filter((m) => m.id && !consolidated.has(m.id))
  const sig = idSignature(fresh)
  const text = fresh.length ? formatConfidentMissNotice(fresh) : null
  const res = await dispatchNotice('confidentMiss', rt.config.confidentMiss, `miss:${sig}`, text, rt, deps)
  // Mark the surfaced ids consolidated ONLY after the nudge is safely emitted (mirrors
  // the routine marking processed only once the signal is on disk).
  if (res.emitted && input.vaultDir && fresh.length) {
    const next = new Set(consolidated)
    for (const m of fresh) if (m.id) next.add(m.id)
    writeC(input.vaultDir, next)
  }
  return res
}
