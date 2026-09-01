import { randomUUID } from 'crypto'
import type { Database } from 'better-sqlite3'
import { getDb, transactional, withWriteRetry } from '../database'
// Static import (was a late `require`, which is unresolvable under vitest's ESM
// transform and made the whole insertChunks SQL path untestable). vec-loader
// imports nothing from this module and only a type from better-sqlite3, so
// there is no cycle and no load-time side effect.
import { isVecAvailable } from './vec-loader'

// rag_collections CRUD. The store owns id generation, timestamping, and the
// row ↔ object conversion. Per the persistence-boundary doc, IPC handlers
// call into this module and not directly into SQLite; spine emission also
// lives here so an event row is impossible to miss.
//
// The `RagCollection` type is duplicated in `src/lib/types.ts` for the
// renderer (the two tsconfig roots can't reach across the electron/src
// boundary). Keep both in lockstep — same field names, same optionality.
export interface RagCollection {
  id: string
  name: string
  description?: string
  embedderId: string
  chunkSize: number
  chunkOverlap: number
  workspacePath?: string
  projectId?: string
  createdAt: number
  updatedAt: number
}
//
// Pattern mirrors `permission-policies-store.ts`: DB-first with a process-
// local memory fallback that activates if `getDb()` throws (headless tests)
// — and ONLY then. A statement that fails against a live DB is retried by
// `withWriteRetry` (database.ts, PS3) and then propagated; see
// `activateFallback` below for why it must not latch there.
// Mirroring the fallback specifically for collections keeps the test layer
// straightforward; rag_documents and rag_chunks land in R5 and don't need
// the same treatment because their tests get real fixtures and stubs.

export type CollectionInput = {
  name: string
  description?: string
  embedderId: string
  chunkSize?: number
  chunkOverlap?: number
  workspacePath?: string
  projectId?: string
}

export type CollectionPatch = Partial<
  Pick<
    CollectionInput,
    'name' | 'description' | 'embedderId' | 'chunkSize' | 'chunkOverlap' | 'workspacePath' | 'projectId'
  >
>

interface CollectionRow {
  id: string
  name: string
  description: string | null
  embedder_id: string
  chunk_size: number
  chunk_overlap: number
  workspace_path: string | null
  project_id: string | null
  created_at: number
  updated_at: number
}

const DEFAULT_CHUNK_SIZE = 800
const DEFAULT_CHUNK_OVERLAP = 100

function rowToCollection(row: CollectionRow): RagCollection {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    embedderId: row.embedder_id,
    chunkSize: row.chunk_size,
    chunkOverlap: row.chunk_overlap,
    workspacePath: row.workspace_path ?? undefined,
    projectId: row.project_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// ──────────────────── memory fallback ────────────────────

const memoryFallback: RagCollection[] = []
let useFallback = false
let fallbackReason: string | null = null
let fallbackSince: number | null = null

/**
 * Engage the process-local memory store.
 *
 * SCOPE — this is for exactly ONE condition, the one the header comment
 * describes: `getDb()` itself is unavailable (headless tests, no Electron
 * `app`, no database file at all). That is a TOTAL failure — there is no
 * persistence to lose, so serving process-local arrays is strictly better
 * than throwing.
 *
 * It is deliberately NOT reachable from a failure *inside* a SQL call. That
 * is a PARTIAL failure: the database is open and every row is still on disk.
 * Latching the fallback there used to make `listCollections` / `listDocuments`
 * return empty arrays — the Library rendered zero collections, as if the
 * user's whole corpus had been deleted — while every subsequent write went
 * to a volatile array that is discarded at quit. A single transient
 * SQLITE_BUSY (headless CLI holding the write lock, or the periodic WAL
 * checkpoint outrunning busy_timeout) was enough to trip it, permanently,
 * for the rest of the process. Transient SQL failures are now retried by
 * `withWriteRetry` (the same PS3 guard conversation-store, tool-calls-store,
 * brain-db and entity-graph-store use) and, if they still fail, they
 * propagate to the caller so ingest.ts can mark the document failed instead
 * of being handed fake success.
 */
function activateFallback(reason: string): void {
  if (!useFallback) {
    useFallback = true
    fallbackReason = reason
    fallbackSince = Date.now()
    console.warn(
      `[rag-collections] persistence unavailable, falling back to memory at ${new Date(
        fallbackSince
      ).toISOString()}: ${reason}`
    )
  }
}

export function isUsingMemoryFallback(): boolean {
  return useFallback
}

/**
 * Degraded-mode surface for the RAG IPC status handler. While the store is on
 * the memory fallback, everything it reports is process-local and dies at
 * quit; the renderer needs to be able to say so instead of rendering an empty
 * Library that looks like deletion.
 */
export function getMemoryFallbackState(): {
  active: boolean
  reason: string | null
  since: number | null
} {
  return { active: useFallback, reason: fallbackReason, since: fallbackSince }
}

/**
 * Acquire the DB handle for one store call.
 *
 * Returns `null` when the caller should use the memory fallback — i.e. the
 * fallback is already latched, or `getDb()` threw (no database in this
 * process). A handle means the DB is present: the caller runs its statements
 * inside {@link withWriteRetry} and lets anything that survives the retries
 * propagate.
 */
function acquireDb(op: string): Database | null {
  if (useFallback) return null
  try {
    return getDb()
  } catch (err) {
    activateFallback(`${op}: ${(err as Error)?.message ?? 'unknown'}`)
    return null
  }
}

/**
 * Run one store statement group against a live DB, retrying a transient
 * SQLITE_BUSY. Anything still failing after the retries is rethrown — the
 * rows are on disk and the caller must learn that this operation did not
 * happen rather than silently switching to volatile memory.
 */
function runDb<T>(op: string, fn: () => T): T {
  try {
    return withWriteRetry(fn, { label: `rag.${op}` })
  } catch (err) {
    console.error(
      `[rag] ${op} failed against the database at ${new Date().toISOString()}: ${
        (err as Error)?.message ?? String(err)
      } — surfacing to the caller (persistence is NOT being downgraded to memory)`
    )
    throw err
  }
}

// ──────────────────── CRUD ────────────────────

export function createCollection(input: CollectionInput): RagCollection {
  if (!input || typeof input.name !== 'string' || input.name.trim() === '') {
    throw new Error('createCollection: name is required')
  }
  if (!input.embedderId || typeof input.embedderId !== 'string') {
    throw new Error('createCollection: embedderId is required')
  }
  const id = randomUUID()
  const now = Date.now()
  const record: RagCollection = {
    id,
    name: input.name.trim(),
    description: input.description?.trim() || undefined,
    embedderId: input.embedderId,
    chunkSize: input.chunkSize ?? DEFAULT_CHUNK_SIZE,
    chunkOverlap: input.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP,
    workspacePath: input.workspacePath || undefined,
    projectId: input.projectId || undefined,
    createdAt: now,
    updatedAt: now
  }

  const db = acquireDb('createCollection')
  if (db) {
    return runDb('createCollection', () => {
      db.prepare(
        `INSERT INTO rag_collections
           (id, name, description, embedder_id, chunk_size, chunk_overlap,
            workspace_path, project_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        record.id,
        record.name,
        record.description ?? null,
        record.embedderId,
        record.chunkSize,
        record.chunkOverlap,
        record.workspacePath ?? null,
        record.projectId ?? null,
        record.createdAt,
        record.updatedAt
      )
      return record
    })
  }
  memoryFallback.push({ ...record })
  return record
}

export function listCollections(): RagCollection[] {
  const db = acquireDb('listCollections')
  if (db) {
    return runDb('listCollections', () => {
      const rows = db
        .prepare('SELECT * FROM rag_collections ORDER BY updated_at DESC')
        .all() as CollectionRow[]
      return rows.map(rowToCollection)
    })
  }
  return [...memoryFallback]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => ({ ...c }))
}

export function getCollection(id: string): RagCollection | null {
  const db = acquireDb('getCollection')
  if (db) {
    return runDb('getCollection', () => {
      const row = db
        .prepare('SELECT * FROM rag_collections WHERE id = ?')
        .get(id) as CollectionRow | undefined
      return row ? rowToCollection(row) : null
    })
  }
  const found = memoryFallback.find((c) => c.id === id)
  return found ? { ...found } : null
}

export function updateCollection(id: string, patch: CollectionPatch): RagCollection {
  const existing = getCollection(id)
  if (!existing) {
    throw new Error(`updateCollection: no collection with id "${id}"`)
  }
  const now = Date.now()
  const next: RagCollection = {
    ...existing,
    name: patch.name?.trim() ? patch.name.trim() : existing.name,
    description:
      patch.description !== undefined
        ? patch.description?.trim() || undefined
        : existing.description,
    embedderId: patch.embedderId ?? existing.embedderId,
    chunkSize: patch.chunkSize ?? existing.chunkSize,
    chunkOverlap: patch.chunkOverlap ?? existing.chunkOverlap,
    workspacePath:
      patch.workspacePath !== undefined ? patch.workspacePath || undefined : existing.workspacePath,
    projectId:
      patch.projectId !== undefined ? patch.projectId || undefined : existing.projectId,
    updatedAt: now
  }

  const db = acquireDb('updateCollection')
  if (db) {
    return runDb('updateCollection', () => {
      db.prepare(
        `UPDATE rag_collections
            SET name = ?, description = ?, embedder_id = ?,
                chunk_size = ?, chunk_overlap = ?,
                workspace_path = ?, project_id = ?,
                updated_at = ?
          WHERE id = ?`
      ).run(
        next.name,
        next.description ?? null,
        next.embedderId,
        next.chunkSize,
        next.chunkOverlap,
        next.workspacePath ?? null,
        next.projectId ?? null,
        next.updatedAt,
        id
      )
      return next
    })
  }
  const idx = memoryFallback.findIndex((c) => c.id === id)
  if (idx >= 0) memoryFallback[idx] = { ...next }
  return { ...next }
}

/**
 * Seam so the vec-cleanup transaction is executable in a node-env test.
 * Mirrors `CompactConversationDeps` in `conversation-store.ts`: the real
 * getDb() path cannot run under vitest (better-sqlite3 ABI), and a suite
 * that silently skips would certify nothing.
 */
export interface DeleteCollectionDeps {
  db: Pick<Database, 'prepare'>
  transactional: <T>(fn: () => T) => T
}

export function deleteCollection(id: string, deps?: DeleteCollectionDeps): boolean {
  const handle = deps ? deps.db : acquireDb('deleteCollection')
  if (handle) {
    const d: DeleteCollectionDeps = deps ?? { db: handle, transactional }
    const db = d.db
    return runDb('deleteCollection', () => {
      // rag_documents.collection_id has ON DELETE CASCADE, which cascades to
      // rag_chunks. rag_chunk_vec rows are NOT cascaded by SQLite (vec0 is a
      // virtual table and FKs don't reach it), and the "R5 will add a chunk
      // AFTER-DELETE trigger" this code used to rely on never landed — see
      // initVecTable in schema-init.ts, which creates the table and nothing
      // else. So we do here exactly what deleteDocument and
      // deleteChunksForDocument already do: pre-fetch the chunk rowids and
      // DELETE the matching vec rows explicitly, inside the same transaction
      // as the collection delete.
      //
      // Skipping this leaks orphan vec rows keyed on rowids that rag_chunks
      // (no AUTOINCREMENT) hands straight back to the next ingest, and the
      // resulting vec0 PRIMARY KEY collision takes down that later write.
      return d.transactional(() => {
        const chunkRows = db
          .prepare(
            `SELECT c.rowid AS rowid
               FROM rag_chunks c
               JOIN rag_documents d ON d.id = c.document_id
              WHERE d.collection_id = ?`
          )
          .all(id) as { rowid: number }[]
        for (const r of chunkRows) {
          try {
            db.prepare('DELETE FROM rag_chunk_vec WHERE chunk_rowid = ?').run(r.rowid)
          } catch {
            // vec0 absent — fine.
          }
        }
        const result = db
          .prepare('DELETE FROM rag_collections WHERE id = ?')
          .run(id)
        const deleted = Number(result.changes) > 0
        if (deleted && chunkRows.length > 0) {
          // Traceability: the vectors are a rebuildable cache, but record
          // what was purged and when so an operator can correlate a later
          // retrieval gap with this delete.
          console.log(
            `[rag] deleteCollection ${id}: purged ${chunkRows.length} rag_chunk_vec row(s) at ${new Date().toISOString()}`
          )
        }
        return deleted
      })
    })
  }
  const idx = memoryFallback.findIndex((c) => c.id === id)
  if (idx < 0) return false
  memoryFallback.splice(idx, 1)
  return true
}

/**
 * Repair pass for DBs already damaged by the pre-fix deleteCollection:
 * purge rag_chunk_vec rows whose chunk_rowid no longer names a rag_chunks
 * row. Those orphans are a rebuildable cache on their own, but they hold
 * rowids that rag_chunks will hand back to the next ingest, and the vec0
 * PRIMARY KEY collision that follows destroys THAT write.
 *
 * Safe to call on a healthy DB (deletes nothing) and safe when the vec0
 * extension is unavailable (the table doesn't exist; we return 0).
 * Returns the number of orphans purged.
 */
export function reconcileOrphanVecRows(deps?: DeleteCollectionDeps): number {
  try {
    const d: DeleteCollectionDeps = deps ?? { db: getDb(), transactional }
    const db = d.db
    return d.transactional(() => {
      const orphans = db
        .prepare(
          `SELECT chunk_rowid AS rowid FROM rag_chunk_vec
            WHERE chunk_rowid NOT IN (SELECT rowid FROM rag_chunks)`
        )
        .all() as { rowid: number }[]
      for (const o of orphans) {
        db.prepare('DELETE FROM rag_chunk_vec WHERE chunk_rowid = ?').run(o.rowid)
      }
      if (orphans.length > 0) {
        console.warn(
          `[rag] reconcileOrphanVecRows: purged ${orphans.length} orphaned rag_chunk_vec row(s) at ${new Date().toISOString()} (rowids: ${orphans
            .map((o) => o.rowid)
            .join(',')})`
        )
      }
      return orphans.length
    })
  } catch {
    // vec0 absent, or no DB in this process — nothing to reconcile.
    return 0
  }
}

// ════════════════════ DOCUMENTS ════════════════════

// rag_documents CRUD + chunk-insert + cascade-on-delete. Same memory-
// fallback pattern as collections so headless tests can exercise the ingest
// orchestrator end-to-end without booting better-sqlite3.

export type DocumentStatus =
  | 'queued'
  | 'loading'
  | 'chunking'
  | 'embedding'
  | 'ready'
  | 'error'
  | 'stale'

export type DocumentSourceKind =
  | 'file'
  | 'paste'
  | 'workspace'
  | 'skill'
  | 'memory'
  | 'planning'

export interface RagDocument {
  id: string
  collectionId: string
  sourceKind: DocumentSourceKind
  sourcePath?: string
  displayName: string
  mime?: string
  bytes?: number
  hashSha256: string
  mtime?: number
  status: DocumentStatus
  statusDetail?: string
  chunkCount: number
  ingestedAt?: number
  updatedAt: number
}

export interface RagChunkRow {
  id: string
  documentId: string
  collectionId: string
  chunkIndex: number
  startOffset: number
  endOffset: number
  headingPath?: string
  page?: number
  lineStart?: number
  lineEnd?: number
  text: string
  tokenCount?: number
  createdAt: number
}

export interface InsertDocumentInput {
  collectionId: string
  sourceKind: DocumentSourceKind
  sourcePath?: string
  displayName: string
  mime?: string
  bytes?: number
  hashSha256: string
  mtime?: number
  status: DocumentStatus
  statusDetail?: string
}

interface DocumentRow {
  id: string
  collection_id: string
  source_kind: DocumentSourceKind
  source_path: string | null
  display_name: string
  mime: string | null
  bytes: number | null
  hash_sha256: string
  mtime: number | null
  status: DocumentStatus
  status_detail: string | null
  chunk_count: number
  ingested_at: number | null
  updated_at: number
}

function rowToDocument(row: DocumentRow): RagDocument {
  return {
    id: row.id,
    collectionId: row.collection_id,
    sourceKind: row.source_kind,
    sourcePath: row.source_path ?? undefined,
    displayName: row.display_name,
    mime: row.mime ?? undefined,
    bytes: row.bytes ?? undefined,
    hashSha256: row.hash_sha256,
    mtime: row.mtime ?? undefined,
    status: row.status,
    statusDetail: row.status_detail ?? undefined,
    chunkCount: row.chunk_count,
    ingestedAt: row.ingested_at ?? undefined,
    updatedAt: row.updated_at
  }
}

// Memory fallback shape is identical to RagDocument; aliased for clarity
// so the mutating in-memory operations read as "MemoryDocument" at the
// call sites without inventing an interface that adds no members.
// The memory fallback also holds chunks in process memory so the ingest
// orchestrator can verify counts + the orchestrator's transaction-shape
// behaviour in tests.
type MemoryDocument = RagDocument

const memoryDocuments: MemoryDocument[] = []
const memoryChunks: RagChunkRow[] = []

// ──────────────────── document CRUD ────────────────────

/**
 * Boot recovery. Ingest jobs live in memory (IngestManager), so any document
 * left in a transient phase (loading / chunking / embedding) belongs to a job
 * that died with the previous process — a crash, a force-quit, or a mid-ingest
 * restart. Those rows would otherwise show as perpetually "embedding" forever.
 * Reset them to 'error' so the UI is truthful and the user can re-ingest.
 * Call ONCE at startup, before any new job can begin. Returns the count reset.
 */
const INTERRUPTED_DETAIL = 'interrupted — the app restarted before ingest finished; re-index to retry'

export function resetInterruptedDocuments(): number {
  const db = acquireDb('resetInterruptedDocuments')
  if (db) {
    return runDb('resetInterruptedDocuments', () => {
      const info = db
        .prepare(
          `UPDATE rag_documents
             SET status = 'error', status_detail = ?, updated_at = ?
           WHERE status IN ('loading', 'chunking', 'embedding')`
        )
        .run(INTERRUPTED_DETAIL, Date.now())
      return Number(info.changes ?? 0)
    })
  }
  let n = 0
  for (const d of memoryDocuments) {
    if (d.status === 'loading' || d.status === 'chunking' || d.status === 'embedding') {
      d.status = 'error'
      d.statusDetail = INTERRUPTED_DETAIL
      d.updatedAt = Date.now()
      n++
    }
  }
  return n
}

export function insertDocument(input: InsertDocumentInput): RagDocument {
  if (!input.collectionId) throw new Error('insertDocument: collectionId is required')
  if (!input.displayName) throw new Error('insertDocument: displayName is required')
  if (!input.hashSha256) throw new Error('insertDocument: hashSha256 is required')
  const id = randomUUID()
  const now = Date.now()
  const record: RagDocument = {
    id,
    collectionId: input.collectionId,
    sourceKind: input.sourceKind,
    sourcePath: input.sourcePath,
    displayName: input.displayName,
    mime: input.mime,
    bytes: input.bytes,
    hashSha256: input.hashSha256,
    mtime: input.mtime,
    status: input.status,
    statusDetail: input.statusDetail,
    chunkCount: 0,
    ingestedAt: undefined,
    updatedAt: now
  }

  const db = acquireDb('insertDocument')
  if (db) {
    return runDb('insertDocument', () => {
      db.prepare(
        `INSERT INTO rag_documents
           (id, collection_id, source_kind, source_path, display_name,
            mime, bytes, hash_sha256, mtime,
            status, status_detail, chunk_count, ingested_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`
      ).run(
        record.id,
        record.collectionId,
        record.sourceKind,
        record.sourcePath ?? null,
        record.displayName,
        record.mime ?? null,
        record.bytes ?? null,
        record.hashSha256,
        record.mtime ?? null,
        record.status,
        record.statusDetail ?? null,
        record.updatedAt
      )
      return record
    })
  }
  memoryDocuments.push({ ...record })
  return record
}

export interface DocumentPatch {
  status?: DocumentStatus
  statusDetail?: string | null
  chunkCount?: number
  ingestedAt?: number
  // Re-derived source metadata. A reingest rewrites its row in place rather
  // than forking a new one, so the hash has to travel with the new content:
  // leaving the old hash behind would let findDocumentByHash short-circuit a
  // later add of the ORIGINAL file against the row now holding the NEW text.
  hashSha256?: string
  bytes?: number
  mtime?: number
}

export function updateDocument(id: string, patch: DocumentPatch): RagDocument | null {
  const db = acquireDb('updateDocument')
  if (db) {
    return runDb('updateDocument', () => {
      const sets: string[] = ['updated_at = ?']
      const params: Array<string | number | null> = [Date.now()]
      if (patch.status !== undefined) {
        sets.push('status = ?')
        params.push(patch.status)
      }
      if (patch.statusDetail !== undefined) {
        sets.push('status_detail = ?')
        params.push(patch.statusDetail ?? null)
      }
      if (patch.chunkCount !== undefined) {
        sets.push('chunk_count = ?')
        params.push(patch.chunkCount)
      }
      if (patch.ingestedAt !== undefined) {
        sets.push('ingested_at = ?')
        params.push(patch.ingestedAt)
      }
      if (patch.hashSha256 !== undefined) {
        sets.push('hash_sha256 = ?')
        params.push(patch.hashSha256)
      }
      if (patch.bytes !== undefined) {
        sets.push('bytes = ?')
        params.push(patch.bytes)
      }
      if (patch.mtime !== undefined) {
        sets.push('mtime = ?')
        params.push(patch.mtime)
      }
      params.push(id)
      db.prepare(`UPDATE rag_documents SET ${sets.join(', ')} WHERE id = ?`).run(
        ...params
      )
      const row = db
        .prepare('SELECT * FROM rag_documents WHERE id = ?')
        .get(id) as DocumentRow | undefined
      return row ? rowToDocument(row) : null
    })
  }
  const idx = memoryDocuments.findIndex((d) => d.id === id)
  if (idx < 0) return null
  const next: MemoryDocument = {
    ...memoryDocuments[idx],
    status: patch.status ?? memoryDocuments[idx].status,
    statusDetail:
      patch.statusDetail === undefined
        ? memoryDocuments[idx].statusDetail
        : patch.statusDetail ?? undefined,
    chunkCount:
      patch.chunkCount === undefined
        ? memoryDocuments[idx].chunkCount
        : patch.chunkCount,
    ingestedAt:
      patch.ingestedAt === undefined ? memoryDocuments[idx].ingestedAt : patch.ingestedAt,
    hashSha256:
      patch.hashSha256 === undefined ? memoryDocuments[idx].hashSha256 : patch.hashSha256,
    bytes: patch.bytes === undefined ? memoryDocuments[idx].bytes : patch.bytes,
    mtime: patch.mtime === undefined ? memoryDocuments[idx].mtime : patch.mtime,
    updatedAt: Date.now()
  }
  memoryDocuments[idx] = next
  return { ...next }
}

export function getDocument(id: string): RagDocument | null {
  const db = acquireDb('getDocument')
  if (db) {
    return runDb('getDocument', () => {
      const row = db
        .prepare('SELECT * FROM rag_documents WHERE id = ?')
        .get(id) as DocumentRow | undefined
      return row ? rowToDocument(row) : null
    })
  }
  const found = memoryDocuments.find((d) => d.id === id)
  return found ? { ...found } : null
}

export function findDocumentByHash(
  collectionId: string,
  hashSha256: string
): RagDocument | null {
  const db = acquireDb('findDocumentByHash')
  if (db) {
    return runDb('findDocumentByHash', () => {
      const row = db
        .prepare(
          `SELECT * FROM rag_documents
             WHERE collection_id = ? AND hash_sha256 = ?
             LIMIT 1`
        )
        .get(collectionId, hashSha256) as DocumentRow | undefined
      return row ? rowToDocument(row) : null
    })
  }
  const found = memoryDocuments.find(
    (d) => d.collectionId === collectionId && d.hashSha256 === hashSha256
  )
  return found ? { ...found } : null
}

export function listDocuments(collectionId: string): RagDocument[] {
  const db = acquireDb('listDocuments')
  if (db) {
    return runDb('listDocuments', () => {
      const rows = db
        .prepare(
          `SELECT * FROM rag_documents
             WHERE collection_id = ?
             ORDER BY updated_at DESC`
        )
        .all(collectionId) as DocumentRow[]
      return rows.map(rowToDocument)
    })
  }
  return memoryDocuments
    .filter((d) => d.collectionId === collectionId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((d) => ({ ...d }))
}

export function deleteDocument(id: string): boolean {
  const db = acquireDb('deleteDocument')
  if (db) {
    return runDb('deleteDocument', () => {
      // rag_documents.id is the FK target for rag_chunks; the FK is ON
      // DELETE CASCADE so chunks go too. rag_chunk_vec rows are NOT
      // cascaded (vec0 is outside the FK plumbing) — we DELETE them
      // explicitly first so the rowids freed by the chunk delete don't
      // leak into the next vec INSERT.
      const chunkRows = db
        .prepare('SELECT rowid FROM rag_chunks WHERE document_id = ?')
        .all(id) as { rowid: number }[]
      for (const r of chunkRows) {
        try {
          db.prepare('DELETE FROM rag_chunk_vec WHERE chunk_rowid = ?').run(r.rowid)
        } catch {
          // vec0 absent — fine.
        }
      }
      const result = db
        .prepare('DELETE FROM rag_documents WHERE id = ?')
        .run(id)
      return Number(result.changes) > 0
    })
  }
  const idx = memoryDocuments.findIndex((d) => d.id === id)
  if (idx < 0) return false
  memoryDocuments.splice(idx, 1)
  // Cascade chunks.
  for (let i = memoryChunks.length - 1; i >= 0; i--) {
    if (memoryChunks[i].documentId === id) memoryChunks.splice(i, 1)
  }
  return true
}

// ──────────────────── chunks ────────────────────

export interface InsertChunkInput {
  documentId: string
  collectionId: string
  chunkIndex: number
  startOffset: number
  endOffset: number
  text: string
  headingPath?: string
  page?: number
  lineStart?: number
  lineEnd?: number
  tokenCount?: number
}

/**
 * Insert N chunks for one document and (optionally) write the matching vec
 * rows in a single transaction. The FTS5 mirror is kept in sync by the
 * AFTER INSERT trigger declared in `database.ts`.
 *
 * The vec write is gated on `vectors` being non-null AND `isVecAvailable()`
 * returning true. When `rag_chunk_vec` doesn't exist (older DB or extension
 * unavailable), the chunks still land — retrieval falls back to FTS-only.
 *
 * Returns the inserted chunk rowids in input order so the caller can
 * reconcile against `vectors` for a future re-insert.
 */
export function insertChunks(
  chunks: InsertChunkInput[],
  vectors?: Float32Array[]
): { rowids: number[]; ids: string[] } {
  if (chunks.length === 0) return { rowids: [], ids: [] }
  if (vectors && vectors.length !== chunks.length) {
    throw new Error(
      `insertChunks: vectors.length (${vectors.length}) must match chunks.length (${chunks.length})`
    )
  }
  const ids = chunks.map(() => randomUUID())
  const now = Date.now()

  const db = acquireDb('insertChunks')
  if (db) {
    // Every failure here propagates (after the SQLITE_BUSY retries in runDb).
    // A constraint violation means "this write is wrong"; a BUSY / IO error
    // means "this write did not land". Neither means "the database is gone",
    // and falling through to the memory arrays would hand ingest.ts
    // synthesized rowids — fake success. ingest.ts then marks the document
    // status:'ready' with a chunkCount matching nothing on disk, while the
    // whole store silently latches to volatile memory for the rest of the
    // process. Let ingest's catch (it calls failDoc) report it instead.
    return runDb('insertChunks', () => {
      const writeVec = !!vectors && isVecAvailable()
      const insertChunk = db.prepare(
        `INSERT INTO rag_chunks
           (id, document_id, collection_id, chunk_index,
            start_offset, end_offset, heading_path, page,
            line_start, line_end, text, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const insertVec = writeVec
        ? db.prepare(
            'INSERT INTO rag_chunk_vec(chunk_rowid, embedding) VALUES (?, ?)'
          )
        : null
      const tx = db.transaction(() => {
        const rowids: number[] = []
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i]
          const result = insertChunk.run(
            ids[i],
            c.documentId,
            c.collectionId,
            c.chunkIndex,
            c.startOffset,
            c.endOffset,
            c.headingPath ?? null,
            c.page ?? null,
            c.lineStart ?? null,
            c.lineEnd ?? null,
            c.text,
            c.tokenCount ?? null,
            now
          )
          const rowid = Number(result.lastInsertRowid)
          rowids.push(rowid)
          if (insertVec && vectors) {
            // BigInt forces an INTEGER bind — vec0 rejects a rowid it sees as
            // REAL ("Only integers are allowed for primary key values").
            insertVec.run(BigInt(rowid), Buffer.from(vectors[i].buffer))
          }
        }
        return rowids
      })
      const rowids = tx()
      return { rowids, ids }
    })
  }

  // Memory fallback: synthesize sequential rowids so the orchestrator can
  // assert one-to-one correspondence with vectors.
  const rowids: number[] = []
  let nextRowid = memoryChunks.length + 1
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]
    memoryChunks.push({
      id: ids[i],
      documentId: c.documentId,
      collectionId: c.collectionId,
      chunkIndex: c.chunkIndex,
      startOffset: c.startOffset,
      endOffset: c.endOffset,
      headingPath: c.headingPath,
      page: c.page,
      lineStart: c.lineStart,
      lineEnd: c.lineEnd,
      text: c.text,
      tokenCount: c.tokenCount,
      createdAt: now
    })
    rowids.push(nextRowid++)
  }
  return { rowids, ids }
}

export function deleteChunksForDocument(documentId: string): number {
  const db = acquireDb('deleteChunksForDocument')
  if (db) {
    return runDb('deleteChunksForDocument', () => {
      // Pre-fetch rowids so the vec rows can be removed alongside the
      // chunk rows. The FTS trigger fires AFTER DELETE on rag_chunks; the
      // vec table is virtual and doesn't get the FK cascade.
      const chunkRows = db
        .prepare('SELECT rowid FROM rag_chunks WHERE document_id = ?')
        .all(documentId) as { rowid: number }[]
      const tx = db.transaction(() => {
        for (const r of chunkRows) {
          try {
            db.prepare('DELETE FROM rag_chunk_vec WHERE chunk_rowid = ?').run(
              r.rowid
            )
          } catch {
            // vec0 absent — fine.
          }
        }
        const result = db
          .prepare('DELETE FROM rag_chunks WHERE document_id = ?')
          .run(documentId)
        return Number(result.changes)
      })
      return tx()
    })
  }
  let count = 0
  for (let i = memoryChunks.length - 1; i >= 0; i--) {
    if (memoryChunks[i].documentId === documentId) {
      memoryChunks.splice(i, 1)
      count++
    }
  }
  return count
}

export function getChunk(chunkId: string): RagChunkRow | null {
  const db = acquireDb('getChunk')
  if (db) {
    return runDb('getChunk', () => {
      const row = db
        .prepare(
          `SELECT id, document_id, collection_id, chunk_index,
                  start_offset, end_offset, heading_path, page,
                  line_start, line_end, text, token_count, created_at
             FROM rag_chunks WHERE id = ?`
        )
        .get(chunkId) as
        | {
            id: string
            document_id: string
            collection_id: string
            chunk_index: number
            start_offset: number
            end_offset: number
            heading_path: string | null
            page: number | null
            line_start: number | null
            line_end: number | null
            text: string
            token_count: number | null
            created_at: number
          }
        | undefined
      if (!row) return null
      return {
        id: row.id,
        documentId: row.document_id,
        collectionId: row.collection_id,
        chunkIndex: row.chunk_index,
        startOffset: row.start_offset,
        endOffset: row.end_offset,
        headingPath: row.heading_path ?? undefined,
        page: row.page ?? undefined,
        lineStart: row.line_start ?? undefined,
        lineEnd: row.line_end ?? undefined,
        text: row.text,
        tokenCount: row.token_count ?? undefined,
        createdAt: row.created_at
      }
    })
  }
  const found = memoryChunks.find((c) => c.id === chunkId)
  return found ? { ...found } : null
}

export function countChunksForDocument(documentId: string): number {
  const db = acquireDb('countChunksForDocument')
  if (db) {
    return runDb('countChunksForDocument', () => {
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM rag_chunks WHERE document_id = ?')
        .get(documentId) as { n: number }
      return row.n
    })
  }
  return memoryChunks.filter((c) => c.documentId === documentId).length
}

/** Concatenate a document's chunk text in chunk order — the reader/viewer (P3b)
 *  renders this. Returns '' for an unknown/empty document. */
export function getDocumentText(documentId: string): string {
  const db = acquireDb('getDocumentText')
  if (db) {
    return runDb('getDocumentText', () => {
      const rows = db
        .prepare('SELECT text FROM rag_chunks WHERE document_id = ? ORDER BY chunk_index')
        .all(documentId) as { text: string }[]
      return rows.map((r) => r.text).join('\n\n')
    })
  }
  return memoryChunks
    .filter((c) => c.documentId === documentId)
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .map((c) => c.text)
    .join('\n\n')
}

// ════════════════════ CONVERSATION ATTACHMENTS (R11) ════════════════════

export interface RagAttachment {
  conversationId: string
  collectionId?: string
  documentId?: string
  attachedAt: number
}

const memoryAttachments: RagAttachment[] = []

export function addAttachment(input: {
  conversationId: string
  collectionId?: string
  documentId?: string
}): RagAttachment {
  if (!input.conversationId) throw new Error('addAttachment: conversationId is required')
  if (!input.collectionId && !input.documentId) {
    throw new Error('addAttachment: collectionId or documentId is required')
  }
  if (input.collectionId && input.documentId) {
    throw new Error('addAttachment: exactly one of collectionId / documentId')
  }
  const record: RagAttachment = {
    conversationId: input.conversationId,
    collectionId: input.collectionId,
    documentId: input.documentId,
    attachedAt: Date.now()
  }

  const db = acquireDb('addAttachment')
  if (db) {
    return runDb('addAttachment', () => {
      db.prepare(
        `INSERT INTO conversation_rag_attachments
           (conversation_id, collection_id, document_id, attached_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id,
                     COALESCE(collection_id, ''),
                     COALESCE(document_id, ''))
         DO UPDATE SET attached_at = excluded.attached_at`
      ).run(
        record.conversationId,
        record.collectionId ?? null,
        record.documentId ?? null,
        record.attachedAt
      )
      return record
    })
  }
  const existing = memoryAttachments.find(
    (a) =>
      a.conversationId === record.conversationId &&
      a.collectionId === record.collectionId &&
      a.documentId === record.documentId
  )
  if (existing) existing.attachedAt = record.attachedAt
  else memoryAttachments.push({ ...record })
  return record
}

export function removeAttachment(input: {
  conversationId: string
  collectionId?: string
  documentId?: string
}): boolean {
  const db = acquireDb('removeAttachment')
  if (db) {
    return runDb('removeAttachment', () => {
      const result = db
        .prepare(
          `DELETE FROM conversation_rag_attachments
             WHERE conversation_id = ?
               AND COALESCE(collection_id, '') = COALESCE(?, '')
               AND COALESCE(document_id, '')   = COALESCE(?, '')`
        )
        .run(
          input.conversationId,
          input.collectionId ?? null,
          input.documentId ?? null
        )
      return Number(result.changes) > 0
    })
  }
  const idx = memoryAttachments.findIndex(
    (a) =>
      a.conversationId === input.conversationId &&
      a.collectionId === input.collectionId &&
      a.documentId === input.documentId
  )
  if (idx < 0) return false
  memoryAttachments.splice(idx, 1)
  return true
}

export function listAttachments(conversationId: string): RagAttachment[] {
  const db = acquireDb('listAttachments')
  if (db) {
    return runDb('listAttachments', () => {
      const rows = db
        .prepare(
          `SELECT * FROM conversation_rag_attachments
             WHERE conversation_id = ?
             ORDER BY attached_at DESC`
        )
        .all(conversationId) as Array<{
        conversation_id: string
        collection_id: string | null
        document_id: string | null
        attached_at: number
      }>
      return rows.map((r) => ({
        conversationId: r.conversation_id,
        collectionId: r.collection_id ?? undefined,
        documentId: r.document_id ?? undefined,
        attachedAt: r.attached_at
      }))
    })
  }
  return memoryAttachments
    .filter((a) => a.conversationId === conversationId)
    .sort((a, b) => b.attachedAt - a.attachedAt)
    .map((a) => ({ ...a }))
}

export function copyAttachments(sourceConversationId: string, targetConversationId: string): number {
  if (!sourceConversationId || !targetConversationId) {
    throw new Error('copyAttachments: sourceConversationId and targetConversationId are required')
  }
  const now = Date.now()
  const db = acquireDb('copyAttachments')
  if (db) {
    return runDb('copyAttachments', () => {
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO conversation_rag_attachments
             (conversation_id, collection_id, document_id, attached_at)
           SELECT ?, collection_id, document_id, ?
             FROM conversation_rag_attachments
            WHERE conversation_id = ?`
        )
        .run(targetConversationId, now, sourceConversationId)
      return Number(result.changes)
    })
  }
  const source = memoryAttachments.filter((a) => a.conversationId === sourceConversationId)
  let copied = 0
  for (const a of source) {
    const exists = memoryAttachments.some(
      (m) =>
        m.conversationId === targetConversationId &&
        m.collectionId === a.collectionId &&
        m.documentId === a.documentId
    )
    if (!exists) {
      memoryAttachments.push({
        conversationId: targetConversationId,
        collectionId: a.collectionId,
        documentId: a.documentId,
        attachedAt: now
      })
      copied += 1
    }
  }
  return copied
}

// ──────────────────── test-only hooks ────────────────────

export function __resetCollectionStore(): void {
  memoryFallback.length = 0
  memoryDocuments.length = 0
  memoryChunks.length = 0
  memoryAttachments.length = 0
  useFallback = false
  fallbackReason = null
  fallbackSince = null
}

export function __forceMemoryFallback(): void {
  activateFallback('__forceMemoryFallback (test hook)')
}

/** Test-only: peek the chunk memory store without going through queries. */
export function __peekMemoryChunks(): readonly RagChunkRow[] {
  return memoryChunks
}
