// longtask-monitor.ts — the renderer half of the freeze instrument.
//
// The main-process stall monitor (electron/services/main-stall-monitor.ts,
// read at GET /debug/stalls) cannot see this window's own thread: a heavy
// mount — an uncached sort over thousands of nodes, a 1.5MB JSON.parse, a
// grapesjs init — freezes this window while main stays perfectly responsive.
// PerformanceObserver('longtask') is Chromium's native instrument for exactly
// that. Entries ≥100ms are logged and ring-buffered on window.__longtasks so a
// CDP session (or DevTools) can read what stalled and when.
//
// LIMITS: longtask entries carry duration + a coarse attribution container,
// not a stack — pairing the timestamp with what surface just mounted is the
// diagnostic step. Buffered longtask entries from before this observer
// connects are requested via `buffered: true`, so early-boot stalls are kept.

export interface LongTaskSample {
  at: number
  ms: number
  name: string
}

declare global {
  interface Window {
    __longtasks?: LongTaskSample[]
  }
}

export function installLongTaskMonitor(): void {
  if (typeof PerformanceObserver === 'undefined') return
  try {
    const buf: LongTaskSample[] = (window.__longtasks = [])
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < 100) continue
        buf.push({ at: Date.now(), ms: Math.round(e.duration), name: e.name })
        if (buf.length > 200) buf.shift()
        console.warn(`[longtask] ${Math.round(e.duration)}ms — ${e.name}`)
      }
    })
    obs.observe({ type: 'longtask', buffered: true })
  } catch {
    /* longtask unsupported in this context — nothing to observe */
  }
}
