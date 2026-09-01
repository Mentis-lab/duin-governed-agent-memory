// Notes-accumulation LIVENESS MONITOR — an EVENT-triggered watchdog for the
// construction + metabolism loops, fired by note ingestion rather than a clock.
//
// WHY event-triggered (and why NOT the existing rebuild-completion monitor):
// brain-health-monitor runs when a construction rebuild COMPLETES. But if the
// construction loop is FROZEN (never rebuilds — the 2-day stall we actually saw),
// no completion event ever fires, so that monitor stays silent exactly when the
// loop is dead. The one signal that KEEPS firing while a downstream loop is frozen
// is the user still writing notes: notes-watcher's reindex chain fires per ingest.
// So we hook there and, every N accumulated ingests (default 10 — "an accumulation
// of 10 new knowledge notes"), assert that the loops which SHOULD have turned on
// that fresh input actually advanced. Notes accumulating + a loop's heartbeat
// ledger stale past its threshold = the loop is frozen while the system is
// demonstrably live → WARN. This is the watchdog the clock-free design asked for.
//
// Mirrors brain-health-monitor's shape: a PURE core (shouldFire / detectFrozenLoops
// — no I/O, fully vitest-testable, no Electron ABI) + a thin FAILURE-ISOLATED I/O
// wrapper. A monitor error can never break or delay ingest.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { messageOf } from '../guarded'

// ──────────────────── watched loops ────────────────────

/** A loop we watch for liveness. `ledger` is the `.duin/_state/` jsonl whose newest
 *  entry (or, failing that, file mtime) is the loop's heartbeat; `staleMs` is how
 *  long that heartbeat may lag — while notes are actively accumulating — before the
 *  loop counts as frozen. Thresholds are generous: these are slow loops (a
 *  construction rebuild honors a 20-min min-gap), so we flag a genuine STALL (many
 *  hours of fresh input with zero advance), never normal debounce/throttle. */
export interface WatchedLoop {
  loop: string
  ledger: string
  staleMs: number
}

const HOUR = 60 * 60 * 1000

/** The loops that froze. Construction is the primary (its heartbeat is the
 *  brain-health ledger the rebuild-completion monitor appends); the three
 *  benchmark loops are the metabolism substrate (coherence / compounding /
 *  self-improve re-score on their own cadences). All live under `.duin/_state/`. */
export const WATCHED_LOOPS: readonly WatchedLoop[] = [
  { loop: 'construction', ledger: 'brain-health-history.jsonl', staleMs: 6 * HOUR },
  { loop: 'coherence', ledger: 'coherence-health-history.jsonl', staleMs: 24 * HOUR },
  { loop: 'compounding', ledger: 'compounding-health-history.jsonl', staleMs: 24 * HOUR },
  { loop: 'self-improve', ledger: 'self-improve-bench-history.jsonl', staleMs: 24 * HOUR }
]

// ──────────────────── ledger schema ────────────────────

/** One heartbeat line per fired check. Flat + small, same `.duin/_state/` jsonl
 *  convention as the other ledgers so a long-lived install accrues a cheap,
 *  greppable time-series of "how live were the loops when notes last piled up". */
export interface NotesLivenessEntry {
  /** ISO timestamp of the check. */
  ts: string
  /** Notes ingested since the previous check (the accumulation that triggered it). */
  accumulated: number
  /** Per-loop heartbeat age in whole minutes at check time (−1 = never ran / no ledger). */
  loopAgeMin: Record<string, number>
  /** Loops judged frozen this check (heartbeat older than the loop's threshold). */
  frozen: string[]
}

// ──────────────────── pure core (no I/O) ────────────────────

/** Fire the check once at least `threshold` notes have accumulated. */
export function shouldFire(accumulated: number, threshold: number): boolean {
  return threshold > 0 && accumulated >= threshold
}

/** A watched loop's heartbeat at check time: age of its newest ledger entry.
 *  `ageMs === null` means the loop never ran (no ledger / empty / unparseable). */
export interface LoopHeartbeat {
  loop: string
  ageMs: number | null
  staleMs: number
}

/**
 * PURE: given each watched loop's heartbeat age, return the loops that are frozen —
 * i.e. their heartbeat is older than their staleness threshold. A loop that never
 * ran (`ageMs === null`) is frozen ONLY if we've observed real note activity (the
 * caller passes hasActivity), because "never ran" on a brand-new vault with no
 * ingest yet is not a defect. No I/O; the whole freshness judgment lives here so
 * it's exhaustively unit-testable.
 */
export function detectFrozenLoops(beats: LoopHeartbeat[], hasActivity: boolean): string[] {
  const frozen: string[] = []
  for (const b of beats) {
    if (b.ageMs === null) {
      if (hasActivity) frozen.push(b.loop)
      continue
    }
    if (b.ageMs > b.staleMs) frozen.push(b.loop)
  }
  return frozen
}

// ──────────────────── ledger I/O (best-effort, isolated) ────────────────────

/** State-dir path for a `.duin/_state/` ledger file, or null without a vault. */
export function statePath(vault: string | null | undefined, file: string): string | null {
  const dir = typeof vault === 'string' ? vault.trim() : ''
  if (!dir) return null
  return join(dir, '.duin', '_state', file)
}

/** History ledger this monitor appends to. */
export function historyPath(vault: string | null | undefined): string | null {
  return statePath(vault, 'notes-liveness-history.jsonl')
}

/** Retain the most recent entries so a long-lived install can't grow the ledger
 *  unbounded — one line per fired check. */
const MAX_HISTORY_ENTRIES = 5000

/** Newest ISO timestamp in a heartbeat ledger — read from the last parseable line's
 *  `ts` field, falling back to the file's mtime, else null (absent / empty). Kept
 *  robust: a heartbeat is "the loop advanced recently", and both a fresh appended
 *  entry and a fresh file-write attest to that. */
export function readLedgerHeartbeat(path: string | null): number | null {
  if (!path || !existsSync(path)) return null
  try {
    const lines = readFileSync(path, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ts = (JSON.parse(lines[i]) as { ts?: string }).ts
        if (ts) {
          const ms = Date.parse(ts)
          if (Number.isFinite(ms)) return ms
        }
      } catch {
        /* skip a corrupt line, keep scanning older ones */
      }
    }
    // Ledger exists but no parseable ts — fall back to the file's own freshness.
    return statSync(path).mtimeMs
  } catch (e) {
    console.debug('[notes-liveness] heartbeat unreadable:', messageOf(e))
    return null
  }
}

function readRawLines(vault: string | null | undefined): string[] {
  const p = historyPath(vault)
  if (!p || !existsSync(p)) return []
  try {
    return readFileSync(p, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean)
  } catch (e) {
    console.debug('[notes-liveness] history unreadable:', messageOf(e))
    return []
  }
}

/** The most-recent heartbeat entry this monitor wrote, or null. */
export function readLastEntry(vault: string | null | undefined): NotesLivenessEntry | null {
  const lines = readRawLines(vault)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as NotesLivenessEntry
    } catch (e) {
      console.debug('[notes-liveness] skip a corrupt history line:', messageOf(e))
    }
  }
  return null
}

/** Append one heartbeat entry (atomic whole-file rewrite, capped). No-op w/o vault. */
export function appendEntry(vault: string | null | undefined, entry: NotesLivenessEntry): void {
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

// ──────────────────── flag gate + threshold ────────────────────

/** Default-ON; opt-OUT via DUIN_NOTES_LIVENESS_MONITOR=0 (matches the `!== '0'`
 *  polarity of the other DUIN monitor flags). */
export function notesLivenessMonitorEnabled(): boolean {
  return process.env.DUIN_NOTES_LIVENESS_MONITOR !== '0'
}

/** Notes that must accumulate before a check fires. "An accumulation of 10 new
 *  knowledge notes" — tunable via DUIN_NOTES_LIVENESS_THRESHOLD. */
export function accumulationThreshold(): number {
  const n = Number(process.env.DUIN_NOTES_LIVENESS_THRESHOLD)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10
}

// ──────────────────── accumulator + fire-and-forget wrapper ────────────────────

let accumulated = 0

/** Reset the in-memory accumulator (test hook; also used on watcher stop). */
export function resetAccumulator(): void {
  accumulated = 0
}

/** Current accumulator value (test/inspection hook). */
export function pendingAccumulation(): number {
  return accumulated
}

/**
 * EVENT ENTRYPOINT — call from the notes-watcher reindex chain with the number of
 * notes reindexed. Accumulates; once the threshold is crossed, resets and fires the
 * liveness check fire-and-forget. Cheap and synchronous up to the threshold (just an
 * add), so it's safe to call on every ingest. Flag-gated: a disabled monitor doesn't
 * even accumulate.
 */
export function noteAccumulationTick(vault: string | null, count: number): void {
  if (!notesLivenessMonitorEnabled()) return
  if (!Number.isFinite(count) || count <= 0) return
  accumulated += count
  const threshold = accumulationThreshold()
  if (!shouldFire(accumulated, threshold)) return
  const fired = accumulated
  accumulated = 0
  void runNotesLivenessMonitor(vault, fired)
}

/** Injection seam for tests: read a loop's heartbeat age-source. Defaults to the
 *  real ledger read; tests pass a pure map. */
export type ReadHeartbeat = (vault: string | null, loop: WatchedLoop) => number | null

/**
 * Run the liveness check for a just-crossed accumulation: read each watched loop's
 * heartbeat, flag any frozen past its threshold WHILE notes accumulated, WARN, and
 * append a heartbeat history line.
 *
 * FAILURE-ISOLATED + NON-BLOCKING: the whole body is try/caught, so a monitor error
 * can never break or delay ingest. Flag-gated no-op when disabled.
 */
export async function runNotesLivenessMonitor(
  vault: string | null,
  accumulatedNotes: number,
  readHeartbeat?: ReadHeartbeat,
  now: number = nowMs()
): Promise<void> {
  try {
    if (!notesLivenessMonitorEnabled()) return
    const read: ReadHeartbeat =
      readHeartbeat ?? ((v, loop) => readLedgerHeartbeat(statePath(v, loop.ledger)))

    const beats: LoopHeartbeat[] = WATCHED_LOOPS.map((loop) => {
      const hb = read(vault, loop)
      return { loop: loop.loop, ageMs: hb === null ? null : Math.max(0, now - hb), staleMs: loop.staleMs }
    })

    // Notes DID accumulate to reach this check, so the system is demonstrably active —
    // a never-run loop counts as frozen here (that's the whole point of the watchdog).
    const frozen = detectFrozenLoops(beats, accumulatedNotes > 0)

    const loopAgeMin: Record<string, number> = {}
    for (const b of beats) loopAgeMin[b.loop] = b.ageMs === null ? -1 : Math.round(b.ageMs / 60000)

    if (frozen.length > 0) {
      console.warn(
        `[notes-liveness] ${frozen.length} loop(s) frozen after ${accumulatedNotes} notes accumulated: ` +
          frozen.map((f) => `${f} (${loopAgeMin[f] < 0 ? 'never ran' : `${loopAgeMin[f]}m stale`})`).join(', ')
      )
    } else {
      console.log(`[notes-liveness] all loops fresh after ${accumulatedNotes} notes accumulated`)
    }

    appendEntry(vault, {
      ts: new Date(now).toISOString(),
      accumulated: accumulatedNotes,
      loopAgeMin,
      frozen
    })
  } catch (e) {
    console.warn('[notes-liveness] monitor error (ingest unaffected):', messageOf(e))
  }
}

/** Wall clock, isolated so tests can pin `now` via the wrapper's parameter. */
function nowMs(): number {
  return Date.now()
}
