// deleteCollection must purge rag_chunk_vec alongside the cascaded chunks — EXECUTING coverage
// against Node's built-in `node:sqlite`, so the delete transaction and the rowid reuse both happen
// for real without the Electron better-sqlite3 ABI.
//
// This file exists because the obvious test does not work. The sibling store.test.ts forces the
// memory fallback in beforeEach, so it never touches a single line of the SQL delete path; a test
// written there passes with the vec cleanup removed. Injecting a node:sqlite handle through the
// DeleteCollectionDeps seam (the same shape conversation-compact-node.test.ts uses) makes the
// statement genuinely executable here.
//
// The property under test: deleteCollection let the FK cascade take rag_documents -> rag_chunks but
// never deleted the matching rag_chunk_vec rows — the exact cleanup deleteDocument and
// deleteChunksForDocument both perform explicitly. rag_chunks has no AUTOINCREMENT, so SQLite hands
// the freed rowids straight back to the next ingest and the orphans collide on the vec0 INTEGER
// PRIMARY KEY, destroying THAT write.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { Database } from 'better-sqlite3'

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('electron app not available in test environment')
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { deleteCollection, reconcileOrphanVecRows, type DeleteCollectionDeps } from './store'

// Mirrors schema-init.ts: both FKs are ON DELETE CASCADE, and rag_chunk_vec is keyed on the chunk
// rowid. The production table is a vec0 virtual table; a plain table with the same INTEGER PRIMARY
// KEY reproduces the collision that matters here (and node:sqlite has no vec0 extension).
const SCHEMA = `
  CREATE TABLE rag_collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    embedder_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE rag_documents (
    id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL REFERENCES rag_collections(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL
  );
  CREATE TABLE rag_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
    collection_id TEXT NOT NULL,
    text TEXT NOT NULL
  );
  CREATE TABLE rag_chunk_vec (
    chunk_rowid INTEGER PRIMARY KEY,
    embedding BLOB
  );
`

let db: DatabaseSync
const asDb = (): Pick<Database, 'prepare'> => db as unknown as Pick<Database, 'prepare'>

/** A real transaction over node:sqlite — mirrors the production `transactional` helper. */
const realTx = <T,>(fn: () => T): T => {
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
const deps = (): DeleteCollectionDeps => ({ db: asDb(), transactional: realTx })

const addCollection = (id: string): void => {
  db.prepare(
    'INSERT INTO rag_collections (id, name, embedder_id, created_at, updated_at) VALUES (?,?,?,?,?)'
  ).run(id, `Collection ${id}`, 'bge-small-en-v1.5', 1000, 1000)
}

/** Ingest a document: N chunks plus one vec row per chunk, exactly as insertChunks does. */
const ingest = (collectionId: string, docId: string, n: number): number[] => {
  db.prepare('INSERT INTO rag_documents (id, collection_id, display_name) VALUES (?,?,?)').run(
    docId,
    collectionId,
    `${docId}.pdf`
  )
  const rowids: number[] = []
  for (let i = 0; i < n; i++) {
    const res = db
      .prepare('INSERT INTO rag_chunks (id, document_id, collection_id, text) VALUES (?,?,?,?)')
      .run(`${docId}-c${i}`, docId, collectionId, `Chunk ${i} of ${docId}, the only copy of this text.`)
    const rowid = Number(res.lastInsertRowid)
    rowids.push(rowid)
    db.prepare('INSERT INTO rag_chunk_vec (chunk_rowid, embedding) VALUES (?,?)').run(
      rowid,
      Buffer.alloc(8)
    )
  }
  return rowids
}

const vecRowids = (): number[] =>
  (db.prepare('SELECT chunk_rowid AS r FROM rag_chunk_vec ORDER BY r').all() as { r: number }[]).map(
    (x) => Number(x.r)
  )

const orphanCount = (): number =>
  Number(
    (
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM rag_chunk_vec WHERE chunk_rowid NOT IN (SELECT rowid FROM rag_chunks)'
        )
        .get() as { n: number | bigint }
    ).n
  )

const chunkCount = (collectionId: string): number =>
  Number(
    (
      db
        .prepare('SELECT COUNT(*) AS n FROM rag_chunks WHERE collection_id = ?')
        .get(collectionId) as { n: number | bigint }
    ).n
  )

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
})

describe('deleteCollection — vec rows go with the cascaded chunks (node:sqlite)', () => {
  it('leaves NO orphaned rag_chunk_vec rows behind', () => {
    addCollection('A')
    addCollection('B')
    ingest('A', 'docA', 3)
    const bRowids = ingest('B', 'docB', 5) // B's chunks hold the highest rowids

    expect(vecRowids()).toHaveLength(8)

    expect(deleteCollection('B', deps())).toBe(true)

    // The cascade removed B's documents and chunks...
    expect(chunkCount('B')).toBe(0)
    // ...and the vec rows must have gone with them. Pre-fix this was 5.
    expect(orphanCount()).toBe(0)
    expect(vecRowids()).toEqual([1, 2, 3])
    for (const r of bRowids) expect(vecRowids()).not.toContain(r)
  })

  it('THE BUG: the NEXT ingest into a surviving collection still persists', () => {
    addCollection('A')
    addCollection('B')
    ingest('A', 'docA', 3)
    ingest('B', 'docB', 5) // rowids 4..8

    deleteCollection('B', deps())

    // rag_chunks has no AUTOINCREMENT, so the next insert reclaims rowid 4 — precisely the rowid an
    // orphaned vec row would still be holding.
    expect(() => ingest('A', 'docNEW', 3)).not.toThrow()

    // Pre-fix, the vec insert raised a PRIMARY KEY collision, the whole ingest transaction rolled
    // back, and docNEW's chunks never landed while the store latched to volatile memory.
    expect(chunkCount('A')).toBe(6)
    expect(vecRowids()).toEqual([1, 2, 3, 4, 5, 6])
    expect(orphanCount()).toBe(0)
  })

  it('does not touch vec rows belonging to other collections', () => {
    addCollection('A')
    addCollection('B')
    const aRowids = ingest('A', 'docA', 4)
    ingest('B', 'docB', 2)

    deleteCollection('B', deps())

    expect(vecRowids()).toEqual(aRowids)
    expect(chunkCount('A')).toBe(4)
  })

  it('returns false and deletes nothing for an unknown collection id', () => {
    addCollection('A')
    const aRowids = ingest('A', 'docA', 3)

    expect(deleteCollection('nope', deps())).toBe(false)
    expect(vecRowids()).toEqual(aRowids)
    expect(chunkCount('A')).toBe(3)
  })
})

describe('reconcileOrphanVecRows — repairs a DB already damaged by the old path (node:sqlite)', () => {
  it('purges only the orphans and reports how many', () => {
    addCollection('A')
    const aRowids = ingest('A', 'docA', 3)
    // Simulate the pre-fix damage: vec rows whose chunks are gone.
    for (const r of [900, 901, 902]) {
      db.prepare('INSERT INTO rag_chunk_vec (chunk_rowid, embedding) VALUES (?,?)').run(
        r,
        Buffer.alloc(8)
      )
    }
    expect(orphanCount()).toBe(3)

    expect(reconcileOrphanVecRows(deps())).toBe(3)

    expect(orphanCount()).toBe(0)
    expect(vecRowids()).toEqual(aRowids)
  })

  it('is a no-op on a healthy DB', () => {
    addCollection('A')
    const aRowids = ingest('A', 'docA', 3)
    expect(reconcileOrphanVecRows(deps())).toBe(0)
    expect(vecRowids()).toEqual(aRowids)
  })
})
