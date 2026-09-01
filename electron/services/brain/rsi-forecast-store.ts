// rsi-forecast-store.ts — the CALIBRATION domain for "RSI change forecasts": did a self-improvement
// knob move deliver the MAGNITUDE it predicted?
//
// Each RSI change now carries an ex-ante `predictedDelta` (the fitness lift the move claimed at propose
// time — §rsi-proposer). At adjudication the loop measures the actual delta on the held-out A/B and
// records whether the forecast landed within tolerance (hit) or not (wrong). Aggregated, the Wilson
// lower bound of that hit-rate is "how well-modeled are this brain's self-improvement moves" — a real
// calibration signal the proposer reads to PREFER well-forecast knob configs over lucky ones, not just
// lifting ones. Append-only jsonl under .duin/_state, mirroring reveal-outcomes / recall-efficacy; the
// canonical reader (calRowsRsiForecast) lives in calibration-native.ts alongside the other domains so
// these outcomes also flow into calibration().domains + the fitness vector. PURE fs, single-writer.
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

const rsiForecastPath = (vault: string): string => join(vault, '.duin', '_state', 'rsi-forecast.jsonl')

export interface RsiForecastRecord {
  /** the resolved change id (rsi-proposer changeId) */
  id: string
  /** the fitness engine the change targeted */
  engine: string
  /** the JOINT knob-config cell the change landed in — namedSkillTopK × recallFailureLimit */
  topK: number
  failLimit: number
  /** the ex-ante MAGNITUDE forecast registered at propose time */
  predictedDelta: number
  /** the measured fitness delta on the held-out A/B (after.score − before.score) */
  actualDelta: number
  /** |predictedDelta − actualDelta| <= tolerance — the forecast landed */
  hit: boolean
  /** ISO resolution time — the held-out cut point for calibration windowing */
  resolved: string
}

/** WRITER — append a resolved RSI forecast outcome (ensures the state dir exists). Best-effort by
 *  contract: callers wrap this in try/catch so a ledger write never stalls the self-improve loop. */
export function recordRsiForecast(vault: string, rec: RsiForecastRecord): void {
  const path = rsiForecastPath(vault)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(rec) + '\n', 'utf-8')
}

/** Read the rsi-forecast ledger (missing ⇒ []). Skips blank/corrupt lines. */
export function readRsiForecasts(vault: string): RsiForecastRecord[] {
  const path = rsiForecastPath(vault)
  if (!existsSync(path)) return []
  const out: RsiForecastRecord[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as RsiForecastRecord)
    } catch {
      /* skip a corrupt row */
    }
  }
  return out
}

/** Light floor for the proposer's SECONDARY forecast-accuracy preference (below this many resolved
 *  forecasts a cell expresses no preference). Distinct from CAL_MIN_N(20): this is a tie-break among
 *  already-improving cells, never a gate on a safety/keep decision, so a lighter floor is honest. */
export const FORECAST_PREFER_MIN_N = 3

export interface ConfigForecast {
  /** mean actual delta observed for this joint cell (the ex-ante forecast for a revisit) */
  meanActual: number
  /** hit-rate of past forecasts for this cell (fraction within tolerance) */
  hitRate: number
  n: number
}

/** PURE — per joint-config-cell forecast history from a set of records, keyed `${topK}x${failLimit}`.
 *  meanActual seeds a revisit's predictedDelta; hitRate drives the proposer's accurate-config
 *  preference. Reads the SAME rsi-forecast ledger the calibration domain aggregates (one file, two
 *  readers — a global domain + this per-cell selector), never a parallel store. */
export function forecastByConfig(records: RsiForecastRecord[]): Map<string, ConfigForecast> {
  const agg = new Map<string, { sumActual: number; hits: number; n: number }>()
  for (const r of records) {
    if (typeof r.topK !== 'number' || typeof r.failLimit !== 'number') continue
    const key = `${r.topK}x${r.failLimit}`
    const a = agg.get(key) ?? { sumActual: 0, hits: 0, n: 0 }
    a.sumActual += typeof r.actualDelta === 'number' ? r.actualDelta : 0
    a.hits += r.hit === true ? 1 : 0
    a.n += 1
    agg.set(key, a)
  }
  const out = new Map<string, ConfigForecast>()
  for (const [key, a] of agg) {
    out.set(key, { meanActual: a.n ? a.sumActual / a.n : 0, hitRate: a.n ? a.hits / a.n : 0, n: a.n })
  }
  return out
}
