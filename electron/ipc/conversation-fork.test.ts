import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: any[]) => any>()
const recordEvent = vi.fn()
const saveMessage = vi.fn()
const insertDocument = vi.fn(() => ({ id: 'seed-doc-1' }))
const insertChunks = vi.fn()
const updateDocument = vi.fn()
const addAttachment = vi.fn()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn)
  },
  app: { getPath: () => 'C:/userData' }
}))

vi.mock('../services/conversation-store', () => ({
  getConversation: vi.fn(() => ({
    id: 'source-conv',
    model: 'test-model',
    kind: 'local',
    title: 'Source',
    worktreePath: 'C:/old',
    projectId: 'project-1'
  })),
  createConversation: vi.fn(() => ({ id: 'fork-conv' })),
  findMessage: vi.fn(() => ({ id: 'msg-1', content: 'message seed' })),
  saveMessage,
  updateConversationTitle: vi.fn(),
  listConversations: vi.fn(() => []),
  listSessions: vi.fn(() => []),
  setConversationArchived: vi.fn(),
  setConversationPinned: vi.fn(),
  searchSessions: vi.fn(() => []),
  deleteConversation: vi.fn(),
  updateConversationModel: vi.fn(),
  updateConversationTitleById: vi.fn(),
  getMessages: vi.fn(() => []),
  clearConversationMessages: vi.fn(),
  listConversationLineage: vi.fn(() => [])
}))

vi.mock('../services/providers/registry', () => ({ chatOnce: vi.fn() }))
vi.mock('../services/workspace-state', () => ({ getActiveWorkspace: vi.fn(() => 'C:/current') }))
vi.mock('../services/conversation-rag', () => ({
  ensureConversationCollection: vi.fn(() => ({
    id: 'seed-col-1',
    // The seed embeds in THIS collection's space, so the stamp has to be here.
    embedderId: 'bge-small-en-v1.5',
    chunkSize: 800,
    chunkOverlap: 100
  }))
}))
vi.mock('../services/rag/store', () => ({
  addAttachment,
  copyAttachments: vi.fn(() => 2),
  insertDocument,
  insertChunks,
  updateDocument
}))
vi.mock('../services/rag/chunker', () => ({
  chunk: vi.fn(() => [
    {
      index: 0,
      startOffset: 0,
      endOffset: 20,
      text: 'chunk text'
    }
  ])
}))
vi.mock('../services/settings-helper', () => ({
  readSettings: vi.fn(() => ({ safeSeedLength: 10 }))
}))
const embed = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([0.1, 0.2])))
const embedWith = vi.fn(async (_id: string, texts: string[]) => embed(texts))
vi.mock('../services/rag/embeddings/service', () => ({
  getEmbeddingsService: () => ({
    embed: (t: string[]) => embed(t),
    embedWith: (id: string, t: string[]) => embedWith(id, t)
  })
}))
vi.mock('../services/event-log', () => ({ recordEvent }))

describe('conversation:fork seed handling', () => {
  beforeEach(async () => {
    handlers.clear()
    vi.clearAllMocks()
    const mod = await import('./conversation')
    mod.registerConversationHandlers()
  })

  it('turns oversized seed content into an attached RAG document and telemetry', async () => {
    const handler = handlers.get('conversation:fork')
    expect(handler).toBeDefined()

    const result = await handler?.({}, {
      sourceConversationId: 'source-conv',
      sourceMessageId: 'msg-1',
      seedKind: 'custom',
      seedContent: 'this seed content is definitely longer than ten chars',
      includeRagAttachments: true,
      workspaceMode: 'current'
    })

    expect(result.success).toBe(true)
    expect(addAttachment).toHaveBeenCalledWith({
      conversationId: 'fork-conv',
      collectionId: 'seed-col-1'
    })
    expect(insertDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        collectionId: 'seed-col-1',
        sourceKind: 'paste',
        displayName: 'Seed from message msg-1',
        status: 'chunking'
      })
    )
    expect(insertChunks).toHaveBeenCalled()
    // Backlog finding 31: this was the only insertChunks call site in the repo that
    // omitted the vectors argument, and the argument is optional so nothing complained.
    // The seed text is replaced by a document pointer in the visible turn, so a seed
    // without vectors is lexical-search-only forever with no reindex path back.
    expect(embed).toHaveBeenCalledWith(['chunk text'])
    // ...and in the collection's OWN space. ensureConversationCollection returns an
    // EXISTING collection unchanged, so embedding with the process-active embedder
    // would mix two spaces into one collection after an embedder change.
    expect(embedWith).toHaveBeenCalledWith('bge-small-en-v1.5', ['chunk text'])
    const [, vectorsArg] = insertChunks.mock.calls[0]
    expect(vectorsArg).toHaveLength(1)
    expect(vectorsArg[0]).toBeInstanceOf(Float32Array)
    expect(updateDocument).toHaveBeenCalledWith(
      'seed-doc-1',
      expect.objectContaining({ status: 'ready', chunkCount: 1 })
    )
    expect(saveMessage.mock.calls[0][0].content).toContain('Seed attached as document')
    expect(recordEvent.mock.calls.map((c) => c[0].type)).toEqual(
      expect.arrayContaining(['conversation.seed.truncated', 'conversation.forked'])
    )
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'conversation.seed.truncated',
        entityId: 'seed-doc-1'
      })
    )
  })

  it('still stores the seed when embedding fails, rather than losing it', async () => {
    embedWith.mockRejectedValueOnce(new Error('embedder cold'))
    const handler = handlers.get('conversation:fork')
    const result = await handler?.({}, {
      sourceConversationId: 'source-conv',
      sourceMessageId: 'msg-1',
      seedKind: 'custom',
      seedContent: 'this seed content is definitely longer than ten chars',
      includeRagAttachments: true,
      workspaceMode: 'current'
    })
    expect(result.success).toBe(true)
    // Degrades to the previous lexical-only insert instead of aborting the fork.
    expect(insertChunks).toHaveBeenCalled()
    expect(insertChunks.mock.calls[0][1]).toBeUndefined()
    expect(updateDocument).toHaveBeenCalledWith(
      'seed-doc-1',
      expect.objectContaining({ status: 'ready' })
    )
  })

  it('keeps small seed content inline and records seed.attached', async () => {
    const handler = handlers.get('conversation:fork')
    const result = await handler?.({}, {
      sourceConversationId: 'source-conv',
      seedKind: 'custom',
      seedContent: 'tiny',
      includeRagAttachments: false,
      workspaceMode: 'none'
    })

    expect(result.success).toBe(true)
    expect(insertDocument).not.toHaveBeenCalled()
    expect(saveMessage.mock.calls[0][0].content).toContain('tiny')
    expect(recordEvent.mock.calls.map((c) => c[0].type)).toEqual(
      expect.arrayContaining(['conversation.seed.attached', 'conversation.forked'])
    )
  })
})
