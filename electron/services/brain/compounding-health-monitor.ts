// Compounding Health MONITOR — closes the gap the Coherence Map flagged at
// coherence-map.ts: computeCompoundingHealth had a live route (GET /debug/
// compounding-health) but NO scheduled/triggered writer, so
// `compounding-health-history.jsonl` never existed. Two things stayed broken as a
// result: (1) the Coherence Health LIVENESS rollup reads the compounding overall
// from that ledger, so it stayed null (compounding contributed nothing to the
// meta-benchmark), and (2) six liveness/intent loops whose only guard is a
// `compounding-health:*` metric had no runtime instrument actually recomputing it.
//
// This module makes the compounding benchmark SELF-POLICING: it recomputes the live
// report, WARNs on regression vs the prior run, and appends the history line the
// rollup + this project's ledger convention expect. Triggered on the metabolism
// loop's own event (consolidation completion) AND refreshed on the coherence daily
// tick so the rollup it feeds is never stale.
//
// Same PURE-core + FAILURE-ISOLATED-I/O split as brain-health-monitor.ts: the pure
// detectRegression / toLedgerEntry are unit-tested against fixtures with no Electron
// ABI; the wrapper lazily imports computeCompoundingHealthLive and swallows every
// error so a monitor fault can never break consolidation or the coherence tick.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { messageOf } from '../guarded'
import type { CompoundingHealth } from './compounding-health'

// ──────────────────── ledger schema ────────────────────

const AXES = ['stability', 'metabolism', 'compounding', 'grounding'] as const
type AxisName = (typeof AXES)[number]

/** One compact history line per run. `overall` is TOP-LEVEL because coherence-health
 *  reads it directly (coherence-health-live.ts: readLastJsonl(...).overall). */
export interface CompoundingLedgerEntry {
  ts: string
  overall: number
  axes: Record<AxisName, number>
  weakestAxis: string
  /** How many axes had no input to judge — a rising count is itself a data regression. */
  unmeasuredCount: number
}

/** PURE: project a full CompoundingHealth report onto the compact ledger entry. */
export function toLedgerEntry(report: CompoundingHealth): CompoundingLedgerEntry {
  return {
    ts: report.builtAt,
    overall: report.overall,
    axes: {
      stability: report.axes.stability.score,
      metabolism: report.axes.metabolism.score,
      compounding: report.axes.compounding.score,
      grounding: report.axes.grounding.score
    },
    weakestAxis: report.weakestAxis,
    unmeasuredCount: Array.isArray(report.unmeasuredAxes) ? report.unmeasuredAxes.length : 0
  }
}

// ──────────────────── regression thresholds ────────────────────

/** Overall score drop (vs prior run) that trips a WARN. */
export const OVERALL_DROP = 5
/** Per-axis score drop (vs prior run) that trips a WARN. */
export const AXIS_DROP = 10
/** Absolute floor: any MEASURED axis below this WARNs regardless of history. A 0-score
 *  axis that is simply unmeasured (no input yet) must NOT floor-trip — that's cold-start,
 *  not a defect — so the floor check skips axes at exactly 0 with a rising unmeasuredCount. */
export const AXIS_FLOOR = 25

const r1 = (x: number): number => Math.round(x * 10) / 10
const EPS = 1e-9

/**
 * PURE: compare the current run against the PRIOR ledger entry → human-readable
 * regression messages. No I/O.
 *
 * Regressions (each ⇒ a WARN with before→after delta):
 *   - overall drops > OVERALL_DROP
 *   - any axis drops > AXIS_DROP
 *   - unmeasuredCount RISES (a previously-measured axis lost its input — data starving,
 *     the exact failure mode behind the value-core cold-map: a loop going dark reads as
 *     "neutral" unless we flag the measurement itself regressing)
 * Plus a history-independent absolute floor: any axis < AXIS_FLOOR (but not an
 * unmeasured 0). `prev === null` (first-ever run) ⇒ only the floor can fire.
 */
export function detectRegression(
  prev: CompoundingLedgerEntry | null,
  curr: CompoundingLedgerEntry
): string[] {
  const out: string[] = []

  // Absolute floor — independent of history. Skip an axis sitting at exactly 0 while
  // unmeasuredCount is non-zero (cold-start neutral, not a real collapse).
  for (const name of AXES) {
    const s = curr.axes[name]
    if (s < AXIS_FLOOR && !(s === 0 && curr.unmeasuredCount > 0)) {
      out.push(`FLOOR: ${name} axis ${r1(s)} < ${AXIS_FLOOR}`)
    }
  }

  if (!prev) return out

  if (prev.overall - curr.overall > OVERALL_DROP + EPS) {
    out.push(`overall dropped ${r1(prev.overall)}→${r1(curr.overall)} (Δ${r1(curr.overall - prev.overall)})`)
  }
  for (const name of AXES) {
    const a = prev.axes[name]
    const b = curr.axes[name]
    if (a - b > AXIS_DROP + EPS) out.push(`${name} axis dropped ${r1(a)}→${r1(b)} (Δ${r1(b - a)})`)
  }
  if (curr.unmeasuredCount > prev.unmeasuredCount) {
    out.push(
      `unmeasuredAxes rose ${prev.unmeasuredCount}→${curr.unmeasuredCount} (a measured axis lost its input — loop going dark)`
    )
  }
  return out
}

// ──────────────────── ledger I/O (best-effort, isolated) ────────────────────

/** History ledger path — the file the coherence rollup + this convention expect.
 *  Null when no vault. */
export function historyPath(vault: string | null | undefined): string | null {
  const dir = typeof vault === 'string' ? vault.trim() : ''
  if (!dir) return null
  return join(dir, '.duin', '_state', 'compounding-health-history.jsonl')
}

const MAX_HISTORY_ENTRIES = 5000

function readRawLines(vault: string | null | undefined): string[] {
  const p = historyPath(vault)
  if (!p || !existsSync(p)) return []
  try {
    return readFileSync(p, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean)
  } catch (e) {
    console.debug('[compounding-health] history unreadable:', messageOf(e))
    return []
  }
}

/** The PRIOR (most-recent) ledger entry, or null when none / unparseable. */
export function readLastEntry(vault: string | null | undefined): CompoundingLedgerEntry | null {
  const lines = readRawLines(vault)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as CompoundingLedgerEntry
    } catch (e) {
      console.debug('[compounding-health] skip a corrupt history line:', messageOf(e))
    }
  }
  return null
}

/** Append one entry (atomic whole-file rewrite, capped). No-op when no vault. */
export function appendEntry(vault: string | null | undefined, entry: CompoundingLedgerEntry): void {
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

/** Default-ON; opt-OUT via DUIN_COMPOUNDING_HEALTH_MONITOR=0 (matches the other
 *  DUIN monitor flags' `!== '0'` polarity). */
export function compoundingHealthMonitorEnabled(): boolean {
  return process.env.DUIN_COMPOUNDING_HEALTH_MONITOR !== '0'
}

/** Injection seam: the live compute needs the Electron better-sqlite3 ABI, so the
 *  default is lazily imported (keeps this module import-clean + vitest-safe); tests
 *  pass a pure mock. */
export type ComputeCompounding = (vault: string | null) => CompoundingHealth | Promise<CompoundingHealth>

/**
 * Recompute the compounding benchmark, WARN on any regression vs the prior run, and
 * append a history line (which feeds the Coherence Health compounding rollup).
 *
 * FAILURE-ISOLATED + NON-BLOCKING: the entire body is try/caught, so a monitor error
 * (or computeCompoundingHealthLive throwing) is swallowed and can never break or
 * delay the caller (consolidation / the coherence tick). Call fire-and-forget.
 * Flag-gated: DUIN_COMPOUNDING_HEALTH_MONITOR=0 ⇒ immediate no-op.
 */
export async function runCompoundingHealthMonitor(
  vault: string | null,
  compute?: ComputeCompounding
): Promise<void> {
  try {
    if (!compoundingHealthMonitorEnabled()) return
    const fn: ComputeCompounding =
      compute ?? (async (v) => (await import('./compounding-health-live')).computeCompoundingHealthLive(v))
    const report = await fn(vault)
    const curr = toLedgerEntry(report)
    const prev = readLastEntry(vault)

    const regressions = detectRegression(prev, curr)
    if (regressions.length > 0) {
      console.warn(
        `[compounding-health] ${regressions.length} regression(s) (overall ${r1(curr.overall)}` +
          `${prev ? ` vs prior ${r1(prev.overall)}` : ', first run'}):`
      )
      for (const msg of regressions) console.warn(`[compounding-health]   - ${msg}`)
    } else {
      console.log(
        `[compounding-health] OK — overall ${r1(curr.overall)}, weakest ${curr.weakestAxis}` +
          `${curr.unmeasuredCount ? `, ${curr.unmeasuredCount} unmeasured` : ''}`
      )
    }

    appendEntry(vault, curr)
  } catch (e) {
    // Swallow — advisory only; the caller (consolidation / coherence tick) is unaffected.
    console.warn('[compounding-health] monitor error (caller unaffected):', messageOf(e))
  }
}
