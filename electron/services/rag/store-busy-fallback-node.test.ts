// rag/store must NOT latch its process-wide memory fallback when a *live* database throws.
//
// The defect: `activateFallback` was reachable from ~15 catch sites that wrapped ordinary SQL
// calls, and it is a permanent process-wide latch (only the test-only `__resetCollectionStore`
// clears it). One transient SQLITE_BUSY — a headless CLI invocation, which database.ts:47-55
// explicitly exempts from the single-instance lock, or the periodic WAL checkpoint holding the
// write lock past busy_timeout=5000 — flipped the whole store to volatile arrays for the rest of
// the process. From that moment `listCollections()` returned `[...memoryFallback]` (empty), so the
// Library rendered zero collections as if every collection the user ever built had been deleted,
// while `insertChunks` reported fake success into memory and every re-created collection and
// re-ingested document was discarded at quit.
//
// The guard already existed next door: database.ts exports `withWriteRetry` (PS3) and
// conversation-store, tool-calls-store, brain-db, brain-db-durability and entity-graph-store all
// use it. rag/store.ts was the only store that never imported it.
//
// This file EXECUTES the SQL path. The sibling store.test.ts forces the memory fallback in
// beforeEach, so it never runs a line of it, and the real better-sqlite3 ABI does not load under
// vitest. So, like conversation-compact-node.test.ts and store-delete-collection-vec-node.test.ts,
// we drive real statements through Node's built-in `node:sqlite` behind a mocked `../database`
// module whose getDb() hands back that handle and which can inject SQLITE_BUSY on demand.
//
// `withWriteRetry` is re-implemented in the mock WITHOUT the sleep (the production one busy-waits
// via Atomics.wait, which would add seconds to this suite). The retry contract it models — BUSY
// only, 3 attempts, everything else rethrown — is the real one, and database-retry.test.ts covers
// the production implementation itself. What this file certifies is store.ts's side of the
// contract: that it routes its statements through the retry at all, and that a failure surviving
// the retries propagates instead of silently downgrading persistence to memory.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const state = vi.hoisted(() => ({
  db: null as unknown,
  getDbThrows: false,
  /** Number of upcoming statement executions that should raise SQLITE_BUSY. */
  busyCountdown: 0,
  retryCalls: 0
}))

vi.mock('../database', () => ({
  getDb: () => {
    if (state.getDbThrows) throw new Error('electron app not available in test environment')
    return state.db
  },
  transactional: <T>(fn: () => T): T => fn(),
  withWriteRetry: <T>(fn: () => T, opts: { maxRetries?: number } = {}): T => {
    state.retryCalls++
    const maxRetries = opts.maxRetries ?? 3
    let attempt = 0
    for (;;) {
      try {
        return fn()
      } catch (err) {
        const code = (err as { code?: string })?.code
        const isBusy = code === 'SQLITE_BUSY' || /SQLITE_BUSY/i.test(String((err as Error)?.message))
        if (!isBusy || attempt >= maxRetries) throw err
        attempt++
      }
    }
  }
}))

// No sqlite-vec extension in this environment; the chunks still land, retrieval just falls back to
// FTS. (Production consults the same flag.)
vi.mock('./vec-loader', () => ({
  isVecAvailable: () => false,
  getVecLoadError: () => null,
  loadSqliteVec: () => {}
}))

import {
  __resetCollectionStore,
  createCollection,
  insertChunks,
  insertDocument,
  isUsingMemoryFallback,
  getMemoryFallbackState,
  listCollections,
  listDocuments
} from './store'

// Mirrors the RAG segment of schema-init.ts (the columns store.ts actually binds).
const SCHEMA = `
  CREATE TABLE rag_collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    embedder_id TEXT NOT NULL,
    chunk_size INTEGER NOT NULL DEFAULT 800,
    chunk_overlap INTEGER NOT NULL DEFAULT 100,
    workspace_path TEXT,
    project_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE rag_documents (
    id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL REFERENCES rag_collections(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL,
    source_path TEXT,
    display_name TEXT NOT NULL,
    mime TEXT,
    bytes INTEGER,
    hash_sha256 TEXT NOT NULL,
    mtime INTEGER,
    status TEXT NOT NULL,
    status_detail TEXT,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    ingested_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE rag_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
    collection_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    heading_path TEXT,
    page INTEGER,
    line_start INTEGER,
    line_end INTEGER,
    text TEXT NOT NULL,
    token_count INTEGER,
    created_at INTEGER NOT NULL
  );
`

let real: DatabaseSync

/** better-sqlite3-shaped facade over node:sqlite that can raise SQLITE_BUSY on demand. */
function makeHandle(db: DatabaseSync): unknown {
  const busyGuard = (): void => {
    if (state.busyCountdown > 0) {
      state.busyCountdown--
      const err = new Error('database is locked') as Error & { code: string }
      err.code = 'SQLITE_BUSY'
      throw err
    }
  }
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql)
      return {
        run: (...args: unknown[]) => {
          busyGuard()
          return stmt.run(...(args as never[]))
        },
        all: (...args: unknown[]) => {
          busyGuard()
          return stmt.all(...(args as never[]))
        },
        get: (...args: unknown[]) => {
          busyGuard()
          return stmt.get(...(args as never[]))
        }
      }
    },
    transaction: (fn: () => unknown) => () => {
      db.exec('BEGIN')
      try {
        const out = fn()
        db.exec('COMMIT')
        return out
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    }
  }
}

function seedCollectionAndDocument(): { collectionId: string; documentId: string } {
  const collection = createCollection({
    name: 'Field notes',
    description: 'hand-authored, not derived from anything on disk',
    embedderId: 'bge-small-en-v1.5'
  })
  const doc = insertDocument({
    collectionId: collection.id,
    sourceKind: 'paste',
    displayName: 'pasted buffer',
    hashSha256: 'abc123',
    status: 'loading'
  })
  return { collectionId: collection.id, documentId: doc.id }
}

const chunk = (documentId: string, collectionId: string, i: number) => ({
  documentId,
  collectionId,
  chunkIndex: i,
  startOffset: i * 10,
  endOffset: i * 10 + 10,
  text: `chunk ${i}`
})

beforeEach(() => {
  real = new DatabaseSync(':memory:')
  real.exec(SCHEMA)
  state.db = makeHandle(real)
  state.getDbThrows = false
  state.busyCountdown = 0
  state.retryCalls = 0
  __resetCollectionStore()
})

describe('rag/store: a transient SQLITE_BUSY on a live DB', () => {
  it('retries the write instead of latching the process onto memory', () => {
    const { collectionId, documentId } = seedCollectionAndDocument()

    // The lock contention lands on insertChunks' transaction (store.ts's insertChunks), the exact
    // site the report names. Two BUSY errors, then the lock frees.
    state.busyCountdown = 2
    const result = insertChunks([
      chunk(documentId, collectionId, 0),
      chunk(documentId, collectionId, 1)
    ])

    expect(result.rowids).toHaveLength(2)
    expect(state.retryCalls).toBeGreaterThan(0)
    // The chunks are on disk, not in a volatile array.
    const persisted = real.prepare('SELECT COUNT(*) AS n FROM rag_chunks').get() as { n: number }
    expect(Number(persisted.n)).toBe(2)
    // And the store is still talking to the database.
    expect(isUsingMemoryFallback()).toBe(false)
    expect(listCollections().map((c) => c.id)).toEqual([collectionId])
  })
})

describe('rag/store: a SQLITE_BUSY that outlives the retries', () => {
  it('propagates to the caller instead of reporting fake success', () => {
    const { collectionId, documentId } = seedCollectionAndDocument()

    state.busyCountdown = 999
    // ingest.ts wraps insertChunks in try/catch and calls failDoc() — it can only do that if the
    // failure actually reaches it. The pre-fix store swallowed it and returned synthesized rowids,
    // so ingest marked the document 'ready' with a chunkCount matching nothing on disk.
    expect(() => insertChunks([chunk(documentId, collectionId, 0)])).toThrow(/locked|BUSY/i)

    state.busyCountdown = 0
    const onDisk = real.prepare('SELECT COUNT(*) AS n FROM rag_chunks').get() as { n: number }
    expect(Number(onDisk.n)).toBe(0)
  })

  it('leaves persisted collections and documents visible — no empty-Library lie', () => {
    const { collectionId, documentId } = seedCollectionAndDocument()

    state.busyCountdown = 999
    expect(() => insertChunks([chunk(documentId, collectionId, 0)])).toThrow()
    state.busyCountdown = 0

    // THE regression: the failed write must not have latched the store. If it did, these reads
    // return the empty in-memory arrays and the user sees zero collections — indistinguishable
    // from "everything I built was deleted" — while every subsequent write goes to memory and is
    // lost at quit.
    expect(isUsingMemoryFallback()).toBe(false)
    expect(getMemoryFallbackState().active).toBe(false)
    expect(listCollections().map((c) => c.id)).toEqual([collectionId])
    expect(listDocuments(collectionId).map((d) => d.id)).toEqual([documentId])

    // And a subsequent write still reaches the database rather than a volatile array.
    const second = createCollection({ name: 'Second', embedderId: 'bge-small-en-v1.5' })
    const rows = real
      .prepare('SELECT id FROM rag_collections WHERE id = ?')
      .all(second.id) as unknown[]
    expect(rows).toHaveLength(1)
  })

  it('does not latch on a non-BUSY SQL failure either', () => {
    const { collectionId } = seedCollectionAndDocument()

    // A foreign-key / constraint style failure: unknown document id. The DB is perfectly healthy.
    expect(() =>
      insertChunks([chunk('no-such-document', collectionId, 0)])
    ).toThrow()
    expect(isUsingMemoryFallback()).toBe(false)
    expect(listCollections().map((c) => c.id)).toEqual([collectionId])
  })
})

describe('rag/store: the memory fallback still covers the case it was designed for', () => {
  it('engages when getDb() itself is unavailable, and records reason + timestamp', () => {
    state.getDbThrows = true
    const before = Date.now()

    const created = createCollection({ name: 'Headless', embedderId: 'bge-small-en-v1.5' })

    expect(isUsingMemoryFallback()).toBe(true)
    const fallback = getMemoryFallbackState()
    expect(fallback.active).toBe(true)
    expect(fallback.reason).toMatch(/createCollection/)
    expect(fallback.since).toBeGreaterThanOrEqual(before)
    expect(listCollections().map((c) => c.id)).toEqual([created.id])
  })
})
