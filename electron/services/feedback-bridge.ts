// feedback-bridge.ts — DUIN autonomic nervous system, organ #2 (the consumption
// bridge). The feedback channel (organ #1) records every verdict on a proactive
// surface as a typed seed in the append-only `events` table. Those seeds just
// SIT there until something drains them into the engine's learning loops. This
// is that drain.
//
// Two design constraints, both load-bearing:
//
//   1. KEYLESS-FIRST (design §7 graceful degradation). The drain ALWAYS writes a
//      normalized record to an app-owned local ledger
//      (userData/feedback-bridge/consumed-seeds.jsonl). That ledger is the
//      independent, offline record of every consumed verdict — it works with no
//      Python engine, no network, no vault. Forwarding to the engine is the
//      opt-in ESCALATION on top of it, not a prerequisite.
//
//   2. NEVER A SECOND WRITER. The engine's calibration ledgers
//      (risk-predictions.jsonl, prediction-feedback.jsonl, insight-verdicts.jsonl)
//      are single-writer behind the engine's own _LEDGER_LOCK. This bridge does
//      NOT touch those files. It forwards over HTTP to the engine's /state/*
//      endpoints, so the engine stays the sole writer and the verdict is applied
//      THROUGH the lock. When the engine is down, the seed waits ('pending') and
//      retries on the next drain — it is never written out-of-band.
//
// A verdict only forwards when it carries an engineRef (the surface came from a
// real engine artifact) AND the action maps to a clean engine enum. Generic app
// nudges, snoozes, and forecast verdicts stage locally only — see routeFor().

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { app } from 'electron'
import { listEvents, type EventRecord } from './event-log'
import {
  FEEDBACK_EVENT_TYPE,
  type EngineRef,
  type EngineRefKind,
  type FeedbackAction
} from './feedback-observations'
import { messageOf } from './guarded'

// ──────────────────── routing (pure, unit-tested) ────────────────────

/** An engine /state/* call the bridge will POST: path + JSON body. */
export interface EngineRoute {
  /** Endpoint path, e.g. '/state/insight-verdict'. */
  endpoint: string
  /** JSON body. Shapes match server.py's POST handlers exactly. */
  body: Record<string, string>
}

/**
 * Map (verdict, engine artifact kind) → the engine call, or null to STAGE the
 * seed locally without forwarding. Pure and total — every branch is explicit so
 * the table reads as the spec.
 *
 * Conservative on purpose: we only forward where the verdict maps unambiguously
 * to a verified engine enum (checked against server.py):
 *   • insight  : useful/dismissed/acted/inaccurate
 *   • prediction (risk): false_alarm/correct/clear
 * forecast verdicts are NOT forwarded — a forecast resolves on its real hit/miss
 * outcome (owned by the resolution loop), which a usefulness click can't supply.
 * cascade has no safe action mapping yet. snooze is a deferral, never a signal.
 */
export function routeFor(action: FeedbackAction, ref: EngineRef): EngineRoute | null {
  const { kind, id, domain } = ref
  if (action === 'snooze') return null

  switch (kind) {
    case 'insight': {
      // act → 'acted', dismiss → 'dismissed', not-relevant → 'inaccurate'.
      const verdict =
        action === 'act' ? 'acted' : action === 'dismiss' ? 'dismissed' : 'inaccurate'
      return { endpoint: '/state/insight-verdict', body: { id, verdict } }
    }
    case 'prediction': {
      // act → 'correct' (acting validates the flag), not-relevant → 'false_alarm'.
      // dismiss (right kind, wrong moment) is NOT a calibration signal → stage.
      if (action === 'dismiss') return null
      const mark = action === 'act' ? 'correct' : 'false_alarm'
      return {
        endpoint: '/state/prediction-feedback',
        body: { id, domain: domain ?? '', mark }
      }
    }
    case 'forecast':
      // Outcome unknown from a usefulness click; the resolution loop owns hit/miss.
      return null
    case 'cascade':
      // No safe verdict→action mapping yet.
      return null
    default:
      return null
  }
}

// ──────────────────── consumed-seed record ────────────────────

export type DeliveryState = 'staged' | 'pending' | 'delivered' | 'failed'

/** One row in consumed-seeds.jsonl. Append-only; latest-per-eventId wins. */
export interface ConsumedSeed {
  eventId: string
  recordedAt: number
  consumedAt: number
  action: FeedbackAction
  detectorClass: string
  seedType: string | null
  outcomeStatus: string | null
  engineRef: EngineRef | null
  route: EngineRoute | null
  /**
   * 'staged'    = by design, no forwarding (no route). Terminal.
   * 'delivered' = engine accepted the POST. Terminal.
   * 'pending'   = mappable but the engine was down; retry next drain.
   * 'failed'    = the engine rejected or the POST errored; retry up to MAX_ATTEMPTS.
   */
  delivery: DeliveryState
  deliveryDetail?: string
  attempts: number
  lastAttemptAt?: number
}

const MAX_ATTEMPTS = 5

// ──────────────────── dependencies (injectable for tests) ────────────────────

export interface BridgeDeps {
  /** Read feedback events. Defaults to the real event-log reader. */
  listEvents: typeof listEvents
  /** Current epoch ms. Injectable so tests are deterministic. */
  now: () => number
  /** Engine origin ('' when the sidecar is down). */
  engineOrigin: () => string
  /** fetch impl. Defaults to global fetch (Electron main / Node 18+). */
  fetchFn: typeof fetch
  /** Directory holding the local ledger + cursor. */
  ledgerDir: string
}

function defaultLedgerDir(): string {
  // app.getPath throws outside a running Electron app (headless tests inject
  // their own dir, so this default never runs there — but stay defensive).
  try {
    return join(app.getPath('userData'), 'feedback-bridge')
  } catch {
    return join(tmpdir(), 'duin-feedback-bridge')
  }
}

function defaultEngineOrigin(): string {
  // The external engine origin is retired — feedback always stages into the
  // app-owned ledger (the existing keyless/degraded path).
  return ''
}

/**
 * Resolve deps with per-field fallbacks. Each default is only evaluated when the
 * caller did NOT override it — so a test that injects `ledgerDir` never triggers
 * the Electron `app.getPath` default, and one that injects `engineOrigin` never
 * touches the sidecar.
 */
function defaultDeps(overrides: Partial<BridgeDeps> = {}): BridgeDeps {
  return {
    listEvents: overrides.listEvents ?? listEvents,
    now: overrides.now ?? (() => Date.now()),
    engineOrigin: overrides.engineOrigin ?? defaultEngineOrigin,
    fetchFn: overrides.fetchFn ?? (((...args: Parameters<typeof fetch>) => fetch(...args)) as typeof fetch),
    ledgerDir: overrides.ledgerDir ?? defaultLedgerDir()
  }
}

// ──────────────────── ledger + cursor I/O ────────────────────

function ledgerPath(dir: string): string {
  return join(dir, 'consumed-seeds.jsonl')
}
function cursorPath(dir: string): string {
  return join(dir, 'cursor.json')
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/** Read every consumed-seed row, collapsed to latest-per-eventId. */
export function readLedger(dir: string): Map<string, ConsumedSeed> {
  const byId = new Map<string, ConsumedSeed>()
  const p = ledgerPath(dir)
  if (!existsSync(p)) return byId
  let raw: string
  try {
    raw = readFileSync(p, 'utf-8')
  } catch {
    return byId
  }
  for (const line of raw.split('\n')) {
    const ln = line.trim()
    if (!ln) continue
    try {
      const row = JSON.parse(ln) as ConsumedSeed
      if (row && typeof row.eventId === 'string') byId.set(row.eventId, row)
    } catch {
      // tolerate a torn last line / hand-edit; skip it
    }
  }
  return byId
}

function appendLedger(dir: string, row: ConsumedSeed): void {
  ensureDir(dir)
  appendFileSync(ledgerPath(dir), JSON.stringify(row) + '\n', 'utf-8')
}

function readCursor(dir: string): number {
  const p = cursorPath(dir)
  if (!existsSync(p)) return 0
  try {
    const j = JSON.parse(readFileSync(p, 'utf-8')) as { lastConsumedAt?: number }
    return typeof j.lastConsumedAt === 'number' ? j.lastConsumedAt : 0
  } catch {
    return 0
  }
}

function writeCursor(dir: string, lastConsumedAt: number): void {
  ensureDir(dir)
  writeFileSync(cursorPath(dir), JSON.stringify({ lastConsumedAt }), 'utf-8')
}

// ──────────────────── event → consumed-seed translation ────────────────────

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function engineRefOf(e: EventRecord): EngineRef | null {
  const r = e.payload?.engineRef as Partial<EngineRef> | undefined
  if (!r || typeof r !== 'object') return null
  const kinds: readonly EngineRefKind[] = ['forecast', 'prediction', 'insight', 'cascade']
  const id = asString(r.id)?.trim()
  if (!id || !r.kind || !kinds.includes(r.kind)) return null
  const domain = asString(r.domain ?? null)
  return { kind: r.kind, id, domain: domain && domain.trim() ? domain.trim() : undefined }
}

function actionOf(e: EventRecord): FeedbackAction | null {
  const a = e.payload?.action
  const all: readonly FeedbackAction[] = ['act', 'snooze', 'dismiss', 'not-relevant']
  return typeof a === 'string' && (all as string[]).includes(a)
    ? (a as FeedbackAction)
    : null
}

// ──────────────────── delivery ────────────────────

async function deliver(
  deps: BridgeDeps,
  origin: string,
  route: EngineRoute
): Promise<{ ok: boolean; detail: string }> {
  const url = origin.replace(/\/$/, '') + route.endpoint
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const res = await deps.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(route.body),
      signal: controller.signal
    })
    let parsed: { ok?: boolean; error?: string } = {}
    try {
      parsed = (await res.json()) as { ok?: boolean; error?: string }
    } catch (e) { console.debug('[feedback-bridge] non-JSON body:', messageOf(e)) }
    // The engine answers {ok:true|false,...}. Treat HTTP-2xx + ok!==false as success.
    if (res.ok && parsed.ok !== false) {
      return { ok: true, detail: `${res.status}` }
    }
    return { ok: false, detail: `http ${res.status}: ${parsed.error ?? 'rejected'}`.slice(0, 200) }
  } catch (err) {
    return { ok: false, detail: `network: ${(err as Error)?.message ?? 'error'}`.slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}

// ──────────────────── drain ────────────────────

export interface DrainSummary {
  scanned: number
  newlyConsumed: number
  staged: number
  delivered: number
  pending: number
  failed: number
  retried: number
  engineConnected: boolean
  cursorAt: number
}

/**
 * Drain newly-recorded feedback seeds into the local ledger, forwarding the
 * mappable ones to the engine when it's up; then retry any prior pending/failed
 * rows. Idempotent: an event already in the ledger is never re-consumed, and a
 * delivered/terminal row is never re-sent.
 */
export async function drainFeedbackBridge(
  overrides: Partial<BridgeDeps> = {}
): Promise<DrainSummary> {
  const deps = defaultDeps(overrides)
  const origin = deps.engineOrigin()
  const connected = !!origin

  const ledger = readLedger(deps.ledgerDir)
  const cursor = readCursor(deps.ledgerDir)

  const summary: DrainSummary = {
    scanned: 0,
    newlyConsumed: 0,
    staged: 0,
    delivered: 0,
    pending: 0,
    failed: 0,
    retried: 0,
    engineConnected: connected,
    cursorAt: cursor
  }

  // 1) New events since the cursor (ascending so the cursor advances cleanly).
  const events = deps.listEvents({
    type: FEEDBACK_EVENT_TYPE,
    sinceMs: cursor > 0 ? cursor : undefined,
    order: 'asc',
    limit: 1000
  })
  summary.scanned = events.length

  let maxRecordedAt = cursor
  for (const e of events) {
    if (e.createdAt > maxRecordedAt) maxRecordedAt = e.createdAt
    if (ledger.has(e.id)) continue // already consumed (cursor tie / overlap)

    const action = actionOf(e)
    if (!action) continue
    const engineRef = engineRefOf(e)
    const route = engineRef ? routeFor(action, engineRef) : null

    let delivery: DeliveryState
    let detail: string | undefined
    let attempts = 0
    let lastAttemptAt: number | undefined

    if (!route) {
      delivery = 'staged'
    } else if (!connected) {
      delivery = 'pending'
    } else {
      attempts = 1
      lastAttemptAt = deps.now()
      const r = await deliver(deps, origin, route)
      delivery = r.ok ? 'delivered' : 'failed'
      detail = r.detail
    }

    const row: ConsumedSeed = {
      eventId: e.id,
      recordedAt: e.createdAt,
      consumedAt: deps.now(),
      action,
      detectorClass: asString(e.payload?.detectorClass) ?? 'unclassified',
      seedType: asString(e.payload?.seedType),
      outcomeStatus: asString(e.payload?.outcomeStatus),
      engineRef,
      route,
      delivery,
      deliveryDetail: detail,
      attempts,
      lastAttemptAt
    }
    appendLedger(deps.ledgerDir, row)
    ledger.set(e.id, row)
    summary.newlyConsumed++
    if (delivery === 'staged') summary.staged++
    else if (delivery === 'delivered') summary.delivered++
    else if (delivery === 'pending') summary.pending++
    else summary.failed++
  }

  // 2) Retry prior undelivered rows — only worth it if the engine is up now.
  if (connected) {
    for (const row of ledger.values()) {
      if (row.delivery !== 'pending' && row.delivery !== 'failed') continue
      if (!row.route) continue
      if (row.attempts >= MAX_ATTEMPTS) continue
      const r = await deliver(deps, origin, row.route)
      const updated: ConsumedSeed = {
        ...row,
        delivery: r.ok ? 'delivered' : 'failed',
        deliveryDetail: r.detail,
        attempts: row.attempts + 1,
        lastAttemptAt: deps.now()
      }
      appendLedger(deps.ledgerDir, updated)
      ledger.set(row.eventId, updated)
      summary.retried++
      if (updated.delivery === 'delivered') summary.delivered++
    }
  }

  // 3) Advance the cursor past everything we scanned (all are now in the ledger,
  //    so re-scanning them is a no-op; this just keeps the listEvents window small).
  if (maxRecordedAt > cursor) {
    writeCursor(deps.ledgerDir, maxRecordedAt)
    summary.cursorAt = maxRecordedAt
  }

  return summary
}

// ──────────────────── status (read-only) ────────────────────

export interface BridgeStatus {
  total: number
  byDelivery: Record<DeliveryState, number>
  engineConnected: boolean
  cursorAt: number
  ledgerDir: string
}

export function feedbackBridgeStatus(overrides: Partial<BridgeDeps> = {}): BridgeStatus {
  const deps = defaultDeps(overrides)
  const ledger = readLedger(deps.ledgerDir)
  const byDelivery: Record<DeliveryState, number> = {
    staged: 0,
    pending: 0,
    delivered: 0,
    failed: 0
  }
  for (const row of ledger.values()) byDelivery[row.delivery]++
  return {
    total: ledger.size,
    byDelivery,
    engineConnected: !!deps.engineOrigin(),
    cursorAt: readCursor(deps.ledgerDir),
    ledgerDir: deps.ledgerDir
  }
}

// ──────────────────── periodic driver ────────────────────

let timer: ReturnType<typeof setInterval> | null = null

/**
 * Start a periodic drain. Fires once shortly after boot (catch-up) then every
 * `intervalMs`. Best-effort: a drain error is logged, never thrown. Idempotent —
 * calling twice does not stack timers.
 */
export function startFeedbackBridge(intervalMs = 60_000): void {
  if (timer) return
  const tick = (): void => {
    drainFeedbackBridge().catch((err) =>
      console.warn('[feedback-bridge] drain error:', (err as Error)?.message)
    )
  }
  setTimeout(tick, 5_000)
  timer = setInterval(tick, Math.max(10_000, intervalMs))
}

export function stopFeedbackBridge(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
