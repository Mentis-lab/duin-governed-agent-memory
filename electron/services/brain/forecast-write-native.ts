// forecast-write-native — the operator WRITE arrows into the calibration ledger
// (.duin/_state/risk-predictions.jsonl): setForecastVerdict (adjudicate a forecast) +
// logForecast (author a bare probabilistic forecast). Ports set_forecast_verdict +
// log_forecast from server.py. Together with forecast-ledger (append graph forecasts) +
// calibration-store (resolve+score), TS now owns the whole ledger — the single writer.
// Each verdict is written THROUGH the resolve so the write→resolve→score loop stays atomic.
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'fs'
import { atomicWriteFileSync } from '../atomic-write'
import { join, dirname } from 'path'
import { runCalibration } from './calibration-store'
import { messageOf } from '../guarded'

const ledgerPath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'risk-predictions.jsonl')
const isoDay = (d: Date): string => d.toISOString().slice(0, 10)

function loadRows(path: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  let txt: string
  try {
    txt = readFileSync(path, 'utf-8')
  } catch {
    return rows
  }
  for (const ln of txt.split(/\r?\n/)) {
    const s = ln.trim()
    if (!s) continue
    try {
      rows.push(JSON.parse(s) as Record<string, unknown>)
    } catch (e) { console.debug('[forecast-write-native] skip malformed  matches Pythons json.JSONDecodeError pass:', messageOf(e)) }
  }
  return rows
}

function atomicWriteJsonl(path: string, rows: Record<string, unknown>[]): void {
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
  // temp -> fdatasync -> rename: the forecast ledger must survive a crash mid-write.
  atomicWriteFileSync(path, body, 0o644)
}

export interface VerdictResult {
  ok: boolean
  error?: string
  id?: string
  resolution?: string
  matched?: number
  changed?: number
  resolved_this_run?: number
}

/** Record an operator verdict on a forecast-mode prediction, then resolve+rescore in the
 *  same call — the single-writer invariant on risk-predictions.jsonl holds. resolution ∈
 *  {hit,miss,moot}. Idempotent; a CHANGED verdict clears the prior one so it re-resolves.
 *  Port of set_forecast_verdict. */
export function setForecastVerdict(
  vaultDir: string | null,
  predId: string,
  resolution: string,
  today: Date = new Date()
): VerdictResult {
  const res = (resolution || '').trim().toLowerCase()
  if (res !== 'hit' && res !== 'miss' && res !== 'moot') {
    return { ok: false, error: 'resolution must be one of hit|miss|moot' }
  }
  if (!predId) return { ok: false, error: 'id required' }
  if (!vaultDir) return { ok: false, error: 'no prediction ledger' }
  const ledger = ledgerPath(vaultDir)
  if (!existsSync(ledger)) return { ok: false, error: 'no prediction ledger' }
  const rows = loadRows(ledger)
  const hit = rows.filter((r) => r.id === predId)
  if (!hit.length) return { ok: false, error: `no prediction id=${predId}` }
  let changed = 0
  for (const r of hit) {
    if (r.resolution !== res) {
      r.resolution = res
      r.verdict = null // allow re-resolution (corrects a prior verdict too)
      delete r.resolved
      changed += 1
    }
  }
  if (changed) atomicWriteJsonl(ledger, rows)
  const out = runCalibration(vaultDir, today) // resolve+rescore now (mirrors _resolve_risk_ledger_unlocked)
  return {
    ok: true,
    id: predId,
    resolution: res,
    matched: hit.length,
    changed,
    resolved_this_run: out.resolved
  }
}

export interface LogForecastResult {
  ok: boolean
  error?: string
  id?: string
  eval_by?: string
  confidence?: number
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Author a bare probabilistic forecast (subjects-empty, forecast-mode). Stable id →
 *  a re-post is a no-op dup. Schema mirrors _log_predictions_unlocked. Port of log_forecast. */
export function logForecast(
  vaultDir: string | null,
  input: { predicted: string; confidence: unknown; evalBy: string; track?: string; id?: string },
  today: Date = new Date()
): LogForecastResult {
  const predicted = (input.predicted || '').trim()
  if (!predicted) return { ok: false, error: 'predicted text required' }
  const conf = Number(input.confidence)
  if (input.confidence === null || input.confidence === '' || !Number.isFinite(conf)) {
    return { ok: false, error: 'confidence must be a number in [0,1]' }
  }
  if (!(conf >= 0 && conf <= 1)) return { ok: false, error: 'confidence must be in [0,1]' }
  const evalBy = (input.evalBy || '').trim()
  if (!ISO_DATE.test(evalBy) || Number.isNaN(Date.parse(evalBy))) {
    return { ok: false, error: 'eval_by must be an ISO date (YYYY-MM-DD)' }
  }
  const slug = predicted.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'x'
  const fid = (input.id || '').trim() || `forecast::${slug}`
  if (!vaultDir) return { ok: false, error: 'no vault' }
  const ledger = ledgerPath(vaultDir)
  const existing = new Set(loadRows(ledger).map((r) => r.id as string))
  if (existing.has(fid)) return { ok: false, error: `forecast id already exists: ${fid}`, id: fid }
  mkdirSync(dirname(ledger), { recursive: true })
  const row = {
    id: fid,
    created: isoDay(today),
    source: 'operator-forecast',
    kind: 'forecast',
    trigger_signature: { type: 'forecast', value: '' },
    predicted,
    subjects: [] as string[],
    sources: [] as string[],
    track: input.track ?? '',
    confidence: conf,
    eval_after: { by: evalBy },
    verdict: null
  }
  appendFileSync(ledger, JSON.stringify(row) + '\n', 'utf-8') // O_APPEND: atomic complete-line write
  return { ok: true, id: fid, eval_by: evalBy, confidence: conf }
}
