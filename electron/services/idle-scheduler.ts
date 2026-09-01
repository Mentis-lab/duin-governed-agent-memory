// idle-scheduler.ts — run heavy main-thread maintenance when the operator is away.
//
// WHY THIS EXISTS. The in-process brain server and better-sqlite3 both live on the
// Electron main thread, so a multi-second maintenance pass freezes every window's
// input while it runs. Three such passes were MEASURED and then left on wall-clock
// timers (PLANNING/DUIN_PERF_LAUNCH_HANDOFF.md): the claim-metabolism tick (~4s,
// every 15 min), the backend-health integrity pragmas (~2.1s, hourly), and the
// brain-graph SWR rebuild (1.7–3.3s, scheduled by the very surface-open it then
// freezes). The felt symptom is "the app hitches when I open a page".
//
// The design is OS-style idle scheduling, not a stopgap: heavy maintenance waits
// until the operator has not touched the machine for `idleMs`, and runs anyway
// once `maxDelayMs` has passed so freshness is bounded. The work itself still
// runs on the main thread — deliberately. Moving these passes to a worker means
// moving their module graphs (sqlite handles, vault fs, settings), which is a
// far larger change; if the stall monitor still shows attributed stalls after
// idle-gating, that is the next step, taken on evidence.
//
// LIMITS. This module does not make anything faster — it only moves when it
// runs. `getIdleMs` reads Electron's powerMonitor (system-wide input idle);
// before app-ready, or outside Electron (tests), the fallback treats the system
// as idle, which degrades to today's run-immediately behavior rather than
// never-running.

import { withScope } from './main-stall-monitor'

export interface RunWhenIdleOpts {
  /** Operator must have been hands-off this long before the work may start. */
  idleMs: number
  /** Hard freshness bound: run regardless once this much time has been spent waiting. */
  maxDelayMs: number
  /** How often to re-check idleness while waiting. Default 15s. */
  pollMs?: number
  /** Injected for tests. Default: Electron powerMonitor.getSystemIdleTime()*1000. */
  getIdleMs?: () => number
  /** Injected for tests. Default: global setTimeout (unref'd). */
  schedule?: (fn: () => void, ms: number) => void
  /** Injected for tests. Default Date.now. */
  now?: () => number
}

function defaultIdleMs(): number {
  try {
    // Lazy so importing this module never pulls electron at module-eval time
    // (vitest imports services without an app). require, not import(): the
    // wait-loop needs a synchronous answer.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { powerMonitor } = require('electron') as typeof import('electron')
    return powerMonitor.getSystemIdleTime() * 1000
  } catch {
    // No powerMonitor (tests, pre-ready) → claim idle, so the work degrades to
    // running immediately — today's behavior — instead of being starved forever.
    return Number.MAX_SAFE_INTEGER
  }
}

/**
 * Run `fn` once, as soon as the operator has been idle for `opts.idleMs`,
 * or unconditionally once `opts.maxDelayMs` has elapsed. Returns immediately.
 * The run is wrapped in the stall monitor's scope so its cost is attributed.
 *
 * NEVER runs `fn` on the caller's stack — even when already idle, the first
 * check is deferred one scheduler tick. SwrJsonCache's contract ("a rebuild
 * never runs inside the request") depends on this, and the etag suite caught
 * the inline variant re-serving the NEW body on what must be a stale serve.
 */
export function runWhenIdle(name: string, fn: () => void, opts: RunWhenIdleOpts): void {
  const pollMs = opts.pollMs ?? 15_000
  const getIdle = opts.getIdleMs ?? defaultIdleMs
  const now = opts.now ?? Date.now
  const schedule =
    opts.schedule ??
    ((f: () => void, ms: number) => {
      const t = setTimeout(f, ms)
      t.unref?.()
    })
  const startedWaiting = now()

  const attempt = (): void => {
    const waited = now() - startedWaiting
    const overdue = waited >= opts.maxDelayMs
    const idle = ((): boolean => {
      try {
        return getIdle() >= opts.idleMs
      } catch {
        return true // an unreadable idle source must not starve maintenance
      }
    })()
    if (idle || overdue) {
      if (overdue && !idle) {
        console.log(`[idle-scheduler] ${name}: overdue after ${Math.round(waited / 1000)}s — running despite activity`)
      }
      try {
        withScope(`idle:${name}`, fn)
      } catch (e) {
        console.warn(`[idle-scheduler] ${name} threw (non-fatal):`, (e as Error)?.message)
      }
      return
    }
    schedule(attempt, pollMs)
  }

  schedule(attempt, 0)
}
