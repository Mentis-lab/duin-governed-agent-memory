// Native port of Python `forecast_record()` (server.py) — the predictor's track
// record: per-pattern hit-rate + tier calibration, written by resolve_risk_ledger.
// It's a pass-through read of <vault>/.duin/_state/forecast-track-record.json, with a
// stable empty fallback when the file is absent/corrupt — byte-parity with Python.
// Part of the brain unification (retire the Python engine); see DUIN_UNIFICATION_HANDOFF.

import { readFileSync } from 'fs'
import { join } from 'path'

export interface ForecastRecord {
  patterns: Record<string, unknown>
  resolved_this_run: number
  [k: string]: unknown
}

// A FRESH object each call — a shared const would let a caller mutating `.patterns`
// leak into the next call (the mutable-state test guards this).
const fallback = (): ForecastRecord => ({ patterns: {}, resolved_this_run: 0 })

/** Read the forecast track-record JSON for a vault, or the empty fallback. Pure fs. */
export function forecastRecord(vaultDir: string | null): ForecastRecord {
  if (!vaultDir) return fallback()
  try {
    return JSON.parse(readFileSync(join(vaultDir, '.duin', '_state', 'forecast-track-record.json'), 'utf-8')) as ForecastRecord
  } catch {
    return fallback()
  }
}
