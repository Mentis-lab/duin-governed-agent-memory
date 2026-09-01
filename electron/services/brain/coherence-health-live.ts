// Live gatherer for Coherence Health — the side-effectful wrapper that feeds the PURE
// computeCoherenceHealth (mirrors compounding-health-live.ts / brain-health-live.ts). Kept separate so
// coherence-health.ts stays import-clean (no fs, no Electron), unit-testable, and runnable anywhere.
//
// DELIBERATELY DECOUPLED: this reads the three subsystem-benchmark HISTORY LEDGERS off disk (their
// `.duin/_state/*-health-history.jsonl` files) rather than importing brain/backend/compounding-health
// modules. That means Coherence Health works on ANY branch — even one where a given benchmark module
// doesn't exist — and reflects the LAST PERSISTED run of each monitor, not a fresh (expensive) recompute.
// A missing ledger contributes `null` (that rollup is simply absent), never a throw.
//
// The ONLY clock read is `now` (minted here for builtAt + the frozen-ledger detector), so the pure core
// stays deterministic.

import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { messageOf } from '../guarded'
import { COHERENCE_MAP } from './coherence-map'
import {
  computeCoherenceHealth,
  type CoherenceHealth,
  type CoherenceHealthDeps,
  type RollupDeps,
  type LintSummary
} from './coherence-health'
import { lintCoherence, type LedgerStat } from './coherence-lint'

/** `.duin/_state/<name>` under the vault, or null when there's no vault. */
function statePath(vault: string | null, name: string): string | null {
  const dir = typeof vault === 'string' ? vault.trim() : ''
  if (!dir) return null
  return join(dir, '.duin', '_state', name)
}

/** Last non-empty line of a jsonl ledger parsed as T, or null when absent/unreadable/unparseable. */
function readLastJsonl<T>(path: string | null): T | null {
  if (!path) return null
  let lines: string[]
  try {
    lines = readFileSync(path, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean)
  } catch (e) {
    console.debug('[coherence-health-live] ledger unreadable:', path, messageOf(e))
    return null
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as T
    } catch (e) {
      console.debug('[coherence-health-live] skip corrupt ledger line:', messageOf(e))
    }
  }
  return null
}

/** mtime (ms) of a path, or null when it can't be stat'd. */
function mtimeMs(path: string | null): number | null {
  if (!path) return null
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

// ──────────────────── the three nested rollups ────────────────────

/**
 * A nested rollup older than this is not a current signal.
 *
 * 72h is deliberately generous: Brain Health is event-driven (it fires after a
 * Construction rebuild), so a genuinely quiet vault can go a day or two without
 * one and that is not a fault.
 */
export const NESTED_ROLLUP_MAX_AGE_HOURS = 72

/**
 * PURE. The overall from a nested rollup entry, or null when it is too old to
 * count as current.
 *
 * This is the fix for the sharpest self-measurement defect found on 2026-07-30:
 * Coherence Health is the apex benchmark, it NESTS Brain Health, and it read the
 * latest entry's `.overall` with no regard for when that entry was written. Brain
 * Health had not run in 10 days — construction stalled, and it only fires after a
 * Construction rebuild — so the apex score was averaging in a corpse and
 * reporting 84.4 as if current. **A benchmark consuming a stale benchmark is
 * worse than one that has not run: it manufactures a current-looking number from
 * a dead input.**
 *
 * Null is the honest answer and already a first-class case here (`compounding`
 * was null for all of v1), so a suppressed rollup contributes no signal rather
 * than a false one. The freeze itself is not hidden by this — the liveness axis
 * scores it separately via the frozen-ledger detector.
 *
 * `fallbackMs` (the file mtime) covers entries with no parseable `ts`: undated is
 * not the same as fresh, and treating it as fresh is the bug being fixed.
 */
export function freshOverall(
  entry: { overall?: unknown; ts?: unknown } | null,
  nowMs: number,
  fallbackMs: number | null,
  maxAgeHours: number = NESTED_ROLLUP_MAX_AGE_HOURS
): number | null {
  if (!entry || typeof entry.overall !== 'number') return null
  const parsed = typeof entry.ts === 'string' ? Date.parse(entry.ts) : NaN
  const writtenMs = Number.isFinite(parsed) ? parsed : fallbackMs
  if (writtenMs === null || !Number.isFinite(writtenMs)) return null
  if (nowMs - writtenMs > maxAgeHours * 3_600_000) return null
  return entry.overall
}

/** Latest `.overall` from a nested rollup ledger, suppressed when stale. */
function readNestedOverall(vault: string | null, file: string, nowMs: number): number | null {
  const path = statePath(vault, file)
  return freshOverall(
    readLastJsonl<{ overall?: number; ts?: string }>(path),
    nowMs,
    mtimeMs(path)
  )
}

/** Compounding Health overall from compounding-health-history.jsonl (latest .overall). Usually ABSENT
 *  in v1 — there is no scheduled compounding-health monitor yet, so this is expected to be null until
 *  one is added (tracked in the Coherence Map as the Compounding Health "no scheduled monitor" gap). */
function readCompoundingOverall(vault: string | null, nowMs: number): number | null {
  return readNestedOverall(vault, 'compounding-health-history.jsonl', nowMs)
}

/** Backend Health has no 0-100 overall in its ledger, so DERIVE one from the latest entry: start at
 *  100 and subtract for each operational anomaly (integrity fail, failure spike, stuck runs, orphans,
 *  stale backups). This keeps the pure core rollup-shape uniform (a number|null) without teaching it
 *  the backend-health entry schema. Null when no backend-health ledger exists. */
export interface BackendHealthEntryLike {
  integrity?: Array<{ integrityOk?: boolean; fkViolations?: number }>
  backupAgeHours?: number | null
  moatBackupAgeHours?: number | null
  failures?: { totalCount?: number }
  stuckRuns?: number
  orphanToolCalls?: number
}

/** PURE: derive a 0-100 backend health score from a backend-health ledger entry. Exported for tests. */
export function deriveBackendOverall(e: BackendHealthEntryLike | null): number | null {
  if (!e) return null
  let score = 100
  const integrity = e.integrity ?? []
  if (integrity.some((i) => i.integrityOk === false || (i.fkViolations ?? 0) > 0)) score -= 40
  if ((e.failures?.totalCount ?? 0) >= 100) score -= 20
  if ((e.stuckRuns ?? 0) > 0) score -= 15
  if ((e.orphanToolCalls ?? 0) > 0) score -= 10
  const STALE = 26
  if (e.backupAgeHours === null || e.backupAgeHours === undefined || e.backupAgeHours > STALE) score -= 10
  if (typeof e.moatBackupAgeHours === 'number' && e.moatBackupAgeHours > STALE) score -= 5
  return score < 0 ? 0 : score
}

function readBackendOverall(vault: string | null): number | null {
  const e = readLastJsonl<BackendHealthEntryLike>(statePath(vault, 'backend-health-history.jsonl'))
  return deriveBackendOverall(e)
}

// ──────────────────── the frozen-ledger lint input ────────────────────

/** Ledgers expected to CO-ADVANCE while the app is active — the set the frozen-ledger detector compares.
 *  (A ledger lagging the freshest of these by >24h is a stalled loop.) */
const CO_ADVANCING_LEDGERS = [
  'claim-ledger.jsonl',
  'brain-health-history.jsonl',
  'backend-health-history.jsonl'
]

function gatherLedgerStats(vault: string | null): LedgerStat[] {
  const out: LedgerStat[] = []
  for (const name of CO_ADVANCING_LEDGERS) {
    const mt = mtimeMs(statePath(vault, name))
    if (mt !== null) out.push({ name, mtimeMs: mt })
  }
  return out
}

// ──────────────────── the live compute ────────────────────

/**
 * Gather deps from live state and compute the Coherence Health report. Read-only w.r.t. every store; a
 * missing source contributes a neutral/null signal (never throws). The deterministic lint runs its
 * cheap detectors here (map `unguarded` + `frozen-ledger` over the co-advancing ledgers); the expensive
 * dead-export source scan is intentionally NOT run on this hot-ish route (it's a separate offline pass).
 */
export function computeCoherenceHealthLive(vault: string | null): CoherenceHealth {
  const now = new Date()
  const builtAt = now.toISOString()

  const rollups: RollupDeps = {
    brain: readNestedOverall(vault, 'brain-health-history.jsonl', now.getTime()),
    backend: readBackendOverall(vault),
    compounding: readCompoundingOverall(vault, now.getTime())
  }

  // Cheap deterministic lint (no source scan): map-unguarded (exact) + frozen-ledger (mtime-based).
  let lint: LintSummary | null = null
  try {
    const report = lintCoherence({
      map: COHERENCE_MAP,
      ledgers: gatherLedgerStats(vault),
      nowMs: now.getTime()
    })
    lint = report.summary
  } catch (e) {
    console.debug('[coherence-health-live] lint pass failed (non-fatal):', messageOf(e))
  }

  const deps: CoherenceHealthDeps = {
    builtAt,
    map: COHERENCE_MAP,
    rollups,
    lint
  }
  return computeCoherenceHealth(deps)
}
