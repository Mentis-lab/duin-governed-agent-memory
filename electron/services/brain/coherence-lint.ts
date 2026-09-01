// COHERENCE LINT — the deterministic "code backbone" (DUIN_COHERENCE_HEALTH.md §3). Most gaps this
// session were detectable WITHOUT an LLM; this module encodes the cheap, high-value ones as PURE
// detectors so each run they're free, complete, and reliable — agents spend tokens only on judgment
// (cold-by-design vs defect). Each detector returns CANDIDATE findings that FEED the Coherence Map /
// the LIVENESS+GUARDEDNESS axes; they are NOT auto-applied to the map.
//
// v1 subset (the proven, cheapest detectors from the §3 catalog):
//   - dead-export        an exported fn/const with no non-test caller anywhere in electron/ (grep-based).
//   - frozen-ledger      a `.duin/_state/*.jsonl` whose mtime is stale vs its siblings (loop frozen).
//   - unguarded          a Coherence Map subsystem with an empty detector list.
//   - benchmark-regression  a nested-benchmark overall that dropped vs the prior history entry.
//
// DESIGN: the DETECTORS are pure (take injected inputs, return findings) so they unit-test against
// fixtures with zero I/O. A thin best-effort I/O wrapper (runCoherenceLint) gathers the inputs from
// the running app; its entire body is try/caught so a lint error can never break a caller.
//
// PRECISION NOTES are load-bearing and documented per-detector — v1 dead-export is a grep heuristic
// (medium precision), the others are exact.

import type { CoherenceEntry } from './coherence-map'

// ──────────────────── finding shape ────────────────────

export type CoherenceDetector = 'dead-export' | 'frozen-ledger' | 'unguarded' | 'benchmark-regression'

export interface CoherenceFinding {
  detector: CoherenceDetector
  /** The subject: a symbol name, a ledger filename, a subsystem, or a benchmark axis. */
  subject: string
  /** Human-readable detail. */
  detail: string
  /** 'exact' = deterministic no-false-positive; 'heuristic' = best-effort, may over/under-report. */
  precision: 'exact' | 'heuristic'
}

/** Compact per-detector counts (what the LintSummary in coherence-health.ts consumes). */
export interface CoherenceLintReport {
  findings: CoherenceFinding[]
  summary: {
    deadExports: number
    frozenLedgers: number
    unguarded: number
    benchmarkRegressions: number
  }
}

// ──────────────────── detector 1: dead-export (heuristic) ────────────────────

/** A source file for the pure dead-export detector: its path + full text. */
export interface SourceFile {
  path: string
  content: string
}

/** Matches `export function NAME` and `export const NAME =` / `export async function NAME`. We only
 *  consider function-ish exports (const arrow/fn) — the class the §3 catalog targets. Types/interfaces
 *  are excluded (no runtime caller to find). */
const EXPORT_RE = /export\s+(?:async\s+)?(?:function\s+([A-Za-z0-9_$]+)|const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>)/g

/** Is this path a test/spec file (excluded as a "caller" — a symbol used only by its own test is dead). */
export function isTestPath(path: string): boolean {
  return /\.(test|spec)\.[tj]sx?$/.test(path) || /[\\/]__tests__[\\/]/.test(path)
}

/** Count non-test occurrences of `name` as a standalone identifier across `files`, EXCLUDING the
 *  single export site. Word-boundary match (best-effort; no AST). PURE.
 *
 *  Exported because `coherence-map-claims.test.ts` cross-checks the map's hand-typed `wiringState`
 *  against this same computation. That check and the dead-export detector must agree by
 *  construction — two implementations of "is this called?" would be the exact drift this module
 *  exists to catch. */
export function countNonTestReferences(
  name: string,
  exportFilePath: string,
  files: SourceFile[]
): number {
  const idRe = new RegExp(`\\b${name}\\b`, 'g')
  let refs = 0
  for (const f of files) {
    if (isTestPath(f.path)) continue
    const matches = f.content.match(idRe)
    if (!matches) continue
    // On the file that DECLARES the export, one occurrence is the declaration itself — discount it.
    refs += f.path === exportFilePath ? Math.max(0, matches.length - 1) : matches.length
  }
  return refs
}

/**
 * DEAD-EXPORT (heuristic, WIRING): find exported functions/const-arrows with ZERO non-test references
 * anywhere in the provided source set (outside their own declaration). PURE.
 *
 * PRECISION = heuristic. It is grep-based (no AST), so it can:
 *   - FALSE-POSITIVE on symbols reached only via dynamic dispatch, re-export barrels, string keys, or
 *     reflection (they look uncalled but aren't).
 *   - FALSE-NEGATIVE on a symbol "referenced" only inside a comment or a same-named unrelated identifier.
 * So findings are CANDIDATES for human/agent adjudication, never auto-applied. It correctly ignores
 * test-only callers (a symbol used solely by its own test IS dead for production purposes).
 */
export function findDeadExports(files: SourceFile[]): CoherenceFinding[] {
  const out: CoherenceFinding[] = []
  for (const f of files) {
    if (isTestPath(f.path)) continue // don't hunt exports that live only in test files
    EXPORT_RE.lastIndex = 0
    let m: RegExpExecArray | null
    const seen = new Set<string>()
    while ((m = EXPORT_RE.exec(f.content)) !== null) {
      const name = m[1] ?? m[2]
      if (!name || seen.has(name)) continue
      seen.add(name)
      const refs = countNonTestReferences(name, f.path, files)
      if (refs === 0) {
        out.push({
          detector: 'dead-export',
          subject: name,
          detail: `exported '${name}' in ${f.path} has no non-test caller across the scanned source set`,
          precision: 'heuristic'
        })
      }
    }
  }
  return out
}

// ──────────────────── detector 2: frozen-ledger (exact-ish) ────────────────────

/** A ledger file for the frozen-ledger detector: its name + mtime (ms). */
export interface LedgerStat {
  name: string
  mtimeMs: number
}

/** How much staler than the FRESHEST sibling a ledger must be (hours) to be flagged frozen. */
export const FROZEN_LEDGER_STALE_HOURS = 24

/**
 * FROZEN-LEDGER (LIVENESS): among a set of sibling ledgers written by loops that SHOULD advance
 * together, flag any whose mtime lags the freshest sibling by more than FROZEN_LEDGER_STALE_HOURS.
 * The freshest ledger proves the app was recently active, so a lagging sibling is a stalled loop
 * (this is exactly how the 2-day claim-ledger freeze would have been caught). PURE — mtimes + now
 * are injected; the detector never stats the filesystem.
 *
 * PRECISION = heuristic-but-tight: a genuinely low-frequency ledger (writes < daily by design) could
 * false-positive, so the caller should pass only ledgers expected to co-advance (claim / brain-health /
 * backend-health / construction). The gap vs the freshest sibling (not vs `now`) avoids flagging a
 * whole idle app as frozen.
 */
export function findFrozenLedgers(
  ledgers: LedgerStat[],
  nowMs: number,
  staleHours = FROZEN_LEDGER_STALE_HOURS
): CoherenceFinding[] {
  const out: CoherenceFinding[] = []
  const present = ledgers.filter((l) => Number.isFinite(l.mtimeMs))
  if (present.length < 2) return out // need a sibling to compare against
  const freshest = Math.max(...present.map((l) => l.mtimeMs))
  const staleMs = staleHours * 3_600_000
  for (const l of present) {
    const lagMs = freshest - l.mtimeMs
    if (lagMs > staleMs) {
      out.push({
        detector: 'frozen-ledger',
        subject: l.name,
        detail: `${l.name} lags the freshest sibling by ${(lagMs / 3_600_000).toFixed(1)}h (> ${staleHours}h) — loop likely frozen`,
        precision: 'heuristic'
      })
    }
  }
  return out
}

// ──────────────────── detector 3: unguarded (exact) ────────────────────

/**
 * UNGUARDED (GUARDEDNESS): a Coherence Map subsystem with an empty detector list has no deterministic
 * check protecting it. PURE + EXACT (a direct property read over the map). These are the subsystems
 * that most need a new detector minted (the §3 "every verified gap mints a detector" growth path).
 */
export function findUnguarded(map: CoherenceEntry[]): CoherenceFinding[] {
  return map
    .filter((e) => e.detectors.length === 0)
    .map((e) => ({
      detector: 'unguarded' as const,
      subject: e.subsystem,
      detail: `subsystem '${e.subsystem}' (axis ${e.axis}, state ${e.wiringState}) has no guarding detector`,
      precision: 'exact' as const
    }))
}

// ──────────────────── detector 4: benchmark-regression (exact) ────────────────────

/** A nested-benchmark history slice: its name + the last two overall scores (prev, curr). */
export interface BenchmarkSlice {
  name: string
  prevOverall: number | null
  currOverall: number | null
}

/** Overall drop (points) between the last two entries that trips a regression finding. */
export const BENCHMARK_DROP = 5

/**
 * BENCHMARK-REGRESSION (LIVENESS): a nested subsystem-benchmark whose latest overall dropped by more
 * than BENCHMARK_DROP vs the prior history entry. PURE + EXACT over the injected pair. A null prev/curr
 * (only one entry, or absent ledger) yields no finding — a regression needs two points to compare.
 */
export function findBenchmarkRegressions(slices: BenchmarkSlice[]): CoherenceFinding[] {
  const out: CoherenceFinding[] = []
  for (const s of slices) {
    if (s.prevOverall === null || s.currOverall === null) continue
    if (!Number.isFinite(s.prevOverall) || !Number.isFinite(s.currOverall)) continue
    const drop = s.prevOverall - s.currOverall
    if (drop > BENCHMARK_DROP) {
      out.push({
        detector: 'benchmark-regression',
        subject: s.name,
        detail: `${s.name} overall dropped ${s.prevOverall}→${s.currOverall} (Δ−${drop.toFixed(1)} > ${BENCHMARK_DROP})`,
        precision: 'exact'
      })
    }
  }
  return out
}

// ──────────────────── aggregation ────────────────────

/** Inputs for a full pure lint pass (all injected — no I/O). */
export interface CoherenceLintInput {
  map: CoherenceEntry[]
  sources?: SourceFile[]
  ledgers?: LedgerStat[]
  nowMs?: number
  benchmarks?: BenchmarkSlice[]
}

/**
 * PURE aggregate: run every v1 detector over injected inputs and roll them into a CoherenceLintReport.
 * dead-export/frozen-ledger/benchmark-regression are skipped when their inputs are absent (so a
 * map-only call still yields the exact `unguarded` findings). The `summary` counts feed directly into
 * coherence-health.ts's LintSummary.
 */
export function lintCoherence(input: CoherenceLintInput): CoherenceLintReport {
  const findings: CoherenceFinding[] = []
  if (input.sources && input.sources.length) findings.push(...findDeadExports(input.sources))
  if (input.ledgers && input.ledgers.length) {
    findings.push(...findFrozenLedgers(input.ledgers, input.nowMs ?? Date.now()))
  }
  findings.push(...findUnguarded(input.map))
  if (input.benchmarks && input.benchmarks.length) {
    findings.push(...findBenchmarkRegressions(input.benchmarks))
  }
  const summary = {
    deadExports: findings.filter((f) => f.detector === 'dead-export').length,
    frozenLedgers: findings.filter((f) => f.detector === 'frozen-ledger').length,
    unguarded: findings.filter((f) => f.detector === 'unguarded').length,
    benchmarkRegressions: findings.filter((f) => f.detector === 'benchmark-regression').length
  }
  return { findings, summary }
}
