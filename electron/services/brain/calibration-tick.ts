// calibration-tick.ts — periodic resolve+score of the forecast ledger, so the
// calibration loop advances on a CLOCK, not only when /state/forecasts is viewed.
// A forecast resolves once its eval window passes; this makes that happen even if
// nobody opens the forecasts panel. runCalibration is idempotent + best-effort, so
// a tick over an already-resolved (or empty) ledger is a cheap no-op.
import { runCalibration } from './calibration-store'
import {
  watchForecastResolved,
  watchCalibrationDrift,
  watchForecastOwed,
  watchConfidentMiss,
  type OwedForecast,
  type ConfidentMiss
} from '../proactive/watchers'
import { forecastOwed, confidentMisses } from './simple-reads-native'
import { nudgeFromCalibration } from '../proactive/builtin-nudges'

// 15 min matches the app's existing loop-tick cadence; eval windows are day-grained
// so sub-hour granularity is ample. Override via DUIN_CALIBRATION_TICK_MS; set it to
// 0 to disable the periodic tick entirely (start/stop become no-ops).
const TICK_MS = (() => {
  const raw = Number(process.env.DUIN_CALIBRATION_TICK_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 15 * 60_000
})()
const INITIAL_MS = 30_000 // let boot settle before the first resolve

let timer: ReturnType<typeof setInterval> | null = null
let initial: ReturnType<typeof setTimeout> | null = null

/** Resolve+score once for the current vault. Best-effort: never throws — a bad
 *  vault dir or IO error must not crash the tick. Exposed for tests. */
export function calibrationTick(getVaultDir: () => string | null): void {
  let dir: string | null
  try {
    dir = getVaultDir()
  } catch {
    return // a throwing settings read must not crash the tick
  }
  if (!dir) return
  try {
    const cal = runCalibration(dir)
    // Proactive watch/notify (#2): the resolution loop is exactly where a forecast
    // becomes due/resolved and where the tier calibration is recomputed. Fire the
    // (opt-in, default-OFF) forecast + drift watchers as a POST-STEP call — they
    // never throw and change nothing about the resolve above.
    if (cal.resolved > 0) {
      void watchForecastResolved({ resolved: cal.resolved })
    }
    void watchCalibrationDrift(cal.confidenceCalibration)
    // (e) Adjudication backlog + (f) confident-miss surfacing (opt-in, default-OFF).
    // Both read the ledger directly (best-effort, never throw) and route ONE deduped
    // nudge through the delivery-queue — the native replacements for the operator's
    // forecast_adjudication_trigger.py / surprise_consolidation_trigger.py.
    void watchForecastOwed({ owed: forecastOwed(dir).owed as OwedForecast[], vaultDir: dir })
    // Owed DECISIONS — the closing arrow that used to be a human clicking an outcome in the
    // Active Work panel. That surface is retired, so this runs in its place on the same tick
    // that already resolves forecasts. It only ever closes a LAPSED window as unobserved
    // (excluded from hit-rate); it never invents a substantive outcome. Lazily required for
    // the same reason as the nudge graph below — keep the graph build out of the tick's
    // static import chain — and wrapped because an unattended tick must never be taken down
    // by a bad register.
    // DYNAMIC `import()`, NOT `require()` — and therefore in a fire-and-forget async IIFE, since
    // this tick is synchronous by signature. A bare `require('./decision-loop')` is copied
    // verbatim into the single-file `out/main/index.js`, where that path does not exist (nothing
    // statically imports it, so Rollup never emits it). It threw MODULE_NOT_FOUND into the catch
    // below on every tick, which means the lapsed-decision-window archiver — a real durable write
    // — has never run in ANY packaged build. Confirmed 2026-08-04 by reading the shipped asar.
    // `import()` keeps the laziness and gets the module emitted as a chunk. The step was already
    // best-effort and order-independent (`void watch*` around it), so deferring it by a microtask
    // changes nothing observable.
    void (async () => {
      try {
        const brainMod = await import('./index')
        const { runDecisionLoop } = await import('./decision-loop')
        const res = runDecisionLoop(dir, brainMod.getKeylessInsightInputs(dir).openLoops)
        if (res.unobserved > 0) {
          console.log(
            `[decision-loop] closed ${res.unobserved} lapsed decision window(s) as unobserved ` +
              `(${res.open} still open of ${res.seen})`
          )
        }
      } catch {
        // best-effort, matching every other post-step on this tick
      }
    })()
    void watchConfidentMiss({ misses: confidentMisses(dir).misses as ConfidentMiss[], vaultDir: dir })
    // Two-way nudge (#4): if enough forecasts are due for a verdict, ask the operator
    // (opt-in, fail-closed) whether they want the brief now — a Y reply delivers it.
    // Lazily required so the tick doesn't statically pull the nudge/digest graph, and
    // getCalibration is read here for the full report (recent[] carries the due dates).
    // Dynamic `import()` for the same reason as the decision-loop block above: a bare require of
    // './index' does not survive the single-file main bundle, so this nudge never fired either.
    void (async () => {
      try {
        const brain = await import('./index')
        void nudgeFromCalibration(brain.getCalibration(dir), {
          getDigest: () => brain.getHomeDigest(dir),
          getCalibration: () => brain.getCalibration(dir)
        })
      } catch (e) {
        console.debug('[calibration-tick] forecast nudge skipped:', (e as Error)?.message)
      }
    })()
  } catch (e) {
    console.warn('[calibration-tick] resolve failed (non-fatal):', (e as Error)?.message)
  }
}

/** Start the periodic resolver: one settle-delayed pass, then every TICK_MS. No-op
 *  if already running or the tick is disabled (TICK_MS=0). */
export function startCalibrationTick(getVaultDir: () => string | null): void {
  if (timer || TICK_MS === 0) return
  initial = setTimeout(() => calibrationTick(getVaultDir), INITIAL_MS)
  timer = setInterval(() => calibrationTick(getVaultDir), TICK_MS)
}

export function stopCalibrationTick(): void {
  if (initial) {
    clearTimeout(initial)
    initial = null
  }
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
