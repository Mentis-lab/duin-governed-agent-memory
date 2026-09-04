// Home — the gatherer. One call fans out to everything the folded surfaces read (IPC and the
// local brain's /state and /debug routes), settles each source independently, and returns the
// HomeInputs the pure model composes. A source that cannot be read is reported by label, never
// mistaken for "nothing there".
//
// Also owns the "what changed" baseline: a snapshot per app session in localStorage, so the
// next session can say what moved while the operator was away.

import { duinFetch } from '@/duin/lib/loopback-auth'
import { fetchBrainGraphSummary, fetchLearnLoop, fetchSchedulesWithRunner } from '@/duin/lib/state'
import { useActivityStore } from '@/stores/activity-store'
import { useAutomationsStore } from '@/stores/automations-store'
import { useChatStore } from '@/stores/chat-store'
import { useNoticesStore } from '@/stores/notices-store'
import type { EngineInput, HomeInputs, Snapshot } from './home-model'

interface Envelope<T> {
  success?: boolean
  data?: T
  error?: string
}

function unwrap<T>(r: unknown): T | null {
  if (!r || typeof r !== 'object') return null
  const e = r as Envelope<T>
  if (e.success === false) return null
  return (e.data ?? null) as T | null
}

/** Read `window.__DUIN_BASE` at call time: main injects it after load when the brain port is
 *  not the default (an isolated instance), and a frozen constant would point at the wrong app. */
function brainBase(): string {
  const w = window as unknown as { __DUIN_BASE?: string }
  return w.__DUIN_BASE || 'http://127.0.0.1:8799'
}

type Api = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
function api(): Api | undefined {
  return (window as unknown as { api?: Api }).api
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await duinFetch(`${brainBase()}${path}`, { signal })
  if (!r.ok) throw new Error(`${path} ${r.status}`)
  return (await r.json()) as T
}

/** Run one source; a rejection becomes null and a label in `unreadable`. */
async function settle<T>(label: string, unreadable: string[], run: () => Promise<T | null>): Promise<T | null> {
  try {
    return await run()
  } catch {
    unreadable.push(label)
    return null
  }
}

// ── The "since you were away" baseline ───────────────────────────────────────

const SEEN_CURRENT = 'duin.home.seen.current.v1'
const SEEN_PREVIOUS = 'duin.home.seen.previous.v1'
const BOOT_ID = 'duin.home.bootId.v1'

function bootId(): string {
  try {
    let id = sessionStorage.getItem(BOOT_ID)
    if (!id) {
      id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      sessionStorage.setItem(BOOT_ID, id)
    }
    return id
  } catch {
    return 'no-session-storage'
  }
}

interface StoredSnapshot extends Snapshot {
  bootId: string
}

function readStored(key: string): StoredSnapshot | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const v = JSON.parse(raw) as StoredSnapshot
    return v && typeof v.at === 'number' ? v : null
  } catch {
    return null
  }
}

/** The baseline for deltas: the last snapshot written by a PREVIOUS app session. A snapshot
 *  from this session is rolled to "previous" the first time a new session reads it. */
export function loadLastSeen(): Snapshot | null {
  const id = bootId()
  const current = readStored(SEEN_CURRENT)
  if (current && current.bootId !== id) {
    try {
      localStorage.setItem(SEEN_PREVIOUS, JSON.stringify(current))
      localStorage.removeItem(SEEN_CURRENT)
    } catch {
      /* storage blocked: deltas stay session-only */
    }
    return current
  }
  return readStored(SEEN_PREVIOUS)
}

export function saveSeen(snapshot: Snapshot): void {
  try {
    const stored: StoredSnapshot = { ...snapshot, bootId: bootId() }
    localStorage.setItem(SEEN_CURRENT, JSON.stringify(stored))
  } catch {
    /* storage blocked: nothing to keep */
  }
}

// ── The gather ────────────────────────────────────────────────────────────────

interface FactLike {
  id: string
  fact: string
  status: string
  ts?: number | string
  govern?: { verdict?: string } | null
}

interface AgentRunLike {
  status: 'running' | 'done' | 'error' | 'aborted'
  finishedAt: number | null
}

export async function loadHomeInputs(signal?: AbortSignal): Promise<HomeInputs> {
  const now = Date.now()
  const unreadable: string[] = []
  const a = api()
  const lastSeen = loadLastSeen()

  const noticesP = settle('notices', unreadable, async () => {
    const store = useNoticesStore.getState()
    await store.loadNotices()
    return useNoticesStore.getState().notices
  })
  const awaitingP = settle('learning', unreadable, async () => {
    const rows = unwrap<{ id: string }[]>(await a?.operator?.awaitingRatify?.())
    return rows ? rows.length : 0
  })
  const digestP = settle('digest', unreadable, async () => unwrap<HomeInputs['digest']>(await a?.brain?.homeDigest?.()))
  const engineP = settle('engine', unreadable, async (): Promise<EngineInput | null> => {
    const m = a?.model
    if (!m?.resolve) return null
    const [res, health, providers, models] = await Promise.all([
      m.resolve('chat').catch(() => null),
      m.healthList?.().catch(() => null),
      m.listProviders?.().catch(() => null),
      m.list?.().catch(() => null)
    ])
    const ps = unwrap<{ id: string; label: string }[]>(providers) ?? []
    const ms = unwrap<{ id: string; name: string }[]>(models) ?? []
    return {
      resolution: unwrap<EngineInput['resolution']>(res),
      health: unwrap<EngineInput['health']>(health) ?? [],
      providerLabels: Object.fromEntries(ps.map((p) => [p.id, p.label])),
      modelNames: Object.fromEntries(ms.map((x) => [x.id, x.name]))
    }
  })
  const indexP = settle('index', unreadable, () => getJson<HomeInputs['index']>('/state/index-status', signal))
  const graphP = settle('graph', unreadable, () => fetchBrainGraphSummary(signal))
  const statusP = settle('brain status', unreadable, async () => unwrap<{ hasModel: boolean }>(await a?.brain?.status?.()))
  const schedulesP = settle('schedules', unreadable, () => fetchSchedulesWithRunner(signal))
  const automationsP = settle('automations', unreadable, async () => {
    const store = useAutomationsStore.getState()
    await store.refresh()
    const rows = useAutomationsStore.getState().automations
    const failing = rows.filter((r) => r.enabled && typeof r.lastResult === 'string' && /^(error|failed)/i.test(r.lastResult)).length
    const lastRunAt = rows.reduce<number | null>((best, r) => (r.lastRunAt && (best === null || r.lastRunAt > best) ? r.lastRunAt : best), null)
    return { total: rows.length, enabled: rows.filter((r) => r.enabled).length, lastRunAt, failing }
  })
  const runningP = settle('background', unreadable, async () => {
    const store = useActivityStore.getState()
    await store.refresh()
    const s = useActivityStore.getState()
    const agentRuns = s.agentRuns as AgentRunLike[]
    const toolCalls = useChatStore.getState().toolCalls
    const since = lastSeen?.at ?? 0
    const finished = agentRuns.filter((r) => r.finishedAt !== null && r.finishedAt > since)
    return {
      running: {
        agents: agentRuns.filter((r) => r.status === 'running').length,
        toolCalls: toolCalls.filter((c) => c.status === 'pending' || c.status === 'running').length,
        wakeups: s.wakeups.filter((w) => w.status === 'pending').length
      },
      runs: {
        done: finished.filter((r) => r.status === 'done').length,
        failed: finished.filter((r) => r.status === 'error').length
      }
    }
  })
  const stallsP = settle('stalls', unreadable, async () => {
    const r = await getJson<{ stalls: { ms?: number; durationMs?: number }[]; since: number }>('/debug/stalls', signal)
    const totalMs = r.stalls.reduce((sum, s) => sum + (s.ms ?? s.durationMs ?? 0), 0)
    return { count: r.stalls.length, totalMs, sinceMs: Math.max(0, now - r.since) }
  })
  const costP = settle('spend', unreadable, async () => {
    const r = await getJson<{ totals: { calls: number; costUsd: number }; estimated: boolean }>('/debug/cost?window=24h', signal)
    return { costUsd: r.totals.costUsd, calls: r.totals.calls, estimated: r.estimated }
  })
  const backendP = settle('backend health', unreadable, async () => {
    const r = await getJson<{
      ts: string
      integrity: { db: string; integrityOk: boolean; fkViolations?: number }[]
      backupAgeHours: number | null
      stuckRuns: number
    } | null>('/debug/backend-health', signal)
    if (!r) return null
    const integrityOk = r.integrity.length === 0 ? null : r.integrity.every((s) => s.integrityOk && (s.fkViolations ?? 0) === 0)
    return { integrityOk, backupAgeHours: r.backupAgeHours, stuckRuns: r.stuckRuns, ts: r.ts }
  })
  const connectionsP = settle('sources', unreadable, async () => unwrap<HomeInputs['connections']>(await a?.connections?.list?.()))
  const learningP = settle('learning', unreadable, async () => {
    const facts = unwrap<FactLike[]>(await a?.operator?.list?.()) ?? []
    const awaiting = facts.filter((f) => f.status === 'provisional' && f.govern?.verdict === 'ratify')
    const awaitingIds = new Set(awaiting.map((f) => f.id))
    const proving = facts.filter((f) => (f.status === 'candidate' || f.status === 'provisional') && !awaitingIds.has(f.id))
    const confirmed = facts.filter((f) => f.status === 'promoted')
    const live = facts.filter((f) => f.status !== 'vetoed')
    const latest = live
      .map((f) => ({ f, ts: typeof f.ts === 'number' ? f.ts : Date.parse(String(f.ts ?? '')) || 0 }))
      .sort((x, y) => y.ts - x.ts)[0]
    let correctionsQueued = 0
    try {
      const loop = await fetchLearnLoop(signal)
      correctionsQueued = Number((loop as { queued?: number; corrections_new?: number }).queued ?? (loop as { corrections_new?: number }).corrections_new ?? 0) || 0
    } catch {
      /* the learn-loop route is optional; the counts above stand on their own */
    }
    return {
      awaiting: awaiting.length,
      proving: proving.length,
      confirmed: confirmed.length,
      latestFact: latest && latest.ts > (lastSeen?.at ?? 0) ? latest.f.fact : null,
      correctionsQueued
    }
  })
  const calibrationP = settle('calibration', unreadable, async () => {
    const r = await getJson<{ totals?: { predictions: number; resolved: number; open: number; false_alarms: number } }>('/state/calibration', signal)
    const tt = r.totals
    return tt ? { predictions: tt.predictions, resolved: tt.resolved, open: tt.open, falseAlarms: tt.false_alarms } : null
  })
  const afterActionP = settle('after action', unreadable, async () => {
    const id = useChatStore.getState().activeConversationId
    if (!id || !a?.afterAction?.get) return null
    const report = unwrap<{ counts?: { toolErrors?: number; chatErrors?: number } }>(await a.afterAction.get(id))
    if (!report?.counts) return null
    return { toolErrors: report.counts.toolErrors ?? 0, chatErrors: report.counts.chatErrors ?? 0 }
  })

  const [notices, awaitingFacts, digest, engine, index, graph, status, schedules, automations, activity, stalls, cost, backend, connections, learning, calibration, afterAction] =
    await Promise.all([noticesP, awaitingP, digestP, engineP, indexP, graphP, statusP, schedulesP, automationsP, runningP, stallsP, costP, backendP, connectionsP, learningP, calibrationP, afterActionP])

  return {
    now,
    notices,
    counts: useNoticesStore.getState().counts,
    awaitingFacts: awaitingFacts ?? 0,
    digest,
    engine,
    index,
    graph,
    hasModel: status ? status.hasModel : null,
    schedules,
    automations,
    running: activity?.running ?? null,
    runs: activity?.runs ?? null,
    stalls,
    cost,
    backend,
    connections,
    learning,
    calibration,
    afterAction,
    lastSeen,
    unreadable: [...new Set(unreadable)]
  }
}
