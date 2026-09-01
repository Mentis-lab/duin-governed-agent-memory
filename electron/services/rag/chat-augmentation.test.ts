import { beforeEach, describe, expect, it, vi } from 'vitest'

// augmentForChat transitively imports electron (app.getPath), the sqlite store,
// the retrieve leg, and the embeddings worker. Mock exactly those seams so the
// REAL augmentForChat runs — this is a load-bearing test of the production
// function, not of an extracted copy.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/duin-test-userdata' },
  BrowserWindow: { getAllWindows: () => [] }
}))

// Capture the topN augmentForChat asks retrieve for, so we can prove the
// rerank-driven 3x over-fetch actually fires.
const retrieveCalls: { topN?: number }[] = []
const rerankSpy = vi.fn(async (_q: string, texts: string[]) =>
  texts.map((_t, i) => 1 - i * 0.01)
)

function fakeChunk(id: string) {
  return {
    chunkId: id,
    documentId: 'doc1',
    collectionId: 'col1',
    text: `text for ${id}`,
    displayName: 'doc1.md',
    scores: { fused: 0.5 },
    ranks: {}
  }
}
const FAKE_RESULTS = [fakeChunk('c1'), fakeChunk('c2'), fakeChunk('c3')]

vi.mock('./store', () => ({
  listAttachments: () => [
    { conversationId: 'conv1', collectionId: 'col1', attachedAt: 1 }
  ]
}))

vi.mock('./retrieve', () => ({
  retrieveWithMeta: async (input: { topN?: number }) => {
    retrieveCalls.push({ topN: input.topN })
    return {
      retrievalId: 'ret1',
      results: FAKE_RESULTS,
      lexHits: 3,
      vecHits: 3,
      fusedCount: 3,
      durationMs: 1
    }
  },
  persistRetrieval: () => {}
}))

vi.mock('./embeddings/service', () => ({
  getEmbeddingsService: () => ({
    embed: async (texts: string[]) => texts.map(() => new Float32Array([0])),
    rerank: rerankSpy,
    // augmentForChat now passes the active embedder id to retrieve (vector-leg
    // space guard); the stub must expose it like the real service does.
    getActiveEmbedderId: () => 'bge-small-en-v1.5'
  })
}))

// Keep the real rerank pass, but route its event-log write to the in-memory
// fallback so it doesn't reach for the (mock-electron) sqlite db.
import { __forceMemoryFallback, __resetEventLog } from '../event-log'
import { augmentForChat } from './chat-augmentation'

const FUSED_TOP_N_DEFAULT = 8

beforeEach(() => {
  retrieveCalls.length = 0
  rerankSpy.mockClear()
  __resetEventLog()
  __forceMemoryFallback()
})

describe('augmentForChat rerank default (regression: raw settings.rerankMode read)', () => {
  it('over-fetches 3x AND reranks when rerankMode is unset (fresh install)', async () => {
    // settings omitted entirely — mirrors settings.json with no rag key. The
    // bug read settings.rerankMode raw (undefined ⇒ treated as off), skipping
    // over-fetch and rerank while the UI showed local-cross-encoder selected.
    const result = await augmentForChat({ conversationId: 'conv1', query: 'q' })

    expect(result).not.toBeNull()
    expect(retrieveCalls).toHaveLength(1)
    // Over-fetch: fusedTopN(8) * 3 = 24. Pre-fix this was 8.
    expect(retrieveCalls[0].topN).toBe(FUSED_TOP_N_DEFAULT * 3)
    // Rerank actually ran: the wired cross-encoder (embeddings.rerank) was hit.
    expect(rerankSpy).toHaveBeenCalledTimes(1)
  })

  it('honours an explicit off: no over-fetch, no rerank', async () => {
    const result = await augmentForChat({
      conversationId: 'conv1',
      query: 'q',
      settings: { rerankMode: 'off' }
    })

    expect(result).not.toBeNull()
    expect(retrieveCalls[0].topN).toBe(FUSED_TOP_N_DEFAULT)
    expect(rerankSpy).not.toHaveBeenCalled()
  })
})
