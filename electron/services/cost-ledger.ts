// cost-ledger.ts — what DUIN's model calls cost, computed from the event spine.
//
// THE HOLE THIS CLOSES. Cost was unobservable from inside the app: `model.request.completed`
// carried `usage`, but the spine's `/token/i` redaction turned every counter into '[redacted]'
// (event-log.ts, fixed alongside this file), and nothing rolled the counters up per role or per
// provider (2026-09-02 evaluation, L7 F7 / synthesis S9). This module reads the spine back and
// answers "what did the last 24 h / 7 d cost, by role and by provider" for `/debug/cost` and the
// Status panel's Spend row.
//
// TWO SOURCES, DECLARED. (1) `model.request.completed` payloads — every non-streaming provider
// call (background roles: extraction, jury, reviewer, title, …). (2) The turn journal's TURN_END
// `costUsd` — the /agui chat path, whose streaming calls emit no `model.request.*` event at all
// today (L7 F7). Both are summed and both are named in `sources`; if a chat event ever carries
// usage, `limits.overlapPossible` says so rather than silently double counting.
//
// ESTIMATED, HONESTLY. A payload with a `costUsd` field is exact. One with numeric usage is
// priced from the DeepSeek table (executor-cost.ts, data) or, for other cloud models, the cost
// table's blended fallback ($1 / $3 per M) — and the ledger says `estimated: true` whenever a
// fallback price or a historically redacted counter was involved. Local providers price at $0.
//
// Also home of the legacy → contract mapping for model events: payloads written before the P0
// router contract (roles.ts) carry a free-text `role` ('operator-learning', 'turn-beat', …) and a
// `purpose`, not a RouteTask and a classified reason. `roleFromModelEventPayload` and
// `reasonFromModelEventPayload` read either shape, so the failure watcher and this ledger agree.

import { listEvents, type EventRecord, type EventFilter } from './event-log'
import { costOfUsage, DEFAULT_PROVIDER_PRICE, type PriceTable } from './longrun/cost-budget'
import { DEEPSEEK_PRICES } from './executor/executor-cost'
import type { ProviderHealthReason, RouteTask } from './providers/roles'

// ──────────────────── role + reason mapping ────────────────────

const ROUTE_TASKS: ReadonlySet<string> = new Set([
  'chat',
  'agentic',
  'extraction',
  'reviewer',
  'jury',
  'title',
  'embed',
  'reason'
])

/** Roles that run without the operator watching. A failure here has no transcript to land in. */
export const BACKGROUND_ROLES: ReadonlySet<RouteTask> = new Set<RouteTask>([
  'extraction',
  'jury',
  'reviewer',
  'title',
  'embed'
])

const HEALTH_REASONS: ReadonlySet<string> = new Set([
  'ok',
  'no-key',
  'no-credit',
  'unauthorized',
  'model-access',
  'rate-limit',
  'not-found',
  'network',
  'unknown'
])

/** True when `payload.role` is already a router-contract RouteTask (a lane-A event). */
export function isContractRole(role: unknown): role is RouteTask {
  return typeof role === 'string' && ROUTE_TASKS.has(role)
}

/**
 * PURE. The RouteTask a model event belongs to. Contract payloads carry it verbatim. Legacy
 * payloads (`role` = a job label such as 'operator-learning', `purpose` = main/composer/title/
 * pipeline/sub-agent/other) are mapped: a title helper is `title`; a job label naming a jury,
 * reviewer or embedder maps to that role; any other background purpose — or a job label with no
 * purpose — is `extraction` (the background bucket); a main/composer turn is `chat`.
 */
export function roleFromModelEventPayload(payload: Record<string, unknown> | undefined): RouteTask {
  const p = payload ?? {}
  if (isContractRole(p.role)) return p.role
  const purpose = typeof p.purpose === 'string' ? p.purpose : ''
  const label = typeof p.role === 'string' ? p.role.trim().toLowerCase() : ''
  if (purpose === 'title') return 'title'
  if (label.includes('jury')) return 'jury'
  if (label.includes('review')) return 'reviewer'
  if (label.includes('embed')) return 'embed'
  if (purpose === 'other' || purpose === 'pipeline' || purpose === 'sub-agent') return 'extraction'
  if (!purpose && label) return 'extraction'
  return 'chat'
}

/**
 * PURE. The classified reason of a failed model event. Contract payloads carry `reason`. Legacy
 * payloads are classified from the HTTP status and the bounded error preview — a floor, not the
 * router's classifier (that is lane A's `classifyProviderError`); it exists so the failures
 * already on disk can be read, and it returns 'unknown' rather than guessing.
 */
export function reasonFromModelEventPayload(
  payload: Record<string, unknown> | undefined
): ProviderHealthReason {
  const p = payload ?? {}
  if (typeof p.reason === 'string' && HEALTH_REASONS.has(p.reason)) return p.reason as ProviderHealthReason
  const status = typeof p.httpStatus === 'number' ? p.httpStatus : Number(p.status)
  if (status === 401) return 'unauthorized'
  if (status === 402) return 'no-credit'
  if (status === 403) return 'model-access'
  if (status === 404) return 'not-found'
  if (status === 429) return 'rate-limit'
  const text = [p.errorPreview, p.errorClass, p.error, p.message]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase()
  if (!text) return 'unknown'
  if (/insufficient|balance|credit|quota|余额|billing/.test(text)) return 'no-credit'
  if (/no api key|missing api key|no key/.test(text)) return 'no-key'
  if (/invalid (api )?key|invalid authentication|unauthori[sz]ed|authentication/.test(text)) return 'unauthorized'
  if (/does not have access|model-access|not allowed to use|permission/.test(text)) return 'model-access'
  if (/rate.?limit|too many requests|429/.test(text)) return 'rate-limit'
  if (/not found|does not exist|no such model|unknown model|unsupported model/.test(text)) return 'not-found'
  if (/econnrefused|enotfound|etimedout|econnreset|fetch failed|network|timed? ?out|socket|abort/.test(text))
    return 'network'
  return 'unknown'
}

// ──────────────────── windows ────────────────────

export type CostWindow = '24h' | '7d'
export const COST_WINDOW_MS: Record<CostWindow, number> = {
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000
}

/** PURE. '7d' or the default '24h'; anything else is the default, never an error. */
export function parseCostWindow(raw: unknown): CostWindow {
  return raw === '7d' ? '7d' : '24h'
}

// ──────────────────── collection (paged) ────────────────────

/** The spine's list cap is 1000 rows; a 7-day window on a busy install is ~2,200 model events. */
export const COST_PAGE_SIZE = 1000
export const COST_MAX_EVENTS = 20_000

export type ListEventsFn = (filter: EventFilter) => EventRecord[]

export interface CollectOptions {
  sinceMs: number
  untilMs: number
  /** Stop (and say `truncated`) past this many events. Default COST_MAX_EVENTS. */
  maxEvents?: number
  list?: ListEventsFn
}

/**
 * Page back through the spine, newest first, until the window is exhausted or `maxEvents` is hit.
 * Ids are deduped across pages (the `untilMs` bound is inclusive, so the boundary row repeats).
 */
export function collectModelEvents(opts: CollectOptions): { events: EventRecord[]; truncated: boolean } {
  const list = opts.list ?? listEvents
  const pageSize = COST_PAGE_SIZE
  const maxEvents = Math.max(pageSize, opts.maxEvents ?? COST_MAX_EVENTS)
  const types: EventRecord['type'][] = ['model.request.completed']
  const seen = new Set<string>()
  const events: EventRecord[] = []
  let untilMs = opts.untilMs
  let truncated = false
  for (;;) {
    const page = list({ type: types, sinceMs: opts.sinceMs, untilMs, limit: pageSize, order: 'desc' })
    let fresh = 0
    for (const ev of page) {
      if (seen.has(ev.id)) continue
      seen.add(ev.id)
      events.push(ev)
      fresh++
    }
    if (fresh === 0 || page.length < pageSize) break
    if (events.length >= maxEvents) {
      truncated = true
      break
    }
    untilMs = page[page.length - 1].createdAt
  }
  return { events, truncated }
}

// ──────────────────── aggregation ────────────────────

export interface UsageTotals {
  /** Model calls seen. */
  calls: number
  costUsd: number
  inputTokens: number
  outputTokens: number
  /** Prompt tokens served from a provider prefix cache (billed at the cached rate). */
  cachedTokens: number
  /** Calls whose payload carried numeric usage. */
  metered: number
  /** Calls whose payload carried an exact `costUsd`. */
  exact: number
  /** Calls priced from the fallback rate (model not in the price table). */
  estimatedCalls: number
  /** Calls whose counters were redacted on disk (pre-fix rows) — tokens unknown, cost unknown. */
  redactedCalls: number
}

export function emptyTotals(): UsageTotals {
  return {
    calls: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    metered: 0,
    exact: 0,
    estimatedCalls: 0,
    redactedCalls: 0
  }
}

interface EventUsage {
  present: boolean
  redacted: boolean
  inputTokens: number
  outputTokens: number
  cachedTokens: number
}

function counter(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

/** PURE. Read a payload's usage block in either its numeric or its historically redacted form. */
export function usageFromPayload(payload: Record<string, unknown> | undefined): EventUsage {
  const raw = payload?.usage
  if (!raw || typeof raw !== 'object') return { present: false, redacted: false, inputTokens: 0, outputTokens: 0, cachedTokens: 0 }
  const u = raw as Record<string, unknown>
  const values = [u.inputTokens, u.outputTokens, u.promptTokens, u.completionTokens, u.cacheReadTokens]
  const redacted = values.some((v) => v === '[redacted]')
  if (redacted) return { present: true, redacted: true, inputTokens: 0, outputTokens: 0, cachedTokens: 0 }
  const cacheRead = counter(u.cacheReadTokens)
  const cacheWrite = counter(u.cacheWriteTokens)
  // NormalizedUsage's inputTokens is the UNCACHED remainder; a plain promptTokens-only payload
  // (older producers) is taken as the whole prompt.
  const input = u.inputTokens !== undefined ? counter(u.inputTokens) + cacheWrite : Math.max(0, counter(u.promptTokens) - cacheRead)
  const output = u.outputTokens !== undefined ? counter(u.outputTokens) : counter(u.completionTokens)
  return { present: true, redacted: false, inputTokens: input, outputTokens: output, cachedTokens: cacheRead }
}

export interface SummarizeOptions {
  priceTable?: PriceTable
  /** Local providers price at $0. Default: provider id 'ollama'. */
  isLocal?: (provider: string, model: string) => boolean
}

export interface UsageSummary {
  totals: UsageTotals
  byRole: Record<string, UsageTotals>
  byProvider: Record<string, UsageTotals>
  /** The raw producer label (legacy `role`/`purpose`), so 'operator-learning 21 calls' is visible. */
  byJob: Record<string, UsageTotals>
  /** Chat-role events that carried usage — if > 0, the journal source may overlap with events. */
  chatEventsWithUsage: number
}

function bump(map: Record<string, UsageTotals>, key: string): UsageTotals {
  return (map[key] ??= emptyTotals())
}

function add(t: UsageTotals, u: EventUsage, cost: number | null, kind: 'exact' | 'priced' | 'fallback' | 'redacted' | 'none'): void {
  t.calls++
  if (u.present && !u.redacted) {
    t.metered++
    t.inputTokens += u.inputTokens
    t.outputTokens += u.outputTokens
    t.cachedTokens += u.cachedTokens
  }
  if (cost !== null) t.costUsd += cost
  if (kind === 'exact') t.exact++
  if (kind === 'fallback') t.estimatedCalls++
  if (kind === 'redacted') t.redactedCalls++
}

/** PURE. Roll `model.request.completed` events up per role, provider and job label. */
export function summarizeModelEvents(events: EventRecord[], opts: SummarizeOptions = {}): UsageSummary {
  const table = opts.priceTable ?? DEEPSEEK_PRICES
  const fallback = DEFAULT_PROVIDER_PRICE
  const isLocal = opts.isLocal ?? ((provider: string) => provider === 'ollama')
  const out: UsageSummary = { totals: emptyTotals(), byRole: {}, byProvider: {}, byJob: {}, chatEventsWithUsage: 0 }
  for (const ev of events) {
    if (ev.type !== 'model.request.completed') continue
    const p = ev.payload ?? {}
    const role = roleFromModelEventPayload(p)
    const provider = typeof p.provider === 'string' && p.provider ? p.provider : 'unknown'
    const model = typeof p.model === 'string' ? p.model : ''
    const job = typeof p.role === 'string' && p.role && !isContractRole(p.role) ? p.role : role
    const u = usageFromPayload(p)
    let cost: number | null = null
    let kind: 'exact' | 'priced' | 'fallback' | 'redacted' | 'none' = 'none'
    if (typeof p.costUsd === 'number' && Number.isFinite(p.costUsd)) {
      cost = Math.max(0, p.costUsd)
      kind = 'exact'
    } else if (u.present && u.redacted) {
      kind = 'redacted'
    } else if (u.present) {
      if (isLocal(provider, model)) {
        cost = 0
        kind = 'priced'
      } else {
        const known = model !== '' && table[model] !== undefined
        cost = costOfUsage(
          { model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedInputTokens: u.cachedTokens },
          table,
          fallback
        )
        kind = known ? 'priced' : 'fallback'
      }
    }
    if (role === 'chat' && u.present) out.chatEventsWithUsage++
    add(out.totals, u, cost, kind)
    add(bump(out.byRole, role), u, cost, kind)
    add(bump(out.byProvider, provider), u, cost, kind)
    add(bump(out.byJob, job), u, cost, kind)
  }
  return out
}

// ──────────────────── the ledger ────────────────────

/** One turn as the journal reader hands it over (agui-journal.ts `readRecentTurns`). */
export interface JournalTurnLike {
  at: number
  model?: unknown
  end?: Record<string, unknown>
}

export interface CostLedgerSource {
  name: 'events' | 'journal'
  rows: number
  costUsd: number
  note: string
}

export interface CostLedger {
  window: CostWindow
  since: number
  until: number
  sources: CostLedgerSource[]
  totals: UsageTotals
  byRole: Record<string, UsageTotals>
  byProvider: Record<string, UsageTotals>
  byJob: Record<string, UsageTotals>
  /** True when any figure rests on a fallback price or a redacted counter. */
  estimated: boolean
  limits: {
    maxEvents: number
    truncated: boolean
    journalTurns: number
    journalTurnsInWindow: number
    /** Chat-role events with usage exist alongside journal costs — the two could overlap. */
    overlapPossible: boolean
    pricing: string
  }
}

export interface BuildCostLedgerOptions extends SummarizeOptions {
  window: CostWindow
  now?: number
  list?: ListEventsFn
  maxEvents?: number
  /** Turn journals (chat path). Omit when the caller has no journal reader. */
  journalTurns?: JournalTurnLike[]
  /** Model id → provider id, for attributing journal spend. Unknown → 'unknown'. */
  providerOf?: (modelId: string) => string
}

/** Roll the two sources into one ledger. Pure given `list` and `journalTurns`. */
export function buildCostLedger(opts: BuildCostLedgerOptions): CostLedger {
  const now = opts.now ?? Date.now()
  const since = now - COST_WINDOW_MS[opts.window]
  const cap = opts.maxEvents ?? COST_MAX_EVENTS
  const { events, truncated } = collectModelEvents({ sinceMs: since, untilMs: now, list: opts.list, maxEvents: cap })
  const summary = summarizeModelEvents(events, opts)

  const turns = opts.journalTurns ?? []
  let journalRows = 0
  let journalCost = 0
  for (const t of turns) {
    if (!(t.at >= since && t.at <= now)) continue
    const c = t.end?.costUsd
    if (typeof c !== 'number' || !Number.isFinite(c)) continue
    journalRows++
    journalCost += Math.max(0, c)
    const model = typeof t.model === 'string' ? t.model : ''
    const provider = model && opts.providerOf ? opts.providerOf(model) : 'unknown'
    const metered = typeof t.end?.meteredCalls === 'number' ? t.end.meteredCalls : 0
    for (const bucket of [summary.totals, bump(summary.byRole, 'chat'), bump(summary.byProvider, provider), bump(summary.byJob, 'chat-turn')]) {
      bucket.calls += Math.max(1, metered)
      bucket.metered += metered
      bucket.exact++
      bucket.costUsd += Math.max(0, c)
    }
  }

  const eventCost = Object.values(summary.byJob).reduce((s, t) => s + t.costUsd, 0) - journalCost
  const estimated = summary.totals.estimatedCalls > 0 || summary.totals.redactedCalls > 0
  return {
    window: opts.window,
    since,
    until: now,
    sources: [
      {
        name: 'events',
        rows: events.length,
        costUsd: Number(Math.max(0, eventCost).toFixed(6)),
        note: 'model.request.completed payloads (non-streaming calls: background roles); priced per model'
      },
      {
        name: 'journal',
        rows: journalRows,
        costUsd: Number(journalCost.toFixed(6)),
        note: 'TURN_END.costUsd from agui-journal (chat turns; streaming calls emit no spine event)'
      }
    ],
    totals: summary.totals,
    byRole: summary.byRole,
    byProvider: summary.byProvider,
    byJob: summary.byJob,
    estimated,
    limits: {
      maxEvents: cap,
      truncated,
      journalTurns: turns.length,
      journalTurnsInWindow: journalRows,
      overlapPossible: summary.chatEventsWithUsage > 0 && journalRows > 0,
      pricing: 'costUsd on the payload is exact; else DeepSeek table (executor-cost.ts); other cloud models at the blended fallback $1 in / $3 out per M (estimated); local providers $0; redacted pre-fix counters carry no cost'
    }
  }
}
