// COHERENCE HEALTH — the meta-benchmark (DUIN_COHERENCE_HEALTH.md §1). The apex of the benchmark
// pattern DUIN ships 3× (Brain / Backend / Compounding Health). Those each score ONE subsystem's live
// numbers; THIS scores the WHOLE system's wiring (design→code→runtime) over the Coherence Map, and
// NESTS the three subsystem-benchmark overalls as inputs to its LIVENESS axis. It is the "system that
// builds the system," expressed as a number that only rises when a real gap actually closes.
//
// FOUR AXES (weighted → overall). Every sub-metric is a deterministic count/ratio over the map + the
// nested rollups — so a fix provably moves a NAMED axis and a regression trips it:
//   WIRING          .30  is every loop connected end-to-end (producer→consumer→behavior)?
//   INTENT-FIDELITY .30  does code match design intent (no silent drift)?
//   GUARDEDNESS     .20  is each loop protected by a deterministic detector + a scheduled monitor?
//   LIVENESS        .20  are the loops actually turning (fresh) + the nested benchmarks healthy?
//
// PURITY (mirrors compounding-health.ts): computeCoherenceHealth performs NO I/O, no clock reads (the
// report time is injected as `builtAt`), no module imports of live state — every signal arrives in
// `deps` (the map, the three rollup overalls, an optional lint summary). The thin live gatherer
// (coherence-health-live.ts) reads the map + the benchmark history ledgers and feeds this pure core.
//
// by_design is load-bearing: a COLD_BY_DESIGN / byDesign entry is a DELIBERATE stance (the operator's
// accept-starvation, whole-note privacy, proof-receipts cold-by-use) and is treated as HEALTHY — it
// must never tank an axis. Only a NON-byDesign cold/dead/gap/shadow state is counted as a defect.

import type { CoherenceEntry, CoherenceAxis, WiringState } from './coherence-map'

// ──────────────────── injected shapes ────────────────────

/** The three nested subsystem-benchmark overalls (0-100), or null when that ledger is absent.
 *  Injected by the live gatherer (reads each benchmark's history ledger) so this core imports no
 *  live-state module and works across branches where a given benchmark may not exist. */
export interface RollupDeps {
  /** Brain Health overall (brain-health-history.jsonl latest), or null. */
  brain: number | null
  /** Backend Health overall — derived by the gatherer from the latest backend-health entry, or null. */
  backend: number | null
  /** Compounding Health overall (compounding-health-history.jsonl latest), or null. */
  compounding: number | null
}

/** Optional deterministic-lint summary (coherence-lint.ts). Folded into notes + small penalties; never
 *  the primary signal (the map is). All counts default to 0 / absent when the lint didn't run. */
export interface LintSummary {
  /** Exported symbols with no non-test caller (WIRING candidates). */
  deadExports: number
  /** `.duin/_state/*.jsonl` ledgers stale vs their siblings while the app is active (LIVENESS). */
  frozenLedgers: number
  /** Map subsystems with an empty detector list (GUARDEDNESS). */
  unguarded: number
  /** Nested-benchmark axis drops vs a prior history entry (LIVENESS). */
  benchmarkRegressions: number
}

export interface CoherenceHealthDeps {
  /** Report time — INJECTED (the pure fn never calls Date.now()/new Date()). */
  builtAt: string
  /** The Coherence Map (typically COHERENCE_MAP; injectable for tests). */
  map: CoherenceEntry[]
  /** The nested subsystem-benchmark overalls for the LIVENESS rollup. */
  rollups: RollupDeps
  /** Optional deterministic-lint findings summary. */
  lint?: LintSummary | null
  /** OPTIONAL axis-weight override (defaults below). */
  weights?: Partial<AxisWeights>
}

// ──────────────────── report shape ────────────────────

export interface AxisReport {
  score: number // 0-100
  metrics: Record<string, number>
  notes: string
}
export interface CoherenceHealth {
  overall: number // 0-100 weighted avg of the 4 axes
  weakestAxis: string
  axes: {
    wiring: AxisReport
    intentFidelity: AxisReport
    guardedness: AxisReport
    liveness: AxisReport
  }
  builtAt: string
}

export interface AxisWeights {
  wiring: number
  intentFidelity: number
  guardedness: number
  liveness: number
}

/** Axis weights per DUIN_COHERENCE_HEALTH.md §1. WIRING + INTENT dominate (a disconnected or
 *  drifted loop is the worst class of defect); GUARDEDNESS + LIVENESS are the maintenance substrate. */
export const DEFAULT_AXIS_WEIGHTS: AxisWeights = {
  wiring: 0.3,
  intentFidelity: 0.3,
  guardedness: 0.2,
  liveness: 0.2
}

// ──────────────────── small pure helpers ────────────────────

const clamp = (x: number, lo = 0, hi = 100): number => (x < lo ? lo : x > hi ? hi : x)
const round1 = (x: number): number => Math.round(x * 10) / 10
const round3 = (x: number): number => Math.round(x * 1000) / 1000
const pct = (num: number, den: number): number => (den > 0 ? num / den : 0)

/** Weighted average of {score,weight} pairs; ignores zero-weight terms. PURE. */
function weightedAvg(parts: { score: number; weight: number }[]): number {
  let s = 0
  let w = 0
  for (const p of parts) {
    if (p.weight <= 0) continue
    s += p.score * p.weight
    w += p.weight
  }
  return w === 0 ? 0 : s / w
}

/** A `.jsonl`-style detector name that denotes a SCHEDULED monitor (vs a one-shot test/invariant).
 *  Anything containing "-monitor" or "monitor:" counts (brain-health-monitor, backend-health-monitor…). */
export function isMonitorDetector(d: string): boolean {
  return /monitor/i.test(d)
}

/** Entries whose PRIMARY axis is `axis`. PURE. */
export function entriesForAxis(map: CoherenceEntry[], axis: CoherenceAxis): CoherenceEntry[] {
  return map.filter((e) => e.axis === axis)
}

/**
 * Is this entry HEALTHY for scoring purposes? PURE + the honesty pivot:
 *   - byDesign === true            → always healthy (a deliberate cold stance is not a defect).
 *   - wiringState === 'LIVE'       → healthy.
 *   - anything else (COLD / DEAD / WRITTEN_NEVER_READ / SHADOW / GAP, not byDesign) → a DEFECT.
 * (COLD_BY_DESIGN with byDesign=false would be an inconsistent entry; we treat only byDesign as the
 *  gate so the map author can't accidentally launder a defect via the state name alone.)
 */
export function isHealthy(e: CoherenceEntry): boolean {
  return e.byDesign || e.wiringState === 'LIVE'
}

/** The set of states that count as a hard "dead wiring" defect (only when NOT byDesign). */
const DEAD_WIRING_STATES: ReadonlySet<WiringState> = new Set<WiringState>(['DEAD', 'WRITTEN_NEVER_READ'])

// ──────────────────── axis scorers (each PURE, each unit-testable) ────────────

/**
 * WIRING — is every loop connected end-to-end?
 * - liveFraction = healthy (LIVE or byDesign) / total wiring-axis subsystems.
 * - deadWiring   = NON-byDesign DEAD + WRITTEN_NEVER_READ (dead code / dead data sinks).
 * - brokenChains = NON-byDesign GAP (a design edge with no code path).
 * Score = 100·liveFraction (byDesign entries never subtract).
 */
export function scoreWiring(map: CoherenceEntry[]): AxisReport {
  const es = entriesForAxis(map, 'wiring')
  const total = es.length
  const healthy = es.filter(isHealthy).length
  const liveFraction = pct(healthy, total)
  const deadWiring = es.filter((e) => !e.byDesign && DEAD_WIRING_STATES.has(e.wiringState)).length
  const brokenChains = es.filter((e) => !e.byDesign && e.wiringState === 'GAP').length
  const byDesignCold = es.filter((e) => e.byDesign).length

  const score = clamp(100 * liveFraction)
  return {
    score: round1(score),
    metrics: {
      subsystems: total,
      liveOrByDesign: healthy,
      liveFraction: round3(liveFraction),
      deadWiring,
      brokenChains,
      byDesignCold
    },
    notes: `${healthy}/${total} wired (or by-design); ${deadWiring} dead/written-never-read, ${brokenChains} broken chain(s); ${byDesignCold} cold-by-design (not counted)`
  }
}

/**
 * INTENT-FIDELITY — does code match design intent (no silent drift)?
 * - intentMatch = matching / total intent-axis subsystems. A match = healthy (LIVE or byDesign).
 * - driftFlags  = NON-byDesign, non-LIVE intent entries (default-off-better · threshold-inversion ·
 *   stale-anchor — the drift classes).
 * Score = 100·intentMatch.
 */
export function scoreIntentFidelity(map: CoherenceEntry[]): AxisReport {
  const es = entriesForAxis(map, 'intent')
  const total = es.length
  const matched = es.filter(isHealthy).length
  const intentMatch = pct(matched, total)
  const driftFlags = total - matched
  const byDesign = es.filter((e) => e.byDesign).length

  const score = clamp(100 * intentMatch)
  return {
    score: round1(score),
    metrics: {
      subsystems: total,
      intentMatched: matched,
      intentMatch: round3(intentMatch),
      driftFlags,
      byDesign
    },
    notes: `${matched}/${total} match design intent; ${driftFlags} drift flag(s); ${byDesign} deliberate gate(s)`
  }
}

/**
 * GUARDEDNESS — is each loop protected by a detector + a scheduled monitor? Measured across the
 * WHOLE map (guardedness is a system-wide property, not confined to the guarded-axis subsystems):
 * - detectorCoverage = subsystems with ≥1 detector / total.
 * - monitorCoverage  = subsystems with a *-monitor detector / total.
 * Score = 100·(0.6·detectorCoverage + 0.4·monitorCoverage). An empty-detector map subsystem lowers
 * it directly (that IS the `unguarded` lint finding).
 */
export function scoreGuardedness(map: CoherenceEntry[]): AxisReport {
  const total = map.length
  const withDetector = map.filter((e) => e.detectors.length > 0).length
  const withMonitor = map.filter((e) => e.detectors.some(isMonitorDetector)).length
  const detectorCoverage = pct(withDetector, total)
  const monitorCoverage = pct(withMonitor, total)
  const unguarded = total - withDetector

  const score = clamp(100 * (0.6 * detectorCoverage + 0.4 * monitorCoverage))
  return {
    score: round1(score),
    metrics: {
      subsystems: total,
      withDetector,
      detectorCoverage: round3(detectorCoverage),
      withMonitor,
      monitorCoverage: round3(monitorCoverage),
      unguarded
    },
    notes: `detector coverage ${withDetector}/${total} (${(detectorCoverage * 100).toFixed(0)}%); monitor coverage ${withMonitor}/${total} (${(monitorCoverage * 100).toFixed(0)}%); ${unguarded} unguarded`
  }
}

/** Weight of the map-fresh half of LIVENESS when at least one nested rollup is present. */
export const LIVENESS_MAP_WEIGHT = 0.5
/** Weight of the nested subsystem-benchmark rollup half of LIVENESS when rollups are present. */
export const LIVENESS_ROLLUP_WEIGHT = 0.5

/**
 * LIVENESS — are the loops actually turning (fresh) + are the nested benchmarks healthy?
 * - freshFraction = fresh (LIVE or byDesign) / total liveness-axis subsystems.
 * - frozenCount   = NON-byDesign, non-LIVE liveness entries (frozen/stuck/cold loops).
 * - nested rollups: the mean of the present {brain, backend, compounding} overalls (0-100).
 * Score = when ≥1 rollup present: LIVENESS_MAP_WEIGHT·(100·freshFraction) + LIVENESS_ROLLUP_WEIGHT·rollupMean;
 *         else just 100·freshFraction. A frozenLedger / benchmarkRegression lint finding applies a
 *         small documented penalty (advisory; the rollups + map are the primary signal).
 */
export function scoreLiveness(
  map: CoherenceEntry[],
  rollups: RollupDeps,
  lint?: LintSummary | null
): AxisReport {
  const es = entriesForAxis(map, 'liveness')
  const total = es.length
  const fresh = es.filter(isHealthy).length
  const freshFraction = pct(fresh, total)
  const frozenCount = total - fresh
  const mapFreshScore = clamp(100 * freshFraction)

  const present = [rollups.brain, rollups.compounding, rollups.backend].filter(
    (x): x is number => typeof x === 'number' && Number.isFinite(x)
  )
  const rollupMean = present.length > 0 ? present.reduce((a, b) => a + b, 0) / present.length : null

  let base: number
  if (rollupMean === null) {
    base = mapFreshScore
  } else {
    base = weightedAvg([
      { score: mapFreshScore, weight: LIVENESS_MAP_WEIGHT },
      { score: rollupMean, weight: LIVENESS_ROLLUP_WEIGHT }
    ])
  }

  // Advisory lint penalties — small, documented, capped. The map + rollups remain primary.
  const frozen = lint?.frozenLedgers ?? 0
  const regress = lint?.benchmarkRegressions ?? 0
  const penalty = Math.min(20, frozen * 5 + regress * 5)
  const score = clamp(base - penalty)

  return {
    score: round1(score),
    metrics: {
      subsystems: total,
      freshLoops: fresh,
      freshFraction: round3(freshFraction),
      frozenCount,
      rollupBrain: rollups.brain ?? -1,
      rollupBackend: rollups.backend ?? -1,
      rollupCompounding: rollups.compounding ?? -1,
      rollupMean: rollupMean === null ? -1 : round1(rollupMean),
      lintFrozenLedgers: frozen,
      lintBenchmarkRegressions: regress,
      penalty
    },
    notes: `${fresh}/${total} loops fresh; ${frozenCount} frozen/stuck; nested rollups {brain ${
      rollups.brain ?? '–'
    }, backend ${rollups.backend ?? '–'}, compounding ${rollups.compounding ?? '–'}}${
      rollupMean === null ? ' (none present)' : ` mean ${round1(rollupMean)}`
    }${penalty > 0 ? `; −${penalty} lint penalty (${frozen} frozen, ${regress} regressions)` : ''}`
  }
}

// ──────────────────── the pure benchmark ────────────────────

/**
 * Compute the 4-axis Coherence Health report from INJECTED deps. PURE + deterministic: no I/O, no
 * clock reads (report time is `deps.builtAt`). Every axis degrades gracefully on an empty map / absent
 * rollups (never throws) — an empty axis scores 0 with a "no subsystems" note.
 */
export function computeCoherenceHealth(deps: CoherenceHealthDeps): CoherenceHealth {
  const weights: AxisWeights = { ...DEFAULT_AXIS_WEIGHTS, ...(deps.weights ?? {}) }
  const map = deps.map ?? []

  const wiring = scoreWiring(map)
  const intentFidelity = scoreIntentFidelity(map)
  const guardedness = scoreGuardedness(map)
  const liveness = scoreLiveness(map, deps.rollups, deps.lint)

  const overall = weightedAvg([
    { score: wiring.score, weight: weights.wiring },
    { score: intentFidelity.score, weight: weights.intentFidelity },
    { score: guardedness.score, weight: weights.guardedness },
    { score: liveness.score, weight: weights.liveness }
  ])

  const axisScores: [string, number][] = [
    ['wiring', wiring.score],
    ['intentFidelity', intentFidelity.score],
    ['guardedness', guardedness.score],
    ['liveness', liveness.score]
  ]
  const weakestAxis = axisScores.reduce((min, cur) => (cur[1] < min[1] ? cur : min))[0]

  return {
    overall: round1(overall),
    weakestAxis,
    axes: { wiring, intentFidelity, guardedness, liveness },
    builtAt: deps.builtAt
  }
}

// ──────────────────── regression detector (PURE) ────────────────────

/** Overall score drop (vs prior report) that trips a WARN. */
export const OVERALL_DROP = 5
/** Per-axis score drop (vs prior report) that trips a WARN. */
export const AXIS_DROP = 10
/** Absolute floor: any axis below this WARNs regardless of history. Coherence starts well above this;
 *  a fall below it means a whole class of loops disconnected or a benchmark collapsed. */
export const AXIS_FLOOR = 25

const AXES = ['wiring', 'intentFidelity', 'guardedness', 'liveness'] as const
const EPS = 1e-9

/**
 * PURE: compare the current report against the PRIOR one → a (possibly empty) list of human-readable
 * regression messages. No I/O. `prev === null` ⇒ only the absolute floors can fire.
 *
 * Regressions (each ⇒ a WARN with before→after delta):
 *   - overall drops > OVERALL_DROP
 *   - any axis drops > AXIS_DROP
 *   - deadWiring RISES (a loop went dead / a store stopped being read)
 *   - driftFlags RISE (new silent drift)
 *   - frozenCount RISES (a live loop froze)
 * Plus history-independent absolute floors: any axis < AXIS_FLOOR.
 */
export function detectCoherenceRegression(
  prev: CoherenceHealth | null,
  curr: CoherenceHealth
): string[] {
  const out: string[] = []

  for (const name of AXES) {
    const s = curr.axes[name].score
    if (s < AXIS_FLOOR) out.push(`FLOOR: ${name} axis ${round1(s)} < ${AXIS_FLOOR}`)
  }
  if (curr.overall < AXIS_FLOOR) out.push(`FLOOR: overall ${round1(curr.overall)} < ${AXIS_FLOOR}`)

  if (!prev) return out

  if (prev.overall - curr.overall > OVERALL_DROP + EPS) {
    out.push(`overall dropped ${round1(prev.overall)}→${round1(curr.overall)} (Δ${round1(curr.overall - prev.overall)})`)
  }
  for (const name of AXES) {
    const a = prev.axes[name].score
    const b = curr.axes[name].score
    if (a - b > AXIS_DROP + EPS) out.push(`${name} axis dropped ${round1(a)}→${round1(b)} (Δ${round1(b - a)})`)
  }

  const pDead = Number(prev.axes.wiring.metrics.deadWiring ?? 0)
  const cDead = Number(curr.axes.wiring.metrics.deadWiring ?? 0)
  if (cDead > pDead) out.push(`deadWiring rose ${pDead}→${cDead} (+${cDead - pDead}, a loop went dead)`)

  const pDrift = Number(prev.axes.intentFidelity.metrics.driftFlags ?? 0)
  const cDrift = Number(curr.axes.intentFidelity.metrics.driftFlags ?? 0)
  if (cDrift > pDrift) out.push(`driftFlags rose ${pDrift}→${cDrift} (+${cDrift - pDrift}, new silent drift)`)

  const pFrozen = Number(prev.axes.liveness.metrics.frozenCount ?? 0)
  const cFrozen = Number(curr.axes.liveness.metrics.frozenCount ?? 0)
  if (cFrozen > pFrozen) out.push(`frozenCount rose ${pFrozen}→${cFrozen} (+${cFrozen - pFrozen}, a live loop froze)`)

  return out
}
