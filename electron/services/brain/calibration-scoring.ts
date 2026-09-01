// calibration-scoring — proper scoring rules for DUIN's forecast ledger (Evidence Threshold · A4).
//
// The 2026-07-08 eval scored calibration BELOW a basic Brier tracker: the resolver computes only
// useful_rate / efficacy + Beta(1,1)/Wilson smoothing — honest DISCIPLINE, but not a PROPER
// scoring rule, so it can't claim "beats baseline." This adds the missing instrument — Brier +
// log-loss + a base-rate baseline + Murphy skill score + a reliability curve / ECE — the
// AIA-Forecaster / RLCR frontier method that turns "we track calibration" into "our Brier beats
// the base rate."
//
// PURE + ADDITIVE by design: it reads resolved forecasts and computes scores. It does NOT touch
// `calibration-resolve-native` (which stays byte-exact vs the Python resolver until the
// brain-unification flip retires Python). Wiring this into the live calibration payload rides
// that coordinated flip; the math is built + tested now. The `scoreResolvedLedger` IO wrapper at
// the bottom loads the ledger and scores it — surfaced via the /state/calibration-score route
// (NOT the golden-locked /state/calibration payload).
import { readFileSync } from 'fs'
import { join } from 'path'
import { messageOf } from '../guarded'

// Kinds where `averted` means the STRUCTURAL claim HELD (a correct positive). driver/convergence
// assert a coupling — `averted` = subjects resolved together = the coupling held = outcome 1.
// cascade is NOT here on purpose: it is a THREAT forecast (P(the slippage propagates)); its
// `averted` means the threat was DEFUSED = the predicted event did NOT happen = a correct negative
// (outcome 0), the same as any risk kind. (Lumping cascade with the structural kinds would score a
// cascade as "right" exactly when its threat did not materialize, and make single-gate cascades —
// which resolve materialized/averted only — incapable of ever scoring a miss.)
const AVERTED_MEANS_HELD = new Set(['driver', 'convergence'])

/** A resolved probabilistic forecast: a stated probability + its binary outcome. */
export interface ScoredForecast {
  confidence: number // stated P(event), 0..1
  outcome: 0 | 1 // 1 = materialized (hit), 0 = refuted (miss)
}

export interface ReliabilityBin {
  lo: number
  hi: number
  n: number
  meanPredicted: number
  observedFreq: number
}

export interface ProperScore {
  n: number
  baseRate: number | null // fraction that materialized
  brier: number | null // mean (p - o)^2 — lower is better (0 = perfect)
  baselineBrier: number | null // Brier of always-predict-base-rate = p̄(1-p̄)
  skillScore: number | null // 1 - brier/baselineBrier (Murphy); > 0 beats the base rate. GATED below minN.
  logLoss: number | null // cross-entropy, clamped
  ece: number | null // expected calibration error (mean reliability gap)
  reliability: ReliabilityBin[]
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

interface LedgerRow {
  confidence?: number | null
  verdict?: string | null
  resolution?: string | null
  kind?: string | null // used to interpret `averted` (coupling vs risk semantics — see below)
  signal?: boolean // caller sets from KIND_MODE (signal-mode kinds are efficacy-scored, not probabilistic)
}

/** Pull proper-scorable rows: probabilistic forecasts (numeric confidence) that RESOLVED
 *  (materialized / averted / refuted). Signal-mode / unobserved / moot / open are excluded.
 *
 *  `averted` is KIND-DEPENDENT (the reconciliation of the calibration `averted` contradiction):
 *   - STRUCTURAL coupling (driver/convergence): confidence = P(the coupling holds); `averted` =
 *     subjects resolved together = the coupling HELD = a correct POSITIVE (outcome 1). This matches
 *     the weight/track-record path, which scores these `averted` as 'useful'.
 *   - RISK/event kinds (incl. cascade — a threat forecast): confidence = P(the event materializes);
 *     `averted` = the event did NOT happen = a correct NEGATIVE (outcome 0).
 *  The old uniform `averted→0` drove baseRate→0 → baselineBrier=0 → skillScore permanently null for
 *  the structural kinds (the two scorers disagreed on their `averted`); see AVERTED_MEANS_HELD. */
export function extractScoredForecasts(rows: LedgerRow[]): ScoredForecast[] {
  const out: ScoredForecast[] = []
  for (const r of rows) {
    if (r.signal) continue
    const c = typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? clamp01(r.confidence) : null
    if (c == null) continue
    const v = (r.verdict || r.resolution || '').toString().toLowerCase()
    const avertedIsHeld = AVERTED_MEANS_HELD.has((r.kind || '').toString().toLowerCase())
    if (v === 'materialized' || v === 'hit') out.push({ confidence: c, outcome: 1 })
    else if (v === 'averted') out.push({ confidence: c, outcome: avertedIsHeld ? 1 : 0 })
    else if (v === 'refuted' || v === 'miss') out.push({ confidence: c, outcome: 0 })
    // unobserved / moot / open → excluded
  }
  return out
}

/**
 * Proper scoring over resolved probabilistic forecasts. Descriptive stats (brier/baseRate/
 * logLoss/ece/reliability) are always returned; the DEFENSIBLE claim (skillScore = "beats
 * base rate") is GATED to null below `minN` so a thin ledger can't over-claim — the same
 * honesty discipline as the resolver's Wilson/min_n gate.
 */
export function properScore(forecasts: ScoredForecast[], minN = 20): ProperScore {
  const n = forecasts.length
  if (n === 0) {
    return { n: 0, baseRate: null, brier: null, baselineBrier: null, skillScore: null, logLoss: null, ece: null, reliability: [] }
  }

  const baseRate = forecasts.reduce((s, f) => s + f.outcome, 0) / n
  const brier = forecasts.reduce((s, f) => s + (f.confidence - f.outcome) ** 2, 0) / n
  const baselineBrier = baseRate * (1 - baseRate)
  const eps = 1e-12
  const logLoss =
    -forecasts.reduce((s, f) => {
      const p = clamp01(f.confidence)
      return s + (f.outcome === 1 ? Math.log(Math.max(p, eps)) : Math.log(Math.max(1 - p, eps)))
    }, 0) / n

  const reliability: ReliabilityBin[] = []
  for (let i = 0; i < 10; i++) {
    const lo = i / 10
    const hi = (i + 1) / 10
    const inBin = forecasts.filter((f) => (i < 9 ? f.confidence >= lo && f.confidence < hi : f.confidence >= lo && f.confidence <= hi))
    if (inBin.length === 0) continue
    reliability.push({
      lo,
      hi,
      n: inBin.length,
      meanPredicted: inBin.reduce((s, f) => s + f.confidence, 0) / inBin.length,
      observedFreq: inBin.reduce((s, f) => s + f.outcome, 0) / inBin.length
    })
  }
  const ece = reliability.reduce((s, b) => s + (b.n / n) * Math.abs(b.meanPredicted - b.observedFreq), 0)

  const skillScore = n >= minN && baselineBrier > 0 ? 1 - brier / baselineBrier : null
  return { n, baseRate, brier, baselineBrier, skillScore, logLoss, ece, reliability }
}

// Signal-mode kinds (KIND_MODE in calibration-resolve-native) are efficacy-scored, not
// probabilistic — excluded from proper scoring.
const SIGNAL_KINDS = new Set(['decision-window'])

/** IO wrapper: load the resolved forecast ledger (.duin/_state/risk-predictions.jsonl) and
 *  compute the proper score. The pure functions above stay testable; this is the thin read side
 *  the /state/calibration-score route calls. */
/** Read + extract the proper-scorable (confidence, outcome) pairs from the resolved forecast
 *  ledger. Shared primitive: scoreResolvedLedger + the Platt recalibration fit both consume it. */
export function loadScoredForecasts(vaultDir: string | null): ScoredForecast[] {
  if (!vaultDir) return []
  let txt: string
  try {
    txt = readFileSync(join(vaultDir, '.duin', '_state', 'risk-predictions.jsonl'), 'utf-8')
  } catch {
    return []
  }
  const rows: LedgerRow[] = []
  for (const ln of txt.split(/\r?\n/)) {
    const s = ln.trim()
    if (!s) continue
    try {
      const r = JSON.parse(s) as { confidence?: number; verdict?: string; resolution?: string; kind?: string }
      rows.push({ confidence: r.confidence, verdict: r.verdict, resolution: r.resolution, kind: r.kind, signal: SIGNAL_KINDS.has(r.kind ?? '') })
    } catch (e) { console.debug('[calibration-scoring] skip malformed:', messageOf(e)) }
  }
  return extractScoredForecasts(rows)
}

export function scoreResolvedLedger(vaultDir: string | null, minN = 20): ProperScore {
  return properScore(loadScoredForecasts(vaultDir), minN)
}
