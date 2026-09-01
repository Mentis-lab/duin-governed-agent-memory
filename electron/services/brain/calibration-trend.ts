// calibration-trend — per-domain proper scores and a REAL improvement slope (world-model Stage 4a).
//
// self-improve-bench reports slope 0. That 0 is structural, not measured: it is the mean of a few
// hardcoded component values, so it cannot move whatever the system learns. This module computes the
// slope the honest way — replay the resolved ledger in date order, score each period, and fit the
// trend — and reports it per domain, because "is DUIN getting better" is a different question for a
// deadline tracker than for a risk forecast.
//
// Two disciplines carried from bench/world-model (the offline harness this mirrors):
//   * SIGNAL-mode kinds are scored as EFFICACY and never folded into a Brier. Mixing a 200-row
//     deadline-reminder rate into an 8-row probabilistic Brier is the easiest way to overstate the
//     axis.
//   * The slope is SAMPLE-WEIGHTED. Periods range from a handful of rows to a hundred; an unweighted
//     fit lets a near-empty period swing the trend as hard as a full one. Both fits are returned and
//     a sign disagreement is flagged as unreliable.
//
// PURE over supplied rows, except for the single thin reader at the bottom.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Kinds scored as efficacy, not probability — mirrors calibration-scoring.ts SIGNAL_KINDS. */
const SIGNAL_KINDS = new Set(['decision-window'])
/** Kinds where `averted` means the structure HELD — mirrors AVERTED_MEANS_HELD. */
const AVERTED_MEANS_HELD = new Set(['driver', 'convergence'])

export interface TrendRow {
  kind?: string
  confidence?: number
  verdict?: string
  resolution?: string
  outcome?: string
  resolved?: string
  created?: string
}

export interface PeriodPoint {
  period: string
  n: number
  value: number
}

export interface DomainTrend {
  domain: string
  population: 'proper' | 'signal'
  metric: string
  n: number
  periods: number
  slope: number | null
  slopeUnweighted: number | null
  /** True when the weighted and unweighted fits disagree in SIGN — trend carried by thin periods. */
  weightingDisagrees: boolean | null
  improving: boolean | null
  gated: boolean
  gatedReason: string | null
  series: PeriodPoint[]
}

const MIN_N = 20
const MIN_PERIODS = 3

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

/** Binary outcome for the probabilistic population, app-parity. Returns null when unresolved. */
function properOutcome(r: TrendRow): number | null {
  const kind = String(r.kind ?? '').toLowerCase()
  const v = String(r.verdict ?? r.resolution ?? '').toLowerCase()
  if (v === 'materialized' || v === 'hit') return 1
  if (v === 'averted') return AVERTED_MEANS_HELD.has(kind) ? 1 : 0
  if (v === 'refuted' || v === 'miss') return 0
  return null
}

/** Binary outcome for the efficacy population (decided on time vs slipped). */
function signalOutcome(r: TrendRow): number | null {
  const o = String(r.outcome ?? r.verdict ?? '').toLowerCase()
  if (['on-time', 'decided-on-time', 'decided', 'useful', 'hit', 'averted'].includes(o)) return 1
  if (['slipped', 'wrong', 'false-alarm', 'materialized'].includes(o)) return 0
  return null
}

function weekKey(iso?: string): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const d = new Date(t)
  const start = Date.UTC(d.getUTCFullYear(), 0, 1)
  const week = Math.floor((d.getTime() - start) / (7 * 86400_000))
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** Weighted OLS slope; null below 3 points. */
export function olsSlope(points: { x: number; y: number; w?: number }[]): number | null {
  if (points.length < MIN_PERIODS) return null
  const W = points.reduce((s, p) => s + (p.w ?? 1), 0)
  if (W === 0) return null
  const mx = points.reduce((s, p) => s + (p.w ?? 1) * p.x, 0) / W
  const my = points.reduce((s, p) => s + (p.w ?? 1) * p.y, 0) / W
  let num = 0
  let den = 0
  for (const p of points) {
    const w = p.w ?? 1
    num += w * (p.x - mx) * (p.y - my)
    den += w * (p.x - mx) ** 2
  }
  return den === 0 ? null : num / den
}

const round = (x: number | null, d = 5): number | null => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d))

function buildTrend(
  domain: string,
  population: 'proper' | 'signal',
  rows: { p: number; y: number; at?: string }[]
): DomainTrend {
  const buckets = new Map<string, { p: number; y: number }[]>()
  for (const r of rows) {
    const k = weekKey(r.at)
    if (!k) continue
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k)!.push(r)
  }
  const series: PeriodPoint[] = [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, rs]) => ({
      period,
      n: rs.length,
      // proper => Brier (lower better); signal => rate (higher better)
      value:
        population === 'proper'
          ? rs.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / rs.length
          : rs.reduce((s, r) => s + r.y, 0) / rs.length
    }))

  const pts = series.map((s, i) => ({ x: i, y: s.value, w: s.n }))
  const slope = olsSlope(pts)
  const slopeUnweighted = olsSlope(pts.map((p) => ({ x: p.x, y: p.y })))
  const gated = rows.length < MIN_N || series.length < MIN_PERIODS
  return {
    domain,
    population,
    metric: population === 'proper' ? 'brier (lower is better)' : 'efficacy rate (higher is better)',
    n: rows.length,
    periods: series.length,
    slope: gated ? null : round(slope),
    slopeUnweighted: round(slopeUnweighted),
    weightingDisagrees:
      slope != null && slopeUnweighted != null ? Math.sign(slope) !== Math.sign(slopeUnweighted) : null,
    improving: gated || slope == null ? null : population === 'proper' ? slope < 0 : slope > 0,
    gated,
    gatedReason: gated
      ? rows.length < MIN_N
        ? `n=${rows.length} < minN=${MIN_N}`
        : `only ${series.length} populated period(s), need >= ${MIN_PERIODS}`
      : null,
    series: series.map((s) => ({ ...s, value: round(s.value, 4) as number }))
  }
}

export interface CalibrationTrendResult {
  generated: string
  overall: DomainTrend[]
  perDomain: DomainTrend[]
  note: string
}

/** PURE: per-domain trends over the resolved ledger. */
export function calibrationTrend(rows: TrendRow[], nowIso = new Date().toISOString()): CalibrationTrendResult {
  const proper: { p: number; y: number; at?: string }[] = []
  const signal: { p: number; y: number; at?: string }[] = []
  const byDomainProper = new Map<string, { p: number; y: number; at?: string }[]>()

  for (const r of rows) {
    const kind = String(r.kind ?? 'unknown').toLowerCase()
    const at = r.resolved ?? r.created
    const c = typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? clamp01(r.confidence) : null
    if (SIGNAL_KINDS.has(kind)) {
      const y = signalOutcome(r)
      if (y !== null) signal.push({ p: c ?? 0, y, at })
      continue
    }
    if (c === null) continue
    const y = properOutcome(r)
    if (y === null) continue
    const row = { p: c, y, at }
    proper.push(row)
    if (!byDomainProper.has(kind)) byDomainProper.set(kind, [])
    byDomainProper.get(kind)!.push(row)
  }

  return {
    generated: nowIso,
    overall: [buildTrend('all', 'proper', proper), buildTrend('decision-window', 'signal', signal)],
    perDomain: [...byDomainProper.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([d, rs]) => buildTrend(d, 'proper', rs)),
    note:
      'Signal-mode (decision-window) is efficacy and is never folded into a Brier. Slopes are ' +
      'sample-weighted; a sign disagreement with the unweighted fit means the trend rests on thin ' +
      'periods. A gated slope is withheld, not estimated as 0.'
  }
}

/** Thin IO: read the resolved-forecast ledger as raw rows. A malformed line is skipped, never
 *  allowed to abort the score; a missing ledger yields []. */
export function readForecastLedgerRows(vaultDir: string | null): TrendRow[] {
  if (!vaultDir) return []
  let txt: string
  try {
    txt = readFileSync(join(vaultDir, '.duin', '_state', 'risk-predictions.jsonl'), 'utf-8')
  } catch {
    return []
  }
  const out: TrendRow[] = []
  for (const ln of txt.split(/\r?\n/)) {
    const s = ln.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s) as TrendRow)
    } catch {
      /* skip malformed row */
    }
  }
  return out
}
