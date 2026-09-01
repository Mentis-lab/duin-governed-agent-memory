import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('electron app not available in test environment')
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

import {
  __forceMemoryFallback,
  __resetCollectionStore,
  createCollection,
  insertChunks,
  insertDocument
} from './store'
import {
  __forceMemoryFallback as forceEventMemory,
  __resetEventLog,
  listEvents
} from '../event-log'
import { fuseRRF, resolveQueryVec, retrieveWithMeta, soleCollectionSpace } from './retrieve'

beforeEach(() => {
  __resetEventLog()
  forceEventMemory()
  __resetCollectionStore()
  __forceMemoryFallback()
})

// ──────────────────── RRF math (pure) ────────────────────

describe('fuseRRF math', () => {
  it('a candidate present in both legs ranks above a candidate present in only one', () => {
    const lex = [{ rowid: 1, chunk_id: 'A', score: -1 }]
    const vec = [
      { rowid: 1, chunk_id: 'A', distance: 0.1 },
      { rowid: 2, chunk_id: 'B', distance: 0.2 }
    ]
    const fused = fuseRRF(lex, vec, 5)
    expect(fused[0].chunkId).toBe('A')
    expect(fused[0].scores.fused).toBeGreaterThan(fused[1].scores.fused)
  })

  it('returns at most topN entries', () => {
    const lex = Array.from({ length: 10 }, (_, i) => ({
      rowid: i + 1,
      chunk_id: `L${i}`,
      score: -i
    }))
    const fused = fuseRRF(lex, [], 3)
    expect(fused).toHaveLength(3)
  })

  it('preserves per-leg rank in the .ranks field', () => {
    const lex = [
      { rowid: 1, chunk_id: 'X', score: -2 },
      { rowid: 2, chunk_id: 'Y', score: -1 }
    ]
    const vec = [{ rowid: 1, chunk_id: 'X', distance: 0.1 }]
    const fused = fuseRRF(lex, vec, 5)
    const x = fused.find((f) => f.chunkId === 'X')!
    expect(x.ranks.lex).toBe(1)
    expect(x.ranks.vec).toBe(1)
    const y = fused.find((f) => f.chunkId === 'Y')!
    expect(y.ranks.lex).toBe(2)
    expect(y.ranks.vec).toBeUndefined()
  })
})

// ──────────────────── query-embedding resolution (vec-leg gate) ────────────────────

describe('resolveQueryVec', () => {
  it('returns a caller-supplied queryEmbedding without embedding', async () => {
    const pre = new Float32Array([1, 2, 3])
    const embed = vi.fn(async () => [new Float32Array([9])])
    const got = await resolveQueryVec({
      query: 'q',
      collectionIds: ['c'],
      queryEmbedding: pre,
      embed
    })
    expect(got).toBe(pre)
    expect(embed).not.toHaveBeenCalled()
  })

  it('embeds the query when no queryEmbedding is supplied', async () => {
    const vec = new Float32Array([0.5, 0.5])
    const embed = vi.fn(async () => [vec])
    const got = await resolveQueryVec({
      query: 'hello',
      collectionIds: ['c'],
      embed
    })
    expect(got).toBe(vec)
    expect(embed).toHaveBeenCalledWith(['hello'])
  })

  // The load-bearing regression guard: a rejecting embedder (offline / weights
  // never downloaded → typed MODEL_DOWNLOAD_FAILED) must NOT propagate. Before
  // the fix the naked `await input.embed(...)` inside retrieveFromDb threw,
  // discarding the already-computed lexical leg; here it degrades to null so
  // the caller falls back to lexical-only.
  it('degrades to null (does not throw) when the embedder rejects', async () => {
    const embed = vi.fn(async () => {
      throw new Error('MODEL_DOWNLOAD_FAILED')
    })
    const got = await resolveQueryVec({
      query: 'offline query',
      collectionIds: ['c'],
      embed
    })
    expect(got).toBeNull()
  })

  it('returns null when neither queryEmbedding nor embed is provided', async () => {
    const got = await resolveQueryVec({ query: 'q', collectionIds: ['c'] })
    expect(got).toBeNull()
  })
  it('embeds in the target space when one is given, bypassing the active embedder', async () => {
    const spaceVec = new Float32Array([7])
    const embed = vi.fn(async () => [new Float32Array([9])])
    const embedWith = vi.fn(async () => [spaceVec])
    const got = await resolveQueryVec(
      { query: 'hello', collectionIds: ['c'], embed, embedWith },
      'bge-small-en-v1.5'
    )
    expect(got).toBe(spaceVec)
    expect(embedWith).toHaveBeenCalledWith('bge-small-en-v1.5', ['hello'], 'none')
    expect(embed).not.toHaveBeenCalled()
  })

  it('degrades to null when the target-space embed rejects', async () => {
    const embedWith = vi.fn(async () => {
      throw new Error('MODEL_DOWNLOAD_FAILED')
    })
    const got = await resolveQueryVec(
      { query: 'q', collectionIds: ['c'], embedWith },
      'bge-small-en-v1.5'
    )
    expect(got).toBeNull()
  })
})

describe('soleCollectionSpace', () => {
  // Deciding WHEN it is safe to re-point the query embedding at the collections'
  // own space. One shared space => the query can meet the vectors where they live,
  // so a changed default embedder no longer pins the collection to lexical-only.
  // Anything else => no single query vector is right for the whole scope, and the
  // vec-leg guard's skip stays the correct answer.
  // Real catalogue ids: the target is handed to embedWith, which rejects anything
  // getEmbedder cannot resolve, so a placeholder id would not exercise the real path.
  const E5 = 'multilingual-e5-small'
  const BGE = 'bge-small-en-v1.5'

  it('returns the shared id when every collection agrees', () => {
    expect(soleCollectionSpace([E5, E5, E5])).toBe(E5)
  })

  it('returns null for a mixed scope', () => {
    expect(soleCollectionSpace([E5, BGE])).toBeNull()
  })

  it('returns null for an empty scope', () => {
    expect(soleCollectionSpace([])).toBeNull()
  })

  it('ignores blank / unstamped ids', () => {
    expect(soleCollectionSpace(['', '  ', E5])).toBe(E5)
    expect(soleCollectionSpace(['', '  '])).toBeNull()
  })

  it('trims, so a padded stamp still matches the guard it is compared against', () => {
    expect(soleCollectionSpace([` ${E5} `])).toBe(E5)
  })

  it('returns null for a stamp this build cannot resolve', () => {
    // A stamp equals itself, so the guard would clear the leg and resolveQueryVec would
    // then throw inside embedWith — degrading the whole query to lexical instead of
    // simply declining to re-target.
    expect(soleCollectionSpace(['a-model-this-build-dropped'])).toBeNull()
  })
})

// ──────────────────── memory-fallback retrieval (lex-only) ────────────────────

describe('retrieve (memory fallback, lex-only)', () => {
  it('returns chunks containing the query tokens, scoped to the collection', async () => {
    const c1 = createCollection({ name: 'Alpha', embedderId: 'e' })
    const c2 = createCollection({ name: 'Beta', embedderId: 'e' })
    const doc1 = insertDocument({
      collectionId: c1.id,
      sourceKind: 'paste',
      displayName: 'd1',
      hashSha256: 'h1',
      status: 'ready'
    })
    const doc2 = insertDocument({
      collectionId: c2.id,
      sourceKind: 'paste',
      displayName: 'd2',
      hashSha256: 'h2',
      status: 'ready'
    })
    insertChunks([
      {
        documentId: doc1.id,
        collectionId: c1.id,
        chunkIndex: 0,
        startOffset: 0,
        endOffset: 50,
        text: 'lamprey routes per-model to multiple providers'
      },
      {
        documentId: doc1.id,
        collectionId: c1.id,
        chunkIndex: 1,
        startOffset: 50,
        endOffset: 100,
        text: 'unrelated content about coffee and toast'
      },
      {
        documentId: doc2.id,
        collectionId: c2.id,
        chunkIndex: 0,
        startOffset: 0,
        endOffset: 50,
        text: 'lamprey appears in this OTHER collection too'
      }
    ])

    const info = await retrieveWithMeta({
      query: 'lamprey routes',
      collectionIds: [c1.id]
    })
    expect(info.results.length).toBeGreaterThan(0)
    // Scope: results must only come from c1.
    for (const r of info.results) {
      expect(r.collectionId).toBe(c1.id)
    }
    // The top hit is the chunk that contains both tokens.
    expect(info.results[0].text).toContain('lamprey routes')
  })

  it('empty query returns an empty result with zero hits', async () => {
    const c = createCollection({ name: 'X', embedderId: 'e' })
    const info = await retrieveWithMeta({ query: '', collectionIds: [c.id] })
    expect(info.results).toEqual([])
    expect(info.lexHits).toBe(0)
  })

  it('empty collectionIds returns empty', async () => {
    const info = await retrieveWithMeta({ query: 'hello', collectionIds: [] })
    expect(info.results).toEqual([])
  })

  it('emits a rag.query.completed event with scope + counts', async () => {
    const c = createCollection({ name: 'X', embedderId: 'e' })
    const doc = insertDocument({
      collectionId: c.id,
      sourceKind: 'paste',
      displayName: 'd',
      hashSha256: 'h',
      status: 'ready'
    })
    insertChunks([
      {
        documentId: doc.id,
        collectionId: c.id,
        chunkIndex: 0,
        startOffset: 0,
        endOffset: 100,
        text: 'the rapid quick brown lamprey hops the fence'
      }
    ])
    await retrieveWithMeta({ query: 'lamprey', collectionIds: [c.id] })
    const events = listEvents({ type: 'rag.query.completed' })
    expect(events).toHaveLength(1)
    const payload = events[0].payload as {
      scopes: string[]
      lexHits: number
      fusedCount: number
    }
    expect(payload.scopes).toEqual([c.id])
    expect(payload.fusedCount).toBeGreaterThan(0)
  })
})
