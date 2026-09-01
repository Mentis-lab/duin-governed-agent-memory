// Long-run L1 — the durable run journal. An append-only, fsync'd JSONL file
// (one record per line) that is the SINGLE durability record for iteration
// progress. It lives at <artifactDir>/.duin/run-journal.jsonl, independent of
// the SQLite DB so it survives a DB corruption/rollback a table would share.
//
// The DB holds only the `last_git_sha` pointer used to reconcile against this
// journal on restart (see reconcile.ts). All logic here is pure over an
// injected `JournalFs` seam so it is unit-tested with an in-memory fake — no
// real fs, no native binding.

/** The step-name discriminant for a journal entry: the 8-step iteration
 *  protocol plus the stop/resume/error control kinds. */
export type JournalKind =
  | 'load'
  | 'decide'
  | 'do'
  | 'verify'
  | 'commit'
  // 'staged' — governor 4a held output: an iteration's commit parked on a side ref,
  // NOT landed on HEAD. Distinct from 'commit' precisely so reconcile (which anchors
  // only on 'commit') never mistakes a held iteration for a durable one.
  | 'staged'
  | 'report'
  | 'stop'
  | 'resume'
  | 'error'

/**
 * Canonical usage record. Defined HERE (Phase A) so cost-budget.ts and
 * loop-digest.ts import the type — the dependency direction is A → B → E, so
 * the build order holds.
 */
export interface TokenUsage {
  model?: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
}

/**
 * One append-only JSONL record. `seq` is monotonic per journal file; `gitSha`
 * ties the entry to the artifact commit that made it durable (the L1/L2
 * reconcile key). Non-commit kinds carry a null gitSha.
 */
export interface JournalEntry {
  seq: number
  ts: number
  loopId: string
  itemId: string | null
  kind: JournalKind
  gitSha: string | null
  usage: TokenUsage | null
  cost: number | null
  note: string | null
}

/**
 * Injected fs seam. `appendLine` MUST open O_APPEND, write `line` + "\n",
 * fsync, then close (durability). `readLines` returns [] when the file is
 * missing. Tests pass an in-memory fake; production wraps node fs.
 */
export interface JournalFs {
  appendLine(path: string, line: string): void
  readLines(path: string): string[]
  exists(path: string): boolean
}

// ---------------------------------------------------------------------------
// Line (de)serialization
// ---------------------------------------------------------------------------

/** Parse one JSONL line into a JournalEntry, or null when malformed/partial
 *  (a torn trailing write after a crash) or blank. Never throws. */
function parseLine(line: string): JournalEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  if (
    typeof o.seq !== 'number' ||
    !Number.isFinite(o.seq) ||
    typeof o.ts !== 'number' ||
    !Number.isFinite(o.ts) ||
    typeof o.loopId !== 'string' ||
    typeof o.kind !== 'string'
  ) {
    return null
  }
  return {
    seq: o.seq,
    ts: o.ts,
    loopId: o.loopId,
    itemId: typeof o.itemId === 'string' ? o.itemId : null,
    kind: o.kind as JournalKind,
    gitSha: typeof o.gitSha === 'string' ? o.gitSha : null,
    usage: (o.usage ?? null) as TokenUsage | null,
    cost: typeof o.cost === 'number' && Number.isFinite(o.cost) ? o.cost : null,
    note: typeof o.note === 'string' ? o.note : null
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Parse the whole journal into ordered entries, skipping any malformed/partial
 * line (e.g. a torn final write). The input to reconcile().
 */
export function readEntries(path: string, fs: JournalFs): JournalEntry[] {
  if (!fs.exists(path)) return []
  const out: JournalEntry[] = []
  for (const line of fs.readLines(path)) {
    const parsed = parseLine(line)
    if (parsed) out.push(parsed)
  }
  return out
}

/**
 * The final well-formed entry (for seq continuation and quick resume checks)
 * — walks from the tail so a torn trailing write is skipped without turning
 * the whole file into JournalEntry objects.
 */
export function lastEntry(path: string, fs: JournalFs): JournalEntry | null {
  if (!fs.exists(path)) return null
  const lines = fs.readLines(path)
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseLine(lines[i])
    if (parsed) return parsed
  }
  return null
}

// ---------------------------------------------------------------------------
// Write (the single durable-write primitive for L1)
// ---------------------------------------------------------------------------

/**
 * The single durable-write primitive for L1. Assigns `seq = (lastEntry?.seq ??
 * -1) + 1` and `ts = clock()`, serializes the completed entry to one JSON line,
 * and fsync-appends it via the seam. Returns the completed entry.
 */
export function appendEntry(
  path: string,
  entry: Omit<JournalEntry, 'seq' | 'ts'>,
  fs: JournalFs,
  clock: () => number = Date.now
): JournalEntry {
  const last = lastEntry(path, fs)
  const complete: JournalEntry = {
    seq: (last?.seq ?? -1) + 1,
    ts: clock(),
    loopId: entry.loopId,
    itemId: entry.itemId,
    kind: entry.kind,
    gitSha: entry.gitSha,
    usage: entry.usage,
    cost: entry.cost,
    note: entry.note
  }
  fs.appendLine(path, JSON.stringify(complete))
  return complete
}
