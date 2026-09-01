// main-stall-monitor.ts — the instrument that sees main-thread freezes.
//
// The UI freezes the operator can feel (page-open hitches, whole-app input
// stalls) had no instrument on either side of the process boundary: none of the
// 381 ipcMain handlers is timed, the in-process brain server's routes are not
// timed, and a 939KB DEVLOG contains zero freeze incidents — not because none
// happened, but because nothing could record one. This module is that
// instrument. It does not fix anything; it attributes.
//
// Two signals, cheap enough to be always-on:
//   1. ATTRIBUTED — withScope(name, fn) times fn's SYNCHRONOUS portion (for an
//      async fn: up to the point it returns its promise — exactly the part that
//      blocks the event loop) and records samples ≥ ATTR_MS.
//   2. UNATTRIBUTED — a 250ms heartbeat measures event-loop lag; lag ≥ LAG_MS
//      with no attributed sample in the last second is recorded as
//      'unattributed', meaning: something stalled main and nothing is wrapped
//      around it yet. An unattributed stall is a TODO, not noise.
//
// Read it at GET /debug/stalls on the brain server, or via getStalls() in
// tests. Ring-buffered (last 200), with per-scope totals since launch.
//
// LIMITS: sync work resumed AFTER an await inside a wrapped handler is not
// attributed (it lands as unattributed heartbeat lag). GC pauses and Chromium-
// internal jank on main land as unattributed too. The renderer's own long
// tasks are a different thread — src/lib/longtask-monitor.ts covers those.

export interface StallSample {
  at: number
  ms: number
  scope: string
}

interface ScopeTotals {
  count: number
  maxMs: number
  totalMs: number
}

const ATTR_MS = 100
const LAG_MS = 150
const HEARTBEAT_MS = 250
const RING_MAX = 200

const ring: StallSample[] = []
const totals = new Map<string, ScopeTotals>()
let lastAttributedAt = 0
let currentDepth = 0

function record(scope: string, ms: number, at: number): void {
  ring.push({ at, ms, scope })
  if (ring.length > RING_MAX) ring.shift()
  const t = totals.get(scope) ?? { count: 0, maxMs: 0, totalMs: 0 }
  t.count += 1
  t.maxMs = Math.max(t.maxMs, ms)
  t.totalMs += ms
  totals.set(scope, t)
  console.warn(`[main-stall] ${ms}ms — ${scope}`)
}

/**
 * Time the synchronous portion of `fn` under `scope`. Nested scopes: only the
 * OUTERMOST records, so one slow route wrapped by both the http wrapper and an
 * inner idle wrapper yields one sample, attributed to the outer name.
 */
export function withScope<T>(scope: string, fn: () => T): T {
  const outer = currentDepth === 0
  currentDepth += 1
  const start = Date.now()
  try {
    return fn()
  } finally {
    currentDepth -= 1
    if (outer) {
      const ms = Date.now() - start
      if (ms >= ATTR_MS) {
        lastAttributedAt = Date.now()
        record(scope, ms, start)
      }
    }
  }
}

// ── Phases: attribution for sync work that resumes AFTER an await ──
//
// withScope times only the synchronous head of an async handler, so a turn that
// awaits and then blocks main for six seconds recorded as 'unattributed' — the
// documented limit, and in practice the single largest bucket. A phase is the
// other half: it stays open across awaits and does not time anything itself, it
// only NAMES whatever the heartbeat catches while it is open.
//
// Phases nest and overlap (two turns can be in flight). The innermost — most
// recently opened — wins, because that is the most specific answer available.
let phaseSeq = 0
const openPhases = new Map<number, string>()

export function currentPhase(): string | null {
  let last: string | null = null
  for (const v of openPhases.values()) last = v // Map keeps insertion order
  return last
}

/** Name the heartbeat's findings while `fn` is in flight. Records nothing on
 *  its own — a phase that never stalls costs one Map insert and delete. */
export async function withPhase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const id = ++phaseSeq
  openPhases.set(id, name)
  try {
    return await fn()
  } finally {
    openPhases.delete(id)
  }
}

/** Test seam: drop any phase a failed test left open. */
export function _resetPhases(): void {
  openPhases.clear()
}

/**
 * Wrap every subsequently registered ipcMain.handle listener in a scope named
 * for its channel. Call ONCE, before registerAllIpcHandlers. Monkey-patch by
 * design: one wrap site instead of 381 edited handlers. Type-only electron
 * import so this module stays loadable under plain vitest.
 */
export function instrumentIpcMain(ipc: import('electron').IpcMain): void {
  const orig = ipc.handle.bind(ipc)
  type HandleListener = Parameters<import('electron').IpcMain['handle']>[1]
  ipc.handle = ((channel: string, listener: HandleListener) =>
    orig(channel, (event, ...args) =>
      withScope(`ipc:${channel}`, () => listener(event, ...args))
    )) as import('electron').IpcMain['handle']
}

/** Start the heartbeat. Returns a stop function. Injectable clock for tests. */
export function startMainStallMonitor(opts?: {
  now?: () => number
  schedule?: (fn: () => void, ms: number) => { unref?: () => void } | void
}): () => void {
  const now = opts?.now ?? Date.now
  let stopped = false
  let last = now()
  const scheduleNext = (): void => {
    if (stopped) return
    const t = (opts?.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms)))(beat, HEARTBEAT_MS)
    ;(t as { unref?: () => void } | undefined)?.unref?.()
  }
  const beat = (): void => {
    if (stopped) return
    const n = now()
    const lag = n - last - HEARTBEAT_MS
    if (lag >= LAG_MS && n - lastAttributedAt > 1000) {
      // Name it if any phase is open. 'unattributed' now means what it was
      // always supposed to mean: nothing has claimed this code path yet.
      const phase = currentPhase()
      record(phase ? `phase:${phase}` : 'unattributed', lag, last)
    }
    last = n
    scheduleNext()
  }
  scheduleNext()
  return () => {
    stopped = true
  }
}

export function getStalls(): {
  stalls: StallSample[]
  totals: Record<string, ScopeTotals>
  since: number
} {
  const out: Record<string, ScopeTotals> = {}
  for (const [k, v] of totals) out[k] = { ...v }
  return { stalls: [...ring], totals: out, since: monitorSince }
}

const monitorSince = Date.now()

/** Test seam: wipe recorded state so cases are independent. */
export function resetStallsForTest(): void {
  ring.length = 0
  totals.clear()
  lastAttributedAt = 0
}
