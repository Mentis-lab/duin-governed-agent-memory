// forecast-loop — the CLOSING ARROW of the calibration loop. generate → log → resolve,
// composed into one idempotent step that can fire on a cadence INDEPENDENT of the UI.
//
// The pieces already existed and were individually tested (generateForecasts,
// logForecastsToLedger, runCalibration), but nothing fired them on a background cadence:
// resolution ran only when the calibration/predicted-risks endpoint was hit (on-view) or
// a verdict was set. So an operator who never opened the panel left the ledger unresolved
// forever → the tier calibration never reached min_n → β_conf and taste-weighting (which
// read loadKindRates) stayed permanently neutral. The legacy harness closes this with a ~3h
// cron poking the resolver; this is DUIN's native equivalent, driven by a turn-tick +
// idle interval in server.ts. This is the multiplier: it un-gates every confidence-
// weighted surface that consumes the calibration ledger.
import { generateForecasts } from './forecast-generator'
import { logForecastsToLedger } from './forecast-ledger'
import { logPredictedKindsToLedger } from './predicted-kinds-ledger'
import { runCalibration, runPreResolution, runLabelCalibration } from './calibration-store'

export interface ForecastLoopResult {
  generated: number // forecasts derived from the causal graph this run
  logged: number // newly appended to the ledger (pre-act, verdict:null)
  resolved: number // owed forecasts adjudicated this run (verdict filled)
  patterns: number // kinds present in the recomputed track record
  preResolved: number // OPEN forecasts given a leading pre-resolution signal (Milkyway)
  labelScored: number // RESOLVED forecasts calibrated per verbalized-certainty label (Agent-BRACE)
}

/** One full pass of the calibration loop: derive current forecasts, log the new ones
 *  pre-act, then resolve+rescore everything past its eval_after. Idempotent — safe to
 *  fire on any cadence; logging dedups by stable id and resolution never overwrites a
 *  set verdict. Best-effort; a failure returns zeros rather than throwing. */
export function runForecastLoop(vaultDir: string | null, today: Date = new Date()): ForecastLoopResult {
  if (!vaultDir) return { generated: 0, logged: 0, resolved: 0, patterns: 0, preResolved: 0, labelScored: 0 }
  try {
    const fc = generateForecasts(vaultDir, today)
    // Log graph-derived kinds (driver/convergence/cascade) AND the three ported Python-only
    // kinds (deadline-collision/decision-window/anchor-risk) through the SAME single writer,
    // BEFORE resolving — so newly-logged rows past their eval_after resolve in this same pass
    // and no logging gap opens when the Python :8765 write path is retired (ticket Item 2).
    const logged = logForecastsToLedger(vaultDir, fc, today) + logPredictedKindsToLedger(vaultDir, today)
    const cal = runCalibration(vaultDir, today)
    // Milkyway leading signal: score OPEN forecasts pre-resolution (after logging new
    // ones this pass, before their deadlines) so calibration surfaces have a signal now.
    const preResolved = runPreResolution(vaultDir, today)
    // Agent-BRACE per-label calibration over the resolved ledger — robust to the
    // degenerate base rates that null the Murphy skill score.
    const labelScored = runLabelCalibration(vaultDir, today)
    return { generated: fc.length, logged, resolved: cal.resolved, patterns: cal.patterns, preResolved, labelScored }
  } catch {
    return { generated: 0, logged: 0, resolved: 0, patterns: 0, preResolved: 0, labelScored: 0 }
  }
}
