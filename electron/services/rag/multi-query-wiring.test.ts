// multi-query-wiring.test.ts — the multi-query rewrite was DEAD in production (2026-07-25 eval).
//
// Everything existed: rewriteQuery, per-variant retrieval, fuseAcrossVariants, a Settings → RAG
// toggle, and an `if (settings.multiQueryRewrite && opts.planner)` branch in augmentForChat. The
// one missing piece was the planner: ipc/chat.ts never passed one, so the branch could not fire —
// switching the toggle ON in Settings changed nothing at all.
//
// Two halves are proved here: (1) with a planner supplied, the REAL augmentForChat retrieves per
// variant and fuses across them; (2) ipc/chat.ts actually supplies one (the source-parity idiom
// used by graph-expand-adapt.test.ts and mcp-defaults.test.ts, since the chat handler itself is
// not reachable from a unit test).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/duin-test-userdata' },
  BrowserWindow: { getAllWindows: () => [] }
}))

const retrieveCalls: { query: string; topN?: number }[] = []

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

vi.mock('./store', () => ({
  listAttachments: () => [{ conversationId: 'conv1', collectionId: 'col1', attachedAt: 1 }]
}))

// Each variant returns a DIFFERENT chunk set with one overlap, so the cross-variant RRF union is
// observable: the shared chunk must outrank the singletons.
vi.mock('./retrieve', () => ({
  retrieveWithMeta: async (input: { query: string; topN?: number }) => {
    retrieveCalls.push({ query: input.query, topN: input.topN })
    const perVariant: Record<string, string[]> = {
      'how do tools work': ['shared', 'a1'],
      'what is the tool system': ['a2', 'shared'],
      'tool dispatch architecture': ['a3', 'shared']
    }
    const ids = perVariant[input.query] ?? ['fallback']
    return {
      retrievalId: 'ret1',
      results: ids.map(fakeChunk),
      lexHits: ids.length,
      vecHits: ids.length,
      fusedCount: ids.length,
      durationMs: 1
    }
  },
  persistRetrieval: () => {}
}))

vi.mock('./embeddings/service', () => ({
  getEmbeddingsService: () => ({
    embed: async (texts: string[]) => texts.map(() => new Float32Array([0])),
    rerank: async (_q: string, texts: string[]) => texts.map((_t, i) => 1 - i * 0.01),
    getActiveEmbedderId: () => 'bge-small-en-v1.5'
  })
}))

import { __forceMemoryFallback, __resetEventLog } from '../event-log'
import { augmentForChat } from './chat-augmentation'

const planner = async (): Promise<string> =>
  JSON.stringify(['what is the tool system', 'tool dispatch architecture'])

beforeEach(() => {
  retrieveCalls.length = 0
  __resetEventLog()
  __forceMemoryFallback()
})

describe('multi-query rewrite fires when the setting is on AND a planner is supplied', () => {
  it('retrieves once per rewritten variant and fuses across them', async () => {
    const result = await augmentForChat({
      conversationId: 'conv1',
      query: 'how do tools work',
      planner,
      settings: { multiQueryRewrite: true, rerankMode: 'off' }
    })

    expect(result).not.toBeNull()
    // original + 2 rewrites, each retrieved separately.
    expect(retrieveCalls.map((c) => c.query)).toEqual([
      'how do tools work',
      'what is the tool system',
      'tool dispatch architecture'
    ])
    expect(result!.rewrites).toEqual([
      'how do tools work',
      'what is the tool system',
      'tool dispatch architecture'
    ])
    // Cross-variant RRF: 'shared' appears in all three rankings, so it must come out on top of
    // chunks that only one variant surfaced. This is the union the rewrite exists to produce.
    expect(result!.chunks[0].chunkId).toBe('shared')
    expect(result!.chunks.map((c) => c.chunkId)).toEqual(
      expect.arrayContaining(['shared', 'a1', 'a2', 'a3'])
    )
  })

  it('stays single-query when the setting is off, even with a planner available', async () => {
    const result = await augmentForChat({
      conversationId: 'conv1',
      query: 'how do tools work',
      planner,
      settings: { multiQueryRewrite: false, rerankMode: 'off' }
    })

    expect(result).not.toBeNull()
    expect(retrieveCalls).toHaveLength(1)
  })

  it('stays single-query when the setting is on but no planner is supplied (the old defect)', async () => {
    const result = await augmentForChat({
      conversationId: 'conv1',
      query: 'how do tools work',
      settings: { multiQueryRewrite: true, rerankMode: 'off' }
    })

    expect(result).not.toBeNull()
    expect(retrieveCalls).toHaveLength(1)
  })
})

describe('ipc/chat.ts supplies the planner (the wiring that was missing)', () => {
  const chatSource = readFileSync(join(__dirname, '..', '..', 'ipc', 'chat.ts'), 'utf-8')

  it('passes a planner into augmentForChat', () => {
    const start = chatSource.indexOf('await augmentForChat({')
    expect(start).toBeGreaterThan(-1)
    const call = chatSource.slice(start, chatSource.indexOf('})', start))
    expect(call).toMatch(/planner:/)
  })

  it('builds it with the shared makeChatPlanner rather than an inline model call', () => {
    expect(chatSource).toMatch(/makeChatPlanner/)
  })
})
