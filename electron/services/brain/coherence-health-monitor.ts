// Coherence Health MONITOR — makes the APEX meta-benchmark (coherence-health.ts) self-policing on a
// CLOCK, exactly the way brain-health-monitor.ts / backend-health-monitor.ts make their subsystem
// benchmarks self-policing. Before this, computeCoherenceHealthLive was manual-curl-only (one caller:
// GET /debug/coherence-health), so a whole class of loops could disconnect — or a nested subsystem
// benchmark collapse — and the system emitted ZERO signal until a human looked.
//
// THIS module IS the "learning-liveness monitor" the Coherence Map itself flagged as its highest-
// leverage GAP ("coldness is invisible to the system"): a scheduled instrument that notices when the
// compounding/learning loops stop turning. It runs the coherence benchmark on a clock, records a
// compact history line to `.duin/_state/coherence-health-history.jsonl` (the ledger the LIVENESS-axis
// rollups read), and WARNs on any regression vs the prior run via the PURE detectCoherenceRegression.
//
// Shape copied deliberately from the two sibling monitors: a thin, FAILURE-ISOLATED I/O wrapper
// (runCoherenceHealthMonitor) whose ENTIRE body is try/caught so a monitor error can NEVER break or
// delay the app, over a PURE core (detectCoherenceRegression, imported read-only from coherence-health).
// The live compute is behind an injection seam (compute) so tests pass a pure/mock report and never
// touch fs — the default is the import-clean live gatherer (no Electron / better-sqlite3 dependency).

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { messageOf } from '../guarded'
import {
  detectCoherenceRegression,
  type CoherenceHealth
} from './coherence-health'
import { computeCoherenceHealthLive } from './coherence-health-live'

// ──────────────────── ledger schema ────────────────────

/** One compact history line per monitor run. Mirrors the `.duin/_state/` jsonl-ledger convention
 *  (brain-health-history.jsonl / backend-health-history.jsonl): flat + small so a long-lived install
 *  accumulates a cheap, greppable time-series. Carries the overall + the 4 axis scores + weakestAxis,
 *  the headline sub-metrics (liveFraction / detectorCoverage / monitorCoverage / frozenCount), plus the
 *  two regression-input counts (deadWiring / driftFlags) so the PURE regression detector can be replayed
 *  against the prior line without persisting the whole (verbose) CoherenceHealth report. */
export interface CoherenceHealthLedgerEntry {
  /** ISO timestamp of the benchmark run (the report's builtAt). */
  ts: string
  /** Weighted overall score (0-100). */
  overall: number
  /** Per-axis scores (0-100). */
  axes: { wiring: number; intentFidelity: number; guardedness: number; liveness: number }
  /** Name of the lowest-scoring axis. */
  weakestAxis: string
  /** WIRING: healthy (LIVE|byDesign) / total wiring subsystems. */
  liveFraction: number
  /** WIRING: NON-byDesign dead + written-never-read count (regression input). */
  deadWiring: number
  /** INTENT: NON-byDesign, non-LIVE intent entries (regression input). */
  driftFlags: number
  /** GUARDEDNESS: subsystems with ≥1 detector / total. */
  detectorCoverage: number
  /** GUARDEDNESS: subsystems with a *-monitor detector / total (the learning-liveness signal). */
  monitorCoverage: number
  /** LIVENESS: NON-byDesign, non-LIVE liveness entries (frozen loops; regression input). */
  frozenCount: number
}

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0)

/** PURE: project a full CoherenceHealth report onto the compact ledger entry. */
export function toLedgerEntry(report: CoherenceHealth): CoherenceHealthLedgerEntry {
  const w = report.axes.wiring.metrics
  const i = report.axes.intentFidelity.metrics
  const g = report.axes.guardedness.metrics
  const l = report.axes.liveness.metrics
  return {
    ts: report.builtAt,
    overall: report.overall,
    axes: {
      wiring: report.axes.wiring.score,
      intentFidelity: report.axes.intentFidelity.score,
      guardedness: report.axes.guardedness.score,
      liveness: report.axes.liveness.score
    },
    weakestAxis: report.weakestAxis,
    liveFraction: num(w.liveFraction),
    deadWiring: num(w.deadWiring),
    driftFlags: num(i.driftFlags),
    detectorCoverage: num(g.detectorCoverage),
    monitorCoverage: num(g.monitorCoverage),
    frozenCount: num(l.frozenCount)
  }
}

/** PURE: rebuild the minimal CoherenceHealth shape detectCoherenceRegression reads from a stored ledger
 *  entry (overall + axis scores + the deadWiring/driftFlags/frozenCount metrics it compares). Notes are
 *  irrelevant to the detector, so they're empty; every other metric defaults to 0 via the detector's own
 *  `?? 0`. Lets the PURE detector be replayed against the compact prior line. */
export function ledgerEntryToHealth(e: CoherenceHealthLedgerEntry): CoherenceHealth {
  return {
    overall: e.overall,
    weakestAxis: e.weakestAxis,
    builtAt: e.ts,
    axes: {
      wiring: { score: e.axes.wiring, metrics: { liveFraction: e.liveFraction, deadWiring: e.deadWiring }, notes: '' },
      intentFidelity: { score: e.axes.intentFidelity, metrics: { driftFlags: e.driftFlags }, notes: '' },
      guardedness: {
        score: e.axes.guardedness,
        metrics: { detectorCoverage: e.detectorCoverage, monitorCoverage: e.monitorCoverage },
        notes: ''
      },
      liveness: { score: e.axes.liveness, metrics: { frozenCount: e.frozenCount }, notes: '' }
    }
  }
}

const r1 = (x: number): number => Math.round(x * 10) / 10

// ──────────────────── ledger I/O (best-effort, isolated) ────────────────────

/** History ledger path — same `.duin/_state/` dir the sibling health ledgers use. Null when there is no
 *  vault (nothing to persist against). The LIVENESS-axis rollup gatherers read this file. */
export function historyPath(vault: string | null | undefined): string | null {
  const dir = typeof vault === 'string' ? vault.trim() : ''
  if (!dir) return null
  return join(dir, '.duin', '_state', 'coherence-health-history.jsonl')
}

/** Retain the most recent entries so a long-lived install can't grow the ledger (or its O(n) rewrite)
 *  unbounded — mirrors the sibling monitors' cap. */
const MAX_HISTORY_ENTRIES = 5000

/** Read the raw (non-empty) lines of the ledger, or [] when absent/unreadable. */
function readRawLines(vault: string | null | undefined): string[] {
  const p = historyPath(vault)
  if (!p || !existsSync(p)) return []
  try {
    return readFileSync(p, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean)
  } catch (e) {
    console.debug('[coherence-health] history unreadable:', messageOf(e))
    return []
  }
}

/** The PRIOR (most-recent) ledger entry, or null when none / unparseable. */
export function readLastEntry(vault: string | null | undefined): CoherenceHealthLedgerEntry | null {
  const lines = readRawLines(vault)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as CoherenceHealthLedgerEntry
    } catch (e) {
      console.debug('[coherence-health] skip a corrupt history line:', messageOf(e))
    }
  }
  return null
}

/** Append one entry (atomic whole-file rewrite, capped). No-op when no vault. */
export function appendEntry(vault: string | null | undefined, entry: CoherenceHealthLedgerEntry): void {
  const p = historyPath(vault)
  if (!p) return
  const lines = readRawLines(vault)
  lines.push(JSON.stringify(entry))
  const capped = lines.length > MAX_HISTORY_ENTRIES ? lines.slice(-MAX_HISTORY_ENTRIES) : lines
  mkdirSync(dirname(p), { recursive: true })
  const body = capped.join('\n') + '\n'
  const tmp = p + '.tmp'
  writeFileSync(tmp, body, 'utf-8')
  renameSync(tmp, p)
}

// ──────────────────── flag gate + the fire-and-forget wrapper ────────────────────

/** Default-ON; opt-OUT via DUIN_COHERENCE_HEALTH_MONITOR=0 (matches the `!== '0'` polarity of
 *  DUIN_BRAIN_HEALTH_MONITOR / DUIN_BACKEND_HEALTH_MONITOR). */
export function coherenceHealthMonitorEnabled(): boolean {
  return process.env.DUIN_COHERENCE_HEALTH_MONITOR !== '0'
}

/** Injection seam: the default is the import-clean live gatherer; tests pass a pure/mock report. */
export type ComputeCoherence = (vault: string | null) => CoherenceHealth | Promise<CoherenceHealth>

/**
 * Run the Coherence Health benchmark on a clock: compute the live report, WARN on any regression vs the
 * prior run, and append a compact history line.
 *
 * FAILURE-ISOLATED + NON-BLOCKING: the entire body is wrapped in try/catch, so a monitor error (or a
 * throwing compute) is swallowed and can NEVER break or delay the app. Call it fire-and-forget
 * (`void runCoherenceHealthMonitor(deps)`). Flag-gated: DUIN_COHERENCE_HEALTH_MONITOR=0 ⇒ immediate
 * no-op (no compute, no ledger write).
 */
export async function runCoherenceHealthMonitor(
  deps: { vaultDir: string | null },
  compute?: ComputeCoherence
): Promise<void> {
  try {
    if (!coherenceHealthMonitorEnabled()) return
    const fn: ComputeCoherence = compute ?? ((v) => computeCoherenceHealthLive(v))
    const report = await fn(deps.vaultDir)
    const curr = toLedgerEntry(report)
    const prevEntry = readLastEntry(deps.vaultDir)
    const prev = prevEntry ? ledgerEntryToHealth(prevEntry) : null

    const regressions = detectCoherenceRegression(prev, report)
    if (regressions.length > 0) {
      console.warn(
        `[coherence-health] ${regressions.length} regression(s) on check (overall ${r1(curr.overall)}` +
          `${prev ? ` vs prior ${r1(prev.overall)}` : ', first check'}):`
      )
      for (const msg of regressions) console.warn(`[coherence-health]   - ${msg}`)
      // ALERT SURFACE (MVP): the tagged console.warn above + the history ledger + the existing
      // GET /debug/coherence-health route are the signal. A richer in-app toast is a deliberate
      // follow-on (would need renderer wiring outside this phase's file ownership).
    } else {
      console.log(
        `[coherence-health] check OK — overall ${r1(curr.overall)}, weakest ${curr.weakestAxis} ` +
          `(monitor coverage ${(curr.monitorCoverage * 100).toFixed(0)}%)`
      )
    }

    appendEntry(deps.vaultDir, curr)
  } catch (e) {
    // Swallow — the monitor is advisory only; the app must be unaffected.
    console.warn('[coherence-health] monitor error (app unaffected):', messageOf(e))
  }
}
