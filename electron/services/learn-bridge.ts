// learn-bridge.ts — DUIN autonomic nervous system, organ #3 (the learning weld).
//
// THE PROBLEM IT SOLVES. DUIN had two disjoint learning half-loops that never
// touched:
//   • Substrate A (this app): operator-model.json — captures candidate facts,
//     and the human promotes/vetoes them in LearningPanel. LIVE.
//   • Substrate B (the vault metabolism): .duin/_state/corrections.jsonl →
//     reflect → taste → binding candidates. DEAD, because corrections.jsonl was
//     never written on a DUIN dogfood vault (its producer is the operator's interactive
//     session hooks, which DUIN doesn't run).
// So the rich human verdict signal Substrate A collects was dumped in an isolated
// store that zero vault routines read. This bridge welds the two: every human
// verdict (promote / veto) is forwarded into the operator-authored corrections
// stream, then a reflect recomputes taste. The flywheel now turns on DUIN's OWN
// usage — no dependence on the operator's hooks.
//
// Design constraints (mirrored from feedback-bridge, both load-bearing):
//   1. KEYLESS-FIRST. Every verdict is recorded to an app-owned local ledger
//      (userData/learn-bridge/pending.jsonl) first; forwarding to the engine is
//      the opt-in escalation on top of it, never a prerequisite.
//   2. NEVER A SECOND WRITER. corrections.jsonl is written ONLY by the engine
//      (learn.append_correction, behind its own file handle). We POST over HTTP
//      to /learn/correction; when the engine is down the row waits ('pending')
//      and retries on the next drain — never written out-of-band.
//   3. OPERATOR-ONLY CONTRACT. The engine rejects any correction row carrying a
//      `source` key (machine rows are not learning signal). A promote/veto IS a
//      human verdict — legitimately operator-authored — so we omit `source`.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { app } from 'electron'
import { LOCAL_BRAIN_PORT } from './local-brain/server'
import type { OperatorFact } from './brain/operator-model'
import { messageOf } from './guarded'

export type LearnAction = 'promote' | 'veto'

/**
 * A row of .duin/_state/corrections.jsonl. Shapes match learn.append_correction
 * exactly. NB: deliberately NO `source` field — the engine 400s on operator rows
 * that carry one.
 */
export interface CorrectionRow {
  ts: string
  session: string
  skill: string
  artifact: string
  ai_output: string
  correction: string
  why: string
  candidate_rule: string
  polarity: 'correction' | 'positive'
}

// ──────────────────── mapping (pure, unit-tested) ────────────────────

/**
 * Map a human verdict on an operator fact to an operator-authored correction row.
 *
 *   promote → a POSITIVE row: the human confirmed this is a rule DUIN should
 *             follow. candidate_rule carries the fact (the FAST taste arrow —
 *             behavior shifts before any node is promoted in the vault).
 *   veto    → a CORRECTION row: the human rejected this inference. Recurring
 *             vetoes on similar inferences cluster (reflect, ≥3) into a binding
 *             candidate — "stop inferring this", a genuine behavioral signal.
 */
export function mapVerdictToCorrection(
  fact: Pick<OperatorFact, 'fact' | 'kind'>,
  action: LearnAction,
  today: string,
  reason?: string
): CorrectionRow {
  const base: CorrectionRow = {
    ts: today,
    session: '',
    skill: 'operator-model',
    artifact: '',
    ai_output: '',
    // The human's REASONING is the signal that actually models judgment (the
    // strategy doc's finding: the empty-`why` loop captured shallow preferences and
    // dropped the reasoning). We forward a real, VARIABLE reason when the human gave
    // one — that is exactly what reflect() should cluster on. We do NOT synthesize a
    // fixed phrase: a constant here would (a) make any 3 verdicts cluster on the
    // shared template (false binding candidates) and (b) shadow the fact in the
    // binding sample. So `why` is the genuine reason or empty — never boilerplate.
    why: (reason ?? '').trim(),
    correction: '',
    candidate_rule: '',
    polarity: 'correction'
  }
  if (action === 'promote') {
    return { ...base, polarity: 'positive', candidate_rule: fact.fact }
  }
  // veto — the fact itself is the signal; the muted polarity marks it a rejection.
  return { ...base, polarity: 'correction', correction: fact.fact }
}

// ──────────────────── ledger ────────────────────

export type DeliveryState = 'pending' | 'delivered' | 'failed'

/** One row in pending.jsonl. Append-only; latest-per-key wins. */
export interface PendingItem {
  /** `${factId}:${action}` — idempotency key (one verdict forwards once). */
  key: string
  row: CorrectionRow
  delivery: DeliveryState
  attempts: number
  recordedAt: number
  lastAttemptAt?: number
  detail?: string
}

const MAX_ATTEMPTS = 5

function defaultLedgerDir(): string {
  try {
    return join(app.getPath('userData'), 'learn-bridge')
  } catch {
    return join(tmpdir(), 'duin-learn-bridge')
  }
}

let ledgerDirOverride: string | null = null
/** Test seam: pin the ledger dir (and the engine origin) without an Electron app. */
export function __setLearnBridgeLedgerDir(dir: string | null): void {
  ledgerDirOverride = dir
}
function ledgerDir(): string {
  return ledgerDirOverride ?? defaultLedgerDir()
}

let originOverride: (() => string) | null = null
/** Test seam: pin the engine origin resolver. */
export function __setLearnBridgeOrigin(fn: (() => string) | null): void {
  originOverride = fn
}
function engineOrigin(): string {
  if (originOverride) return originOverride()
  // The in-process TS brain (:8799) now owns /learn/* natively (single writer of
  // corrections.jsonl + taste-engine.json). Auto-captured corrections post here
  // instead of the Python sidecar (:8765), whose learn handlers are retired. The
  // in-process front is always up, so this also removes the sidecar-down queueing path.
  return `http://127.0.0.1:${LOCAL_BRAIN_PORT}`
}

let fetchOverride: typeof fetch | null = null
/** Test seam: inject fetch. */
export function __setLearnBridgeFetch(fn: typeof fetch | null): void {
  fetchOverride = fn
}
function fetchFn(): typeof fetch {
  return fetchOverride ?? (((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch)
}

function ledgerPath(): string {
  return join(ledgerDir(), 'pending.jsonl')
}
function markerPath(): string {
  return join(ledgerDir(), 'backfilled.json')
}
function ensureDir(): void {
  const d = ledgerDir()
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
}

/** Read pending.jsonl collapsed to latest-per-key. */
export function readLearnLedger(): Map<string, PendingItem> {
  const byKey = new Map<string, PendingItem>()
  const p = ledgerPath()
  if (!existsSync(p)) return byKey
  let raw: string
  try {
    raw = readFileSync(p, 'utf-8')
  } catch {
    return byKey
  }
  for (const line of raw.split('\n')) {
    const ln = line.trim()
    if (!ln) continue
    try {
      const row = JSON.parse(ln) as PendingItem
      if (row && typeof row.key === 'string') byKey.set(row.key, row)
    } catch {
      // tolerate a torn last line / hand-edit
    }
  }
  return byKey
}

function appendLedger(item: PendingItem): void {
  ensureDir()
  appendFileSync(ledgerPath(), JSON.stringify(item) + '\n', 'utf-8')
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

// ──────────────────── delivery ────────────────────

async function postJson(
  origin: string,
  endpoint: string,
  body: Record<string, unknown> | null
): Promise<{ ok: boolean; detail: string }> {
  const url = origin.replace(/\/$/, '') + endpoint
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const res = await fetchFn()(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal
    })
    let parsed: { ok?: boolean; error?: string } = {}
    try {
      parsed = (await res.json()) as { ok?: boolean; error?: string }
    } catch (e) { console.debug('[learn-bridge] non-JSON body:', messageOf(e)) }
    if (res.ok && parsed.ok !== false) return { ok: true, detail: `${res.status}` }
    return { ok: false, detail: `http ${res.status}: ${parsed.error ?? 'rejected'}`.slice(0, 200) }
  } catch (err) {
    return { ok: false, detail: `network: ${(err as Error)?.message ?? 'error'}`.slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}

// Debounced reflect: a burst of verdicts triggers exactly one reflect.
let reflectTimer: ReturnType<typeof setTimeout> | null = null
function scheduleReflect(): void {
  if (reflectTimer) return
  reflectTimer = setTimeout(() => {
    reflectTimer = null
    const origin = engineOrigin()
    if (!origin) return
    void postJson(origin, '/learn/reflect', null).catch(() => {})
  }, 2500)
}

// ──────────────────── forward (the lifecycle hook target) ────────────────────

/**
 * Forward one human verdict into corrections.jsonl. Idempotent: a key already
 * delivered is never re-sent. Best-effort + keyless-first: the row is recorded
 * locally regardless of engine state, then delivered when the engine is up.
 * Fire-and-forget from the caller (the operator-model lifecycle hook).
 */
export async function forwardCorrection(
  fact: Pick<OperatorFact, 'id' | 'fact' | 'kind'>,
  action: LearnAction,
  reason?: string
): Promise<DeliveryState> {
  const key = `${fact.id}:${action}`
  const ledger = readLearnLedger()
  const existing = ledger.get(key)
  if (existing?.delivery === 'delivered') return 'delivered'

  // Reuse the already-recorded row on retry (idempotent); on first record, capture
  // the human's reason as `why`.
  const row = existing?.row ?? mapVerdictToCorrection(fact, action, todayIso(), reason)
  const origin = engineOrigin()

  let delivery: DeliveryState = 'pending'
  let detail: string | undefined
  let attempts = existing?.attempts ?? 0
  if (origin) {
    attempts += 1
    const r = await postJson(origin, '/learn/correction', row as unknown as Record<string, unknown>)
    delivery = r.ok ? 'delivered' : 'failed'
    detail = r.detail
  }

  appendLedger({
    key,
    row,
    delivery,
    attempts,
    recordedAt: existing?.recordedAt ?? Date.now(),
    lastAttemptAt: origin ? Date.now() : existing?.lastAttemptAt,
    detail
  })
  if (delivery === 'delivered') scheduleReflect()
  return delivery
}

// ──────────────────── drain (retry) ────────────────────

export interface LearnDrainSummary {
  retried: number
  delivered: number
  stillPending: number
  engineConnected: boolean
}

/** Retry every pending/failed row (under the attempt cap). Reflect once if any
 *  newly delivered. No-op when the engine is down. */
export async function drainLearnBridge(): Promise<LearnDrainSummary> {
  const origin = engineOrigin()
  const summary: LearnDrainSummary = {
    retried: 0,
    delivered: 0,
    stillPending: 0,
    engineConnected: !!origin
  }
  if (!origin) {
    for (const row of readLearnLedger().values()) {
      if (row.delivery !== 'delivered') summary.stillPending++
    }
    return summary
  }
  let anyDelivered = false
  for (const row of readLearnLedger().values()) {
    if (row.delivery === 'delivered') continue
    if (row.attempts >= MAX_ATTEMPTS) {
      summary.stillPending++
      continue
    }
    summary.retried++
    const r = await postJson(origin, '/learn/correction', row.row as unknown as Record<string, unknown>)
    const updated: PendingItem = {
      ...row,
      delivery: r.ok ? 'delivered' : 'failed',
      attempts: row.attempts + 1,
      lastAttemptAt: Date.now(),
      detail: r.detail
    }
    appendLedger(updated)
    if (updated.delivery === 'delivered') {
      summary.delivered++
      anyDelivered = true
    } else {
      summary.stillPending++
    }
  }
  if (anyDelivered) scheduleReflect()
  return summary
}

// ──────────────────── backfill (warm the cold start once) ────────────────────

/**
 * On first run, forward the human verdicts already sitting in operator-model.json
 * (the promoted + vetoed facts) so the flywheel warms from real signal instead of
 * a cold seed. Guarded by a marker file AND the per-key delivered check, so it
 * never double-writes. Returns # of verdicts forwarded this call.
 */
export async function backfillFromFacts(facts: OperatorFact[]): Promise<number> {
  if (existsSync(markerPath())) return 0
  const verdicts = facts.filter((f) => f.status === 'promoted' || f.status === 'vetoed')
  let forwarded = 0
  for (const f of verdicts) {
    const action: LearnAction = f.status === 'promoted' ? 'promote' : 'veto'
    await forwardCorrection(f, action)
    forwarded++
  }
  try {
    ensureDir()
    writeFileSync(markerPath(), JSON.stringify({ at: Date.now(), forwarded }), 'utf-8')
  } catch (e) { console.debug('[learn-bridge] best-effort:', messageOf(e)) }
  return forwarded
}

// ──────────────────── status (read-only) ────────────────────

export interface LearnBridgeStatus {
  total: number
  byDelivery: Record<DeliveryState, number>
  engineConnected: boolean
  ledgerDir: string
}

export function learnBridgeStatus(): LearnBridgeStatus {
  const ledger = readLearnLedger()
  const byDelivery: Record<DeliveryState, number> = { pending: 0, delivered: 0, failed: 0 }
  for (const row of ledger.values()) byDelivery[row.delivery]++
  return {
    total: ledger.size,
    byDelivery,
    engineConnected: !!engineOrigin(),
    ledgerDir: ledgerDir()
  }
}

// ──────────────────── periodic driver ────────────────────

let timer: ReturnType<typeof setInterval> | null = null
let bootstrapTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Start the bridge: backfill once from the current operator facts, then drain on
 * an interval (retrying pending rows when the engine comes up). Best-effort; a
 * drain error is logged, never thrown. Idempotent — two calls don't stack timers.
 */
export function startLearnBridge(getFacts: () => OperatorFact[], intervalMs = 60_000): void {
  if (timer) return
  const tick = (): void => {
    drainLearnBridge().catch((err) =>
      console.warn('[learn-bridge] drain error:', (err as Error)?.message)
    )
  }
  bootstrapTimer = setTimeout(() => {
    bootstrapTimer = null
    backfillFromFacts(getFacts())
      .catch((err) => console.warn('[learn-bridge] backfill error:', (err as Error)?.message))
      .finally(tick)
  }, 6_000)
  timer = setInterval(tick, Math.max(10_000, intervalMs))
}

export function stopLearnBridge(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (bootstrapTimer) {
    clearTimeout(bootstrapTimer)
    bootstrapTimer = null
  }
  if (reflectTimer) {
    clearTimeout(reflectTimer)
    reflectTimer = null
  }
}
