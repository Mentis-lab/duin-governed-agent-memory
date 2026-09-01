// The RAG vector leg must spend its k budget INSIDE the queried collections.
//
// `rag_chunk_vec` is one physical vec0 index shared by every collection, and
// `rag:auto-attach` mints a collection per conversation, so a normal user's
// index holds dozens of unrelated scopes. The pre-fix statement filtered by
// `c.collection_id` on the JOINED rag_chunks row — a predicate vec0 cannot see,
// so SQLite resolved the globally-nearest k chunks first and discarded the
// out-of-scope ones afterwards. The result was silent: no error, no wrong rows,
// just a near-empty vector leg for the document the user had just attached, and
// hybrid retrieval quietly degrading to BM25.
//
// Nothing about that is observable through the memory fallback the sibling
// retrieve.test.ts uses (it has no vector leg at all) or through a query-string
// assertion, so this suite executes `runVectorLeg` against a REAL vec0 index.
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import BetterSqlite3, { type Database } from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('electron app not available in test environment')
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { runVectorLeg } from './retrieve'

// Mirrors the guard the other native-DB suites use — and verify-proof's own
// probe — exactly, so --list-native-skips accounts for this file. Deliberately
// does NOT also probe sqlite-vec: folding that in would let a vec0 load failure
// vanish as an "ABI skip" while the gate reports these suites as executing. A
// missing extension has to be loud, so it surfaces as a beforeAll failure and
// as the explicit vec_version() assertion below.
const HAS_NATIVE_SQLITE: boolean = (() => {
  try {
    const probe = new BetterSqlite3(':memory:')
    probe.prepare('SELECT 1 AS ok').get()
    probe.close()
    return true
  } catch {
    return false
  }
})()

const DIM = 384

/**
 * A vector at exactly L2 distance `delta` from the query vector `e0`, offset
 * along a basis direction the query has no component in. Deterministic by
 * construction — the ranking under test never depends on random draws.
 */
function vecAt(delta: number, axis: number): Float32Array {
  const v = new Float32Array(DIM)
  v[0] = 1
  v[2 + (axis % (DIM - 2))] = delta
  return v
}

const QUERY = vecAt(0, 0) // e0 itself

// Sizing mirrors the reported scenario: ~20 conversations' worth of attached
// files already in the shared index, then one freshly attached document.
const DECOY_COLLECTIONS = 20
const DECOY_PER_COLLECTION = 50
const SCOPED_CHUNKS = 40
const K = 30

const SCOPED_COLLECTION = '__auto:conv-fresh'

let db: Database
const allCollections: string[] = []

beforeAll(() => {
  if (!HAS_NATIVE_SQLITE) return
  db = new BetterSqlite3(':memory:')
  sqliteVec.load(db)
  // Mirrors schema-init.ts: rag_chunks (rowid keyed) + the vec0 table pinned to
  // FLOAT[384]. Only the columns runVectorLeg touches are reproduced.
  db.exec(`
    CREATE TABLE rag_chunks (
      id            TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      text          TEXT NOT NULL
    );
    CREATE INDEX idx_rag_chunks_collection ON rag_chunks(collection_id);
    CREATE VIRTUAL TABLE rag_chunk_vec USING vec0(
      chunk_rowid INTEGER PRIMARY KEY,
      embedding   FLOAT[384]
    );
  `)

  const insChunk = db.prepare(
    'INSERT INTO rag_chunks (id, collection_id, text) VALUES (?, ?, ?)'
  )
  // BigInt forces an INTEGER bind — vec0 rejects a rowid it sees as REAL. Same
  // reason store.ts insertChunks does it.
  const insVec = db.prepare(
    'INSERT INTO rag_chunk_vec (chunk_rowid, embedding) VALUES (?, ?)'
  )
  const add = (collectionId: string, id: string, v: Float32Array): void => {
    const res = insChunk.run(id, collectionId, id)
    insVec.run(BigInt(Number(res.lastInsertRowid)), Buffer.from(v.buffer))
  }

  db.transaction(() => {
    // Out-of-scope chunks: very close to the query (delta 0.001 … 0.101), i.e.
    // they own the global nearest neighbourhood. This is the deterministic
    // encoding of what clustered real data produces statistically — a scoped
    // collection is a small minority of one shared index, so the global top-k
    // is dominated by chunks the caller never asked for.
    let axis = 0
    for (let c = 0; c < DECOY_COLLECTIONS; c++) {
      const cid = `__auto:conv-${c}`
      allCollections.push(cid)
      for (let j = 0; j < DECOY_PER_COLLECTION; j++) {
        add(cid, `${cid}:chunk-${j}`, vecAt(0.001 + 0.0001 * axis, axis))
        axis++
      }
    }
    // In-scope chunks: farther away (delta 1.000 … 1.039) but strictly ordered,
    // so the expected in-scope ranking is known exactly.
    allCollections.push(SCOPED_COLLECTION)
    for (let i = 0; i < SCOPED_CHUNKS; i++) {
      add(SCOPED_COLLECTION, `scoped-chunk-${i}`, vecAt(1 + 0.001 * i, axis++))
    }
  })()
})

afterAll(() => {
  db?.close()
})

describe.skipIf(!HAS_NATIVE_SQLITE)('runVectorLeg — scope must bound the KNN', () => {
  it('actually has vec0 loaded (without it every assertion below is vacuous)', () => {
    const row = db.prepare('SELECT vec_version() AS v').get() as { v: string }
    expect(typeof row?.v).toBe('string')
  })

  it('returns a full k of in-scope neighbours even when the shared index is dominated by other collections', () => {
    const rows = runVectorLeg(db, QUERY, [SCOPED_COLLECTION], K)

    // Before the fix the KNN resolved the global nearest 30 — all of them
    // decoys — and the collection filter then threw every one away, so this
    // came back EMPTY while `vecHits: 0` looked like "nothing was relevant".
    expect(rows).toHaveLength(K)
    for (const r of rows) {
      expect(r.chunk_id).toMatch(/^scoped-chunk-/)
    }
  })

  it('ranks the in-scope neighbours correctly, not just enough of them', () => {
    const rows = runVectorLeg(db, QUERY, [SCOPED_COLLECTION], K)
    const expected = Array.from({ length: K }, (_, i) => `scoped-chunk-${i}`)
    expect(rows.map((r) => r.chunk_id)).toEqual(expected)
    // Distances stay monotonically increasing — the leg still hands fuseRRF a
    // properly ordered ranking.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].distance).toBeGreaterThan(rows[i - 1].distance)
    }
  })

  it('is unchanged when every collection is in scope (no regression for single-collection databases)', () => {
    const rows = runVectorLeg(db, QUERY, allCollections, K)
    expect(rows).toHaveLength(K)
    // With the whole index in scope the answer is the true global top-k: the
    // 30 nearest decoys, in ascending distance.
    const brute = db
      .prepare(
        `SELECT c.id AS chunk_id
           FROM rag_chunk_vec v
           JOIN rag_chunks c ON c.rowid = v.chunk_rowid
          ORDER BY vec_distance_L2(v.embedding, ?)
          LIMIT ?`
      )
      .all(Buffer.from(QUERY.buffer), K) as { chunk_id: string }[]
    expect(rows.map((r) => r.chunk_id)).toEqual(brute.map((r) => r.chunk_id))
  })

  it('returns fewer than k when the scope holds fewer chunks, and never leaks another collection', () => {
    const rows = runVectorLeg(db, QUERY, ['__auto:conv-0'], DECOY_PER_COLLECTION + 25)
    expect(rows).toHaveLength(DECOY_PER_COLLECTION)
    for (const r of rows) {
      expect(r.chunk_id.startsWith('__auto:conv-0:')).toBe(true)
    }
  })

  it('returns empty (and does not throw) for a collection with no chunks', () => {
    expect(runVectorLeg(db, QUERY, ['__auto:conv-never-ingested'], K)).toEqual([])
  })
})
