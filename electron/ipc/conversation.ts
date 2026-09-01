import { ipcMain } from 'electron'
import { createHash, randomUUID } from 'crypto'
import * as store from '../services/conversation-store'
import { chatOnce } from '../services/providers/registry'
import { getActiveWorkspace } from '../services/workspace-state'
import { ensureConversationCollection } from '../services/conversation-rag'
import {
  addAttachment,
  copyAttachments,
  insertChunks,
  insertDocument,
  updateDocument
} from '../services/rag/store'
import { chunk as chunkText } from '../services/rag/chunker'
import { getEmbeddingsService } from '../services/rag/embeddings/service'
import { getEmbedder } from '../services/rag/embeddings/catalog'
import { readSettings } from '../services/settings-helper'
import { recordEvent } from '../services/event-log'
import { friendly, messageOf } from '../services/guarded'
import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

/** Below this a "summary" is not plausibly a context-preserving digest of a >=4-message conversation,
 *  and is far more likely a refusal, a truncated token, or an error string returned as content. Chosen
 *  to be well under any real summary (the prompt asks for up to 300 words) while excluding one-liners. */
const MIN_SUMMARY_CHARS = 120

/** Write the pre-mutation messages to disk and return the path. Compaction and deletion are both
 *  irreversible and user-invoked — compact runs with no confirmation at all and is gated on model
 *  output nobody has verified is faithful; delete is gated only on a `confirm()` that never says the
 *  transcript is unrecoverable — so the originals must survive them. Throws if the archive cannot be
 *  written; the caller then abandons the operation.
 *
 *  `meta` stamps WHAT the archive is for and, for deletes, the conversation row itself: compact keeps
 *  that row, delete destroys it (title, model, kind, timestamps), so the messages alone would not be
 *  enough to reconstruct the thread. */
function archiveConversation(
  conversationId: string,
  msgs: unknown[],
  meta?: { reason: string; conversation?: unknown }
): string {
  const dir = join(app.getPath('userData'), 'compact-archive')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${conversationId}-${Date.now()}.json`)
  writeFileSync(
    path,
    JSON.stringify(
      {
        conversationId,
        archivedAt: new Date().toISOString(),
        reason: meta?.reason ?? 'conversation:compact',
        ...(meta?.conversation ? { conversation: meta.conversation } : {}),
        messageCount: msgs.length,
        messages: msgs
      },
      null,
      2
    )
  )
  return path
}

type SeedKind = 'none' | 'message' | 'block' | 'transcript-range' | 'custom'
type WorkspaceMode = 'inherit' | 'current' | 'none'

export interface ForkParams {
  sourceConversationId: string
  sourceMessageId?: string
  seedKind: SeedKind
  seedContent?: string
  seedBlobJson?: string
  includeRagAttachments?: boolean
  workspaceMode?: WorkspaceMode
  titleOverride?: string
}

const SEED_KINDS = new Set<SeedKind>([
  'none',
  'message',
  'block',
  'transcript-range',
  'custom'
])
const WORKSPACE_MODES = new Set<WorkspaceMode>(['inherit', 'current', 'none'])

function sanitizeForkParams(raw: unknown): ForkParams {
  if (typeof raw === 'string') {
    return {
      sourceConversationId: raw,
      seedKind: 'none',
      includeRagAttachments: true,
      workspaceMode: 'inherit'
    }
  }
  const input = (raw ?? {}) as Partial<ForkParams>
  if (typeof input.sourceConversationId !== 'string' || !input.sourceConversationId) {
    throw new Error('sourceConversationId is required')
  }
  const seedKind = input.seedKind ?? 'none'
  if (!SEED_KINDS.has(seedKind)) throw new Error(`invalid seedKind: ${seedKind}`)
  const workspaceMode = input.workspaceMode ?? 'current'
  if (!WORKSPACE_MODES.has(workspaceMode)) {
    throw new Error(`invalid workspaceMode: ${workspaceMode}`)
  }
  const sourceMessageId =
    typeof input.sourceMessageId === 'string' && input.sourceMessageId
      ? input.sourceMessageId
      : undefined
  const seedContent =
    typeof input.seedContent === 'string' ? input.seedContent : undefined
  const seedBlobJson =
    typeof input.seedBlobJson === 'string' ? input.seedBlobJson : undefined

  if ((seedKind === 'block' || seedKind === 'custom') && !seedContent?.trim()) {
    throw new Error(`seedContent is required for seedKind=${seedKind}`)
  }
  if (seedKind === 'transcript-range' && !seedBlobJson?.trim() && !seedContent?.trim()) {
    throw new Error('seedBlobJson or seedContent is required for seedKind=transcript-range')
  }

  return {
    sourceConversationId: input.sourceConversationId,
    sourceMessageId,
    seedKind,
    seedContent,
    seedBlobJson,
    includeRagAttachments: input.includeRagAttachments !== false,
    workspaceMode,
    titleOverride:
      typeof input.titleOverride === 'string' && input.titleOverride.trim()
        ? input.titleOverride.trim()
        : undefined
  }
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function buildSeedTurn(params: ForkParams, content: string): string {
  const attrs = [
    `source="${escapeAttr(params.sourceConversationId)}"`,
    `kind="${escapeAttr(params.seedKind)}"`
  ]
  if (params.sourceMessageId) {
    attrs.push(`from_message_id="${escapeAttr(params.sourceMessageId)}"`)
  }
  return `<seed_context ${attrs.join(' ')}>\n${content.trim()}\n</seed_context>`
}

function seedBudget(): number {
  const raw = readSettings().safeSeedLength
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 8192
}

interface SeedTurnResult {
  body: string
  truncated: boolean
  seedBytes: number
  attachedDocumentId?: string
  threshold: number
}

async function attachSeedAsRagDocument(
  conversationId: string,
  params: ForkParams,
  content: string
): Promise<{ documentId: string; collectionId: string; chunkCount: number }> {
  const collection = ensureConversationCollection(conversationId)
  addAttachment({ conversationId, collectionId: collection.id })
  const bytes = Buffer.byteLength(content, 'utf8')
  const displayName = params.sourceMessageId
    ? `Seed from message ${params.sourceMessageId}`
    : `Seed from conversation ${params.sourceConversationId}`
  const doc = insertDocument({
    collectionId: collection.id,
    sourceKind: 'paste',
    displayName,
    mime: 'text/plain',
    bytes,
    hashSha256: createHash('sha256').update(content).digest('hex'),
    status: 'chunking'
  })
  const chunks = chunkText(
    { text: content, sourceKind: 'paste', mime: 'text/plain', extension: '.txt' },
    { chunkSize: collection.chunkSize, chunkOverlap: collection.chunkOverlap }
  )
  // Embed before inserting. This was the ONLY insertChunks call site in the repo that
  // omitted the vectors argument — and the argument is optional, so nothing complained.
  // The seed text is stripped from the visible turn and replaced by a document pointer,
  // so a seed that never got vectors is lexical-search-only forever: any paraphrased
  // question about it comes up empty, and there is no reindex path that repairs it.
  //
  // Failing to embed must not lose the seed, so a throw degrades to the previous
  // lexical-only insert rather than aborting the fork. That is a strictly better
  // outcome than today's silent version of the same thing, because it is logged.
  let vectors: Float32Array[] | undefined
  try {
    // ...in the COLLECTION's space, not the process-active one. ensureConversationCollection
    // stamps a NEW collection with whatever is active at creation, but returns an EXISTING
    // one unchanged — so seeding a second fork after the user changed embedders would put
    // two embedding spaces in one collection, which is the rag/ingest.ts defect (finding 14)
    // reached by a path that never goes through IngestManager.
    // Guarded like ingest, but resolved the OTHER way, deliberately. embedWith throws
    // on a stamp this catalogue cannot resolve, and the catch below turns a throw into
    // a seed stored with NO vectors — which the comment above calls out as permanent
    // and unrepairable ("lexical-search-only forever... there is no reindex path").
    // ingest can fail a document because the user can see it and retry; the seed has
    // no such surface and no second chance, so here a same-space-as-everything-else
    // vector beats no vector at all.
    const svc = getEmbeddingsService(app.getPath('userData'))
    const stamped = collection.embedderId
    if (stamped && !getEmbedder(stamped)) {
      console.warn(
        `[conversation] seed collection ${collection.id} is stamped with unknown embedder "${stamped}"; embedding with the active one so the seed is not left vectorless`
      )
    }
    vectors =
      stamped && getEmbedder(stamped)
        ? await svc.embedWith(stamped, chunks.map((c) => c.text), 'none')
        : await svc.embed(chunks.map((c) => c.text))
    if (vectors.length !== chunks.length) {
      console.warn(
        `[conversation] seed embed returned ${vectors.length} vectors for ${chunks.length} chunks  storing lexical-only`
      )
      vectors = undefined
    }
  } catch (e) {
    console.warn('[conversation] seed embed failed  storing the seed lexical-only:', messageOf(e))
  }
  insertChunks(
    chunks.map((c) => ({
      documentId: doc.id,
      collectionId: collection.id,
      chunkIndex: c.index,
      startOffset: c.startOffset,
      endOffset: c.endOffset,
      text: c.text,
      headingPath: c.headingPath,
      page: c.page,
      lineStart: c.lineStart,
      lineEnd: c.lineEnd
    })),
    vectors
  )
  updateDocument(doc.id, {
    status: 'ready',
    chunkCount: chunks.length,
    ingestedAt: Date.now(),
    statusDetail: chunks.length === 0 ? 'no extractable content' : null
  })
  return { documentId: doc.id, collectionId: collection.id, chunkCount: chunks.length }
}

async function seedTurnBody(
  conversationId: string,
  params: ForkParams,
  content: string
): Promise<SeedTurnResult> {
  const threshold = seedBudget()
  const seedBytes = Buffer.byteLength(content, 'utf8')
  if (content.length <= threshold) {
    return {
      body: buildSeedTurn(params, content),
      truncated: false,
      seedBytes,
      threshold
    }
  }
  const estimatedTokens = Math.ceil(content.length / 4)
  try {
    const attached = await attachSeedAsRagDocument(conversationId, params, content)
    return {
      truncated: true,
      seedBytes,
      threshold,
      attachedDocumentId: attached.documentId,
      body: buildSeedTurn(
        params,
        `Seed attached as document (${estimatedTokens} estimated tokens, ${content.length} chars). ` +
          `Inline seed budget is ${threshold} chars.`
      )
    }
  } catch (err) {
    const preview = content.slice(0, threshold)
    const message = err instanceof Error ? err.message : String(err)
    return {
      truncated: true,
      seedBytes,
      threshold,
      body: buildSeedTurn(
        params,
        `${preview}\n\n[Seed truncated at ${threshold} chars because RAG attachment failed: ${message}]`
      )
    }
  }
}

function emitConversationForked(params: ForkParams, args: {
  conversationId: string
  seedBytes: number
  workspaceMode: WorkspaceMode
  copiedAttachmentCount: number
}): void {
  try {
    recordEvent({
      type: 'conversation.forked',
      actorKind: 'user',
      conversationId: args.conversationId,
      entityKind: 'conversation',
      entityId: args.conversationId,
      payload: {
        sourceConversationId: params.sourceConversationId,
        sourceMessageId: params.sourceMessageId,
        seedKind: params.seedKind,
        seedBytes: args.seedBytes,
        workspaceMode: args.workspaceMode,
        includeRagAttachments: params.includeRagAttachments !== false,
        copiedAttachmentCount: args.copiedAttachmentCount
      }
    })
  } catch (err) {
    console.error('[conversation] conversation.forked event failed:', err)
  }
}

function emitSeedEvent(
  conversationId: string,
  params: ForkParams,
  seed: SeedTurnResult
): void {
  try {
    recordEvent({
      type: seed.truncated ? 'conversation.seed.truncated' : 'conversation.seed.attached',
      actorKind: 'user',
      conversationId,
      entityKind: seed.attachedDocumentId ? 'rag-document' : 'conversation',
      entityId: seed.attachedDocumentId ?? conversationId,
      severity: seed.truncated ? 'warning' : 'info',
      payload: {
        conversationId,
        seedKind: params.seedKind,
        seedBytes: seed.seedBytes,
        threshold: seed.truncated ? seed.threshold : undefined,
        attachedDocumentId: seed.attachedDocumentId
      },
      redaction: 'metadata'
    })
  } catch (err) {
    console.error('[conversation] seed event failed:', err)
  }
}

function resolveSeedContent(params: ForkParams): string | null {
  if (params.seedKind === 'none') return null
  if (params.seedContent?.trim()) return params.seedContent
  if (params.seedKind === 'message' && params.sourceMessageId) {
    const message = store.findMessage(params.sourceConversationId, params.sourceMessageId)
    if (!message) throw new Error('source message not found')
    return message.content
  }
  if (params.seedKind === 'transcript-range' && params.seedBlobJson?.trim()) {
    return params.seedBlobJson
  }
  return null
}
export function registerConversationHandlers(): void {
  ipcMain.handle('conversation:list', async () => {
    try {
      return { success: true, data: store.listConversations() }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  // E3 — sessions sidebar.
  ipcMain.handle(
    'sessions:list',
    async (
      _event,
      opts?: { tab?: 'recent' | 'pinned' | 'archived'; query?: string; limit?: number; offset?: number }
    ) => {
      try {
        return { success: true, data: store.listSessions(opts) }
      } catch (err) {
        return { success: false, error: messageOf(err) }
      }
    }
  )

  ipcMain.handle('sessions:archive', async (_event, id: string, archived: boolean) => {
    try {
      store.setConversationArchived(id, archived)
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('sessions:setPinned', async (_event, id: string, pinned: boolean) => {
    try {
      store.setConversationPinned(id, pinned)
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('sessions:search', async (_event, query: string, limit?: number) => {
    try {
      const lim = typeof limit === 'number' && limit > 0 ? Math.min(limit, 200) : 50
      return { success: true, data: store.searchSessions(query, lim) }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('conversation:get', async (_event, id) => {
    try {
      const conv = store.getConversation(id)
      if (!conv) return { success: false, error: 'Conversation not found' }
      return { success: true, data: conv }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle(
    'conversation:create',
    async (
      _event,
      model: string,
      opts?: {
        kind?: 'local' | 'cloud' | 'worktree'
        worktreePath?: string | null
        projectId?: string | null
      }
    ) => {
      try {
        return { success: true, data: store.createConversation(model, opts) }
      } catch (err) {
        return { success: false, error: messageOf(err) }
      }
    }
  )

  ipcMain.handle('conversation:delete', async (_event, id) => {
    try {
      // ARCHIVE FIRST — same rule the strictly-LESS-destructive `conversation:compact` handler below
      // already follows. Compact only swaps the messages for a summary and keeps the conversation row,
      // yet it writes every prior message to disk before touching the DB and abandons itself if that
      // write throws. Delete does strictly more damage — one transaction drops the conversation row,
      // FK-cascades every message, and clears tool_calls / snip logs / FTS / RAG attachments — and used
      // to leave no artifact at all. The only recovery was persistence:restoreFromBackup, a whole-DB
      // snapshot up to 24h stale that rolls back every OTHER conversation too, so a mis-targeted delete
      // from the Sidebar context menu (guarded by a bare `confirm("Delete \"<title>\"?")`) permanently
      // destroyed the thread. Preserve+record+stamp, then delete; a failed preserve is never a delete.
      const conv = store.getConversation(id)
      const msgs = store.getMessages(id)
      let archivePath: string | null = null
      if (conv || msgs.length > 0) {
        try {
          archivePath = archiveConversation(id, msgs, { reason: 'conversation:delete', conversation: conv })
        } catch (e) {
          return {
            success: false,
            error: `Could not archive the conversation before deleting it: ${friendly(e, 'archive failed')}`
          }
        }
      }
      store.deleteConversation(id)
      return { success: true, data: { archivePath } }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('conversation:updateTitle', async (_event, id, title) => {
    try {
      store.updateConversationTitle(id, title)
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('conversation:getMessages', async (_event, id) => {
    try {
      return { success: true, data: store.getMessages(id) }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('conversation:appendSystem', async (_event, id, content) => {
    try {
      const msg = store.saveMessage({
        id: randomUUID(),
        conversationId: id,
        role: 'system',
        content
      })
      return { success: true, data: msg }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('conversation:setModel', async (_event, id, model) => {
    try {
      store.updateConversationModel(id, model)
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('conversation:fork', async (_event, raw: unknown) => {
    try {
      const params = sanitizeForkParams(raw)
      const src = store.getConversation(params.sourceConversationId)
      if (!src) return { success: false, error: 'source not found' }
      const seedContent = resolveSeedContent(params)
      let worktreePath: string | null = null
      if (params.workspaceMode === 'inherit') {
        worktreePath = src.worktreePath ?? null
      } else if (params.workspaceMode === 'current') {
        worktreePath = getActiveWorkspace()
      }
      const next = store.createConversation(src.model, {
        kind: src.kind ?? 'local',
        worktreePath,
        projectId: src.projectId ?? null,
        forkedFromId: params.sourceConversationId,
        forkedFromMessageId: params.sourceMessageId ?? null,
        seedSourceKind: params.seedKind,
        seedBlob:
          params.seedKind === 'none'
            ? null
            : {
                sourceConversationId: params.sourceConversationId,
                sourceMessageId: params.sourceMessageId,
                kind: params.seedKind,
                seedBytes: seedContent ? Buffer.byteLength(seedContent, 'utf8') : 0,
                contentPreview: seedContent?.slice(0, 240)
              }
      })

      const copiedAttachmentCount = params.includeRagAttachments
        ? copyAttachments(params.sourceConversationId, next.id)
        : 0

      let seedBytes = seedContent ? Buffer.byteLength(seedContent, 'utf8') : 0
      if (seedContent && params.seedKind !== 'none') {
        const seedTurn = await seedTurnBody(next.id, params, seedContent)
        seedBytes = seedTurn.seedBytes
        store.saveMessage({
          id: randomUUID(),
          conversationId: next.id,
          role: 'user',
          content: seedTurn.body
        })
        emitSeedEvent(next.id, params, seedTurn)
      }
      const title = params.titleOverride ?? (src.title ? `${src.title} (fork)` : null)
      if (title) store.updateConversationTitle(next.id, title)
      emitConversationForked(params, {
        conversationId: next.id,
        seedBytes,
        workspaceMode: params.workspaceMode ?? 'current',
        copiedAttachmentCount
      })
      return { success: true, data: { conversationId: next.id } }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('conversation:lineage', async (_event, conversationId: string) => {
    try {
      if (typeof conversationId !== 'string' || !conversationId) {
        return { success: false, error: 'conversationId is required' }
      }
      return { success: true, data: store.listConversationLineage(conversationId) }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('conversation:compact', async (_event, id: string) => {
    try {
      const conv = store.getConversation(id)
      if (!conv) return { success: false, error: 'conversation not found' }
      const msgs = store.getMessages(id)
      if (msgs.length < 4) {
        return { success: false, error: 'Conversation is too short to compact.' }
      }
      // Build a summarization request using the conversation's own model.
      const summaryReq = [
        {
          role: 'system' as const,
          content:
            'You are a summarizer. Produce a concise context-preservation summary (≤300 words) of the following conversation. Preserve specific decisions, file paths, code snippets, and unresolved questions. Output Markdown.'
        },
        ...msgs
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content
          }))
      ]
      const summaryResult = await chatOnce(summaryReq as any, conv.model)
      const summary = summaryResult.content
      // The gate used to be `!summary?.trim()`, i.e. ANY non-blank string authorized destroying the whole
      // conversation — a refusal ("I can't summarize that."), a truncated token, or a provider error
      // string returned as content all qualified. Require the summary to be substantive before it is
      // allowed to stand in for the thread it replaces.
      const text = (summary ?? '').trim()
      if (!text) return { success: false, error: 'Summarizer returned empty output.' }
      if (text.length < MIN_SUMMARY_CHARS) {
        return { success: false, error: `Summarizer returned only ${text.length} characters — refusing to replace ${msgs.length} messages with it.` }
      }
      // ARCHIVE FIRST. Compaction is destructive and user-invoked with no confirmation step, so the
      // originals are written to disk BEFORE anything is deleted and the compact is abandoned if that
      // write fails. Recovery beats a summary we cannot verify was faithful.
      let archivePath: string
      try {
        archivePath = archiveConversation(id, msgs, { reason: 'conversation:compact' })
      } catch (e) {
        return { success: false, error: `Could not archive the conversation before compacting: ${friendly(e, 'archive failed')}` }
      }
      // Replace ONLY the messages this summary actually stands for.
      //
      // `msgs` was read before the chatOnce await, and summarising a long thread is a
      // real model call. Anything the user sent while it ran is in the DB but not in
      // `msgs` — never summarised, never archived — yet a wholesale
      // `DELETE ... WHERE conversation_id = ?` destroyed it anyway, permanently, under
      // a plain "Conversation compacted" success toast. Scoping the delete to the
      // snapshot's ids keeps those messages; the marker is timestamped at the end of
      // the block it replaces so it sorts into their place instead of jumping ahead
      // of the newer turns.
      const replacedIds = msgs.map((m) => m.id)
      const snapshotEndedAt = msgs[msgs.length - 1]?.timestamp
      const replaced = store.compactConversation(
        id,
        {
          id: randomUUID(),
          content:
            `## Conversation compacted at ${new Date().toISOString()}\n\n` +
            `*(${msgs.length} messages archived to \`${archivePath}\`)*\n\n${text}`,
          createdAt: typeof snapshotEndedAt === 'number' ? snapshotEndedAt : undefined
        },
        undefined,
        { replaceIds: replacedIds }
      )
      return { success: true, data: { summary: text, archived: replaced, archivePath } }
    } catch (err) {
      return { success: false, error: friendly(err, 'compact failed') }
    }
  })
}
