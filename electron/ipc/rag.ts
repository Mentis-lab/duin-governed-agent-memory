import { app, BrowserWindow, ipcMain } from 'electron'
import {
  addAttachment,
  createCollection,
  deleteCollection,
  deleteDocument,
  getChunk,
  getCollection,
  getDocument,
  getDocumentText,
  listAttachments,
  listCollections,
  listDocuments,
  removeAttachment,
  updateCollection,
  updateDocument,
  resetInterruptedDocuments,
  reconcileOrphanVecRows,
  getMemoryFallbackState,
  type CollectionInput,
  type CollectionPatch
} from '../services/rag/store'
import { ensureConversationCollection } from '../services/conversation-rag'
import { recordEvent } from '../services/event-log'
import { isVecAvailable, getVecLoadError } from '../services/rag/vec-loader'
import {
  EMBEDDING_CATALOG,
  getEmbeddingsService
} from '../services/rag/embeddings/service'
import { assertEmbedderFitsRagVec } from '../services/rag/embeddings/rag-vec-dim-guard'
import {
  getIngestManager,
  type IngestFile,
  type IngestProgressEvent
} from '../services/rag/ingest'
import { retrieveWithMeta } from '../services/rag/retrieve'
import { rerank } from '../services/rag/rerank'
import { writeLibrarySidecar } from '../services/library-brain-bridge'
import {
  isMarkdownExtension,
  isSupportedTextExtension,
  loadText
} from '../services/rag/loaders/text'

// RAG IPC surface. R1 lands collection CRUD only. Document / query /
// embedder / attachment handlers arrive in later R-prompts.
//
// Every successful collection mutation writes a `rag.collection.*` event so
// the Activity Timeline shows when collections appeared, were renamed, or
// were removed. The producer is here (not in the store) for the same reason
// the project / settings / approval producers are at the IPC / service edge:
// the store doesn't know whether a write came from the renderer or from
// another main-process service (e.g. a future auto-workspace-collection),
// and the event categories are user-facing actions either way.

function emitCollectionEvent(
  type: 'rag.collection.created' | 'rag.collection.updated' | 'rag.collection.deleted',
  collectionId: string,
  extra: Record<string, unknown> = {}
): void {
  try {
    recordEvent({
      type,
      actorKind: 'user',
      projectId:
        typeof extra.projectId === 'string' ? (extra.projectId as string) : undefined,
      workspacePath:
        typeof extra.workspacePath === 'string'
          ? (extra.workspacePath as string)
          : undefined,
      entityKind: 'rag-collection',
      entityId: collectionId,
      payload: {
        collectionId,
        ...extra
      }
    })
  } catch (err) {
    console.error(`[rag] ${type} event failed:`, err)
  }
}

export function registerRagHandlers(): void {
  // Boot recovery: ingest jobs are in-memory, so any doc left mid-ingest by a
  // previous process is orphaned and would show as perpetually "embedding".
  // Reset those to 'error' once at startup (best-effort — never block boot).
  try {
    const reset = resetInterruptedDocuments()
    if (reset > 0) console.log(`[rag] reset ${reset} interrupted document(s) to error on boot`)
  } catch (err) {
    console.warn('[rag] resetInterruptedDocuments failed:', (err as Error)?.message)
  }
  // Boot repair: DBs written by the pre-fix deleteCollection carry rag_chunk_vec
  // rows whose chunks were cascaded away. rag_chunks has no AUTOINCREMENT, so
  // those stale rowids get reissued to the next ingest and the vec0 PRIMARY KEY
  // collision kills that write. Purge them once at startup (best-effort — the
  // vectors are rebuildable, and it is a no-op on a healthy DB).
  try {
    reconcileOrphanVecRows()
  } catch (err) {
    console.warn('[rag] reconcileOrphanVecRows failed:', (err as Error)?.message)
  }

  ipcMain.handle('rag:collection:list', async () => {
    try {
      return { success: true, data: listCollections() }
    } catch (err) {
      return {
        success: false,
        error: (err as Error)?.message ?? 'rag:collection:list failed'
      }
    }
  })

  ipcMain.handle('rag:collection:create', async (_event, input: unknown) => {
    try {
      const created = createCollection(input as CollectionInput)
      emitCollectionEvent('rag.collection.created', created.id, {
        name: created.name,
        embedderId: created.embedderId,
        workspacePath: created.workspacePath,
        projectId: created.projectId
      })
      return { success: true, data: created }
    } catch (err) {
      return {
        success: false,
        error: (err as Error)?.message ?? 'rag:collection:create failed'
      }
    }
  })

  ipcMain.handle('rag:collection:update', async (_event, id: unknown, patch: unknown) => {
    try {
      if (typeof id !== 'string' || !id) {
        return { success: false, error: 'id is required' }
      }
      const updated = updateCollection(id, (patch ?? {}) as CollectionPatch)
      emitCollectionEvent('rag.collection.updated', updated.id, {
        name: updated.name,
        embedderId: updated.embedderId,
        projectId: updated.projectId,
        workspacePath: updated.workspacePath
      })
      return { success: true, data: updated }
    } catch (err) {
      return {
        success: false,
        error: (err as Error)?.message ?? 'rag:collection:update failed'
      }
    }
  })

  ipcMain.handle('rag:collection:delete', async (_event, id: unknown) => {
    try {
      if (typeof id !== 'string' || !id) {
        return { success: false, error: 'id is required' }
      }
      // Capture the pre-delete row so the event payload can identify it by
      // name + scope. Without this, the timeline reader would only see an
      // id post-delete and couldn't reconstruct what the user removed.
      const existing = getCollection(id)
      const ok = deleteCollection(id)
      if (ok && existing) {
        emitCollectionEvent('rag.collection.deleted', id, {
          name: existing.name,
          embedderId: existing.embedderId,
          projectId: existing.projectId,
          workspacePath: existing.workspacePath
        })
      }
      return { success: true, data: ok }
    } catch (err) {
      return {
        success: false,
        error: (err as Error)?.message ?? 'rag:collection:delete failed'
      }
    }
  })

  // Convenience probe for the renderer. R5+'s ingest UI uses this to show
  // a "vector search disabled" banner; R1 just exposes it as a read-only
  // surface.
  ipcMain.handle('rag:status', async () => {
    // `memoryFallback` is the degraded-mode signal. When it is active the
    // store has no database in this process: every collection / document it
    // reports is process-local and dies at quit. Without this field the only
    // trace was one console.warn, so the Library rendered an empty list that
    // is indistinguishable from "the user's collections were deleted".
    const fallback = getMemoryFallbackState()
    return {
      success: true,
      data: {
        vecAvailable: isVecAvailable(),
        vecError: getVecLoadError(),
        memoryFallback: fallback.active,
        memoryFallbackReason: fallback.reason,
        memoryFallbackSince: fallback.since
      }
    }
  })

  // ──────────────────── R2: embeddings catalogue + selection ────────────────────
  // The renderer can read the catalogue, see which embedder is active, and
  // request a switch. The `embed()` action is deliberately NOT exposed —
  // only the main-process ingest orchestrator (R5) calls it. A renderer
  // with raw embed access could DoS the worker with giant batches.

  ipcMain.handle('rag:embedder:catalog', async () => {
    return { success: true, data: EMBEDDING_CATALOG }
  })

  ipcMain.handle('rag:embedder:active', async () => {
    try {
      const userDataPath = app.getPath('userData')
      const svc = getEmbeddingsService(userDataPath)
      return { success: true, data: { id: svc.getActiveEmbedderId() } }
    } catch (err) {
      return {
        success: false,
        error: (err as Error)?.message ?? 'rag:embedder:active failed'
      }
    }
  })

  ipcMain.handle('rag:embedder:setActive', async (_event, id: unknown) => {
    try {
      if (typeof id !== 'string' || !id) {
        return { success: false, error: 'id is required' }
      }
      // Refuse — BEFORE touching the shared embeddings singleton — any embedder
      // whose vectors the fixed FLOAT[384] rag_chunk_vec table cannot store.
      // Without this, selecting a wider model (bge-m3, 1024-dim) silently killed
      // the RAG vector leg: the query-side `embedding MATCH ?` throws and is
      // swallowed in retrieve.ts, degrading to lexical-only with no signal. The
      // singleton is shared with the local-brain leg (whose notes_vec table DOES
      // migrate width), so the guard lives here at the RAG boundary rather than
      // in the service — a hard reject inside setActive would break that leg.
      assertEmbedderFitsRagVec(id)
      const userDataPath = app.getPath('userData')
      const svc = getEmbeddingsService(userDataPath)
      const info = await svc.setActive(id)
      return { success: true, data: info }
    } catch (err) {
      return {
        success: false,
        error: (err as Error)?.message ?? 'rag:embedder:setActive failed'
      }
    }
  })

  // ──────────────────── R5: documents + ingest ────────────────────

  // Lazy-init the ingest manager + a shared progress fan-out. The ingest
  // manager wraps the embeddings service (which it depends on); we wire
  // the embeddings service in here rather than in the constructor so a
  // headless test environment (no app.getPath) can substitute via the
  // injected-deps API on the singleton.
  let ingestWired = false
  function ensureIngestWired(): ReturnType<typeof getIngestManager> {
    if (!ingestWired) {
      const userDataPath = app.getPath('userData')
      const embeddings = getEmbeddingsService(userDataPath)
      // P1 — bridge every ingested doc into the vault as a sidecar note so it
      // becomes a brain graph node ("documents → memory nodes"). Best-effort.
      const mgr = getIngestManager({ embeddings, onDocumentReady: writeLibrarySidecar })
      mgr.on('progress', (e: IngestProgressEvent) => {
        // Fan progress out to every renderer window. Cheap — the payload
        // is small and the channel is per-event, not per-tick.
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('rag:document:progress', e)
        }
      })
      ingestWired = true
      return mgr
    }
    return getIngestManager()
  }

  ipcMain.handle('rag:document:list', async (_event, collectionId: unknown) => {
    try {
      if (typeof collectionId !== 'string' || !collectionId) {
        return { success: false, error: 'collectionId is required' }
      }
      return { success: true, data: listDocuments(collectionId) }
    } catch (err) {
      return {
        success: false,
        error: (err as Error)?.message ?? 'rag:document:list failed'
      }
    }
  })

  // P3b — the document viewer's reader text (chunk text concatenated in order).
  ipcMain.handle('rag:document:text', async (_event, documentId: unknown) => {
    try {
      if (typeof documentId !== 'string' || !documentId) {
        return { success: false, error: 'documentId is required' }
      }
      let text = getDocumentText(documentId)
      // Fallback: the reader text is rebuilt from rag_chunks, but a doc can end
      // up with ZERO chunks and still have perfectly good source text — e.g. a
      // short/heading-heavy markdown or .txt whose sections all fall under the
      // chunker's MIN_CHUNK_CHARS floor. Chunks are the retrieval unit; display
      // shouldn't depend on them. For text-y sources still on disk, read the
      // file directly so the viewer shows real content instead of the false
      // "No extractable text / scan" message.
      if (!text || !text.trim()) {
        const doc = getDocument(documentId)
        if (doc?.sourcePath && isSupportedTextExtension(doc.sourcePath)) {
          try {
            const loaded = await loadText(doc.sourcePath)
            text = loaded.text
          } catch {
            // Source gone / binary / oversize — keep the empty string and let
            // the viewer fall back to its "no extractable text" note.
          }
        }
      }
      return { success: true, data: text }
    } catch (err) {
      return {
        success: false,
        error: (err as Error)?.message ?? 'rag:document:text failed'
      }
    }
  })

  // P3b+ — raw original file bytes (base64) for the fidelity viewer (PDF.js).
  // Only for docs with a source path still on disk.
  ipcMain.handle('rag:document:file', async (_event, documentId: unknown) => {
    try {
      if (typeof documentId !== 'string' || !documentId) {
        return { success: false, error: 'documentId is required' }
      }
      const doc = getDocument(documentId)
      if (!doc?.sourcePath) return { success: false, error: 'no source file on disk' }
      const { readFile } = await import('fs/promises')
      const buf = await readFile(doc.sourcePath)
      return { success: true, data: { base64: buf.toString('base64'), mime: doc.mime ?? '' } }
    } catch (err) {
      return { success: false, error: (err as Error)?.message ?? 'rag:document:file failed' }
    }
  })

  // P3b+ — first-page JPEG preview extracted from an iWork bundle (the practical
  // view for modern .pages/.numbers/.key, which have no obtainable PDF).
  ipcMain.handle('rag:document:preview', async (_event, documentId: unknown) => {
    try {
      if (typeof documentId !== 'string' || !documentId) {
        return { success: false, error: 'documentId is required' }
      }
      const doc = getDocument(documentId)
      if (!doc?.sourcePath) return { success: true, data: null }
      const { extractIWorkPreview } = await import('../services/rag/loaders')
      const base64 = await extractIWorkPreview(doc.sourcePath)
      return { success: true, data: base64 }
    } catch (err) {
      return { success: false, error: (err as Error)?.message ?? 'rag:document:preview failed' }
    }
  })

  ipcMain.handle(
    'rag:document:ingest',
    async (_event, collectionId: unknown, files: unknown) => {
      try {
        if (typeof collectionId !== 'string' || !collectionId) {
          return { success: false, error: 'collectionId is required' }
        }
        if (!Array.isArray(files) || files.length === 0) {
          return { success: false, error: 'files must be a non-empty array' }
        }
        const sanitized: IngestFile[] = []
        const skippedMarkdown: string[] = []
        for (const f of files as IngestFile[]) {
          if (!f || typeof f.name !== 'string' || !f.name) {
            return { success: false, error: 'each file requires a name' }
          }
          if (
            (typeof f.path !== 'string' || !f.path) &&
            typeof f.text !== 'string'
          ) {
            return {
              success: false,
              error: `file "${f.name}": one of {path, text} is required`
            }
          }
          // Markdown is the vault/Brain's native format — it opens in the
          // Explorer, not the RAG Library (ingesting it even round-trips a
          // duplicate back into the vault via the sidecar bridge). Skip it here
          // rather than creating a redundant, worse-reader Library row.
          if (isMarkdownExtension(f.name)) {
            skippedMarkdown.push(f.name)
            continue
          }
          sanitized.push({
            path: f.path,
            text: f.text,
            name: f.name,
            sourceKind: f.sourceKind
          })
        }
        // Everything the user dropped was markdown → nothing to ingest, but this
        // is not an error: report the skip so the UI can steer them to the Brain.
        if (sanitized.length === 0) {
          return { success: true, data: { jobId: null, skippedMarkdown } }
        }
        const mgr = ensureIngestWired()
        const jobId = mgr.submit(collectionId, sanitized)
        return { success: true, data: { jobId, skippedMarkdown } }
      } catch (err) {
        return {
          success: false,
          error: (err as Error)?.message ?? 'rag:document:ingest failed'
        }
      }
    }
  )

  ipcMain.handle('rag:document:reingest', async (_event, documentId: unknown) => {
    try {
      if (typeof documentId !== 'string' || !documentId) {
        return { success: false, error: 'documentId is required' }
      }
      const doc = getDocument(documentId)
      if (!doc) return { success: false, error: 'not found' }
      // Reingest must run from the original source — paste-sourced rows
      // can't be re-ingested because the buffer is gone after the first run.
      if (!doc.sourcePath) {
        return {
          success: false,
          error: 'cannot reingest a paste-sourced document'
        }
      }
      // Mark the row queued for immediate UI feedback, then hand it to the
      // orchestrator by id so it re-derives IN PLACE.
      //
      // This used to also set chunkCount: 0, which was a pure counter lie —
      // nothing dropped the chunks, so they stayed live in rag_chunks/FTS/vec.
      // That made the bug invisible: the Library looked reset while the old
      // passages were still fully searchable. Worse, the hash dedupe in
      // runOneFile only short-circuits on status 'ready', so moving the row to
      // 'queued' here guaranteed the miss — every reingest inserted a SECOND
      // document row with a duplicate copy of every chunk (N reingests = N
      // copies in retrieval), and stranded this row at 'queued' forever, since
      // resetInterruptedDocuments only rescues loading/chunking/embedding.
      updateDocument(doc.id, { status: 'queued', statusDetail: null })
      const mgr = ensureIngestWired()
      const jobId = mgr.submit(doc.collectionId, [
        {
          path: doc.sourcePath,
          name: doc.displayName,
          sourceKind: doc.sourceKind,
          replaceDocumentId: doc.id
        }
      ])
      return { success: true, data: { jobId } }
    } catch (err) {
      return {
        success: false,
        error: (err as Error)?.message ?? 'rag:document:reingest failed'
      }
    }
  })

  ipcMain.handle('rag:document:delete', async (_event, documentId: unknown) => {
    try {
      if (typeof documentId !== 'string' || !documentId) {
        return { success: false, error: 'documentId is required' }
      }
      const ok = deleteDocument(documentId)
      return { success: true, data: ok }
    } catch (err) {
      return {
        success: false,
        error: (err as Error)?.message ?? 'rag:document:delete failed'
      }
    }
  })

  ipcMain.handle('rag:document:cancel', async (_event, jobId: unknown) => {
    try {
      if (typeof jobId !== 'string' || !jobId) {
        return { success: false, error: 'jobId is required' }
      }
      const mgr = ensureIngestWired()
      const ok = mgr.cancel(jobId)
      return { success: true, data: ok }
    } catch (err) {
      return {
        success: false,
        error: (err as Error)?.message ?? 'rag:document:cancel failed'
      }
    }
  })

  // ──────────────────── R12: chunk fetch (citation preview) ────────────────────

  ipcMain.handle('rag:chunk:get', async (_event, chunkId: unknown) => {
    try {
      if (typeof chunkId !== 'string' || !chunkId) {
        return { success: false, error: 'chunkId is required' }
      }
      const chunk = getChunk(chunkId)
      if (!chunk) return { success: false, error: 'not found' }
      return { success: true, data: chunk }
    } catch (err) {
      return {
        success: false,
        error: (err as Error)?.message ?? 'rag:chunk:get failed'
      }
    }
  })

  // ──────────────────── R11: conversation attachments ────────────────────

  ipcMain.handle(
    'rag:attachments:list',
    async (_event, conversationId: unknown) => {
      try {
        if (typeof conversationId !== 'string' || !conversationId) {
          return { success: false, error: 'conversationId is required' }
        }
        return { success: true, data: listAttachments(conversationId) }
      } catch (err) {
        return {
          success: false,
          error: (err as Error)?.message ?? 'rag:attachments:list failed'
        }
      }
    }
  )

  ipcMain.handle('rag:attachments:add', async (_event, raw: unknown) => {
    try {
      const input = (raw ?? {}) as {
        conversationId?: unknown
        collectionId?: unknown
        documentId?: unknown
      }
      if (typeof input.conversationId !== 'string' || !input.conversationId) {
        return { success: false, error: 'conversationId is required' }
      }
      const collectionId =
        typeof input.collectionId === 'string' ? input.collectionId : undefined
      const documentId =
        typeof input.documentId === 'string' ? input.documentId : undefined
      return {
        success: true,
        data: addAttachment({
          conversationId: input.conversationId,
          collectionId,
          documentId
        })
      }
    } catch (err) {
      return {
        success: false,
        error: (err as Error)?.message ?? 'rag:attachments:add failed'
      }
    }
  })

  ipcMain.handle('rag:attachments:remove', async (_event, raw: unknown) => {
    try {
      const input = (raw ?? {}) as {
        conversationId?: unknown
        collectionId?: unknown
        documentId?: unknown
      }
      if (typeof input.conversationId !== 'string' || !input.conversationId) {
        return { success: false, error: 'conversationId is required' }
      }
      const ok = removeAttachment({
        conversationId: input.conversationId,
        collectionId:
          typeof input.collectionId === 'string' ? input.collectionId : undefined,
        documentId:
          typeof input.documentId === 'string' ? input.documentId : undefined
      })
      return { success: true, data: ok }
    } catch (err) {
      return {
        success: false,
        error: (err as Error)?.message ?? 'rag:attachments:remove failed'
      }
    }
  })

  // ──────────────────── auto-attach (large file → RAG ingest) ────────────────────
  //
  // Drop-replacement entry point for the renderer's "this file is too big to
  // inline" path. Idempotently ensures a per-conversation auto-collection,
  // attaches the conversation to it (so augmentForChat at chat-send time
  // pulls from this scope), and submits the file to the ingest manager.
  //
  // Returns the jobId + collectionId immediately. Progress streams over the
  // existing `rag:document:progress` channel — the renderer matches events
  // by jobId to update its per-attachment chip.
  //
  // The attachment record is added BEFORE ingest completes. That way, if
  // the user sends a chat turn while ingest is still in-flight, augmentForChat
  // sees the collection but finds no chunks yet and emits an empty
  // <retrieved_context> block — safer than retroactively wiring attachments
  // post-ingest, where a race could yield "attached but never queried."
  ipcMain.handle('rag:auto-attach', async (_event, raw: unknown) => {
    try {
      const input = (raw ?? {}) as {
        conversationId?: unknown
        filePath?: unknown
        displayName?: unknown
      }
      if (typeof input.conversationId !== 'string' || !input.conversationId) {
        return { success: false, error: 'conversationId is required' }
      }
      if (typeof input.filePath !== 'string' || !input.filePath) {
        return { success: false, error: 'filePath is required' }
      }
      const displayName =
        typeof input.displayName === 'string' && input.displayName
          ? input.displayName
          : input.filePath

      // 1. Ensure the per-conversation auto-collection exists. Emits the
      //    rag.collection.created event on first call.
      const collection = ensureConversationCollection(input.conversationId)
      const isFresh =
        // Heuristic: if we just got back a collection with zero docs we'll
        // emit the created event; if it already had docs from prior turns
        // the listCollections lookup hit. We don't strictly track this here
        // because createCollection itself doesn't tell us "I created vs.
        // returned existing"; instead the timeline records the first-create
        // event via emitCollectionEvent if we did create. Cheap to skip the
        // event when collection.createdAt is older than 5s (i.e. existed
        // before this call).
        Date.now() - collection.createdAt < 5_000
      if (isFresh) {
        emitCollectionEvent('rag.collection.created', collection.id, {
          name: collection.name,
          embedderId: collection.embedderId,
          auto: true,
          conversationId: input.conversationId
        })
      }

      // 2. Wire the conversation → collection attachment. Idempotent —
      //    addAttachment dedupes by (conversationId, collectionId, null).
      addAttachment({
        conversationId: input.conversationId,
        collectionId: collection.id
      })

      // 3. Submit to the ingest manager. Progress streams via the existing
      //    rag:document:progress channel, which the renderer is already
      //    subscribed to for the Library UI.
      const mgr = ensureIngestWired()
      const jobId = mgr.submit(collection.id, [
        { path: input.filePath, name: displayName, sourceKind: 'file' }
      ])

      return {
        success: true,
        data: { jobId, collectionId: collection.id }
      }
    } catch (err) {
      return {
        success: false,
        error: (err as Error)?.message ?? 'rag:auto-attach failed'
      }
    }
  })

  // ──────────────────── R7: hybrid retrieval ────────────────────

  ipcMain.handle('rag:query:run', async (_event, raw: unknown) => {
    try {
      const input = (raw ?? {}) as {
        query?: unknown
        collectionIds?: unknown
        topN?: unknown
        rerank?: unknown
        minRerankScore?: unknown
        rerankerId?: unknown
      }
      if (typeof input.query !== 'string' || !input.query.trim()) {
        return { success: false, error: 'query is required' }
      }
      if (
        !Array.isArray(input.collectionIds) ||
        input.collectionIds.length === 0 ||
        !input.collectionIds.every((c) => typeof c === 'string' && c.length > 0)
      ) {
        return { success: false, error: 'collectionIds must be a non-empty string array' }
      }
      // Wire embeddings on demand — the renderer is the entry point, but
      // raw embed access isn't exposed; we make the embed call here using
      // the singleton service.
      const userDataPath = app.getPath('userData')
      const embeddings = getEmbeddingsService(userDataPath)
      const topN = typeof input.topN === 'number' ? input.topN : 8
      // Opt-in cross-encoder rerank (P2): over-fetch a wider pool, rerank with
      // the local cross-encoder, apply the calibrated relevance floor, then
      // slice back to topN. Best-effort — rerank() degrades to the RRF order on
      // any failure, so a missing/failed reranker never breaks the query.
      const doRerank = input.rerank === true
      const info = await retrieveWithMeta({
        query: input.query,
        collectionIds: input.collectionIds as string[],
        topN: doRerank ? Math.max(topN, 32) : topN,
        embed: (texts) => embeddings.embed(texts),
        // Preferred path: embed the query in the queried collections' OWN space
        // when they agree on one, so a changed default embedder no longer pins
        // them to lexical-only.
        embedWith: (id, texts, kind) => embeddings.embedWith(id, texts, kind),
        // Fallback identity for the guard: with a mixed-space scope the vector
        // leg is skipped rather than KNN'd across incompatible 384-dim spaces.
        queryEmbedderId: embeddings.getActiveEmbedderId()
      })
      if (doRerank && info.results.length > 1) {
        const rerankerId = typeof input.rerankerId === 'string' ? input.rerankerId : undefined
        let reranked = await rerank(
          {
            query: input.query,
            candidates: info.results,
            mode: 'local-cross-encoder',
            maxCandidates: info.results.length
          },
          {
            crossEncoderScore: (q, cands) =>
              embeddings.rerank(q, cands.map((c) => c.text), rerankerId)
          }
        )
        if (typeof input.minRerankScore === 'number') {
          reranked = reranked.filter((c) => (c.scores.cross ?? 1) >= (input.minRerankScore as number))
        }
        info.results = reranked.slice(0, topN)
        info.fusedCount = info.results.length
      }
      return { success: true, data: info }
    } catch (err) {
      return {
        success: false,
        error: (err as Error)?.message ?? 'rag:query:run failed'
      }
    }
  })
}
