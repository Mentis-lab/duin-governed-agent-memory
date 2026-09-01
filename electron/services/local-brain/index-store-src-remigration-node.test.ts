// remigrateSrcChunks durability — EXECUTING coverage against Node's built-in
// `node:sqlite`, because better-sqlite3 is built for Electron's ABI and won't load
// under vitest (every other index-store suite is pure for that reason, and a
// skipIf'd DB test would pass while checking nothing).
//
// The property under test: an embedder change DROPs notes_vec, so the connector
// -ingested `src/…` chunks keep their text but lose their vectors and must be
// re-embedded. That re-embed used to `DELETE FROM notes_chunks WHERE file LIKE
// 'src/%'` in ONE bare autocommit statement and only then re-insert across ~20
// awaited embed batches (120s timeout each — up to ~40 minutes). Quitting the app,
// an embed utilityProcess segfault, or SQLITE_BUSY from the concurrent
// notes-watcher reindex left the remaining batches unwritten. That text has no
// on-disk origin (unlike file notes, which re-derive from the vault), is not in
// moat-backup's SOURCES, and is untracked by notes_files — so it was gone for good.
//
// Now each batch's delete is folded into the same transaction as its re-insert, so
// every chunk's text exists at every instant and an interrupted pass is redone on
// the next reindex (whose done-marker is likewise deferred — see reindexImpl).
import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { remigrateSrcChunks, type SrcRemigrationDb } from './index-store'

const SCHEMA = `
  CREATE TABLE notes_chunks (
    id INTEGER PRIMARY KEY,
    file TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL
  );
`

let db: DatabaseSync
const asDb = (): SrcRemigrationDb => db as unknown as SrcRemigrationDb

const realTx = (fn: () => void): void => {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** Faithful stand-in for persistPending: the delete of the superseded ids happens
 *  inside the SAME transaction as the insert, then the (async, failure-prone)
 *  embed runs afterwards. `failOnBatch` simulates the interruption. */
const makePersist = (opts: { failOnBatch?: number; failBeforeWrite?: boolean } = {}) => {
  let batch = 0
  const persist = async (
    rows: { file: string; chunkIndex: number; text: string }[],
    replaceIds: number[]
  ): Promise<void> => {
    const n = batch++
    if (opts.failBeforeWrite && n === opts.failOnBatch) throw new Error('SQLITE_BUSY: database is locked')
    realTx(() => {
      for (const id of replaceIds) db.prepare('DELETE FROM notes_chunks WHERE id = ?').run(id)
      for (const r of rows)
        db.prepare('INSERT INTO notes_chunks (file, chunk_index, text) VALUES (?,?,?)').run(r.file, r.chunkIndex, r.text)
    })
    await Promise.resolve()
    // The embed leg: the utilityProcess dies / the 120s timeout trips.
    if (!opts.failBeforeWrite && n === opts.failOnBatch) throw new Error('embed process crashed')
  }
  return persist
}

const seedSrc = (n: number): void => {
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO notes_chunks (file, chunk_index, text) VALUES (?,?,?)').run(
      `src/slack/channel-${Math.floor(i / 10)}`,
      i % 10,
      `Ingested connector message ${i} — irrecoverable once the API window rolls off.`
    )
  }
}

const srcTexts = (): string[] =>
  (db.prepare("SELECT text FROM notes_chunks WHERE file LIKE 'src/%' ORDER BY text").all() as { text: string }[]).map(
    (r) => r.text
  )
const countWhere = (like: string): number =>
  Number((db.prepare('SELECT COUNT(*) AS n FROM notes_chunks WHERE file LIKE ?').get(like) as { n: number | bigint }).n)

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
})

describe('remigrateSrcChunks — connector chunks survive an interrupted embedder migration', () => {
  it('happy path: every src chunk is re-persisted exactly once (no loss, no duplicates)', async () => {
    seedSrc(50)
    const before = srcTexts()
    const done = await remigrateSrcChunks(asDb(), makePersist(), { batchSize: 8 })
    expect(done).toBe(50)
    expect(srcTexts()).toEqual(before)
  })

  it('embed crashes mid-run → ALL src text still present (the data-loss regression)', async () => {
    seedSrc(50)
    const before = srcTexts()
    await expect(remigrateSrcChunks(asDb(), makePersist({ failOnBatch: 2 }), { batchSize: 8 })).rejects.toThrow(
      'embed process crashed'
    )
    // The old delete-everything-up-front shape left only the batches that had
    // already been re-inserted (24 of 50); the rest were unrecoverable.
    expect(srcTexts()).toEqual(before)
    expect(countWhere('src/%')).toBe(50)
  })

  it('the batch write itself fails (SQLITE_BUSY) → that batch keeps its original rows', async () => {
    seedSrc(50)
    const before = srcTexts()
    await expect(
      remigrateSrcChunks(asDb(), makePersist({ failOnBatch: 0, failBeforeWrite: true }), { batchSize: 8 })
    ).rejects.toThrow('SQLITE_BUSY')
    expect(srcTexts()).toEqual(before)
  })

  it('a re-run after an interruption converges (no loss, no duplication)', async () => {
    seedSrc(50)
    const before = srcTexts()
    await expect(remigrateSrcChunks(asDb(), makePersist({ failOnBatch: 2 }), { batchSize: 8 })).rejects.toThrow()
    const done = await remigrateSrcChunks(asDb(), makePersist(), { batchSize: 8 })
    expect(done).toBe(50)
    expect(srcTexts()).toEqual(before)
  })

  it('file-note chunks are never touched (they are owned by the ledger path)', async () => {
    seedSrc(20)
    db.prepare('INSERT INTO notes_chunks (file, chunk_index, text) VALUES (?,?,?)').run('notes/plan.md', 0, 'vault note')
    await expect(remigrateSrcChunks(asDb(), makePersist({ failOnBatch: 1 }), { batchSize: 8 })).rejects.toThrow()
    expect(countWhere('notes/%')).toBe(1)
  })

  it('no src chunks → no-op', async () => {
    expect(await remigrateSrcChunks(asDb(), makePersist(), { batchSize: 8 })).toBe(0)
  })
})
