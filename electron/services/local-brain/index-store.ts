// Local-brain notes index. A SELF-CONTAINED sqlite + sqlite-vec store for a
// user-chosen notes folder, kept deliberately separate from the main
// `lamprey.db` RAG schema so the in-process brain is a drop-in unit with its
// own lifecycle: it can be reindexed, deleted, and reasoned about without
// touching conversation/RAG persistence.
//
// What we REUSE (not reinvent):
//   - `loadSqliteVec` / `isVecAvailable` from rag/vec-loader.ts — the exact
//     same try/catch extension loader the main DB uses.
//   - the EmbeddingsService singleton (rag/embeddings/service.ts) which owns
//     the @huggingface/transformers worker, batching, and model download. We embed
//     through it so there is ONE onnxruntime worker for the whole app.
//   - the vec0 `FLOAT[384]` shape + the chunk/vec insert pattern from
//     rag/store.ts (Buffer.from(vector.buffer); KNN via `embedding MATCH ? AND k = ?`).
//
// The default embedder (bge-small-en-v1.5) is 384-dim, matching the vec0 table.

import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { readdirSync, readFileSync, statSync } from 'fs'
import { extname, join, relative, sep } from 'path'
import type { RetrievalTunables } from './retrieval-tunables'
import { loadSqliteVec, isVecAvailable } from '../rag/vec-loader'
import { getEmbeddingsService } from '../rag/embeddings/service'
import { DEFAULT_EMBEDDER_ID, getEmbedder } from '../rag/embeddings/catalog'
import { loadDocument, isSupportedTextExtension, isOfficeExtension, isIWorkExtension, isImageExtension, ocrEnabled, isAudioExtension, audioTranscribeEnabled, isCanvasExtension } from '../rag/loaders'
import { fuseRRF } from '../rag/retrieve'
import { messageOf } from '../guarded'
import { backupMoatState } from './moat-backup'
import { cjkTokens } from '../brain/cjk-tokens'
import { resolveNoteDate } from './note-date'

// F5 (north-star #1) — ingest ANY existing files/folders, not just markdown.
// Reuses the RAG loaders: pdf (pdf-parse) + docx (mammoth) + MS Office &
// OpenDocument (officeParser: pptx/xlsx/odt/odp/ods/rtf) + Apple iWork
// (pages/numbers/key, graceful) + a broad text set (md/mdx/txt/json/csv/html/…).
// Unsupported files are skipped gracefully.
// Image extensions (png/jpg/screenshots/scans) are ingestable ONLY when the
// OCR feature flag (DUIN_OCR) is on — flag-off, a vault indexes byte-identically
// to today (images skipped). See rag/loaders/ocr.ts.
// Audio extensions (m4a/mp3/wav/ogg) are ingestable ONLY when the voice-memo
// transcription flag (DUIN_AUDIO_TRANSCRIBE, default OFF) is on AND a whisper
// binary is present — flag-off, audio files are skipped. See rag/loaders/audio.ts.
export function isIngestable(name: string): boolean {
  const ext = extname(name).toLowerCase()
  return (
    ext === '.pdf' ||
    ext === '.docx' ||
    isOfficeExtension(name) ||
    isIWorkExtension(name) ||
    isSupportedTextExtension(name) ||
    isCanvasExtension(name) ||
    (ocrEnabled() && isImageExtension(name)) ||
    (audioTranscribeEnabled() && isAudioExtension(name))
  )
}
const CHUNK_SIZE = 800
const CHUNK_OVERLAP = 100
// Walk guard — a runaway/symlinked notes tree shouldn't index the universe.
const MAX_FILES = 10_000
const MAX_DEPTH = 12
// Directories we never index: VCS, editor caches, our own derived vector store,
// and dependency trees. Real content dot-folders (.claude, .agents, …) ARE indexed
// so the graph matches the harness brain's full vault field.
// `.duin` and `.brain` are the app's OWN state dirs (_state ledgers, _eval-fixtures
// behavioral A/B
// transcripts, loops, _moat) — machinery, NOT vault content. It was being indexed
// as notes: 5001 chunks / 36% of the index (2689 alone under _eval-fixtures), high-
// frequency noise that mentions every term and crowds real notes out of the
// candidate pool (a terse decision note loses its slot to dozens of fixtures). The
// engines read `.duin/_state/*` directly, never via search, so excluding it from the
// retrieval index is pure signal gain. (`.duin` ≠ the `DUIN/` content pillar.)
// NOTE: `.brain` is skipped wholesale here, but `collectNoteFiles` appends a SCOPED
// carve-out that re-includes `.brain/memory/*.md` ONLY (the OKF concept skeleton) so
// the scaffolded knowledge is retrievable — everything else under `.brain/` stays out.
// Release M11 (A6 F7): agent/tool configuration trees are not the operator's knowledge. A vault
// that doubles as a repo carries `.claude/` (Claude Code memory, commands, hooks), `.codex/`,
// `.agents/`, `.cursor/` (rules), `.github/` (workflows, templates); indexing them puts
// instruction files written FOR an agent into the retrieval pool the brain answers from — and
// a vault CLAUDE.md is already adopted as instructions by agents-md-loader.ts. Skipped here;
// notes-watcher.shouldIgnore mirrors the list so an edit there never triggers a reindex either.
export const AGENT_CONFIG_DIRS = ['.claude', '.codex', '.agents', '.cursor', '.github'] as const
const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', '.smart-env', 'node_modules', '.duin', '.brain', ...AGENT_CONFIG_DIRS])

export interface SearchHit {
  file: string
  snippet: string
  /** RELATIVE rank score. After fusion this is TOP-NORMALIZED: the best hit is
   *  always exactly 1.0, whatever its true relevance. Good for ordering, useless
   *  as a confidence measure — compare thresholds against `rawScore` instead. */
  score: number
  /** ABSOLUTE relevance of this file, cosine-ish in [0,1], surviving fusion
   *  un-normalized. Undefined when the vector leg produced nothing for this file
   *  (vector search unavailable, or a lexical-only match — BM25 has no absolute
   *  scale to report). Consumers must treat "absent" as "no signal", not as 0. */
  rawScore?: number
}

export interface ChunkRow {
  rowid: number
  file: string
  text: string
}

let db: Database.Database | null = null
let dbPath: string | null = null
let indexedDocCount = 0
let userDataPath: string | null = null

/** Wire the userData path once at boot (mirrors providers/registry's injection
 *  so this module needs no electron import in tests). */
export function setLocalBrainUserDataPath(path: string): void {
  userDataPath = path
}

/** The wired userData path (for siblings that need to locate the brain's dir). */
export function getLocalBrainUserDataPath(): string | null {
  return userDataPath
}

// ──────────────────── live index-progress broadcast ────────────────────
// reindex() runs off the boot path in the main process; the renderer used to see
// only a COARSE phase (queued→chunking→embedding→ready) with no counts, so a big
// first index looked frozen. We push a per-tick `rag:index:progress` message
// carrying {phase, done, total} to every renderer window — the same live fan-out
// ipc/rag.ts uses for `rag:document:progress`. Electron is lazily required + fully
// guarded so this module still loads under vitest (no electron) and the pure-function
// tests are unaffected; progress is best-effort and never throws into reindex.
export type IndexProgressPhase = 'scanning' | 'chunking' | 'embedding' | 'ready'
export interface IndexProgressEvent {
  phase: IndexProgressPhase
  done: number
  total: number
}

function emitIndexProgress(phase: IndexProgressPhase, done: number, total: number): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BrowserWindow } = require('electron') as typeof import('electron')
    const payload: IndexProgressEvent = { phase, done, total }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('rag:index:progress', payload)
    }
  } catch {
    // no electron (tests) / no windows / mid-shutdown — best-effort only
  }
}

/** Emit a progress tick only every ~1/50th of the total (plus the final one), so a
 *  10k-file vault sends ~50 messages per phase, not 10k. PURE-ish (side-effect is the
 *  broadcast); `done`/`total` are 1-based counts. */
function emitProgressThrottled(phase: IndexProgressPhase, done: number, total: number): void {
  const step = Math.max(1, Math.floor(total / 50))
  if (done % step === 0 || done >= total) emitIndexProgress(phase, done, total)
}

/** Fallback vec width when no embedder meta is recorded (the legacy default). */
const VEC_DIM_DEFAULT = 384

/** The active embedder's declared dimension (catalogue). The probe (service
 *  layer) validates this against the model's real output before a switch. */
function activeEmbedderDim(): number {
  return getEmbedder(resolveEmbedderId())?.dimensions ?? VEC_DIM_DEFAULT
}

export function readIndexMeta(handle: Database.Database, key: string): string | null {
  try {
    const row = handle.prepare('SELECT value FROM index_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

export function writeIndexMeta(handle: Database.Database, key: string, value: string): void {
  try {
    handle
      .prepare('INSERT INTO index_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  } catch (err) {
    console.warn('[local-brain] index_meta write failed:', (err as Error).message)
  }
}

/** PURE decision: does the index need a vec rebuild? True when the embedder id
 *  OR its dimension differs from what the current vectors were built with — the
 *  stored vectors are model-specific, so even a same-width switch is incompatible. */
export function vecMigrationNeeded(
  storedId: string | null,
  storedDim: number,
  activeId: string,
  targetDim: number
): boolean {
  return storedId !== activeId || storedDim !== targetDim
}

/** Record which embedder/dim the CURRENT vectors were built with. This is the
 *  migration's DONE-MARKER: once written, vecMigrationNeeded() returns false and
 *  the re-embed never runs again. Stamp it only after the rebuild has actually
 *  finished (see reindexImpl) — same deferral discipline as writeLedger. */
export function stampEmbedderMeta(handle: Database.Database, activeId: string, targetDim: number): void {
  writeIndexMeta(handle, 'embedder_id', activeId)
  writeIndexMeta(handle, 'embedder_dim', String(targetDim))
}

/**
 * Rebuild notes_vec when the active embedder (or its dimension) differs from the
 * one the current vectors were built with — drop + recreate at the target dim
 * and let the caller's reindex re-embed. Returns true when a migration happened.
 * `override` lets tests drive a switch without mutating the catalogue default.
 *
 * `opts.deferStamp` leaves the embedder_id/embedder_dim done-marker UNWRITTEN so
 * the caller can stamp it once the re-embed has completed. Stamping here (the old
 * behaviour) marked the migration done BEFORE a ~40-minute awaited rebuild; an
 * interruption anywhere in that window left the marker saying "done" while the
 * work was half-finished, and because the id then matched, the rebuild was never
 * retried. Callers that own a rebuild pass MUST defer.
 */
export function maybeMigrateVecTable(
  handle: Database.Database,
  override?: { activeId: string; targetDim: number },
  opts?: { deferStamp?: boolean }
): boolean {
  if (!isVecAvailable()) return false
  const activeId = override?.activeId ?? resolveEmbedderId()
  const targetDim = override?.targetDim ?? activeEmbedderDim()
  const storedId = readIndexMeta(handle, 'embedder_id')
  const storedDim = Number(readIndexMeta(handle, 'embedder_dim') ?? '') || VEC_DIM_DEFAULT
  if (!vecMigrationNeeded(storedId, storedDim, activeId, targetDim)) return false
  try {
    handle.exec('DROP TABLE IF EXISTS notes_vec')
    handle.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS notes_vec USING vec0(embedding FLOAT[${targetDim}]);`)
    if (!opts?.deferStamp) stampEmbedderMeta(handle, activeId, targetDim)
    console.log(
      `[local-brain] embedder changed (${storedId ?? 'none'} → ${activeId}, ` +
        `dim ${storedDim} → ${targetDim}); notes_vec rebuilt, reindexing`
    )
    return true
  } catch (err) {
    console.warn('[local-brain] vec table migration failed:', (err as Error).message)
    return false
  }
}

function getDbFor(path: string): Database.Database {
  if (db && dbPath === path) return db
  if (db) {
    try {
      db.close()
    } catch {
      // already closed
    }
    db = null
  }
  const handle = new Database(path)
  handle.pragma('journal_mode = WAL')
  // Load sqlite-vec BEFORE creating the vec0 table — same ordering as
  // database.ts. When the extension is unavailable we fall back to a
  // LIKE-scan over the chunk text (still useful, just no semantic ranking).
  loadSqliteVec(handle)
  handle.exec(`
    CREATE TABLE IF NOT EXISTS notes_chunks (
      id INTEGER PRIMARY KEY,
      file TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_chunks_file ON notes_chunks(file);
    CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT);
    -- Per-file content hash ledger for INCREMENTAL reindex: a file whose hash is
    -- unchanged keeps its chunks + vectors untouched (no re-embed). Only FILE
    -- notes are tracked here; src/ ingested rows are owned by ingestFromSource.
    CREATE TABLE IF NOT EXISTS notes_files (file TEXT PRIMARY KEY, hash TEXT NOT NULL, mtime INTEGER);
  `)
  // Migrate DBs that predate the mtime column (file last-modified ms — powers
  // recency display in the brain graph). ALTER throws if it already exists → ignore.
  try {
    handle.exec('ALTER TABLE notes_files ADD COLUMN mtime INTEGER')
  } catch (e) { console.debug('[index-store] column already present:', messageOf(e)) }
  // note_date = when the note is ABOUT (frontmatter -> filename -> mtime), note_date_src = which
  // rule produced it. Same ALTER-and-ignore precedent as mtime above. Pre-upgrade rows read NULL,
  // which means UNKNOWN and is never back-inferred — see note-date.ts.
  for (const ddl of [
    'ALTER TABLE notes_files ADD COLUMN note_date INTEGER',
    'ALTER TABLE notes_files ADD COLUMN note_date_src TEXT'
  ]) {
    try {
      handle.exec(ddl)
    } catch (e) { console.debug('[index-store] column already present:', messageOf(e)) }
  }
  // The window filter joins chunks -> files and ranges on this, so it needs its own index.
  try {
    handle.exec('CREATE INDEX IF NOT EXISTS idx_notes_files_note_date ON notes_files(note_date)')
  } catch (e) { console.debug('[index-store] note_date index:', messageOf(e)) }
  if (isVecAvailable()) {
    // Dimension is NOT hardcoded: a fresh index adopts the active embedder's
    // width (and records it); an existing index keeps its stored width until a
    // reindex migrates it (maybeMigrateVecTable). Lets non-384 embedders
    // (e.g. bge-m3 = 1024) work without a schema rewrite.
    const stored = readIndexMeta(handle, 'embedder_dim')
    const dim = stored ? Number(stored) || VEC_DIM_DEFAULT : activeEmbedderDim()
    if (!stored) {
      writeIndexMeta(handle, 'embedder_id', resolveEmbedderId())
      writeIndexMeta(handle, 'embedder_dim', String(dim))
    }
    try {
      handle.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS notes_vec USING vec0(embedding FLOAT[${dim}]);`)
    } catch (err) {
      console.warn('[local-brain] notes_vec create failed:', (err as Error).message)
    }
  }
  db = handle
  dbPath = path
  // Reflect any rows that survived a previous session.
  try {
    const row = handle
      .prepare('SELECT COUNT(DISTINCT file) AS n FROM notes_chunks')
      .get() as { n: number }
    indexedDocCount = row.n
  } catch {
    indexedDocCount = 0
  }
  return handle
}

function resolveDbPath(): string {
  if (!userDataPath) {
    throw new Error('local-brain index-store: userDataPath not set (call setLocalBrainUserDataPath)')
  }
  return join(userDataPath, 'local-brain.db')
}

/** STRUCTURE-AWARE chunking (Retrieval score-lift). The old splitter cut every
 *  CHUNK_SIZE chars regardless of content — mid-word, mid-sentence, splitting a
 *  markdown heading from its prose — which weakens BOTH the lexical (broken terms)
 *  and embedding (incoherent span) base signals. This splits on NATURAL boundaries
 *  (blank-line paragraph/heading/list breaks) and packs whole blocks into ~CHUNK_SIZE
 *  windows; only a single block larger than CHUNK_SIZE is broken further, on sentence
 *  boundaries, and only a single over-long sentence is hard-windowed (with overlap).
 *  PURE — unit-tested. Empty → []; text ≤ CHUNK_SIZE → one chunk (unchanged). */
export function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (clean.length === 0) return []
  if (clean.length <= CHUNK_SIZE) return [clean]

  const chunks: string[] = []
  let buf = ''
  const flush = (): void => {
    const t = buf.trim()
    if (t) chunks.push(t)
    buf = ''
  }
  for (const block of splitIntoBlocks(clean)) {
    if (block.length > CHUNK_SIZE) {
      flush()
      for (const piece of splitOversizedBlock(block)) {
        if (buf && buf.length + piece.length + 1 > CHUNK_SIZE) flush()
        buf = buf ? `${buf} ${piece}` : piece
      }
      continue
    }
    // Pack whole blocks until adding the next would overflow, then start a fresh chunk.
    if (buf && buf.length + block.length + 2 > CHUNK_SIZE) flush()
    buf = buf ? `${buf}\n\n${block}` : block
  }
  flush()
  // Defensive: never return empty for non-empty input (e.g. a single giant token).
  return chunks.length ? chunks : [clean.slice(0, CHUNK_SIZE)]
}

/** Paragraph/heading/list units — blank-line separated, trimmed, non-empty. PURE. */
function splitIntoBlocks(text: string): string[] {
  return text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
}

/** Break a single over-CHUNK_SIZE block on sentence enders (Latin + CJK); a single
 *  sentence still longer than CHUNK_SIZE is hard-windowed with CHUNK_OVERLAP. PURE. */
function splitOversizedBlock(block: string): string[] {
  const sentences = block.match(/[^.!?。！？\n]+[.!?。！？]*\s*/g) ?? [block]
  const out: string[] = []
  for (const s of sentences) {
    const t = s.trim()
    if (!t) continue
    if (t.length <= CHUNK_SIZE) {
      out.push(t)
      continue
    }
    for (let i = 0; i < t.length; i += Math.max(1, CHUNK_SIZE - CHUNK_OVERLAP)) {
      out.push(t.slice(i, i + CHUNK_SIZE))
      if (i + CHUNK_SIZE >= t.length) break
    }
  }
  return out
}

export function collectNoteFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        // Skip VCS/editor/derived/dep + app-state trees AND agent/tool config trees
        // (.claude/.codex/.agents/.cursor/.github — AGENT_CONFIG_DIRS). Other dot-folders
        // are still content and are descended into.
        if (SKIP_DIRS.has(entry.name)) continue
        // NOTE (identity-spine P5, "machine files only"): `DUIN/Meta/` holds design cards +
        // specs — REAL knowledge — so it is NOT excluded here. It is indexed + retrievable
        // like any other content pillar. Scaffolding is scoped to `_`-prefixed FILES (below).
        walk(full, depth + 1)
      } else if (entry.isFile()) {
        // Skip dotfiles (.env, .bucket.json, .DS_Store) — secrets/noise, never content.
        if (entry.name.startsWith('.')) continue
        // Skip `_`-prefixed machine files (indexes, logs, metrics, dashboards,
        // prototypes, seeds: _concept-index.md, _dashboard.md, _metrics.md, …). These
        // are scaffolding, NOT knowledge. Scoped to the FILE basename only — legit
        // content living in `_`-prefixed DIRS (ProjectA/…/_原始转录, …/_ocr) has normal
        // file names and survives, so no real note is dropped. (identity-spine §5⑥.)
        if (entry.name.startsWith('_')) continue
        if (isIngestable(entry.name)) out.push(full)
      }
    }
  }
  walk(dir, 0)
  // SCOPED CARVE-OUT: `.brain/` is in SKIP_DIRS (DUIN's own state — _moat ledgers,
  // config.json, caches — must NEVER reach retrieval), so the walk above excludes it
  // wholesale. But the OKF cold-start scaffold writes the user's TYPED concept skeleton
  // (goals/decisions/people pillars + interview-derived concepts) to `.brain/memory/*.md`,
  // which left them indexed nowhere → un-searchable, un-citable in chat. Re-include the
  // `.brain/memory` subtree — `.md` ONLY — so a fresh-vault user can ASK about their
  // scaffolded knowledge and get it grounded. Everything else under `.brain/` stays skipped.
  collectBrainMemoryFiles(join(dir, '.brain', 'memory'), out)
  return out
}

/** Include-pass for the OKF concept notes under `<vault>/.brain/memory`. Collects
 *  `.md` files ONLY (never `.json`/state) and never descends into a nested dot-dir,
 *  so `.brain/_moat/*.json`, `.brain/config.json`, and the rest of DUIN's internal
 *  state can never leak into the retrieval index. Mutates the shared `out` array so
 *  the global MAX_FILES bound still applies. */
function collectBrainMemoryFiles(memoryDir: string, out: string[]): void {
  const walk = (current: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue // no nested dot-dirs (no state leak)
        walk(full, depth + 1)
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
        out.push(full)
      }
    }
  }
  walk(memoryDir, 0)
}

/**
 * (Re)index a notes folder into the local store. Gracefully no-ops when the
 * dir is empty/unset/unreadable, leaving any prior index in place only if the
 * same dir is re-passed; an empty/missing dir clears the index so the graph
 * and search reflect reality.
 *
 * Returns the number of distinct note files indexed.
 */
export interface ReindexPlan {
  /** Unchanged files (content hash matches the ledger) — chunks + vectors kept. */
  keep: string[]
  /** New or modified files — re-chunk + re-embed. */
  changed: string[]
}

/**
 * Pure incremental-reindex decision: partition the CURRENT files (file → content
 * hash) against the STORED hash ledger into `keep` (unchanged) vs `changed` (new or
 * modified). Removed files are implicit — present in `stored` but not `current` —
 * and are pruned by rel-path (everything not in `keep`). This is the testable core;
 * the chunk/vector deletion + ledger write execute against the DB (verified live,
 * like every index-store DB op, since better-sqlite3 doesn't load under vitest).
 */
export function planReindex(
  current: Map<string, string>,
  stored: Map<string, string>
): ReindexPlan {
  const keep: string[] = []
  const changed: string[] = []
  for (const [file, hash] of current) {
    if (stored.get(file) === hash) keep.push(file)
    else changed.push(file)
  }
  return { keep, changed }
}

let reindexInFlight: Promise<number> | null = null
let reindexInFlightDir: string | null | undefined = null
let reindexInFlightGeneration = 0
let reindexDirty = false
let reindexDirtyDir: string | null | undefined = null
let reindexGeneration = 0
const completedReindexes = new Map<string, { generation: number; count: number }>()
let reindexRunnerForTest: ((dir: string | null | undefined) => Promise<number>) | null = null

function reindexRequestKey(dir: string | null | undefined): string {
  return typeof dir === 'string' ? dir : ''
}
/** Concurrency-guarded reindex. Multiple triggers (boot + notes-watcher + settings)
 *  firing together used to prune + rebuild the SAME index in parallel, thrashing the
 *  chunk table so the brain graph blinked empty. Coalesce onto the in-flight run —
 *  but a change arriving mid-run isn't in that run's snapshotted file list, so mark
 *  dirty and re-run ONCE when it settles (trailing-edge) instead of dropping it. */
export function reindex(dir: string | null | undefined): Promise<number> {
  if (reindexInFlight) {
    reindexDirty = true
    reindexDirtyDir = dir
    return reindexInFlight
  }
  return startReindex(dir)
}

function startReindex(dir: string | null | undefined): Promise<number> {
  const generation = ++reindexGeneration
  const key = reindexRequestKey(dir)
  reindexInFlightDir = dir
  reindexInFlightGeneration = generation
  const runner = reindexRunnerForTest ?? reindexImpl
  reindexInFlight = runner(dir).then((count) => {
    completedReindexes.set(key, { generation, count })
    return count
  }).finally(() => {
    reindexInFlight = null
    reindexInFlightDir = null
    reindexInFlightGeneration = 0
    if (reindexDirty) {
      reindexDirty = false
      const trailingDir = reindexDirtyDir
      reindexDirtyDir = null
      void startReindex(trailingDir) // pick up the change that arrived mid-run
    }
  })
  return reindexInFlight
}

/**
 * Await a pass that started after this request and indexed this exact directory.
 *
 * Ordinary `reindex()` intentionally coalesces callers onto the current pass and
 * runs only the latest requested directory on the trailing edge. That is correct
 * for background refreshes, but a vault-adoption coordinator must not publish B
 * as ready merely because an already-running pass for A completed. This method
 * keeps the coalescing policy and waits until its own directory generation lands.
 */
export async function reindexUntilReady(dir: string | null | undefined): Promise<number> {
  const key = reindexRequestKey(dir)
  const minimumGeneration = reindexGeneration + 1

  while (true) {
    const completed = completedReindexes.get(key)
    const newerPassIsRunning =
      completed !== undefined &&
      reindexInFlight !== null &&
      reindexInFlightGeneration > completed.generation
    if (completed && completed.generation >= minimumGeneration && !newerPassIsRunning) {
      return completed.count
    }

    if (!reindexInFlight) {
      // No pass can satisfy this request, so start the required one directly.
      await startReindex(dir)
      continue
    }

    const pass = reindexInFlight
    const passGeneration = reindexInFlightGeneration
    const passIsRequiredTarget =
      reindexRequestKey(reindexInFlightDir) === key && passGeneration >= minimumGeneration

    if (!passIsRequiredTarget) {
      // Preserve the existing latest-request-wins trailing edge. If another
      // caller supersedes this slot, the loop observes that pass and requeues.
      reindexDirty = true
      reindexDirtyDir = dir
    }

    try {
      await pass
    } catch (error) {
      // An unrelated pass failing must not cancel this directory's readiness
      // request. A failure from the required target pass is the real outcome.
      if (passIsRequiredTarget) throw error
    }
  }
}

/** Vector self-heal decision: the index has text chunks + a hash ledger but ZERO
 *  vectors — semantic search is silently dead (best-effort embed failed after the
 *  chunk/ledger commit, or a vec rebuild wasn't followed by a ledger clear). True →
 *  clear the ledger so a reindex re-embeds everything. Pure so it's unit-testable
 *  without a live embedder (which needs the Electron runtime). */
export function needsVectorReheal(fileChunks: number, ledger: number, vecRows: number): boolean {
  return fileChunks > 0 && ledger > 0 && vecRows === 0
}

/** Strip a leading YAML frontmatter block (`---\n … \n---`) so chunk text + embeddings
 *  reflect the note's CONTENT, not its metadata. Only a frontmatter at the very start
 *  is removed (a `---` horizontal rule mid-body is left alone). Pure + unit-tested. */
export function stripFrontmatter(text: string): string {
  return text.replace(/^\uFEFF?[ \t]*---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '')
}

async function reindexImpl(dir: string | null | undefined): Promise<number> {
  if (!dir || typeof dir !== 'string' || dir.trim() === '') {
    // No notes dir configured — clear any prior index so /health and /graph
    // report an empty (not stale) state.
    try {
      clearFileNotes(getDbFor(resolveDbPath()))
    } catch {
      // store unavailable; nothing to clear
    }
    indexedDocCount = 0
    emitIndexProgress('ready', 0, 0)
    return 0
  }

  let stat: import('fs').Stats
  try {
    stat = statSync(dir)
  } catch {
    indexedDocCount = 0
    emitIndexProgress('ready', 0, 0)
    return 0
  }
  if (!stat.isDirectory()) {
    indexedDocCount = 0
    emitIndexProgress('ready', 0, 0)
    return 0
  }

  // Data-safety net: snapshot the moat (claim ledger + construction cache) BEFORE the
  // destructive prune / self-heal ledger-clear below opens the clobber window. Best-effort,
  // content-deduped, shrink-guarded — a file-watch reindex that changed nothing writes nothing,
  // and a clobbered state can't overwrite the good backups. See moat-backup.ts.
  backupMoatState(dir, 'pre-reindex')

  const files = collectNoteFiles(dir)
  const handle = getDbFor(resolveDbPath())
  // Kick off the visible progress lifecycle: scanning = load+hash each file.
  emitIndexProgress('scanning', 0, files.length)

  // Self-heal a desynced index: if the chunk table is empty but the hash ledger
  // isn't, a prior reindex died mid-embed (e.g. a native embed crash) and left the
  // graph permanently stuck empty — the ledger's hashes match, so nothing counts as
  // "changed" and the chunks never rebuild. Clearing the ledger makes every file
  // changed again so the chunks (and the whole brain graph) rebuild.
  try {
    const fileChunks = (handle.prepare('SELECT COUNT(*) AS n FROM notes_chunks WHERE file NOT LIKE ?').get(`${SRC_PREFIX}%`) as { n: number }).n
    const ledger = (handle.prepare('SELECT COUNT(*) AS n FROM notes_files').get() as { n: number }).n
    if (fileChunks === 0 && ledger > 0) {
      console.warn(`[local-brain] index desync (0 note chunks, ${ledger} ledger rows) — clearing ledger to force a full rebuild`)
      handle.prepare('DELETE FROM notes_files').run()
    }
  } catch (e) { console.debug('[index-store] best-effort self-heal:', messageOf(e)) }

  // Self-heal a VECTOR desync: chunks + ledger present but notes_vec is EMPTY. The
  // embed pass is best-effort AFTER the chunk commit (see persistPending) and the
  // ledger is written regardless — so a reindex whose embed failed/timed out (or a
  // vec-table rebuild without a matching ledger clear) strands the index with text
  // chunks but ZERO vectors: the embedder_id is unchanged so maybeMigrateVecTable
  // won't fire, and the chunks-empty heal above doesn't catch it (chunks exist).
  // Result: hybrid search silently degrades to lexical-only forever. Detect it and
  // clear the ledger so every file re-embeds. (Only total-emptiness — a cheap,
  // unambiguous signal; partial gaps are left to normal incremental change-detection.)
  // Only when embeddings are ENABLED — if the kill-switch is on, 0 vectors is the
  // intended state, not a desync, and re-healing would thrash a full rebuild every boot.
  try {
    if (EMBEDDINGS_ENABLED && isVecAvailable()) {
      const fileChunks = (handle.prepare('SELECT COUNT(*) AS n FROM notes_chunks WHERE file NOT LIKE ?').get(`${SRC_PREFIX}%`) as { n: number }).n
      const ledger = (handle.prepare('SELECT COUNT(*) AS n FROM notes_files').get() as { n: number }).n
      const vecRows = (handle.prepare('SELECT COUNT(*) AS n FROM notes_vec').get() as { n: number }).n
      if (needsVectorReheal(fileChunks, ledger, vecRows)) {
        console.warn(`[local-brain] vector desync (${fileChunks} chunks, 0 vectors) — clearing ledger to force a full re-embed`)
        handle.prepare('DELETE FROM notes_files').run()
      }
    }
  } catch (e) { console.debug('[index-store] best-effort self-heal (e.g. notes_vec unavailable):', messageOf(e)) }

  // An embedder/dim change invalidates ALL stored vectors — rebuild notes_vec AND
  // clear the per-file hash ledger so nothing counts as "unchanged" (force a full
  // re-embed at the new dim).
  // The done-marker (index_meta embedder_id/dim) is DEFERRED to the end of this
  // function, next to writeLedger, for exactly the reason the ledger is: everything
  // between here and there is an awaited rebuild (~20 embed batches x 120s), and an
  // interruption must leave the index looking UNMIGRATED so the next run redoes it.
  // Stamping up front made the src/ re-embed below a one-shot with no retry path.
  const activeEmbedder = { activeId: resolveEmbedderId(), targetDim: activeEmbedderDim() }
  const vecMigrated = maybeMigrateVecTable(handle, activeEmbedder, { deferStamp: true })
  if (vecMigrated) handle.prepare('DELETE FROM notes_files').run()

  // Load + CONTENT-hash every current file (hash the extracted text, pre-chunk;
  // mtime lies across sync/copy). This is the incremental spine: a file whose hash
  // matches the stored one KEEPS its chunks + vectors untouched — no re-embed —
  // which is what turns the ~24-min full rebuild into a diff.
  const current = new Map<
    string,
    { raw: string; hash: string; mtime: number; noteDate: number | null; noteDateSrc: string | null }
  >()
  let scanned = 0
  for (const file of files) {
    scanned++
    // Load+extract is the slow part here (pdf/docx parse); tick as it advances.
    emitProgressThrottled('scanning', scanned, files.length)
    let raw: string
    try {
      // F5 — format-aware extraction (pdf/docx/text/html) via the RAG loaders.
      const doc = await loadDocument(file)
      raw = doc.kind === 'text' ? doc.text : doc.pages.map((p) => p.text).join('\n\n')
    } catch {
      continue // unsupported / unreadable — skip gracefully
    }
    // Strip leading YAML frontmatter BEFORE chunk/embed/hash. A note's ~40% metadata
    // head (type/date/owner/method/tags) otherwise dilutes its embedding into generic
    // "decision-metadata" space, dropping it out of the vector candidate pool — the
    // reason a decision note wasn't recalled for its own topic. Content-only text
    // embeds on what the note is ABOUT. (Hash follows the stripped text, so this
    // forces a one-time re-embed on rollout.)
    // Kept because resolveNoteDate's highest-precedence rung parses the frontmatter block that
    // the next line deletes; reading the date off the stripped text silently demotes every
    // frontmatter-dated note to its filename or mtime.
    const rawWithFrontmatter = raw
    raw = stripFrontmatter(raw)
    if (!raw || !raw.trim()) continue
    const rel = relative(dir, file).split(sep).join('/')
    // Data-integrity guard (deferred code-review finding): a user note under a
    // top-level `src/` folder collides with the reserved connector namespace
    // (SRC_PREFIX). clearFileNotes/pruneToKeep PRESERVE `src/%` as ingested rows, so
    // such a note would never be cleared → duplicated on every reindex, and deleting
    // it on disk would never remove its stale rows. Skip it (rare; only code-adjacent
    // vaults) with a warning rather than corrupt the index.
    if (rel === 'src' || rel.startsWith(SRC_PREFIX)) {
      console.warn(`[local-brain] skipping note under reserved '${SRC_PREFIX}' namespace (collides with connector ids): ${rel}`)
      continue
    }
    // File last-modified (ms) for recency display — captured here since the file is
    // already being read; 0 if the stat fails (kept out of the change-detection path,
    // which stays content-hash based per the note above).
    let mtime = 0
    try { mtime = Math.round(statSync(file).mtimeMs) } catch (e) { console.debug('[index-store] keep 0:', messageOf(e)) }
    // When the note is ABOUT — distinct from mtime, which is when its bytes moved. Computed here
    // because `raw` and the stat are both already in hand; storing it is what lets retrieval FILTER
    // by period instead of merely boosting recency.
    const nd = resolveNoteDate(rawWithFrontmatter, rel, mtime)
    current.set(rel, {
      raw,
      hash: createHash('sha1').update(raw).digest('hex'),
      mtime,
      noteDate: nd?.date ?? null,
      noteDateSrc: nd?.src ?? null
    })
  }

  const stored = new Map<string, string>()
  for (const r of handle.prepare('SELECT file, hash FROM notes_files').all() as {
    file: string
    hash: string
  }[]) {
    stored.set(r.file, r.hash)
  }
  const { keep, changed } = planReindex(
    new Map([...current].map(([f, v]) => [f, v.hash])),
    stored
  )

  // Delete chunks + vectors for every FILE note NOT kept — covers changed files'
  // old rows, removed files, and pre-upgrade orphans in one pass. `src/` ingested
  // rows are preserved; the vec deletion is keyed by chunk id so notes_vec never
  // desyncs from notes_chunks.
  pruneToKeep(handle, keep)

  // Re-chunk + embed ONLY the changed/new files (the batched embed pass).
  emitIndexProgress('chunking', 0, changed.length)
  const pending: { file: string; chunkIndex: number; text: string }[] = []
  let chunkedFiles = 0
  for (const rel of changed) {
    chunkText(current.get(rel)!.raw).forEach((text, chunkIndex) =>
      pending.push({ file: rel, chunkIndex, text })
    )
    chunkedFiles++
    emitProgressThrottled('chunking', chunkedFiles, changed.length)
  }
  // Best-effort embed (chunks are already committed by persistPending regardless),
  // in INCREMENTAL BATCHES. A single all-chunks call embeds thousands of chunks
  // sequentially inside ONE EMBED_TIMEOUT_MS window — on CPU that always trips the
  // timeout (e.g. ~1800 forward passes ≫ 120s), so the whole pass returns text-only
  // and persists ZERO vectors, silently killing semantic search. Batching keeps each
  // embed call small enough to finish and COMMIT its vectors before the next, so
  // progress is durable + resumable and a slow span costs one batch, not the index.
  const PERSIST_BATCH = 256
  // Embedding is the long pole (thousands of forward passes) — emit COUNTS per
  // committed batch so the renderer shows real "N / M chunks embedded" movement.
  emitIndexProgress('embedding', 0, pending.length)
  for (let i = 0; i < pending.length; i += PERSIST_BATCH) {
    await persistPending(handle, pending.slice(i, i + PERSIST_BATCH))
    emitIndexProgress('embedding', Math.min(i + PERSIST_BATCH, pending.length), pending.length)
  }

  // Data-integrity (deferred code-review finding): a vec-table migration (embedder/dim
  // change — including EVERY runEmbedderEval candidate) DROPs notes_vec entirely, but
  // the pass above re-embeds only FILE notes. Ingested connector chunks (src/…) keep
  // their text rows but lost their vectors, so search()'s vector leg silently excludes
  // ALL connector-ingested content until each source is manually re-synced. After a
  // migration, re-embed the preserved src/ chunks too (delete+re-persist so persistPending
  // reassigns rowids consistently between notes_chunks and notes_vec).
  if (vecMigrated) {
    await remigrateSrcChunks(
      handle,
      (rows, replaceIds) => persistPending(handle, rows, replaceIds),
      { batchSize: PERSIST_BATCH, onProgress: (done, total) => emitIndexProgress('embedding', done, total) }
    )
  }

  // Rebuild the hash ledger to reality. We record EVERY current file's hash once
  // its chunk TEXT is written — NOT gated on embedding — because the brain graph +
  // lexical search only need the text. Gating on embed success used to leave the
  // ledger empty whenever the embedder was broken, so reindex re-pruned + rebuilt
  // every cycle and the graph blinked empty. Missing vectors backfill when the
  // embedder id/dim changes (maybeMigrateVecTable clears this ledger) or on an
  // explicit reindex; they no longer hold the whole index hostage.
  const writeLedger = handle.transaction(() => {
    handle.prepare('DELETE FROM notes_files').run()
    const ins = handle.prepare(
      'INSERT INTO notes_files(file, hash, mtime, note_date, note_date_src) VALUES (?, ?, ?, ?, ?)'
    )
    const put = (rel: string): void => {
      const c = current.get(rel)!
      ins.run(rel, c.hash, c.mtime, c.noteDate, c.noteDateSrc)
    }
    for (const rel of keep) put(rel)
    for (const rel of changed) put(rel)
  })
  writeLedger()

  // Migration done-marker, written LAST — deliberately after the src/ re-embed
  // above (see maybeMigrateVecTable's deferStamp note). Until this line runs the
  // index still reads as built by the OLD embedder, so an interrupted migration
  // re-migrates and re-embeds on the next reindex instead of being skipped forever.
  if (vecMigrated) {
    stampEmbedderMeta(handle, activeEmbedder.activeId, activeEmbedder.targetDim)
    console.log(`[local-brain] embedder migration complete; index stamped ${activeEmbedder.activeId}/${activeEmbedder.targetDim}`)
  }

  indexedDocCount = current.size
  // Final tick: the index reflects reality now (done === total files indexed).
  emitIndexProgress('ready', current.size, current.size)
  return current.size
}

/** Delete chunks + vectors for every FILE note whose rel-path is NOT in `keep`
 *  (changed / removed / orphaned), preserving `src/` ingested rows. Uses a temp
 *  table so it scales past the SQL bound-variable limit on large vaults. The vec
 *  rows are deleted by chunk id, keeping notes_vec in lockstep with notes_chunks. */
function pruneToKeep(handle: Database.Database, keep: string[]): void {
  const src = `${SRC_PREFIX}%`
  const tx = handle.transaction(() => {
    handle.exec('CREATE TEMP TABLE IF NOT EXISTS _keep(file TEXT PRIMARY KEY)')
    handle.prepare('DELETE FROM _keep').run()
    const ins = handle.prepare('INSERT OR IGNORE INTO _keep(file) VALUES (?)')
    for (const f of keep) ins.run(f)
    if (isVecAvailable()) {
      try {
        handle
          .prepare(
            'DELETE FROM notes_vec WHERE rowid IN (SELECT id FROM notes_chunks WHERE file NOT LIKE ? AND file NOT IN (SELECT file FROM _keep))'
          )
          .run(src)
      } catch {
        // vec table absent
      }
    }
    handle
      .prepare('DELETE FROM notes_chunks WHERE file NOT LIKE ? AND file NOT IN (SELECT file FROM _keep)')
      .run(src)
    handle.exec('DROP TABLE IF EXISTS _keep')
  })
  tx()
}

/** Embed (best-effort) + insert a batch of pending chunks. Shared by reindex
 *  (file notes) and ingestFromSource (Slack/email/calendar). If embedding fails
 *  (no model / offline), text is still persisted so LIKE-search + graph work. */
// RE-ENABLED (embed-worker isolation). The ONNX embedder used to take the WHOLE app
// down mid-reindex — a native fault so low-level crashReporter captured no dump. The
// embedder now runs in an isolated Electron **utilityProcess** (see
// rag/embeddings/service.ts `spawnRealWorker`), so a segfault kills only that child:
// the host survives, service.ts's `exit` handler rejects the in-flight batch, and the
// `catch` below records the index text-only for that batch (the graph + lexical search
// never depended on vectors). Env kill-switch: DUIN_DISABLE_EMBEDDINGS=1 forces the
// prior text-only behaviour if a bad model/host ever needs it.
const EMBEDDINGS_ENABLED = process.env.DUIN_DISABLE_EMBEDDINGS !== '1'

async function persistPending(
  handle: Database.Database,
  pending: { file: string; chunkIndex: number; text: string }[],
  // Chunk ids these rows REPLACE (the src/ re-embed hands us the old rows it is
  // rewriting). Folded into the same transaction as the insert so the swap is
  // atomic: the text is never absent, not even between two statements.
  replaceIds?: number[]
): Promise<boolean> {
  // 1) Insert chunk TEXT first, in its own committed transaction, capturing each
  //    rowid. The brain graph (deriveGraph) + lexical search need only this text —
  //    NOT embeddings. Committing before the embed call means a native embed crash
  //    (an ONNX segfault kills the process, bypassing the catch below) can no longer
  //    leave the graph empty: the chunks are already on disk.
  const insertChunk = handle.prepare(
    'INSERT INTO notes_chunks (file, chunk_index, text) VALUES (?, ?, ?)'
  )
  const rowids: number[] = new Array(pending.length)
  const chunkTx = handle.transaction(() => {
    if (replaceIds && replaceIds.length > 0) {
      const delVec = isVecAvailable() ? handle.prepare('DELETE FROM notes_vec WHERE rowid = ?') : null
      const delChunk = handle.prepare('DELETE FROM notes_chunks WHERE id = ?')
      for (const id of replaceIds) {
        // Drop the stale vector alongside its chunk so notes_vec never keeps a
        // rowid whose chunk is gone (same invariant pruneToKeep maintains).
        if (delVec) { try { delVec.run(BigInt(id)) } catch (e) { console.debug('[index-store] vec row absent:', messageOf(e)) } }
        delChunk.run(id)
      }
    }
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i]
      rowids[i] = Number(insertChunk.run(p.file, p.chunkIndex, p.text).lastInsertRowid)
    }
  })
  chunkTx()

  // Embeddings disabled (crash-avoidance, see EMBEDDINGS_ENABLED) or vec unavailable
  // → text-only is the complete state; skip the embed pass entirely (no ONNX call).
  if (!EMBEDDINGS_ENABLED || !isVecAvailable() || !userDataPath) return true

  // 2) Embed (best-effort) + backfill vectors, BOUNDED BY A TIMEOUT. A throw is
  //    caught; a hang can't stall reindex forever (the chunks are already committed
  //    and the caller records the ledger regardless, so the graph stays populated).
  const EMBED_TIMEOUT_MS = 120_000
  let vectors: Float32Array[] | null = null
  try {
    const svc = getEmbeddingsService(userDataPath)
    vectors = await Promise.race([
      (async (): Promise<Float32Array[]> => {
        return svc.embedWith(resolveEmbedderId(), pending.map((p) => p.text), 'passage')
      })(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('embed timed out')), EMBED_TIMEOUT_MS))
    ])
  } catch (err) {
    console.warn('[local-brain] embedding failed/timed out, indexed text-only:', (err as Error).message)
    return false
  }
  if (!vectors) return false

  const insertVec = handle.prepare('INSERT INTO notes_vec(rowid, embedding) VALUES (?, ?)')
  const vecTx = handle.transaction(() => {
    for (let i = 0; i < pending.length; i++) {
      if (!vectors![i]) continue
      // vec0 rejects a rowid it sees as non-INTEGER; BigInt always binds as INTEGER.
      insertVec.run(BigInt(rowids[i]), Buffer.from(vectors![i].buffer))
    }
  })
  vecTx()
  return true
}

/** The slice of the DB handle remigrateSrcChunks needs. Narrow on purpose: it lets
 *  the regression suite drive this against node:sqlite, since better-sqlite3 is
 *  built for Electron's ABI and won't load under vitest. */
export type SrcRemigrationDb = Pick<Database.Database, 'prepare'>

/** Persist one batch, replacing the chunk ids it supersedes (see persistPending). */
export type SrcRemigrationPersist = (
  rows: { file: string; chunkIndex: number; text: string }[],
  replaceIds: number[]
) => Promise<unknown>

/**
 * Re-embed the connector-ingested (`src/…`) chunks that a vec-table migration
 * preserved as text but stripped of vectors — BATCH BY BATCH, each batch's delete
 * folded into the same transaction as its re-insert.
 *
 * Data-loss guard. This used to run `DELETE FROM notes_chunks WHERE file LIKE
 * 'src/%'` up front as a bare autocommit statement and only then re-insert across
 * ~20 awaited embed batches (120s timeout each — a window up to ~40 minutes). Any
 * interruption in that window (app quit, embed utilityProcess segfault, SQLITE_BUSY
 * from the concurrent notes-watcher reindex, SQLITE_FULL) left the remaining
 * batches unwritten — and src/ text has NO on-disk origin to re-derive from, unlike
 * file notes, which rebuild from the vault. It is absent from moat-backup's SOURCES
 * and untracked by notes_files, so recovery meant a per-source re-sync limited to
 * whatever window the Slack/Gmail/Calendar API still exposes. Older items were gone.
 *
 * Per-batch replace keeps every chunk's text present at every instant: the worst
 * an interruption can do is leave a batch holding its ORIGINAL row, which the next
 * reindex redoes (the embedder done-marker is likewise deferred — see reindexImpl).
 */
export async function remigrateSrcChunks(
  handle: SrcRemigrationDb,
  persist: SrcRemigrationPersist,
  opts: { batchSize?: number; onProgress?: (done: number, total: number) => void } = {}
): Promise<number> {
  const batchSize = Math.max(1, opts.batchSize ?? 256)
  const rows = handle
    .prepare('SELECT id, file, chunk_index AS chunkIndex, text FROM notes_chunks WHERE file LIKE ? ORDER BY file, chunk_index')
    .all(`${SRC_PREFIX}%`) as { id: number; file: string; chunkIndex: number; text: string }[]
  if (rows.length === 0) return 0
  opts.onProgress?.(0, rows.length)
  let done = 0
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    await persist(
      batch.map((r) => ({ file: r.file, chunkIndex: r.chunkIndex, text: r.text })),
      batch.map((r) => Number(r.id))
    )
    done = Math.min(i + batchSize, rows.length)
    opts.onProgress?.(done, rows.length)
  }
  return done
}

// ──────────────────── source ingest (Slack / Gmail / Calendar / …) ────────────────────

// Ingested connector content lives in the SAME index as file notes but under a
// reserved `src/<source>/` file-id namespace, so: (a) reindex() of the notes
// folder NEVER clobbers ingested sources, and (b) re-syncing one source replaces
// only its own rows. graph-derive then types/dates each ingested doc from the
// synthetic frontmatter we prepend.
export const SRC_PREFIX = 'src/'

export interface IngestDoc {
  /** Unique within the source (message ts, email id, event id). */
  id: string
  text: string
  title?: string
  /** ISO date — becomes the node's date (foresight/time-axis). */
  date?: string
  /** Maps to a frontmatter `type` → CausalKind (e.g. 'event' for calendar). */
  kind?: string
  people?: string[]
  url?: string
}

/** Prepend synthetic frontmatter + H1 so graph-derive types/dates/labels the
 *  ingested doc exactly like a real note. Pure. */
export function synthNoteText(doc: IngestDoc, source: string): string {
  const fm: string[] = ['---']
  if (doc.kind) fm.push(`type: ${doc.kind}`)
  if (doc.date) fm.push(`date: ${doc.date}`)
  const tags = [source, ...(doc.people ?? [])].filter(Boolean)
  if (tags.length) fm.push(`tags: [${tags.join(', ')}]`)
  if (doc.url) fm.push(`url: ${doc.url}`)
  fm.push('---')
  const heading = doc.title ? `# ${doc.title}\n` : ''
  return `${fm.join('\n')}\n${heading}${doc.text}`
}

/** Clear FILE notes only (preserve ingested `src/` rows) — used by reindex. */
function clearFileNotes(handle: Database.Database): void {
  const pat = `${SRC_PREFIX}%`
  if (isVecAvailable()) {
    try {
      handle
        .prepare('DELETE FROM notes_vec WHERE rowid IN (SELECT rowid FROM notes_chunks WHERE file NOT LIKE ?)')
        .run(pat)
    } catch {
      // vec table absent
    }
  }
  handle.prepare('DELETE FROM notes_chunks WHERE file NOT LIKE ?').run(pat)
  handle.prepare('DELETE FROM notes_files').run() // hash ledger tracks only file notes
}

function clearByPattern(handle: Database.Database, like: string): void {
  if (isVecAvailable()) {
    try {
      handle
        .prepare('DELETE FROM notes_vec WHERE rowid IN (SELECT rowid FROM notes_chunks WHERE file LIKE ?)')
        .run(like)
    } catch {
      // vec table absent
    }
  }
  handle.prepare('DELETE FROM notes_chunks WHERE file LIKE ?').run(like)
}

/**
 * Ingest non-file content (Slack/Gmail/Calendar/…) into the brain. Replaces the
 * given source's prior rows (idempotent re-sync), chunks + embeds each doc under
 * `src/<source>/<id>`, and persists so search + graph + foresight pick them up.
 * Returns the number of distinct source docs indexed.
 */
export async function ingestFromSource(source: string, docs: IngestDoc[]): Promise<number> {
  const src = source.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
  if (!src) return 0
  const handle = getDbFor(resolveDbPath())
  // Replace this source's window (idempotent re-sync).
  clearByPattern(handle, `${SRC_PREFIX}${src}/%`)
  if (!docs.length) return 0

  const pending: { file: string; chunkIndex: number; text: string }[] = []
  for (const doc of docs) {
    const id = String(doc.id).replace(/[^A-Za-z0-9_.:-]/g, '_')
    if (!id || !doc.text || !doc.text.trim()) continue
    const file = `${SRC_PREFIX}${src}/${id}`
    const chunks = chunkText(synthNoteText(doc, src))
    chunks.forEach((text, chunkIndex) => pending.push({ file, chunkIndex, text }))
  }
  if (pending.length === 0) return 0
  await persistPending(handle, pending)
  return new Set(pending.map((p) => p.file)).size
}

/** Process-local override of the active embedder, set only by the A/B eval
 *  runner (and, later, a probe-gated user switch). Null → the catalogue default.
 *  Lets reindex embed under a candidate model without flipping the shipped
 *  default — the safe way to evaluate e5/bge-m3 against bge-small-en. */
let embedderOverride: string | null = null

export function setEmbedderOverride(id: string | null): void {
  embedderOverride = id && getEmbedder(id) ? id : null
}

export function getEmbedderOverride(): string | null {
  return embedderOverride
}

export function resolveEmbedderId(): string {
  // Override (eval/probe-gated switch) wins; else the catalogue default —
  // getEmbedder() guards against drift / an unknown override id.
  const id = embedderOverride ?? DEFAULT_EMBEDDER_ID
  return getEmbedder(id)?.id ?? DEFAULT_EMBEDDER_ID
}

// ── Pseudo-relevance-feedback (PRF) query expansion — Rocchio, flag-gated (OFF by
//    default via DUIN_QUERY_EXPANSION). Nudges the query embedding toward the top
//    confident vector hits and re-runs KNN, so a terse / paraphrased query reaches
//    on-topic notes it didn't lexically match. Uses ONLY the bundled embedder — no
//    generative model. Best-effort: any failure keeps the base vector result.
const PRF_M = 3 // feedback docs pulled from the first pass
const PRF_ALPHA = 0.7 // weight on the original query vector
const PRF_BETA = 0.3 // weight on the feedback centroid
const PRF_MIN_ANCHOR = 0.6 // only expand when the top hit is a confident anchor (drift guard)

function queryExpansionEnabled(): boolean {
  return process.env.DUIN_QUERY_EXPANSION === '1'
}

/** KNN over notes_vec for a packed embedding buffer → chunk rows with distance. */
function vecKnn(
  handle: Database.Database,
  embeddingBuf: Buffer,
  pool: number
): Array<ChunkRow & { distance: number }> {
  return handle
    .prepare(
      `SELECT c.id AS rowid, c.file AS file, c.text AS text, v.distance AS distance
         FROM notes_vec v
         JOIN notes_chunks c ON c.id = v.rowid
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY distance
        LIMIT ?`
    )
    .all(embeddingBuf, pool, pool) as Array<ChunkRow & { distance: number }>
}

/** Rocchio PRF expansion: `normalize(alpha·query + beta·mean(feedbackDocs))`, in the
 *  same cosine space as the embedder. PURE (no I/O) so it's unit-testable. */
export function rocchioExpand(
  qVec: ArrayLike<number>,
  docVecs: ArrayLike<number>[],
  alpha = PRF_ALPHA,
  beta = PRF_BETA
): Float32Array {
  const dim = qVec.length
  const out = new Float32Array(dim)
  const m = docVecs.length || 1
  for (let i = 0; i < dim; i++) {
    let c = 0
    for (const d of docVecs) c += d[i] ?? 0
    out[i] = alpha * (qVec[i] ?? 0) + beta * (c / m)
  }
  let norm = 0
  for (let i = 0; i < dim; i++) norm += out[i] * out[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dim; i++) out[i] /= norm
  return out
}

/** Files a date window PROVABLY excludes — dated, and dated outside the range.
 *
 *  Deliberately a denylist. A whitelist ("files whose note_date is in range") would silently drop
 *  two whole classes of content, and both failures would look like a thin answer rather than a
 *  broken filter:
 *
 *    1. Every note on an install that has not reindexed since note_date shipped. The column is
 *       backfilled by the index walk, so before that walk EVERY row is NULL and a whitelist returns
 *       the empty set — a total retrieval outage presenting as "I found nothing for that period".
 *    2. Connector-ingested `src/` chunks, which have chunk rows but no notes_files row at all,
 *       since that ledger tracks FILE notes only.
 *
 *  So the rule is: exclude only what we can prove is out of range; admit unknown dates. That biases
 *  toward returning a note that may be outside the period over hiding one that is inside it, which
 *  is the right direction — the operator can see an off-period note and disregard it, but cannot
 *  see one that was never returned.
 *
 *  Fails open on any error: a filter that cannot be computed must not become a filter that excludes
 *  everything. */
export function filesOutsideWindow(handle: Database.Database, w: DateWindow): Set<string> {
  try {
    const rows = handle
      .prepare(
        'SELECT file FROM notes_files WHERE note_date IS NOT NULL AND (note_date < ? OR note_date >= ?)'
      )
      .all(w.from, w.to) as { file: string }[]
    return new Set(rows.map((r) => r.file))
  } catch (e) {
    console.debug('[index-store] window filter unavailable, searching unwindowed:', messageOf(e))
    return new Set()
  }
}

/**
 * HYBRID search over the indexed notes. Runs BOTH the semantic (vector) pass
 * and a lexical term-overlap pass, then FUSES them by Reciprocal Rank Fusion
 * (`fuseSearchHits`). RRF ranks by position across both legs, so an exact keyword
 * in the query — a proper noun like "Beacon" that bge embeddings rank poorly on a
 * tiny corpus — surfaces near the TOP rather than being appended after a full set
 * of mediocre semantic hits. Pure lexical when sqlite-vec is unavailable.
 *
 * No relevance THRESHOLD is applied: on a small notes folder every retained hit
 * is the closest the index has, and the caller (the /agui chat) wants the best
 * available context injected regardless of absolute score. Returns up to `k`
 * hits, each with the source relpath, a snippet, and a 0..1 score (higher=better).
 */
export async function search(query: string, k = 6, tuning?: SearchTuning): Promise<SearchHit[]> {
  const q = (query ?? '').trim()
  if (!q) return []
  let handle: Database.Database
  try {
    handle = getDbFor(resolveDbPath())
  } catch {
    return []
  }

  // Lexical pass runs ALWAYS (cheap on a local notes folder) so an exact term
  // match is never lost to a low embedding rank. Read the chunk rows once and
  // share them with the lexical scorer.
  let allRows: ChunkRow[]
  try {
    allRows = handle.prepare('SELECT id AS rowid, file, text FROM notes_chunks').all() as ChunkRow[]
  } catch {
    allRows = []
  }

  // Date window (optional). Computed as a DENYLIST of files we can PROVE are out of range, never as
  // a whitelist of files in range — see filesOutsideWindow. Both legs consult it.
  const excluded = tuning?.window ? filesOutsideWindow(handle, tuning.window) : null
  const inWindow = (file: string): boolean => !excluded || !excluded.has(file)
  if (excluded) allRows = allRows.filter((r) => inWindow(r.file))
  // Recall pool ≫ k: each leg over-fetches so a terse, on-topic note that ranks,
  // say, #12 in one leg still reaches fusion instead of being cut at k. RRF + BM25
  // then decide the final k. Cheap (both legs already scan/KNN the corpus).
  const POOL = Math.max(k * (tuning?.poolMultiplier ?? 5), tuning?.poolFloor ?? 30)
  const lexical = lexicalScan(allRows, q, POOL)

  // Vector pass — best-effort; merged ON TOP of (i.e. ahead of) the lexical
  // hits. Vector failures degrade to lexical-only rather than dropping results.
  let vector: SearchHit[] = []
  let queryVec: Float32Array | undefined
  let feedbackTexts: string[] = []
  if (isVecAvailable() && userDataPath) {
    try {
      const svc = getEmbeddingsService(userDataPath)
      const [vec] = await svc.embedWith(resolveEmbedderId(), [q], 'query')
      if (vec) {
        queryVec = vec
        // vecKnn's `k` is decided inside sqlite-vec, so a window cannot be pushed into the MATCH.
        // Over-fetch and post-filter instead: without the widening, a window that excludes most of
        // the corpus would leave the vector leg with a handful of survivors out of POOL and the
        // fusion would be lexical-dominated for exactly the queries that need semantics most.
        const rows = vecKnn(handle, Buffer.from(vec.buffer), excluded ? POOL * 4 : POOL).filter((r) =>
          inWindow(r.file)
        )
        feedbackTexts = rows.slice(0, PRF_M).map((r) => r.text)
        vector = rows.map((r) => ({
          file: r.file,
          snippet: makeSnippet(r.text),
          // cosine distance (0 best) → 0..1 similarity score
          score: Math.max(0, 1 - r.distance)
        }))
      }
    } catch (err) {
      console.warn('[local-brain] vector search failed, using lexical only:', (err as Error).message)
    }
  }

  // PRF query expansion (flag-gated, default OFF). Only fires behind a CONFIDENT
  // anchor (top hit ≥ PRF_MIN_ANCHOR) so a weak first pass can't drag the query
  // off-topic (the classic PRF drift). Re-embeds the top feedback docs, Rocchio-
  // nudges the query vector toward them, and re-runs KNN. The lexical leg is left
  // untouched (it already anchors exact terms). Best-effort: keep the base result.
  if (
    queryExpansionEnabled() &&
    queryVec &&
    userDataPath &&
    vector.length > 0 &&
    vector[0].score >= PRF_MIN_ANCHOR &&
    feedbackTexts.length > 0
  ) {
    try {
      const svc = getEmbeddingsService(userDataPath)
      const docVecs = await svc.embedWith(resolveEmbedderId(), feedbackTexts, 'passage')
      const qExp = rocchioExpand(queryVec, docVecs)
      // Same window filter as the base pass — this REPLACES `vector` wholesale below, so skipping
      // it here would let the expansion re-admit exactly the out-of-window notes the base pass
      // just excluded. PRF is default-OFF, which is precisely why this is easy to miss.
      const expRows = vecKnn(handle, Buffer.from(qExp.buffer), excluded ? POOL * 4 : POOL).filter((r) =>
        inWindow(r.file)
      )
      if (expRows.length > 0) {
        vector = expRows.map((r) => ({
          file: r.file,
          snippet: makeSnippet(r.text),
          score: Math.max(0, 1 - r.distance)
        }))
      }
    } catch (err) {
      console.warn('[local-brain] query-expansion failed, keeping base vector:', (err as Error).message)
    }
  }

  // Pass indexed mtimes so fusion applies the bounded temporal-recency prior. Cheap
  // (one small indexed-table read); empty/legacy mtimes degrade to recency-off.
  return fuseSearchHits(vector, lexical, k, {
    mtimes: fileMtimes(),
    wLex: tuning?.fuseWLex,
    wVec: tuning?.fuseWVec,
    fuseK: tuning?.fuseK,
    recencyWeight: tuning?.recencyMaxBoost,
    halfLifeDays: tuning?.recencyHalfLifeDays
  })
}


// WEIGHTED reciprocal-rank fusion. The lexical leg is weighted higher than vector
// because, with BM25, a strong keyword match is a RELIABLE relevance signal, whereas
// a small on-device embedder (e5-small) is not discriminative enough to rank the
// truly-relevant note #1 — it puts a topically-adjacent-but-wrong note (e.g. a dev
// log that mentions the term) at vector rank 1. Plain equal-weight RRF then let that
// vector-rank-1 note tie/beat the actually-relevant note sitting at lexical rank 2,
// which is exactly the terse-decision-note-buried failure. W_LEX>W_VEC lets a strong
// lexical hit win, while a note strong in BOTH legs still outranks either alone; on
// pure-paraphrase queries (no lexical overlap) the lexical leg is empty so vector
// carries as before. RRF_K controls rank flattening (shared default 60).
const FUSE_W_LEX = 2.0
const FUSE_W_VEC = 1.0
const FUSE_K = 60

// Temporal-recency prior (Retrieval score-lift). mtime is indexed (notes_files.mtime)
// but only ever fed the graph display — never ranking. Here it becomes a MILD,
// fail-safe multiplicative prior on the fused RRF score: among similarly-relevant
// notes, the more recently edited one surfaces first. Deliberately bounded so it
// reorders near-ties WITHOUT overriding a real relevance gap (honesty-by-construction:
// a thin signal must not be amplified into a wrong result). An unknown mtime (0 →
// epoch → enormous age → boost≈0 → ×1.0) is neutral BY CONSTRUCTION, so un-migrated
// indexes and the recency-off callers (opts omitted) behave exactly as before.
const RECENCY_MAX_BOOST = 0.15 // freshest note gets at most ×1.15 on its fused score
const RECENCY_HALFLIFE_DAYS = 30 // boost halves every ~30 days of age
const DAY_MS = 86_400_000

export interface FuseRecencyOpts {
  /** rel-path → last-modified ms (from fileMtimes()). Absent/empty → recency off. */
  mtimes?: Map<string, number>
  /** "now" in ms; injectable for deterministic tests. Defaults to Date.now(). */
  now?: number
  /** Max multiplicative boost for a just-edited note. Default RECENCY_MAX_BOOST. */
  recencyWeight?: number
  /** Age (days) at which the boost halves. Default RECENCY_HALFLIFE_DAYS. */
  halfLifeDays?: number
  /** Weighted-RRF weight on the lexical leg. Default FUSE_W_LEX. See retrieval-tunables.ts. */
  wLex?: number
  /** Weighted-RRF weight on the vector leg. Default FUSE_W_VEC. */
  wVec?: number
  /** RRF rank-flattening constant. Default FUSE_K. */
  fuseK?: number
}

/**
 * Per-call retrieval overrides. Every field is optional and an omitted field resolves to the
 * historical constant, so `search(q, k)` with no tuning is byte-identical to before. Shaped as a
 * subset of RetrievalTunables so a clamped config object passes straight through.
 */
/** A half-open date window `[from, to)` in epoch ms, for period-scoped questions. */
export interface DateWindow {
  from: number
  to: number
}

export type SearchTuning = Partial<
  Pick<
    RetrievalTunables,
    | 'poolMultiplier'
    | 'poolFloor'
    | 'fuseWLex'
    | 'fuseWVec'
    | 'fuseK'
    | 'recencyMaxBoost'
    | 'recencyHalfLifeDays'
  >
> & {
  /** Restrict to notes DATED inside this window. Absent ⇒ byte-identical to unwindowed search.
   *  A ranking boost is not a filter: "my last two weeks" is a question about which notes are
   *  ELIGIBLE, and ranking cannot express ineligibility. */
  window?: DateWindow
}

/** Bounded recency multiplier in [1, 1+weight]. Unknown/zero mtime → 1.0 (neutral). PURE. */
export function recencyMultiplier(
  mtime: number,
  now: number,
  weight = RECENCY_MAX_BOOST,
  halfLifeDays = RECENCY_HALFLIFE_DAYS
): number {
  if (!(mtime > 0) || weight <= 0) return 1
  const ageDays = Math.max(0, (now - mtime) / DAY_MS)
  return 1 + weight * Math.exp((-ageDays * Math.LN2) / halfLifeDays)
}

export function fuseSearchHits(
  vector: SearchHit[],
  lexical: SearchHit[],
  k: number,
  opts?: FuseRecencyOpts
): SearchHit[] {
  const dedupByFile = (hits: SearchHit[]): SearchHit[] => {
    const seen = new Set<string>()
    const out: SearchHit[] = []
    for (const h of hits) {
      if (seen.has(h.file)) continue
      seen.add(h.file)
      out.push(h)
    }
    return out
  }
  const vec = dedupByFile(vector)
  const lex = dedupByFile(lexical)
  if (vec.length === 0 && lex.length === 0) return []
  // Fusion weights are overridable (retrieval-tunables.ts); omitted opts ⇒ the historical constants,
  // so every existing caller and test fuses byte-identically.
  const wLex = opts?.wLex ?? FUSE_W_LEX
  const wVec = opts?.wVec ?? FUSE_W_VEC
  const rrfK = opts?.fuseK ?? FUSE_K
  const fused = new Map<string, number>()
  lex.forEach((h, i) => fused.set(h.file, (fused.get(h.file) ?? 0) + wLex / (rrfK + i + 1)))
  vec.forEach((h, i) => fused.set(h.file, (fused.get(h.file) ?? 0) + wVec / (rrfK + i + 1)))
  // Temporal-recency prior: scale each file's fused score by a bounded recency
  // multiplier. Off when opts/mtimes absent (multiplier resolves to ×1.0 anyway),
  // so the recency-blind callers are unchanged.
  if (opts?.mtimes && opts.mtimes.size > 0) {
    const now = opts.now ?? Date.now()
    for (const [file, s] of fused) {
      const boost = recencyMultiplier(opts.mtimes.get(file) ?? 0, now, opts.recencyWeight, opts.halfLifeDays)
      if (boost !== 1) fused.set(file, s * boost)
    }
  }
  // Snippet lookup: prefer the vector leg's snippet for a file in both legs.
  const byFile = new Map<string, SearchHit>()
  for (const h of [...vec, ...lex]) if (!byFile.has(h.file)) byFile.set(h.file, h)
  // Absolute-relevance passthrough. RRF below scores by RANK INDEX only, so every
  // trace of "how relevant was this actually" is destroyed by fusion and then again
  // by the top-normalization — which is why a confidence threshold read off `score`
  // silently never fires. `vec` is deduped and the vector rows arrive ORDER BY
  // distance, so the kept entry is the file's closest chunk: its cosine-ish score
  // is the file's best absolute relevance. Lexical-only files get no rawScore.
  const absByFile = new Map<string, number>()
  for (const h of vec) if (!absByFile.has(h.file) && Number.isFinite(h.score)) absByFile.set(h.file, h.score)
  const ordered = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, k)
  const maxFused = ordered[0]?.[1] || 1
  return ordered.map(([file, s]) => ({
    file,
    snippet: byFile.get(file)?.snippet ?? '',
    score: maxFused > 0 ? s / maxFused : 0,
    rawScore: absByFile.get(file)
  }))
}

/** What a cover pass returned, alongside the hits — so the caller can SAY how complete it was
 *  rather than presenting a truncated set as if it were the whole window. */
export interface CoverResult {
  hits: SearchHit[]
  /** Files inside the window (the true eligible population). */
  eligible: number
  /** Total hits returned — the eligible notes covered PLUS any ranked hit that matched from
   *  outside the dated population (an undated but relevant note can still rank). Use `covered`,
   *  not this, to talk about coverage: this can legitimately exceed `eligible`. */
  emitted: number
  /** How many of `eligible` are actually in the result. THE coverage number: `covered < eligible`
   *  is the only honest definition of "the window was truncated". */
  covered: number
  /** Chars allowed per snippet after fitting the population into the budget. */
  snippetChars: number
}

/** Never emit a snippet shorter than this — below ~60 chars a note is an unusable stub. */
const COVER_MIN_SNIPPET = 60
const COVER_MAX_SNIPPET = 240

/**
 * PURE. Fit `restCount` notes into whatever the ranked head left of `maxChars`.
 *
 * The policy, stated once: SHRINK FIDELITY BEFORE DROPPING NOTES. For "what happened this
 * fortnight", one line about every note beats a paragraph about a third of them — the answer is
 * the shape of the whole window, so a missing note is a hole in the answer while a shorter note is
 * merely terser. Only when even COVER_MIN_SNIPPET does not fit is the population cut, and then
 * `room < restCount` makes the caller say so.
 */
export function planCoverBudget(
  rankedChars: number,
  restCount: number,
  maxChars: number
): { snippetChars: number; room: number } {
  const left = Math.max(0, maxChars - rankedChars)
  const perNote = Math.floor(left / Math.max(1, restCount))
  const snippetChars = Math.min(COVER_MAX_SNIPPET, Math.max(COVER_MIN_SNIPPET, perNote))
  return { snippetChars, room: Math.floor(left / snippetChars) }
}

/**
 * COVER — every note eligible in a window, not the top-k best-matching ones.
 *
 * THE FAILURE THIS ADDRESSES (period-window.ts states it too, from the other end). A periodic
 * report is an AGGREGATION: "what happened in the last fortnight" has its answer spread across
 * every note in the window, and NONE of them individually matches the query terms. Ranked
 * retrieval cannot express that — measured on the real vault, 138 notes fell inside a fortnight
 * and `searchK` returned 6 (4% coverage), and because searchK is clamped to 30, breadth could not
 * close the gap either: `aggregation-arms.eval` scored stock DUIN 0/18 and searchK=30 ALSO 0/18.
 * "Breadth is not the fix. The fix is eligibility, which is a filter, and a filter needs a window."
 *
 * So this does not rank harder — it changes WHICH SET is emitted. Ranked matches keep their place
 * at the front (they are still the most likely to matter), then every other in-window note follows
 * at reduced fidelity, so the model sees the whole population rather than a sample of it.
 *
 * DELIBERATELY ADDITIVE: `search()` is untouched, so every other caller behaves exactly as before.
 * This is only reached when a period window resolved.
 *
 * Budget-aware and HONEST about it: snippet length shrinks to fit the population into `maxChars`,
 * and if even the floor does not fit, the population is cut and `emitted < eligible` says so — the
 * caller surfaces that rather than implying full coverage. No silent truncation.
 */
export async function coverInWindow(
  query: string,
  window: DateWindow,
  opts?: { maxChars?: number; rankedK?: number; tuning?: SearchTuning }
): Promise<CoverResult> {
  const maxChars = opts?.maxChars ?? 24_000
  const empty: CoverResult = { hits: [], eligible: 0, emitted: 0, covered: 0, snippetChars: COVER_MAX_SNIPPET }
  let handle: Database.Database
  try {
    handle = getDbFor(resolveDbPath())
  } catch {
    return empty
  }

  // The eligible population: files with POSITIVE date evidence inside the window, newest first.
  //
  // NOT `filesOutsideWindow`. That is a fail-open DENYLIST — it excludes only what it can PROVE is
  // out of range, so every undated note stays admitted. For RANKING that is the right call and the
  // comment there says why ("a wrong date is worse than no date"): an undated note can still earn
  // its place on relevance. For COVER it is catastrophic, because cover emits the population
  // itself. Measured on the 1,314-note eval fixture, where ZERO notes carry a note_date: the
  // denylist excluded nothing, so "the fortnight" resolved to the entire corpus and cover emitted
  // 381 alphabetically-first notes as if they were the period — strictly worse than the 6
  // relevant ones top-k returned. A period report needs notes PROVEN to be in the period.
  //
  // Consequence, deliberately accepted: a vault with no dates gets an EMPTY cover and falls back
  // to ranked-only. That is the honest answer — "I cannot tell which notes fall in this period" —
  // and the caller reports eligible:0 rather than inventing a population.
  let dated: { file: string }[]
  try {
    dated = handle
      .prepare(
        'SELECT file FROM notes_files WHERE note_date IS NOT NULL AND note_date >= ? AND note_date < ? ORDER BY note_date DESC'
      )
      .all(window.from, window.to) as { file: string }[]
  } catch {
    return empty
  }
  if (dated.length === 0) return empty
  // Order is load-bearing: when the budget forces a cut it must drop the OLDEST notes, not an
  // arbitrary alphabetical tail.
  const order = new Map(dated.map((r, i) => [r.file, i]))
  let rows: { file: string; text: string }[]
  try {
    rows = handle
      .prepare('SELECT file, text FROM notes_chunks WHERE chunk_index = 0')
      .all() as { file: string; text: string }[]
  } catch {
    return empty
  }
  const inWindow = rows
    .filter((r) => order.has(r.file))
    .sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0))
  if (inWindow.length === 0) return empty

  // Ranked matches first — they are the notes that DO answer the query directly, and losing their
  // ordering to a flat alphabetical dump would trade one failure for another.
  let ranked: SearchHit[]
  try {
    ranked = query.trim()
      ? await search(query, opts?.rankedK ?? 6, { ...(opts?.tuning ?? {}), window })
      : []
  } catch {
    ranked = [] // cover is still worth serving without the ranked head
  }
  const rankedFiles = new Set(ranked.map((h) => h.file))

  // Fit the population to the budget by SHRINKING fidelity before dropping notes: a short line
  // about every note beats a full paragraph about a third of them, for a question whose answer is
  // the shape of the whole window.
  const rest = inWindow.filter((r) => !rankedFiles.has(r.file))
  const rankedChars = ranked.reduce((n, h) => n + h.snippet.length, 0)
  const { snippetChars, room } = planCoverBudget(rankedChars, rest.length, maxChars)
  const kept = rest.slice(0, Math.max(0, room))

  const hits: SearchHit[] = [
    ...ranked,
    ...kept.map((r) => ({
      file: r.file,
      snippet: makeSnippet(stripFrontmatter(r.text), snippetChars),
      // Below every ranked hit by construction: these are eligible, not matched, and the score is
      // read downstream as relevance. Flat across the tail so no false ordering is implied.
      score: 0.01
    }))
  ]
  // Coverage counts the ELIGIBLE population present in the result — the ranked head may include a
  // relevant note from outside the dated set, and counting it would report >100% coverage (and
  // print "showing 62 of 61" to the operator).
  const eligibleFiles = new Set(inWindow.map((r) => r.file))
  const covered = new Set(hits.map((h) => h.file).filter((f) => eligibleFiles.has(f))).size
  return {
    hits,
    eligible: inWindow.length,
    emitted: hits.length,
    covered,
    snippetChars
  }
}

/** First-chunk snippet for a specific note file — used by graph-neighbour
 *  expansion to pull the content of a LINKED note the query didn't itself match.
 *  Returns null when the file isn't indexed. */
export function snippetForFile(file: string): string | null {
  const f = (file ?? '').trim()
  if (!f) return null
  let handle: Database.Database
  try {
    handle = getDbFor(resolveDbPath())
  } catch {
    return null
  }
  try {
    const row = handle
      .prepare('SELECT text FROM notes_chunks WHERE file = ? ORDER BY id LIMIT 1')
      .get(f) as { text?: string } | undefined
    return row?.text ? makeSnippet(row.text) : null
  } catch {
    return null
  }
}

/**
 * Graph-augment retrieval: append linked-note hits to the base retrieval set. The
 * base hits came from lexical/semantic match; `neighbors` are notes that connect to
 * a top hit in the knowledge graph but may share NONE of the query's vocabulary —
 * the recall the pure-RAG path structurally can't reach. Base hits are always kept
 * and ranked first; neighbours fill remaining slots up to `k`, deduped by file. PURE.
 */
export function mergeGraphNeighbors(base: SearchHit[], neighbors: SearchHit[], k: number): SearchHit[] {
  const seen = new Set(base.map((h) => h.file))
  const out = [...base]
  for (const n of neighbors) {
    if (out.length >= k) break
    if (!n.file || seen.has(n.file)) continue
    seen.add(n.file)
    out.push(n)
  }
  return out
}

/** Fuller chunk text for a file (not the 240-char display snippet) — the input a
 *  cross-encoder needs to score relevance well. Falls back through the same guard
 *  path as snippetForFile. */
export function chunkTextForFile(file: string, max = 1500): string | null {
  const f = (file ?? '').trim()
  if (!f) return null
  let handle: Database.Database
  try {
    handle = getDbFor(resolveDbPath())
  } catch {
    return null
  }
  try {
    const row = handle
      .prepare('SELECT text FROM notes_chunks WHERE file = ? ORDER BY id LIMIT 1')
      .get(f) as { text?: string } | undefined
    if (!row?.text) return null
    const clean = row.text.replace(/\s+/g, ' ').trim()
    return clean.length <= max ? clean : clean.slice(0, max)
  } catch {
    return null
  }
}

/** Reorder hits by cross-encoder scores (desc), stable on ties. Length mismatch →
 *  hits returned unchanged (never drop a hit on a bad score vector). PURE. */
export function applyRerankOrder(hits: SearchHit[], scores: number[]): SearchHit[] {
  if (!Array.isArray(scores) || scores.length !== hits.length) return hits
  return hits
    .map((h, i) => ({ h, s: scores[i], i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.h)
}

/**
 * Cross-encoder RERANK for the notes-brain retrieval path — the SAME reranker the
 * attachment-RAG pipeline uses (`embeddings.rerank`), so a single setting reorders
 * BOTH pipelines instead of the cross-encoder serving only attachments. Best-effort:
 * no embeddings service, a single hit, or any failure returns the fusion order
 * unchanged (zero regression). Reranks on fuller chunk text, not the display snippet.
 */
export async function rerankHits(
  query: string,
  hits: SearchHit[],
  rerankerId?: string
): Promise<SearchHit[]> {
  if (hits.length <= 1 || !userDataPath) return hits
  try {
    const svc = getEmbeddingsService(userDataPath)
    const passages = hits.map((h) => chunkTextForFile(h.file) ?? h.snippet)
    const scores = await svc.rerank(query, passages, rerankerId)
    return applyRerankOrder(hits, scores)
  } catch (err) {
    console.warn('[local-brain] rerank failed, keeping fusion order:', (err as Error).message)
    return hits
  }
}

/** Embed arbitrary texts through the SAME local embedder the notes index uses —
 *  for query-relevant memory recall (personalization-recall). No userData / no
 *  embedder → [] so the caller falls back to whole-dump grounding. Independent of
 *  sqlite-vec (embedding is the transformers worker, not the vec extension). */
export async function embedForRecall(texts: string[]): Promise<number[][]> {
  if (!texts || texts.length === 0 || !userDataPath) return []
  try {
    const svc = getEmbeddingsService(userDataPath)
    // embedWith, NOT setActive+embed. `setActive` is the USER's Library picker
    // choice; calling it here made every chat turn reset that choice back to the
    // catalogue default, so picking a non-default embedder in Settings->RAG
    // survived exactly until the next turn and then silently reverted. Naming the
    // space per call gets the brain the model its notes_vec index was built with
    // without touching anyone else's default.
    //
    // 'none': BOTH sides of recall's cosine go through this function, so the
    // comparison stays symmetric. Adding a query: prefix to one side only is the
    // configuration E5 handles worst.
    // embedWith() yields Float32Array rows; recall's cosine wants plain number[].
    return (await svc.embedWith(resolveEmbedderId(), texts, 'none')).map((v) => Array.from(v))
  } catch {
    return []
  }
}

// BACKGROUND WARM (efficiency): spin up the embedder worker + load the model AFTER boot, so the FIRST
// real query — which can beat the async reindex on a large vault, or hit a vault reindex never embedded —
// doesn't pay worker-spawn + model-load as first-turn latency. Best-effort + idempotent: no vec / no
// userData / any failure is a silent no-op (the lazy path on the first real embed still works).
let embedderWarmed = false
export async function warmEmbedder(): Promise<void> {
  if (embedderWarmed || !isVecAvailable() || !userDataPath) return
  embedderWarmed = true
  try {
    const svc = getEmbeddingsService(userDataPath)
    // Same reason as embedForRecall: warming must not repoint the user's picker.
    await svc.embedWith(resolveEmbedderId(), [' '], 'query') // throwaway embed → the worker + model are now hot
  } catch {
    embedderWarmed = false // let a later call retry if the first warm failed transiently
  }
}

/**
 * Score chunk rows by query term overlap (PURE — no DB). Tokenizes the query on
 * non-word chars, keeps tokens of length > 1 (so short proper-noun fragments
 * still count), counts occurrences per chunk, and returns the top-k by hit count
 * with a normalized 0..1 score. Unit-tested.
 */
// BM25 params (Robertson/Sparck-Jones defaults). k1 caps term-frequency saturation;
// b controls length normalization (0.75 = strong).
const BM25_K1 = 1.5
const BM25_B = 0.75

/**
 * BM25 lexical ranking. Replaces raw token-occurrence counting, which let LARGE
 * notes win purely by size (a dev log mentioning a term 20× buried a one-paragraph
 * decision note that IS about it). BM25 fixes both failure modes at once:
 *  - IDF: a distinctive query term (风暴模拟器, rare in the corpus) outweighs a common
 *    one, so matching the *specific* term matters more than matching many words.
 *  - length normalization: a short, on-topic note isn't penalised against a sprawling
 *    note whose term mentions are incidental — the crowding-out we saw live.
 * Char length is the doc-length proxy (avoids re-tokenising every chunk per query).
 */
export function lexicalScan(rows: ChunkRow[], query: string, k: number): SearchHit[] {
  const tokens = [...new Set(tokenizeForLexical(query))]
  if (tokens.length === 0 || rows.length === 0) return []
  const N = rows.length
  const lc = rows.map((r) => r.text.toLowerCase())
  const lens = rows.map((r) => r.text.length || 1)
  const avgdl = lens.reduce((a, b) => a + b, 0) / N || 1
  const score = new Float64Array(N)
  for (const t of tokens) {
    const tf = new Int32Array(N)
    let df = 0
    for (let i = 0; i < N; i++) {
      const text = lc[i]
      let cnt = 0
      let from = 0
      while ((from = text.indexOf(t, from)) !== -1) {
        cnt++
        from += t.length
      }
      if (cnt > 0) {
        tf[i] = cnt
        df++
      }
    }
    if (df === 0) continue
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    for (let i = 0; i < N; i++) {
      const f = tf[i]
      if (f === 0) continue
      const denom = f + BM25_K1 * (1 - BM25_B + (BM25_B * lens[i]) / avgdl)
      score[i] += (idf * (f * (BM25_K1 + 1))) / denom
    }
  }
  const idx: number[] = []
  for (let i = 0; i < N; i++) if (score[i] > 0) idx.push(i)
  idx.sort((a, b) => score[b] - score[a])
  const top = idx.slice(0, k)
  const max = top.length ? score[top[0]] : 1
  return top.map((i) => ({
    file: rows[i].file,
    snippet: makeSnippet(rows[i].text),
    score: max > 0 ? score[i] / max : 0
  }))
}

/**
 * Tokenize a query for the lexical leg. Latin/digit runs → whole words (len>1);
 * CJK runs → overlapping character BIGRAMS. Chinese has no word delimiters, and
 * `\W+`/whitespace splitting treats CJK as non-word and drops it ENTIRELY — so on
 * a Chinese vault the keyword leg was blind to every Chinese term ("ProjectA" never
 * matched). Bigrams let a query "ProjectA渠道" match a note containing "ProjectA" via
 * substring counting. Delegates to the shared [[cjk-tokens]] tokenizer so this leg,
 * wholenote-ground's BM25 and claim-recall's overlap join cannot drift apart.
 * QUERY-TIME ONLY: lexicalScan counts occurrences with `indexOf` over the raw chunk
 * text, so no token is ever persisted and changing this needs NO reindex. PURE.
 */
export function tokenizeForLexical(query: string): string[] {
  return cjkTokens(query)
}

function makeSnippet(text: string, max = 240): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : clean.slice(0, max) + '…'
}

/** Count of distinct note files currently indexed. */
export function indexedCount(): number {
  return indexedDocCount
}

/** True while a (re)index is running — lets an external caller (e.g. a benchmark harness that
 *  repoints the vault) wait for the search index to settle before querying, instead of racing it. */
export function isReindexing(): boolean {
  return reindexInFlight !== null
}

/** Read every chunk's (file, text) — used by graph-derive to title nodes and
 *  scan for links. Returned one row per chunk in file/chunk order. */
export function allChunks(): { file: string; text: string }[] {
  let handle: Database.Database
  try {
    handle = getDbFor(resolveDbPath())
  } catch {
    return []
  }
  try {
    return handle
      .prepare('SELECT file, text FROM notes_chunks ORDER BY file, chunk_index')
      .all() as { file: string; text: string }[]
  } catch {
    return []
  }
}

/** Cheap version stamp of the notes index — changes on any indexed content
 *  change. Used to memoize deriveGraph so it isn't rebuilt from the full corpus
 *  2-3× per chat turn. Two signals, both cheap:
 *   - notes_chunks COUNT + MAX(rowid): catches src-ingested add/remove.
 *   - notes_files COUNT + MAX(mtime): catches FILE-note edits. Necessary because
 *     notes_chunks.id is INTEGER PRIMARY KEY (no AUTOINCREMENT), so SQLite reuses
 *     freed top rowids — a chunk-count-preserving edit to the top-rowid note can
 *     reproduce the same COUNT:MAX(rowid). The incremental reindex rewrites the
 *     notes_files ledger (hash + mtime) on every content change, so MAX(mtime)
 *     advances and breaks that collision. A 30s TTL backstops the rest. */
export function notesChunksVersion(): string {
  let handle: Database.Database
  try {
    handle = getDbFor(resolveDbPath())
  } catch {
    return '0:0:0:0'
  }
  try {
    const c = handle
      .prepare('SELECT COUNT(*) AS c, COALESCE(MAX(rowid), 0) AS m FROM notes_chunks')
      .get() as { c: number; m: number }
    const f = handle
      .prepare('SELECT COUNT(*) AS c, COALESCE(MAX(mtime), 0) AS m FROM notes_files')
      .get() as { c: number; m: number }
    return `${c.c}:${c.m}:${f.c}:${f.m}`
  } catch {
    return '0:0:0:0'
  }
}

/** Per-file last-modified time (ms), by rel-path — for recency display in the
 *  brain graph. Files indexed before the mtime column exist with mtime NULL/0. */
export function fileMtimes(): Map<string, number> {
  let handle: Database.Database
  try {
    handle = getDbFor(resolveDbPath())
  } catch {
    return new Map()
  }
  try {
    const rows = handle.prepare('SELECT file, mtime FROM notes_files').all() as {
      file: string
      mtime: number | null
    }[]
    return new Map(rows.map((r) => [r.file, r.mtime ?? 0]))
  } catch {
    return new Map()
  }
}

/** Close the store handle (shutdown). */
export function closeLocalBrainStore(): void {
  if (db) {
    try {
      db.close()
    } catch {
      // already closed
    }
    db = null
    dbPath = null
  }
}

/** Test-only: reset module state between cases. */
export function __resetLocalBrainStoreForTest(): void {
  closeLocalBrainStore()
  indexedDocCount = 0
  userDataPath = null
  reindexInFlight = null
  reindexInFlightDir = null
  reindexInFlightGeneration = 0
  reindexDirty = false
  reindexDirtyDir = null
  reindexGeneration = 0
  completedReindexes.clear()
  reindexRunnerForTest = null
}

/** Test-only: replace the expensive filesystem/SQLite pass with a controllable runner. */
export function __setReindexRunnerForTest(
  runner: ((dir: string | null | undefined) => Promise<number>) | null
): void {
  reindexRunnerForTest = runner
}
