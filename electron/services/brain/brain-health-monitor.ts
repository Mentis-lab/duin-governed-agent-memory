// Brain Health MONITOR (identity-spine P7b) — makes the 4-axis Brain Health
// benchmark SELF-POLICING. Before this, computeBrainHealthLive was manual-curl-only
// (one caller: GET /debug/brain-health), so a construction rebuild that regressed
// coherence/purity/dedup/orphans emitted ZERO signal until a human looked. This
// module runs the benchmark automatically on each completed construction rebuild,
// records a compact history line, and WARNs on regression vs the prior rebuild.
//
// Split into a PURE core (detectRegression / toLedgerEntry — no I/O, no Electron,
// unit-tested against fixtures) and a thin, FAILURE-ISOLATED I/O wrapper
// (runBrainHealthMonitor) wired at the rebuild-completion point in construct.ts.
// The wrapper lazily imports computeBrainHealthLive (which needs the Electron
// better-sqlite3 ABI) so this module stays import-clean and vitest-safe; tests
// inject a mock compute and never touch Electron. The whole wrapper is wrapped in
// try/catch — a monitor error can NEVER break or delay the rebuild.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { messageOf } from '../guarded'
import type { BrainHealthReport } from './brain-health'

// ──────────────────── ledger schema ────────────────────

/** One compact history line per completed rebuild. Mirrors the `.duin/_state/`
 *  jsonl-ledger convention (claim-ledger.jsonl etc.). Deliberately flat + small
 *  so a long-lived install accumulates a cheap, greppable time-series. */
export interface HealthLedgerEntry {
  /** ISO timestamp of the benchmark run (the report's builtAt). */
  ts: string
  /** Weighted overall score (0-100). */
  overall: number
  /** Per-axis scores (0-100). */
  axes: { coherence: number; grounding: number; freshness: number; purity: number }
  /** Coherence sub-metrics that carry the identity-spine invariants directly. */
  componentCount: number
  dedupRate: number
  entityNoteConnectivity: number
  totalEntities: number
}

/** PURE: project a full BrainHealthReport onto the compact ledger entry. */
export function toLedgerEntry(report: BrainHealthReport): HealthLedgerEntry {
  const m = report.axes.coherence.metrics
  return {
    ts: report.builtAt,
    overall: report.overall,
    axes: {
      coherence: report.axes.coherence.score,
      grounding: report.axes.grounding.score,
      freshness: report.axes.freshness.score,
      purity: report.axes.purity.score
    },
    componentCount: Number(m.componentCount ?? 0),
    dedupRate: Number(m.dedupRate ?? 0),
    entityNoteConnectivity: Number(m.entityNoteConnectivity ?? 0),
    totalEntities: Number(m.totalEntities ?? 0)
  }
}

// ──────────────────── regression thresholds ────────────────────

/** Overall score drop (vs prior rebuild) that trips a WARN. */
export const OVERALL_DROP = 5
/** Per-axis score drop (vs prior rebuild) that trips a WARN. */
export const AXIS_DROP = 10
/** entityNoteConnectivity drop (0-1 fraction) that trips a WARN (orphans returning). */
export const CONNECTIVITY_DROP = 0.1
/** totalEntities drop FRACTION (vs prior rebuild) that trips a WARN. A construction COLLAPSE
 *  (degraded/flaky extraction dropping batches → 260→44 entities) shrinks the graph; without this
 *  the monitor was BLIND to it — a smaller graph scores cleaner, so the collapse read as an
 *  IMPROVEMENT (overall ROSE 92.5→95.4). >30% drop now trips a regression WARN. */
export const ENTITY_DROP = 0.3
/** Absolute floor: any axis below this WARNs regardless of history. */
export const AXIS_FLOOR = 40

const AXES = ['coherence', 'grounding', 'freshness', 'purity'] as const
const r1 = (x: number): number => Math.round(x * 10) / 10
const r3 = (x: number): number => Math.round(x * 1000) / 1000
// Scores/rates are pre-ROUNDED (r1 / r3), so a delta at EXACTLY the threshold must not
// trip on IEEE-754 subtraction noise (e.g. 0.8 - 0.7 === 0.10000000000000009). Compare
// against threshold + EPS so only a genuine excess fires.
const EPS = 1e-9

/**
 * PURE: compare the current rebuild's health entry against the PRIOR ledger entry
 * and return a (possibly empty) list of human-readable regression messages. No I/O.
 *
 * Regressions (each ⇒ a WARN with before→after delta):
 *   - overall drops > OVERALL_DROP
 *   - any axis drops > AXIS_DROP
 *   - componentCount INCREASES (graph fragmentation returning)
 *   - dedupRate INCREASES (duplicate entities returning)
 *   - entityNoteConnectivity DROPS > CONNECTIVITY_DROP (entities orphaning from notes)
 *   - totalEntities DROPS > ENTITY_DROP (construction collapse — a degraded/flaky rebuild that
 *     dropped batches shrinks the graph; catches the 260→44 clobber the monitor used to score as a win)
 * Plus history-independent absolute floors: any axis < AXIS_FLOOR.
 * `prev === null` (first-ever rebuild) ⇒ only the absolute floors can fire.
 */
export function detectRegression(prev: HealthLedgerEntry | null, curr: HealthLedgerEntry): string[] {
  const out: string[] = []

  // Absolute floors — independent of history, so they fire even on the first entry.
  for (const name of AXES) {
    const s = curr.axes[name]
    if (s < AXIS_FLOOR) out.push(`FLOOR: ${name} axis ${r1(s)} < ${AXIS_FLOOR}`)
  }
  if (curr.overall < AXIS_FLOOR) out.push(`FLOOR: overall ${r1(curr.overall)} < ${AXIS_FLOOR}`)

  if (!prev) return out

  if (prev.overall - curr.overall > OVERALL_DROP + EPS) {
    out.push(`overall dropped ${r1(prev.overall)}→${r1(curr.overall)} (Δ${r1(curr.overall - prev.overall)})`)
  }
  for (const name of AXES) {
    const a = prev.axes[name]
    const b = curr.axes[name]
    if (a - b > AXIS_DROP + EPS) out.push(`${name} axis dropped ${r1(a)}→${r1(b)} (Δ${r1(b - a)})`)
  }
  if (curr.componentCount > prev.componentCount) {
    out.push(
      `componentCount rose ${prev.componentCount}→${curr.componentCount} (+${curr.componentCount - prev.componentCount}, fragmentation returning)`
    )
  }
  if (curr.dedupRate - prev.dedupRate > EPS) {
    out.push(`dedupRate rose ${r3(prev.dedupRate)}→${r3(curr.dedupRate)} (duplicate entities returning)`)
  }
  if (prev.entityNoteConnectivity - curr.entityNoteConnectivity > CONNECTIVITY_DROP + EPS) {
    out.push(
      `entityNoteConnectivity dropped ${r3(prev.entityNoteConnectivity)}→${r3(curr.entityNoteConnectivity)} (entities orphaning from notes)`
    )
  }
  // totalEntities collapse — the construction-churn signal the monitor was blind to. A degraded/flaky
  // rebuild that drops batches shrinks the entity count; a >ENTITY_DROP (30%) fall vs the prior rebuild
  // is a regression, NOT the improvement a smaller-cleaner graph would otherwise score as.
  if (prev.totalEntities > 0 && prev.totalEntities * (1 - ENTITY_DROP) - curr.totalEntities > EPS) {
    const pct = Math.round((1 - curr.totalEntities / prev.totalEntities) * 100)
    out.push(
      `totalEntities dropped ${prev.totalEntities}→${curr.totalEntities} (−${pct}%, construction collapse — degraded/flaky rebuild)`
    )
  }
  return out
}

// ──────────────────── ledger I/O (best-effort, isolated) ────────────────────

/** History ledger path — same `.duin/_state/` dir the claim-ledger uses. Null when
 *  no vault (nothing to persist against). */
export function historyPath(vault: string | null | undefined): string | null {
  const dir = typeof vault === 'string' ? vault.trim() : ''
  if (!dir) return null
  return join(dir, '.duin', '_state', 'brain-health-history.jsonl')
}

/** Retain the most recent entries so a long-lived install can't grow the ledger
 *  (or the O(n) rewrite) unbounded — one line per ~20-30min rebuild. */
const MAX_HISTORY_ENTRIES = 5000

/** Read the raw (non-empty) lines of the ledger, or [] when absent/unreadable. */
function readRawLines(vault: string | null | undefined): string[] {
  const p = historyPath(vault)
  if (!p || !existsSync(p)) return []
  try {
    return readFileSync(p, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean)
  } catch (e) {
    console.debug('[brain-health] history unreadable:', messageOf(e))
    return []
  }
}

/** The PRIOR (most-recent) ledger entry, or null when none / unparseable. */
export function readLastEntry(vault: string | null | undefined): HealthLedgerEntry | null {
  const lines = readRawLines(vault)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as HealthLedgerEntry
    } catch (e) {
      console.debug('[brain-health] skip a corrupt history line:', messageOf(e))
    }
  }
  return null
}

/** Append one entry (atomic whole-file rewrite, capped). No-op when no vault. */
export function appendEntry(vault: string | null | undefined, entry: HealthLedgerEntry): void {
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

/** Default-ON; opt-OUT via DUIN_BRAIN_HEALTH_MONITOR=0 (matches the `!== '0'`
 *  polarity of DUIN_ENTITY_RESOLVER / DUIN_MAP_ENTITY_OVERLAY). */
export function brainHealthMonitorEnabled(): boolean {
  return process.env.DUIN_BRAIN_HEALTH_MONITOR !== '0'
}

/** Injection seam: the live compute needs the Electron better-sqlite3 ABI, so the
 *  default is lazily imported (keeps this module import-clean + vitest-safe); tests
 *  pass a pure mock. */
export type ComputeHealth = (vault: string | null) => BrainHealthReport | Promise<BrainHealthReport>

/**
 * Run the Brain Health benchmark for a just-completed rebuild: compute the live
 * report, WARN on any regression vs the prior rebuild, and append a history line.
 *
 * FAILURE-ISOLATED + NON-BLOCKING: the entire body is wrapped in try/catch, so a
 * monitor error (or computeBrainHealthLive throwing) is swallowed and can never
 * break or delay the rebuild. Call it fire-and-forget (`void runBrainHealthMonitor(v)`).
 * Flag-gated: DUIN_BRAIN_HEALTH_MONITOR=0 ⇒ immediate no-op (no compute, no ledger write).
 */
export async function runBrainHealthMonitor(vault: string | null, compute?: ComputeHealth): Promise<void> {
  try {
    if (!brainHealthMonitorEnabled()) return
    const fn: ComputeHealth =
      compute ?? (async (v) => (await import('./brain-health-live')).computeBrainHealthLive(v))
    const report = await fn(vault)
    const curr = toLedgerEntry(report)
    const prev = readLastEntry(vault)

    const regressions = detectRegression(prev, curr)
    if (regressions.length > 0) {
      console.warn(
        `[brain-health] ${regressions.length} regression(s) on rebuild (overall ${r1(curr.overall)}` +
          `${prev ? ` vs prior ${r1(prev.overall)}` : ', first rebuild'}):`
      )
      for (const msg of regressions) console.warn(`[brain-health]   - ${msg}`)
      // ALERT SURFACE (MVP): the tagged console.warn above + the history ledger are the
      // signal. DUIN has no generic in-app toast IPC to reuse (brain:needs-key is
      // key-specific and brain:updated is a refetch ping), and minting a new renderer
      // event would require renderer wiring outside this phase's file ownership — so a
      // UI surface (a brain:health-regression toast, or a /debug/brain-health-history
      // route) is a deliberate FOLLOW-ON, not force-fit here.
    } else {
      console.log(`[brain-health] rebuild health OK — overall ${r1(curr.overall)}, weakest ${report.weakestAxis}`)
    }

    appendEntry(vault, curr)
  } catch (e) {
    // Swallow — the rebuild has already persisted; the monitor is advisory only.
    console.warn('[brain-health] monitor error (rebuild unaffected):', messageOf(e))
  }
}
