// operator-fingerprint — the DESCRIPTIVE third face of DUIN's operator self-model
// (alongside the prescriptive `operator-model` facts and the accuracy `calibration`
// loop). It mirrors *how the operator actually decides* as Wilson-gated histograms
// over decision-idiom axes — a MIRROR, never advice, never a verdict. Silence below
// the sample floor is a first-class, honest state (ratio=null + empty render), exactly
// like `buildOperatorBlock`'s cold-start `''`.
//
// PURE + headless: `computeFingerprint(decisions, forecasts)` takes already-loaded rows
// (the route wiring reads `listDecisions()` + the forecast ledger). No file I/O, no store.
// Reuses the calibration loop's honesty math verbatim — `wilson` + `(k+1)/(n+2)` Laplace
// smoothing + `pyRound` from calibration-resolve-native (NOT re-derived). The confidence
// tiering mirrors that module's private `tierOf` thresholds (high≥0.85 / med≥0.5); it is
// inlined here rather than exported because §0.4 forbids editing calibration-*.ts bodies.
//
// See PLANNING/DUIN_OPERATOR_FINGERPRINT_PLAN.md §§1–4. P1 ships the two axes derivable
// today (reversibility-lean + forecast-optimism) and the deferred axes as honest
// `needs-capture` placeholders. Heterogeneity + drift are P3 (this module's extensions).
import { wilson, pyRound } from './calibration-resolve-native'
import { decayWeight } from './consolidation-lenses'
import type { DecisionRow } from './decisions-native'

// Two-tier null gate (intentionally below CAL_MIN_N=20 — decisions accrue at dozens/year,
// forecasts faster). Below N_FLOOR the axis renders nothing; N_FLOOR..N_GATE shows a
// smoothed ratio + band but claims NO direction; at/above N_GATE it earns a norm and is
// divergence-eligible. Overridable per call so tests pin the tiers.
export const N_FLOOR = 5
export const N_GATE = 12

export type AxisGate = 'silent' | 'observe' | 'norm'
/** 'A'=leans the (riskier) A pole · 'B'=leans B · 'balanced'=CI straddles 0.5 · null=no signal yet. */
export type AxisLean = 'A' | 'B' | 'balanced' | null

export interface FingerprintAxis {
  id: string
  label: string // general-audience label — life/work/strategy, NOT coder-speak
  poles: [string, string] // A is ALWAYS the notable/riskier idiom (one-way, confident)
  countA: number
  countB: number
  n: number // countA + countB (classifiable obs)
  total: number // coverage denominator (all rows in scope)
  explicitN?: number // obs whose field was ACTIVELY recorded (reversibility default caveat)
  ratio: number | null // smoothed (k+1)/(n+2) over the display denom, or NULL below N_FLOOR
  ci: [number | null, number | null] // wilson(countA, inference denom) — the band lean/divergence use
  lean: AxisLean
  gate: AxisGate
  source: 'decision-notes' | 'forecast-ledger'
  derivable: 'now' | 'needs-capture'
}

export interface OperatorFingerprint {
  generatedAt: number
  scope: { windowDays?: number; domain?: string }
  totalDecisions: number
  minN: number // the norm / divergence-eligible threshold (N_GATE)
  axes: FingerprintAxis[]
}

/** Minimal forecast shape — only the stated confidence matters for the optimism axis. */
export interface ForecastConfidenceLike {
  confidence?: number | null
}

export interface FingerprintOptions {
  nFloor?: number
  nGate?: number
  now?: number // generatedAt stamp (injectable for deterministic tests)
  windowDays?: number // recorded as scope metadata (P1 does not pre-filter; see P3)
  domain?: string
}

interface AxisStats {
  gate: AxisGate
  ratio: number | null
  ci: [number | null, number | null]
  lean: AxisLean
}

/**
 * The shared gate+lean computation. `inferenceN` is the honest denominator every
 * inference (lean, divergence) keys off; `displayN` is what the shown ratio averages
 * over (they differ only for reversibility, where the shown ratio is full-n but the
 * lean is on explicit-only). Below the floor: silence. Above the gate: a direction is
 * claimed ONLY when the Wilson band clears 0.5 — a thin sample gives a wide band that
 * straddles 0.5 → 'balanced' → no false confidence, automatically.
 */
function axisStats(countA: number, inferenceN: number, displayN: number, nFloor: number, nGate: number): AxisStats {
  const gate: AxisGate = inferenceN < nFloor ? 'silent' : inferenceN < nGate ? 'observe' : 'norm'
  if (gate === 'silent') return { gate, ratio: null, ci: [null, null], lean: null }
  const ratio = pyRound((countA + 1) / (displayN + 2), 3)
  const ci = wilson(countA, inferenceN)
  let lean: AxisLean = null
  if (gate === 'norm') {
    const [lo, hi] = ci
    if (lo != null && hi != null) lean = lo > 0.5 ? 'A' : hi < 0.5 ? 'B' : 'balanced'
  }
  return { gate, ratio, ci, lean }
}

/**
 * FLAGSHIP axis — one-way vs reversible doors, from `DecisionRow.oneWay`.
 * Bias caveat (plan §3): the decision writer defaults `reversibility:'reversible'`, so
 * un-judged notes inflate the reversible pole. `oneWay` is always an active choice, so we
 * LEAN on `explicitN` (rows whose reversibility field was actually recorded, i.e. != '—')
 * and only SHOW the full-n ratio. Fully removing the writer-default contamination from the
 * reversible pole needs a `reversibility_source` capture sentinel (§8 #2, deferred).
 */
function reversibilityAxis(decisions: DecisionRow[], nFloor: number, nGate: number): FingerprintAxis {
  const total = decisions.length
  const countA = decisions.filter((d) => d.oneWay).length // one-way / irreversible (always explicit)
  const explicitN = decisions.filter((d) => d.reversibility && d.reversibility !== '—').length
  const countB = total - countA
  const stats = axisStats(countA, explicitN, total, nFloor, nGate)
  return {
    id: 'reversibility-lean',
    label: 'Reversible vs one-way doors',
    poles: ['one-way', 'reversible'],
    countA,
    countB,
    n: total,
    total,
    explicitN,
    ...stats,
    source: 'decision-notes',
    derivable: 'now'
  }
}

/**
 * The calibration BRIDGE — confident vs hedged forecasts, from stated `confidence`.
 * Buckets mirror calibration-resolve-native's `tierOf`: confident = high (≥0.85);
 * hedged = med+low (a tagged number below 0.85). Untagged (no numeric confidence) is
 * excluded from n. No default-contamination here, so explicitN == n (omitted).
 */
function forecastOptimismAxis(forecasts: ForecastConfidenceLike[], nFloor: number, nGate: number): FingerprintAxis {
  let countA = 0
  let countB = 0
  for (const f of forecasts) {
    const c = f.confidence
    if (typeof c !== 'number' || Number.isNaN(c)) continue // untagged → not classifiable
    if (c >= 0.85) countA++
    else countB++
  }
  const n = countA + countB
  const stats = axisStats(countA, n, n, nFloor, nGate)
  return {
    id: 'forecast-optimism',
    label: 'Confident vs hedged forecasts',
    poles: ['confident', 'hedged'],
    countA,
    countB,
    n,
    total: forecasts.length,
    ...stats,
    source: 'forecast-ledger',
    derivable: 'now'
  }
}

/** A deferred axis shipped honestly in the model: no data path yet → ratio=null, needs-capture. */
function deferredAxis(
  id: string,
  label: string,
  poles: [string, string],
  source: 'decision-notes' | 'forecast-ledger'
): FingerprintAxis {
  return {
    id,
    label,
    poles,
    countA: 0,
    countB: 0,
    n: 0,
    total: 0,
    ratio: null,
    ci: [null, null],
    lean: null,
    gate: 'silent',
    source,
    derivable: 'needs-capture'
  }
}

/**
 * Compute the operator's decision-style fingerprint from already-loaded rows. PURE.
 * Cold start (no decisions AND no forecasts) → `axes: []` — nothing to mirror yet.
 * `scope` is recorded metadata only in P1; scoped/windowed/drift variants are P3.
 */
export function computeFingerprint(
  decisions: DecisionRow[],
  forecasts: ForecastConfidenceLike[],
  opts: FingerprintOptions = {}
): OperatorFingerprint {
  const nFloor = opts.nFloor ?? N_FLOOR
  const nGate = opts.nGate ?? N_GATE
  const generatedAt = opts.now ?? Date.now()
  const scope: { windowDays?: number; domain?: string } = {}
  if (opts.windowDays != null) scope.windowDays = opts.windowDays
  if (opts.domain) scope.domain = opts.domain

  if (decisions.length === 0 && forecasts.length === 0) {
    return { generatedAt, scope, totalDecisions: 0, minN: nGate, axes: [] }
  }

  const axes: FingerprintAxis[] = [
    reversibilityAxis(decisions, nFloor, nGate),
    forecastOptimismAxis(forecasts, nFloor, nGate),
    // DEFERRED (plan §3) — shipped so the roadmap is visible, honest about the missing capture:
    deferredAxis('conviction-reversal', 'Reversed vs held decisions', ['reversed', 'held'], 'decision-notes'),
    deferredAxis('outcome-follow-through', 'Abandoned vs followed-through', ['abandoned', 'followed-through'], 'decision-notes')
  ]
  return { generatedAt, scope, totalDecisions: decisions.length, minN: nGate, axes }
}

// ─── P3: heterogeneity (Simpson guard) + drift lens ──────────────────────────────
// Off by default in the headline axes above — these are opt-in refinements the route/UX
// call once the pooled signal is earned. Both reuse the same honesty math (wilson +
// decayWeight); no new statistics. See plan §4.

const DAY_MS = 86_400_000
export const DRIFT_HALF_LIFE_DAYS = 365 // style drifts on years, not the 30d consolidation default

/** Reversibility classification on the HONEST denominator: one-way → 'A', explicitly-
 *  reversible → 'B', unrecorded ('—') → null (excluded, never counted as a reversible choice). */
function classifyReversibility(d: DecisionRow): 'A' | 'B' | null {
  if (d.oneWay) return 'A'
  if (d.reversibility && d.reversibility !== '—') return 'B'
  return null
}

/** Non-overlap test for two Wilson bands (nulls → treated as not-separated). */
function bandsSeparate(a: [number | null, number | null], b: [number | null, number | null]): boolean {
  if (a[0] == null || a[1] == null || b[0] == null || b[1] == null) return false
  return a[1] < b[0] || b[1] < a[0]
}

export interface ScopedIdiom {
  axis: string
  scopeKey: 'domain' | 'layer'
  scopeValue: string
  countA: number
  n: number
  ratio: number | null
  ci: [number | null, number | null]
}

/**
 * Simpson-guarded scoped sub-idioms for the reversibility axis. A domain/layer sub-idiom
 * surfaces as DISTINCT only when scoped-n AND pooled-n both clear N_gate AND the scoped
 * Wilson band does not overlap the pooled band — otherwise it folds silently into the
 * pooled headline (this is what stops "reckless in finance" off n=4). Pools only WITHIN
 * the axis, never across axes.
 */
export function detectScopedIdioms(decisions: DecisionRow[], opts: FingerprintOptions = {}): ScopedIdiom[] {
  const nGate = opts.nGate ?? N_GATE
  const classifiable = decisions.map((d) => ({ d, c: classifyReversibility(d) })).filter((x) => x.c !== null)
  const pooledN = classifiable.length
  const pooledA = classifiable.filter((x) => x.c === 'A').length
  if (pooledN < nGate) return [] // no trustworthy headline to compare a sub-idiom against
  const pooledCi = wilson(pooledA, pooledN)

  const out: ScopedIdiom[] = []
  for (const scopeKey of ['domain', 'layer'] as const) {
    const groups = new Map<string, { d: DecisionRow; c: 'A' | 'B' | null }[]>()
    for (const x of classifiable) {
      const v = (x.d[scopeKey] || '').trim()
      if (!v) continue
      ;(groups.get(v) ?? groups.set(v, []).get(v)!).push(x)
    }
    for (const [scopeValue, rows] of groups) {
      const n = rows.length
      if (n < nGate) continue
      const countA = rows.filter((r) => r.c === 'A').length
      const ci = wilson(countA, n)
      if (bandsSeparate(ci, pooledCi)) {
        out.push({ axis: 'reversibility-lean', scopeKey, scopeValue, countA, n, ratio: pyRound((countA + 1) / (n + 2), 3), ci })
      }
    }
  }
  return out
}

export interface DriftLens {
  ratio: number | null
  ci: [number | null, number | null]
  n: number // effective (Kish) for the recency lens; raw count for the older half
}
export interface DriftVerdict {
  axis: string
  drifting: boolean
  recent: DriftLens // decay-weighted (recency-emphasized), Kish effective n
  older: DriftLens // the older half by date, unweighted
}

/**
 * Dual stationary+recency drift lens for the reversibility axis. The recency lens weights
 * classifiable decisions by decayWeight(age, 365) and feeds Wilson the Kish EFFECTIVE sample
 * size n_eff=(Σw)²/Σw² (k_eff,n_eff rounded to ints first). Drift is reported ONLY when the
 * recency band and the older-half band separate AND n_eff ≥ N_gate — otherwise the wide band
 * on thin recent data swallows the difference and we stay silent.
 */
export function detectReversibilityDrift(decisions: DecisionRow[], now: number, opts: FingerprintOptions = {}): DriftVerdict {
  const nGate = opts.nGate ?? N_GATE
  const rows = decisions
    .map((d) => ({ c: classifyReversibility(d), t: Date.parse(d.date) }))
    .filter((x): x is { c: 'A' | 'B'; t: number } => x.c !== null && !Number.isNaN(x.t))

  // recency lens (decay-weighted, Kish effective n)
  let sumW = 0
  let sumW2 = 0
  let sumWA = 0
  for (const r of rows) {
    const ageDays = Math.max(0, (now - r.t) / DAY_MS)
    const w = decayWeight(ageDays, DRIFT_HALF_LIFE_DAYS)
    sumW += w
    sumW2 += w * w
    if (r.c === 'A') sumWA += w
  }
  const nEff = sumW2 > 0 ? Math.round((sumW * sumW) / sumW2) : 0
  const kEff = sumW > 0 ? Math.min(nEff, Math.round((sumWA / sumW) * nEff)) : 0
  const recentCi = nEff > 0 ? wilson(kEff, nEff) : ([null, null] as [number | null, number | null])
  const recent: DriftLens = { ratio: nEff > 0 ? pyRound((kEff + 1) / (nEff + 2), 3) : null, ci: recentCi, n: nEff }

  // older half by date (chronological ascending → first half is oldest)
  const sorted = [...rows].sort((a, b) => a.t - b.t)
  const half = Math.floor(sorted.length / 2)
  const olderRows = sorted.slice(0, half)
  const olderN = olderRows.length
  const olderA = olderRows.filter((r) => r.c === 'A').length
  const olderCi = olderN > 0 ? wilson(olderA, olderN) : ([null, null] as [number | null, number | null])
  const older: DriftLens = { ratio: olderN > 0 ? pyRound((olderA + 1) / (olderN + 2), 3) : null, ci: olderCi, n: olderN }

  const drifting = nEff >= nGate && bandsSeparate(recentCi, olderCi)
  return { axis: 'reversibility-lean', drifting, recent, older }
}
