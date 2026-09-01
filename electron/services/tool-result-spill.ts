// HY3 — Tool-result spill valve.
//
// A single large tool result (a big `git log`, a wide grep, a whole-file read)
// otherwise lands verbatim in the model's message array and rides along in
// every subsequent round's context for the rest of the conversation. This is
// the Claude-Code mechanic: when a result exceeds a threshold, write the full
// text to disk, hand the model a head+tail PREVIEW plus a `ref`, and expose a
// `read_tool_result(ref, start, end)` tool for paged read-back.
//
// The full result is still persisted to the conversation store (the UI shows
// it in full) — only the copy fed to the MODEL is elided. The pure preview
// formatter is separated from disk I/O so it can be unit-tested directly.

import { app } from 'electron'
import { join } from 'path'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync
} from 'fs'
import { randomUUID } from 'crypto'

/** Results longer than this (characters) are spilled. 0 / disabled = never. */
export const DEFAULT_SPILL_THRESHOLD = 8192
const HEAD_CHARS = 2048
const TAIL_CHARS = 1024

// R5 (Phase-4) — hard cap on the number of characters ANY single tool result
// (native, MCP, or subagent) is allowed to occupy at rest. An oversized result
// (a giant MCP payload, a runaway subagent transcript) that lands verbatim in
// the conversation store can exceed the SQLite row/column limit and THROW out
// of the persist path — which orphans the whole turn (no terminal frame). We
// truncate to this cap with a legible marker BEFORE persistence so the write
// can't blow up on size. Env `DUIN_MAX_TOOL_RESULT_CHARS` (preferred, DUIN_*
// style) or `MAX_TOOL_RESULT_CHARS`; default 200000; 0/negative disables the
// cap (env-tunable escape hatch — never a silent unraisable hardcode).
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 200_000

/** Resolve the persisted-tool-result char cap from the environment. */
export function maxToolResultChars(): number {
  for (const name of ['DUIN_MAX_TOOL_RESULT_CHARS', 'MAX_TOOL_RESULT_CHARS']) {
    const rawEnv = process.env[name]
    const raw = Number(rawEnv)
    if (Number.isFinite(raw) && rawEnv != null && rawEnv !== '') return raw
  }
  return DEFAULT_MAX_TOOL_RESULT_CHARS
}

/**
 * Truncate `full` so the RETURNED string is at most `max` characters, appending
 * a marker naming how much was dropped. `max <= 0` disables the cap (returns
 * `full` unchanged). The marker length is reserved from the budget so the result
 * is a true upper bound AND the function is idempotent — a second pass sees a
 * string already at/under `max` and returns it unchanged. When `max` is smaller
 * than the marker itself, it falls back to a plain hard slice (no marker room).
 * No I/O — pure, so it is unit-testable and safe to call on every path.
 */
export function capToolResultChars(full: string, max = maxToolResultChars()): string {
  if (max <= 0 || !full || full.length <= max) return full
  const marker = (dropped: number, total: number): string =>
    `\n\n[… tool result truncated: ${dropped} of ${total} characters dropped ` +
    `(exceeds MAX_TOOL_RESULT_CHARS=${max}). …]`
  // Upper bound on the marker length (uses full.length for the dropped-count
  // digits, which is >= the true count, so the real marker never exceeds this).
  const markerBudget = marker(full.length, full.length).length
  if (max <= markerBudget) {
    // Cap too small to fit an explanatory marker — hard-slice to the bound.
    return full.slice(0, max)
  }
  const keep = max - markerBudget
  const dropped = full.length - keep
  return full.slice(0, keep) + marker(dropped, full.length)
}

/** Resolve (and create) the on-disk spill directory under userData. */
export function spillDir(): string {
  const dir = join(app.getPath('userData'), 'tool-results')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Pure preview: head + an elision marker naming the `ref` + tail. No I/O.
 * Always shorter than the original when the original exceeds head+tail.
 */
export function formatSpillPreview(
  full: string,
  ref: string,
  headChars = HEAD_CHARS,
  tailChars = TAIL_CHARS
): string {
  const total = full.length
  const head = full.slice(0, headChars)
  const tailStart = Math.max(headChars, total - tailChars)
  const tail = full.slice(tailStart)
  const elided = Math.max(0, total - head.length - tail.length)
  return (
    `${head}\n\n` +
    `[… ${elided} of ${total} characters elided. Read any range with ` +
    `read_tool_result(ref="${ref}", start, end). …]\n\n` +
    `${tail}`
  )
}

export interface SpillOutcome {
  /** What to feed the model (preview when spilled, original otherwise). */
  result: string
  spilled: boolean
  ref?: string
  chars?: number
}

/**
 * Spill `full` to disk and return a preview when it exceeds `threshold`;
 * otherwise return it unchanged. `threshold <= 0` disables spilling.
 */
export function maybeSpillToolResult(
  full: string,
  opts: { threshold?: number; dir?: string; maxChars?: number } = {}
): SpillOutcome {
  // R5 (Phase-4) — cap the size BEFORE any disk write so an oversized result
  // can't blow past the on-disk/store limits. Idempotent when already capped.
  const capped = capToolResultChars(full, opts.maxChars ?? maxToolResultChars())
  const threshold = opts.threshold ?? DEFAULT_SPILL_THRESHOLD
  if (threshold <= 0 || !capped || capped.length <= threshold) {
    return { result: capped, spilled: false }
  }
  const ref = randomUUID()
  const dir = opts.dir ?? spillDir()
  // Guard the write: a failed spill (full disk, permissions, oversized path)
  // must NOT throw out of the tool loop and orphan the turn. On failure the
  // model still gets the capped result inline; only the paged read-back is lost.
  try {
    writeFileSync(join(dir, `${ref}.txt`), capped, 'utf8')
  } catch (err) {
    console.error('[tool-result-spill] spill write failed; returning inline:', err)
    return { result: capped, spilled: false }
  }
  return { result: formatSpillPreview(capped, ref), spilled: true, ref, chars: capped.length }
}

// ---------------------------------------------------------------------------
// SP-6 (Sweet Spot Phase, 2026-06-10) — spill garbage collection (D3).
//
// HY3 shipped the spill valve with no deletion path at all: every spilled
// result accumulated in userData/tool-results/ forever (zero unlink call
// sites repo-wide before this change). The GC runs at app startup: delete
// files older than SPILL_MAX_AGE_MS, then — if the directory still exceeds
// SPILL_MAX_TOTAL_BYTES — delete oldest-first until it fits. Refs the model
// might still hold for *recent* turns survive; a ref that was GC'd resolves
// to the existing "tool result not found (it may have expired)" reply, which
// the model already handles.
// ---------------------------------------------------------------------------

/** Spill files older than this are deleted at startup (7 days). */
export const SPILL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** After the age sweep, the directory is trimmed oldest-first to this cap. */
export const SPILL_MAX_TOTAL_BYTES = 256 * 1024 * 1024

export interface SpillGcOutcome {
  scanned: number
  deletedByAge: number
  deletedBySize: number
  remainingBytes: number
}

/**
 * Sweep the spill directory. Best-effort: unreadable/undeletable entries are
 * skipped, never thrown — GC must not be able to break app startup.
 */
export function gcSpillDir(
  opts: { dir?: string; maxAgeMs?: number; maxTotalBytes?: number; now?: number } = {}
): SpillGcOutcome {
  const dir = opts.dir ?? spillDir()
  const maxAgeMs = opts.maxAgeMs ?? SPILL_MAX_AGE_MS
  const maxTotalBytes = opts.maxTotalBytes ?? SPILL_MAX_TOTAL_BYTES
  const now = opts.now ?? Date.now()

  let entries: { path: string; mtimeMs: number; size: number }[]
  try {
    entries = readdirSync(dir)
      .filter((name) => name.endsWith('.txt'))
      .flatMap((name) => {
        try {
          const path = join(dir, name)
          const st = statSync(path)
          return st.isFile() ? [{ path, mtimeMs: st.mtimeMs, size: st.size }] : []
        } catch {
          return []
        }
      })
  } catch {
    return { scanned: 0, deletedByAge: 0, deletedBySize: 0, remainingBytes: 0 }
  }

  const scanned = entries.length
  let deletedByAge = 0
  const survivors: typeof entries = []
  for (const entry of entries) {
    if (now - entry.mtimeMs > maxAgeMs) {
      try {
        unlinkSync(entry.path)
        deletedByAge++
      } catch {
        survivors.push(entry)
      }
    } else {
      survivors.push(entry)
    }
  }

  let remainingBytes = survivors.reduce((sum, e) => sum + e.size, 0)
  let deletedBySize = 0
  if (remainingBytes > maxTotalBytes) {
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs) // oldest first
    for (const entry of survivors) {
      if (remainingBytes <= maxTotalBytes) break
      try {
        unlinkSync(entry.path)
        remainingBytes -= entry.size
        deletedBySize++
      } catch {
        // skip — undeletable file stays counted
      }
    }
  }

  return { scanned, deletedByAge, deletedBySize, remainingBytes }
}

/**
 * Read a character range of a spilled result. `ref` is validated against a
 * strict charset to prevent path traversal. Returns a JSON string the model
 * receives as the tool result.
 */
export function readSpilledResult(
  ref: string,
  start = 0,
  end?: number,
  dir?: string
): string {
  if (typeof ref !== 'string' || !/^[\w-]+$/.test(ref)) {
    return JSON.stringify({ error: 'invalid ref' })
  }
  const path = join(dir ?? spillDir(), `${ref}.txt`)
  if (!existsSync(path)) {
    return JSON.stringify({ error: 'tool result not found (it may have expired)', ref })
  }
  const full = readFileSync(path, 'utf8')
  const s = Math.max(0, Math.floor(start) || 0)
  const e = end != null ? Math.min(full.length, Math.floor(end)) : Math.min(full.length, s + 8192)
  return JSON.stringify({
    ref,
    start: s,
    end: e,
    totalChars: full.length,
    content: full.slice(s, e)
  })
}
