// style-fingerprint-service — the thin READ-ONLY wiring the /state/style-fingerprint route
// calls. It joins the three data reads (decisions, forecast confidences, promoted facts) to
// the pure fingerprint + divergence cores. A MIRROR: reads only, never writes, never mutates
// a fact or the calibration ledger (plan §5 boundary). The heavy lifting stays in the pure,
// unit-tested modules; this file is just the I/O seam so those stay testable.
import { readFileSync } from 'fs'
import { join } from 'path'
import { listDecisions } from './decisions-native'
import { listByStatus } from './operator-model'
import {
  computeFingerprint,
  detectScopedIdioms,
  detectReversibilityDrift,
  type OperatorFingerprint,
  type ScopedIdiom,
  type DriftVerdict,
  type ForecastConfidenceLike
} from './operator-fingerprint'
import { detectDivergences, type Divergence } from './operator-divergence'
import { messageOf } from '../guarded'

/**
 * Read every stated forecast confidence from the forecast ledger
 * (.duin/_state/risk-predictions.jsonl). Includes open + resolved rows (the optimism axis
 * is about how confidently forecasts are STATED, independent of resolution). Excludes
 * signal-mode `decision-window` rows — those carry efficacy, not a probabilistic confidence.
 */
export function readForecastConfidences(vaultDir: string | null): ForecastConfidenceLike[] {
  if (!vaultDir) return []
  let txt: string
  try {
    txt = readFileSync(join(vaultDir, '.duin', '_state', 'risk-predictions.jsonl'), 'utf-8')
  } catch {
    return []
  }
  const out: ForecastConfidenceLike[] = []
  for (const ln of txt.split(/\r?\n/)) {
    const s = ln.trim()
    if (!s) continue
    try {
      const r = JSON.parse(s) as { confidence?: number; kind?: string }
      if (r.kind === 'decision-window') continue // signal efficacy, not a forecast confidence
      if (typeof r.confidence === 'number') out.push({ confidence: r.confidence })
    } catch (e) { console.debug('[style-fingerprint-service] skip malformed:', messageOf(e)) }
  }
  return out
}

export interface StyleFingerprintResponse {
  fingerprint: OperatorFingerprint
  divergences: Divergence[]
  scopedIdioms: ScopedIdiom[]
  drift: DriftVerdict | null // null when there's nothing to mirror yet
  promotedFactCount: number
}

/**
 * The single wiring call for /state/style-fingerprint. Reads decisions + forecast
 * confidences + promoted facts, computes the descriptive fingerprint, the prescribed-vs-
 * actual divergences, and the opt-in heterogeneity + drift lenses. Read-only.
 */
export function buildStyleFingerprint(vaultDir: string | null, now: number = Date.now()): StyleFingerprintResponse {
  const decisions = listDecisions(vaultDir).decisions
  const forecasts = readForecastConfidences(vaultDir)
  const fingerprint = computeFingerprint(decisions, forecasts, { now })
  const promoted = listByStatus('promoted').map((f) => ({ id: f.id, fact: f.fact }))
  const divergences = detectDivergences(promoted, fingerprint)
  const scopedIdioms = detectScopedIdioms(decisions)
  const drift = decisions.length ? detectReversibilityDrift(decisions, now) : null
  return { fingerprint, divergences, scopedIdioms, drift, promotedFactCount: promoted.length }
}
