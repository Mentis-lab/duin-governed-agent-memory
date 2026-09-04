// measure-tick.ts — P6: the SCHEDULED behavioral-efficacy measure pass, so the A/B "measured-lift"
// signal populates on a CLOCK instead of only when someone hits POST /state/measure-facts or the
// on-promote hook fires (which it never does — nothing gets promoted, so 0/46 facts carry efficacy).
// Cloned from claim-metabolism-tick.ts. runMeasurePass is idempotent + additive (never prunes), so a
// tick over an already-measured (or empty) store is a cheap no-op.
//
// runMeasurePass makes model calls (several per fact), so this tick is deliberately conservative:
//   • LOCAL-FIRST + PROVIDER-AGNOSTIC, with the BILLABLE cloud fallback gated on backgroundAutonomy —
//     it always prefers a detected local (Ollama) model (zero cost, private); the fallback to the
//     operator's configured CLOUD provider fires ONLY when backgroundAutonomy is ON (the operator has
//     opted into unattended billable background work). With autonomy OFF (the DEFAULT) the tick is
//     LOCAL-ONLY and a true no-op when no local model runs — so an unattended default install can
//     never surprise-bill. No model/provider is hardcoded — DUIN stays portable across model APIs.
//   • CONSERVATIVE cadence (default 6h — a recurring measurement, NOT the 15-min loop tick) and
//     BATCH-CAPPED (default 5 facts/pass) so it is bounded even in the cloud-fallback case.
//   • FIRE-AND-FORGET + failure-isolated — a measure error is swallowed here; it never breaks the app.
//
// GATED by DUIN_MEASURE_TICK (default ON; set to 0/false to disable → start/stop are no-ops with zero
// background work). Cadence via DUIN_MEASURE_TICK_MS (0 disables), batch via DUIN_MEASURE_BATCH.
import { runMeasurePass, localFirstMeasureDeps, localOnlyMeasureDeps } from './judgment-measure-live'
import type { MeasureDeps } from './judgment-measure'
import { readSettings } from '../settings-helper'
import { runStalenessAccrual, accrualDeps } from './grounding-staleness-accrual'

// 6h — this is a recurring MEASUREMENT (expensive model calls), not the day-grained loop tick, so it
// runs far less often than calibration/metabolism. Override via DUIN_MEASURE_TICK_MS; 0 disables.
const TICK_MS = (() => {
  const raw = Number(process.env.DUIN_MEASURE_TICK_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 6 * 60 * 60_000
})()
// Measure at most N facts per pass so a recurring pass is bounded (even on cloud fallback: N facts ×
// a few calls each). Un-measured facts are prioritized by runMeasurePass, so coverage grows over
// successive ticks. Override via DUIN_MEASURE_BATCH.
const BATCH = (() => {
  const raw = Number(process.env.DUIN_MEASURE_BATCH)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5
})()
const INITIAL_MS = 60_000 // let boot settle (after calibration 30s / metabolism 45s) before the first pass

/** Enabled unless DUIN_MEASURE_TICK is explicitly '0' or 'false'. */
export function measureTickEnabled(): boolean {
  const raw = process.env.DUIN_MEASURE_TICK
  return raw !== '0' && raw !== 'false'
}

let timer: ReturnType<typeof setInterval> | null = null
let initial: ReturnType<typeof setTimeout> | null = null

/** backgroundAutonomy master switch, best-effort (missing/unreadable settings ⇒ OFF = gated).
 *  Mirrors compounding-health-live.readBackgroundAutonomy. */
function backgroundAutonomyOn(): boolean {
  try {
    return readSettings().backgroundAutonomy === true
  } catch {
    return false
  }
}

/** The deps a scheduled tick uses when the caller doesn't inject one: LOCAL-FIRST (may fall back to a
 *  billable CLOUD model) ONLY when backgroundAutonomy is ON; otherwise LOCAL-ONLY (free, or a no-op
 *  when no local model runs). Resolved FRESH per tick so toggling autonomy takes effect on the next
 *  pass, not just at startup. */
function activeMeasureDeps(): MeasureDeps {
  return backgroundAutonomyOn() ? localFirstMeasureDeps : localOnlyMeasureDeps
}

/** One batch-capped measure pass. Fire-and-forget + failure-isolated: runMeasurePass is async and
 *  never rejects to the caller here — a failed pass is non-fatal and must not crash the tick or block
 *  the app. When `deps` is OMITTED the autonomy-gated default applies (local-only unless
 *  backgroundAutonomy is on), so an unattended default install never makes a surprise cloud call.
 *  `deps` + `limit` stay injectable for tests. */
export function measureTick(deps?: MeasureDeps, limit: number = BATCH): void {
  void runMeasurePass(deps ?? activeMeasureDeps(), { limit }).catch((e) => {
    console.warn('[measure-tick] pass failed (non-fatal):', (e as Error)?.message)
  })
  stalenessAccrualPass()
}

/** The grounding-staleness calibration accrual, on the same clock and the same cost rule as the
 *  measure pass.
 *
 *  WHY IT LIVES HERE: agui-grounding only down-weights currency-stale facts once the
 *  grounding-staleness domain's Wilson lower bound clears its floor, but nothing in production ever
 *  wrote that domain — its only writer was the manual POST /debug/grounding-eval-live — so on every
 *  real vault the trust stayed null and the gate never opened. Measured on the operator's own vault
 *  2026-09-03: no grounding-staleness.jsonl at all. The STALE benchmark showed the behavioural cost:
 *  DUIN flagged a fact as stale and then grounded its answer on it anyway.
 *
 *  Fire-and-forget + failure-isolated, exactly like the measure pass, and additive only: it appends
 *  calibration evidence. Whether fusion actually engages stays shouldFuseStaleness's decision on that
 *  evidence — this never forces it on. */
function stalenessAccrualPass(): void {
  try {
    const vault = (() => {
      try {
        const d = readSettings().localBrainNotesDir
        return typeof d === 'string' && d ? d : null
      } catch {
        return null
      }
    })()
    void runStalenessAccrual(vault, accrualDeps(backgroundAutonomyOn())).then((r) => {
      if (r.ran && r.recorded > 0) {
        console.log(`[measure-tick] staleness accrual: ${r.recorded} calibration sample(s) from ${r.labeled} judged of ${r.scored} facts` +
          (r.trust ? ` — trust n=${r.trust.n} wilson_lo=${r.trust.wilson_lo.toFixed(2)}${r.trust.gated ? ' (gated)' : ''}` : ''))
      }
    })
  } catch (e) {
    console.warn('[measure-tick] staleness accrual failed (non-fatal):', (e as Error)?.message)
  }
}

/** Start the periodic measure pass: one settle-delayed pass, then every TICK_MS. No-op if already
 *  running, the tick is disabled (TICK_MS=0), or DUIN_MEASURE_TICK is off. Deps are chosen per-tick by
 *  measureTick (autonomy-gated) unless a caller injects one. */
export function startMeasureTick(deps?: MeasureDeps): void {
  if (timer || TICK_MS === 0 || !measureTickEnabled()) return
  initial = setTimeout(() => measureTick(deps), INITIAL_MS)
  timer = setInterval(() => measureTick(deps), TICK_MS)
}

export function stopMeasureTick(): void {
  if (initial) {
    clearTimeout(initial)
    initial = null
  }
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
