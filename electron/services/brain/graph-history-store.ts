import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteFileSync } from '../atomic-write'
import { messageOf } from '../guarded'

/**
 * Graph growth history ledger — ONE structural snapshot per day, appended to
 * `.duin/_state/graph-history.jsonl` and rewritten whole on every panel open.
 *
 * Three data-loss rules this module exists to enforce (the read-modify-rewrite
 * used to do neither of the first two, while its sibling `brain-health-monitor.ts`
 * did both):
 *
 *  1. PRESERVE unparseable lines VERBATIM. The file is a one-row-per-day time
 *     series that can never be rebuilt — `buildGraphSnapshot()` only ever sees
 *     the LIVE graph, so a past day's node/edge counts exist nowhere else, and
 *     the file is absent from moat-backup's SOURCES. A line torn by a sync
 *     conflict or an interrupted write (`{"date":"2026-07-18","notes":12`) is
 *     still salvageable residue; dropping it from the rewrite deletes it from
 *     the only copy on disk. So lines are retained as STRINGS through the
 *     rewrite and parsed only for interpretation, never for persistence.
 *  2. WRITE ATOMICALLY. A bare writeFileSync truncates the sole copy in place,
 *     so an interrupted / ENOSPC write can shred VALID records — i.e. it
 *     manufactures exactly the torn line rule 1 then has to preserve.
 *  3. NEVER REWRITE FROM A FAILED READ. "The file is absent" and "the file could
 *     not be read" are different facts with opposite correct responses — create
 *     it, versus leave it alone — and a `catch { return [] }` erases that
 *     difference before the rewrite can act on it. See `readRawLines`.
 */

/** Retention cap — one line per day, so ~a year of history. */
export const MAX_HISTORY_DAYS = 365

/** Ledger path for a vault, or null when no vault is configured. */
export function graphHistoryPath(vault: string | null | undefined): string | null {
  const dir = typeof vault === 'string' ? vault.trim() : ''
  if (!dir) return null
  return join(dir, '.duin', '_state', 'graph-history.jsonl')
}

/**
 * Raw (trimmed, non-empty) lines of the ledger: `[]` when the file is ABSENT,
 * `null` when it exists but could not be READ.
 *
 * Rule 3, and the one that hid behind the other two. Collapsing a read fault
 * onto the same `[]` as "no ledger yet" is invisible at this level — `[]` is a
 * perfectly ordinary first-run value — but it is a lie the caller cannot detect
 * from the value alone, and the caller's next move is a whole-file rewrite. On
 * a vault in a synced folder (the deployment the header above already
 * anticipates) a sync client or a virus scanner holding a momentary exclusive
 * handle makes readFileSync throw EBUSY/EACCES; the panel open that triggered
 * it would then atomically replace up to MAX_HISTORY_DAYS of unrebuildable rows
 * with today's single row and return looking successful. Rules 1 and 2 protect
 * the bytes of lines we DID read; nothing protected the lines we failed to.
 */
function readRawLines(path: string): string[] | null {
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  } catch (e) {
    console.warn(
      `[graph-history-store] ${path} exists but could not be read (${messageOf(e)}) — ` +
        "abstaining: today's snapshot is skipped rather than rewriting the ledger from an empty read."
    )
    return null
  }
}

function parseOrNull(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export interface GraphHistoryResult {
  /** Parsed rows, file order — what the panel renders. */
  rows: Record<string, unknown>[]
  /** How many lines survived the rewrite unparsed (preserved verbatim). */
  preservedCorruptLines: number
}

/**
 * Read the ledger, upsert today's snapshot (latest wins), rewrite atomically.
 *
 * `writeIfStateDirExists` keeps the original cold-data-safe gate: we never
 * create `.duin/_state` just to log telemetry into it.
 */
export function recordGraphHistory(
  vault: string | null | undefined,
  snapshot: object,
  opts: { today?: string; stateDirExists?: (dir: string) => boolean } = {}
): GraphHistoryResult {
  const path = graphHistoryPath(vault)
  if (!path) return { rows: [], preservedCorruptLines: 0 }
  const today = opts.today ?? new Date().toISOString().slice(0, 10)
  const stateDirExists = opts.stateDirExists ?? existsSync

  const lines = readRawLines(path)
  // ABSTAIN rather than clobber — same posture as the stateDirExists gate below.
  // A failed read tells us nothing about what is on disk, so the one thing we
  // must not do is rewrite the file from it: the ledger is the only copy of every
  // past day's counts. A missing snapshot costs one day of a series that is
  // re-recorded on the next panel open; a wrongful rewrite costs the year.
  if (lines === null) return { rows: [], preservedCorruptLines: 0 }
  // Pair each line with its interpretation. `parsed === null` marks a line we do
  // NOT understand — it is carried through the rewrite untouched rather than
  // dropped, because this file is the only copy of that day's numbers.
  const entries = lines.map((raw) => ({ raw, parsed: parseOrNull(raw) }))

  const stateDir = join(path, '..')
  if (!stateDirExists(stateDir)) {
    return {
      rows: entries.map((e) => e.parsed).filter((r): r is Record<string, unknown> => r !== null),
      preservedCorruptLines: entries.filter((e) => e.parsed === null).length
    }
  }

  // Only a line we could parse AND that claims today is superseded. An
  // unparseable line is never treated as "today's row" — we can't know that it
  // is, and guessing would delete it.
  const kept = entries.filter((e) => e.parsed === null || e.parsed.date !== today)
  kept.push({ raw: '', parsed: { date: today, ...snapshot } })
  const trimmed = kept.slice(-MAX_HISTORY_DAYS)

  // Prior lines go back byte-for-byte (`raw`); only the row we just built is
  // serialized here. Re-serializing a parsed line would silently normalize key
  // order and drop fields JSON round-trips lossily — another quiet rewrite of
  // history we have no need to perform.
  const body = trimmed.map((e) => (e.raw !== '' ? e.raw : JSON.stringify(e.parsed))).join('\n') + '\n'
  atomicWriteFileSync(path, body, 0o644)

  return {
    rows: trimmed.map((e) => e.parsed).filter((r): r is Record<string, unknown> => r !== null),
    preservedCorruptLines: trimmed.filter((e) => e.parsed === null).length
  }
}
