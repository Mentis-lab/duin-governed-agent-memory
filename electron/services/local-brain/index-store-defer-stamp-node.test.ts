// The embedder-migration DONE-MARKER must be deferred to the END of the rebuild.
//
// THE GAP THIS CLOSES. Commit 02ac58d shipped two guards against the same data-loss
// defect. remigrateSrcChunks (guard 1) is covered by index-store-src-remigration-node.test.ts.
// maybeMigrateVecTable's `deferStamp` option (guard 2) had NO executing coverage at all:
// `{ deferStamp: true }` could be deleted from reindexImpl's call site and the whole suite
// stayed green. rag/embedder-meta.test.ts mentions a same-NAMED but different function and
// sits inside a `describe.skipIf(!HAS_NATIVE_SQLITE)` block, so it executes nothing here.
//
// THE PROPERTY. An embedder/dim change DROPs notes_vec and forces a full re-embed that spans
// ~20 awaited batches (120s EMBED_TIMEOUT_MS each — a window up to ~40 minutes). If
// index_meta.embedder_id/embedder_dim is stamped with the NEW model at the TOP of that window
// (the original behaviour), an interruption anywhere inside it leaves the marker saying "done"
// over a half-migrated index. vecMigrationNeeded() then returns false on every subsequent boot,
// so vecMigrated is false, the `src/…` connector re-embed block is skipped FOREVER, and that
// text — which has no on-disk origin, is absent from moat-backup's SOURCES, and is untracked by
// notes_files — is never rebuilt. Guard 1 keeps the TEXT alive through the interruption; guard 2
// is what makes the next boot come back for it. Without guard 2 the retry never happens, so the
// regression is silent and permanent — the original defect's exact signature.
//
// WHY THIS SUITE DRIVES reindexImpl AND NOT maybeMigrateVecTable DIRECTLY. A unit test of
// `maybeMigrateVecTable(handle, override, { deferStamp: true })` proves the OPTION works while
// saying nothing about whether the call site passes it — deleting `{ deferStamp: true }` from
// reindexImpl would leave such a test green. The property only exists at the call site, so the
// test has to run the real reindex path.
//
// WHY node:sqlite. better-sqlite3 is built for Electron's ABI and throws on construction under
// the node-env vitest, so a suite gated on `describe.skipIf(!HAS_NATIVE_SQLITE)` / `nativeOk()`
// reports PASS while executing NOTHING — it would certify the exact property it never checks.
// better-sqlite3 is therefore mocked with a THIN shim over Node's built-in `node:sqlite`: real
// SQL, real transactions, real rollbacks. The only translation is the vec0 virtual-table DDL,
// which needs the native sqlite-vec extension; notes_vec becomes a plain rowid/BLOB table. The
// property under test is the index_meta stamp ordering, not the vec0 DDL. Same reasoning as
// index-store-src-remigration-node.test.ts, conversation-compact-node.test.ts and
// brain-db-vault-switch-node.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Embeddings OFF before index-store evaluates its module-level EMBEDDINGS_ENABLED const, so
// persistPending stops after the committed chunk transaction (no ONNX worker in a unit test).
// The chunk-write leg is the whole of what this suite needs: the interruption it injects is a
// failing WRITE, which is one of the three interruptions the fix's commit message names
// (SQLITE_BUSY from the concurrent notes-watcher reindex).
vi.hoisted(() => {
  process.env.DUIN_DISABLE_EMBEDDINGS = '1'
})

// ─────────────────────────── the node:sqlite-backed better-sqlite3 shim ───────────────────────────

/** Raw handles by path, so the test can seed/inspect the very DB reindex is using WITHOUT
 *  tripping the injected failure (seeding is not the run under test). */
const opened = new Map<string, DatabaseSync>()
/** The same handles as index-store sees them — through the injection seam. */
const shims = new Map<string, { prepare(sql: string): { run(...a: unknown[]): unknown } }>()
/** Successful `src/…` chunk inserts since the last reset — "how much did this run re-persist?". */
let srcInserts = 0
/** Throw on the Nth src insert of the current run (1-based); null = never. */
let failAtSrcInsert: number | null = null

const VEC0_DDL = /CREATE VIRTUAL TABLE (IF NOT EXISTS )?notes_vec USING vec0\([^)]*\)/i

vi.mock('better-sqlite3', () => {
  class Shim {
    readonly raw: DatabaseSync
    private depth = 0

    constructor(path: string) {
      this.raw = new DatabaseSync(path)
      opened.set(path, this.raw)
      shims.set(path, this as unknown as { prepare(sql: string): { run(...a: unknown[]): unknown } })
    }

    pragma(source: string): unknown {
      // better-sqlite3 takes `journal_mode = WAL`; node:sqlite wants the full statement.
      this.raw.exec(`PRAGMA ${source}`)
      return []
    }

    exec(sql: string): void {
      // sqlite-vec is a native extension that cannot load here. A plain table with the same
      // rowid/embedding shape satisfies every statement index-store issues against notes_vec
      // (DROP, CREATE, COUNT(*), DELETE ... WHERE rowid = ?, INSERT(rowid, embedding)).
      this.raw.exec(
        sql.replace(VEC0_DDL, 'CREATE TABLE IF NOT EXISTS notes_vec (rowid INTEGER PRIMARY KEY, embedding BLOB)')
      )
    }

    prepare(sql: string): unknown {
      const stmt: StatementSync = this.raw.prepare(sql)
      const isSrcChunkInsert = /INSERT INTO notes_chunks/i.test(sql)
      return {
        run: (...args: unknown[]) => {
          if (isSrcChunkInsert && typeof args[0] === 'string' && args[0].startsWith('src/')) {
            srcInserts++
            if (failAtSrcInsert !== null && srcInserts === failAtSrcInsert) {
              // The interruption: a write that fails partway through the src re-embed.
              throw new Error('SQLITE_BUSY: database is locked')
            }
          }
          return stmt.run(...(args as never[]))
        },
        get: (...args: unknown[]) => stmt.get(...(args as never[])),
        all: (...args: unknown[]) => stmt.all(...(args as never[]))
      }
    }

    /** better-sqlite3's db.transaction(fn) — a real BEGIN/COMMIT, SAVEPOINTs when nested. */
    transaction<T>(fn: () => T): () => T {
      return (): T => {
        const nested = this.depth > 0
        const sp = `_tx${this.depth}`
        this.raw.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN')
        this.depth++
        try {
          const out = fn()
          this.raw.exec(nested ? `RELEASE ${sp}` : 'COMMIT')
          return out
        } catch (e) {
          this.raw.exec(nested ? `ROLLBACK TO ${sp}` : 'ROLLBACK')
          throw e
        } finally {
          this.depth--
        }
      }
    }

    close(): void {
      this.raw.close()
    }
  }
  return { default: Shim }
})

// sqlite-vec is "available" — otherwise maybeMigrateVecTable returns false at its first line
// and there is no migration to defer the stamp of.
vi.mock('../rag/vec-loader', () => ({
  isVecAvailable: (): boolean => true,
  loadSqliteVec: (): void => {}
}))

// Never reached (embeddings are disabled) — mocked only to keep the ONNX/transformers graph
// out of a unit test's import cost.
vi.mock('../rag/embeddings/service', () => ({
  getEmbeddingsService: (): never => {
    throw new Error('embeddings service must not be constructed in this suite')
  }
}))

// Plain-text loaders: the document pipeline is not what is under test.
vi.mock('../rag/loaders', () => ({
  loadDocument: async (file: string): Promise<{ kind: 'text'; text: string }> => ({
    kind: 'text',
    text: readFileSync(file, 'utf-8')
  }),
  isSupportedTextExtension: (name: string): boolean => name.toLowerCase().endsWith('.md'),
  isOfficeExtension: (): boolean => false,
  isIWorkExtension: (): boolean => false,
  isImageExtension: (): boolean => false,
  isAudioExtension: (): boolean => false,
  ocrEnabled: (): boolean => false,
  audioTranscribeEnabled: (): boolean => false
}))

// Touches the real vault on disk; irrelevant here.
vi.mock('./moat-backup', () => ({ backupMoatState: (): void => {} }))

import {
  reindex,
  setLocalBrainUserDataPath,
  setEmbedderOverride,
  __resetLocalBrainStoreForTest
} from './index-store'

// ─────────────────────────────────────── fixture ───────────────────────────────────────

// A plausible index, not a toy row. PERSIST_BATCH inside reindexImpl is 256, so the src
// re-embed below runs THREE batches — a single-batch fixture would not even open the
// interruption window this test is about.
//
// Sized deliberately at the SMALLEST value that still spans batches with room to die in
// the middle of one. It was 1200 (five batches), which cost 6.35s of test time and was
// enough, under the full suite's parallel load, to push `ans/action-ledger` past vitest's
// 15s timeout — measured, not guessed: with this file removed the suite ran 11 failures
// twice; with it, 12–13. The property under test is the batch BOUNDARY, not the volume,
// so the cost bought nothing. Keep this at 600 unless PERSIST_BATCH changes.
const SRC_CHUNKS = 600
const NOTE_FILES = 40
const SRC_BATCHES = Math.ceil(SRC_CHUNKS / 256)

let root: string
let userData: string
let vault: string

const handle = (): DatabaseSync => opened.get(join(userData, 'local-brain.db'))!

const meta = (key: string): string | null => {
  const row = handle().prepare('SELECT value FROM index_meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

const countWhere = (like: string): number =>
  Number(
    (handle().prepare('SELECT COUNT(*) AS n FROM notes_chunks WHERE file LIKE ?').get(like) as { n: number | bigint }).n
  )

const srcTexts = (): string[] =>
  (handle().prepare("SELECT text FROM notes_chunks WHERE file LIKE 'src/%' ORDER BY text").all() as {
    text: string
  }[]).map((r) => r.text)

/** Connector-ingested chunks across three sources — the rows with no on-disk origin. */
function seedSrcChunks(): void {
  const ins = handle().prepare('INSERT INTO notes_chunks (file, chunk_index, text) VALUES (?, ?, ?)')
  const sources = ['slack', 'gmail', 'calendar']
  for (let i = 0; i < SRC_CHUNKS; i++) {
    const source = sources[i % 3]
    ins.run(
      `src/${source}/thread-${Math.floor(i / 12)}`,
      i % 12,
      `Ingested ${source} item ${i}. Unrecoverable once the adapter's API window rolls off.`
    )
  }
}

function seedVault(): void {
  for (let i = 0; i < NOTE_FILES; i++) {
    writeFileSync(
      join(vault, `note-${i}.md`),
      `# Note ${i}\n\n${`Vault prose for note ${i} that re-derives from disk on any reindex. `.repeat(30)}`,
      'utf-8'
    )
  }
}

/** Bring the index up on the DEFAULT embedder: schema created, meta stamped, ledger written. */
async function bootIndexOnDefaultEmbedder(): Promise<void> {
  seedVault()
  await reindex(vault)
  seedSrcChunks()
  srcInserts = 0
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'defer-stamp-'))
  userData = join(root, 'userData')
  vault = join(root, 'vault')
  mkdirSync(userData, { recursive: true })
  mkdirSync(vault, { recursive: true })
  opened.clear()
  shims.clear()
  srcInserts = 0
  failAtSrcInsert = null
  __resetLocalBrainStoreForTest()
  setEmbedderOverride(null)
  setLocalBrainUserDataPath(userData)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  setEmbedderOverride(null)
  __resetLocalBrainStoreForTest()
  rmSync(root, { recursive: true, force: true })
})

// ────────────── the seam really executes (guards against a silently-skipping suite) ──────────────

describe('test harness', () => {
  it('runs the real reindex path against real SQL', async () => {
    await bootIndexOnDefaultEmbedder()

    // Real rows, from a real walk of a real directory, through the real reindex.
    expect(countWhere('src/%')).toBe(SRC_CHUNKS)
    expect(countWhere('note-%')).toBeGreaterThan(NOTE_FILES)
    expect(meta('embedder_id')).toBe('multilingual-e5-small')
    expect(meta('embedder_dim')).toBe('384')
    // And the injected interruption is genuinely capable of aborting a write on the handle
    // index-store actually holds — an inert injection would make every case below vacuous.
    failAtSrcInsert = 1
    const shim = shims.get(join(userData, 'local-brain.db'))!
    expect(() =>
      shim.prepare('INSERT INTO notes_chunks (file, chunk_index, text) VALUES (?, ?, ?)').run('src/x/y', 0, 't')
    ).toThrow('SQLITE_BUSY')
  })
})

// ────────────────────────────── the interruption (the property) ──────────────────────────────

describe('embedder migration done-marker — interrupted', () => {
  it('does NOT stamp index_meta when the migration dies partway', async () => {
    await bootIndexOnDefaultEmbedder()

    // The switch: multilingual-e5-small (384) → bge-m3 (1024). A real dim change, exactly what
    // settings and runEmbedderEval's candidate sweep both do.
    setEmbedderOverride('bge-m3')
    // Die inside the SECOND of three src batches — past the point of no return, nowhere near the end.
    failAtSrcInsert = 300

    await expect(reindex(vault)).rejects.toThrow('SQLITE_BUSY')

    // THE ASSERTION. The index must still read as built by the OLD embedder, so the next boot
    // re-migrates. Stamped up front, these would already say bge-m3 / 1024 and the src re-embed
    // would be skipped on every subsequent run, forever.
    expect(meta('embedder_id'), 'the done-marker was stamped over a half-migrated index').toBe(
      'multilingual-e5-small'
    )
    expect(meta('embedder_dim'), 'the dim marker was stamped over a half-migrated index').toBe('384')
  })

  it('leaves the connector text intact through the interruption (guard 1 + guard 2 together)', async () => {
    await bootIndexOnDefaultEmbedder()
    const before = srcTexts()

    setEmbedderOverride('bge-m3')
    failAtSrcInsert = 300
    await expect(reindex(vault)).rejects.toThrow('SQLITE_BUSY')

    // Guard 1 keeps the text; guard 2 (above) is what brings the next run back for it.
    expect(srcTexts()).toEqual(before)
    expect(countWhere('src/%')).toBe(SRC_CHUNKS)
  })

  it('the NEXT reindex retries the migration and re-embeds every src chunk', async () => {
    await bootIndexOnDefaultEmbedder()
    const before = srcTexts()

    setEmbedderOverride('bge-m3')
    failAtSrcInsert = 300
    await expect(reindex(vault)).rejects.toThrow('SQLITE_BUSY')

    // Next boot. Nothing else marks these rows dirty — notes_files does not track them and
    // moat-backup does not hold them — so the unstamped marker is the ONLY thing that can
    // bring the re-embed back.
    failAtSrcInsert = null
    srcInserts = 0
    await reindex(vault)

    expect(srcInserts, 'the interrupted migration was never retried').toBe(SRC_CHUNKS)
    expect(srcTexts()).toEqual(before)
    expect(countWhere('src/%')).toBe(SRC_CHUNKS)
    // Converged: now — and only now — the migration is done.
    expect(meta('embedder_id')).toBe('bge-m3')
    expect(meta('embedder_dim')).toBe('1024')
  })

  it('stays retryable across REPEATED interruptions (each run redoes the work)', async () => {
    await bootIndexOnDefaultEmbedder()
    setEmbedderOverride('bge-m3')

    // Two interruptions at different stages: batch 2, then batch 3. (Was [300, 700], which
    // no longer reaches a second failure now the fixture is 600 — and 550 is a better probe
    // anyway, since it lands in a different batch from 300 rather than the same one.)
    for (const failAt of [300, 550]) {
      failAtSrcInsert = failAt
      srcInserts = 0
      await expect(reindex(vault)).rejects.toThrow('SQLITE_BUSY')
      expect(meta('embedder_id')).toBe('multilingual-e5-small')
      // Each interrupted run got real work done before dying — it is not spinning on nothing.
      expect(srcInserts).toBe(failAt)
    }

    failAtSrcInsert = null
    srcInserts = 0
    await reindex(vault)
    expect(srcInserts).toBe(SRC_CHUNKS)
    expect(meta('embedder_id')).toBe('bge-m3')
  })
})

// ───────────────── the happy path (the guard cannot pass by simply never stamping) ─────────────────

describe('embedder migration done-marker — completed', () => {
  it('DOES stamp once the whole migration finishes', async () => {
    await bootIndexOnDefaultEmbedder()

    setEmbedderOverride('bge-m3')
    await reindex(vault)

    expect(meta('embedder_id')).toBe('bge-m3')
    expect(meta('embedder_dim')).toBe('1024')
    expect(srcInserts, 'every src chunk should have been re-embedded across its batches').toBe(SRC_CHUNKS)
    expect(SRC_BATCHES).toBeGreaterThan(1) // the fixture really does span batches
  })

  it('a completed migration is not redone on the next reindex', async () => {
    await bootIndexOnDefaultEmbedder()
    setEmbedderOverride('bge-m3')
    await reindex(vault)

    srcInserts = 0
    await reindex(vault)

    // The marker matches, so vecMigrationNeeded() is false — no pointless ~40-minute re-embed
    // on every boot. Deferring the stamp must not cost idempotence.
    expect(srcInserts).toBe(0)
    expect(meta('embedder_id')).toBe('bge-m3')
    expect(countWhere('src/%')).toBe(SRC_CHUNKS)
  })
})
