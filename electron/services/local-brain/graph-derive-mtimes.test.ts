// The gap this closes: the brain-graph rebuild called deriveGraph() to read two fields
// per node, and deriveGraph hands out a structuredClone of the whole causal graph so
// callers cannot mutate its memo. That clone was the entire cost of the call and none of
// its value — the result was read once, for `mtime`, and dropped — inside a rebuild
// measured at 2.8-3.5s of blocked main thread (/debug/stalls, 2026-09-02).
//
// deriveNodeMtimes reads the memo directly and returns a fresh Map of primitives, which
// keeps the guarantee the clone existed for: nothing a caller does can reach the memo.
// That guarantee is the thing worth pinning, because losing it is silent — a mutation
// through the returned value would corrupt every later deriveGraph() in the process.
//
// POWER CONTROL: return `_deriveCache.graph` from deriveGraph without the
// structuredClone and "deriveGraph still hands out an isolated copy" fails. Have
// deriveNodeMtimes hand back node objects instead of a Map of primitives and
// "the memo cannot be reached through the returned map" fails.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let chunkVersion = 1
const CHUNKS = [
  { file: 'a.md', text: 'alpha [[b]]' },
  { file: 'b.md', text: 'beta' }
]

vi.mock('./index-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./index-store')>()),
  allChunks: (): unknown[] => CHUNKS.map((c) => ({ ...c })),
  notesChunksVersion: (): number => chunkVersion
}))

const load = async (): Promise<typeof import('./graph-derive')> => {
  vi.resetModules()
  return import('./graph-derive')
}

beforeEach(() => {
  chunkVersion++
})

describe('deriveNodeMtimes', () => {
  it('returns id → mtime for every node that has one', async () => {
    const { deriveGraph, deriveNodeMtimes } = await load()
    const graph = deriveGraph()
    const withMtime = (graph.nodes as Array<{ id: string; mtime?: number }>).filter((n) => n.mtime)
    const map = deriveNodeMtimes()
    expect(map.size).toBe(withMtime.length)
    for (const n of withMtime) expect(map.get(n.id)).toBe(n.mtime)
  })

  it('the memo cannot be reached through the returned map', async () => {
    // A Map of primitives, not of node objects: writing into it must not be able to
    // reach the cached graph every later deriveGraph() is cloned from.
    const { deriveGraph, deriveNodeMtimes } = await load()
    const before = JSON.stringify(deriveGraph())
    const map = deriveNodeMtimes()
    for (const k of map.keys()) map.set(k, -1)
    map.set('injected', 999)
    expect(JSON.stringify(deriveGraph())).toBe(before)
  })

  it('deriveGraph still hands out an isolated copy', async () => {
    // The clone deriveNodeMtimes skips must remain in place for deriveGraph itself —
    // mergedGraph() returns its result directly to callers that do mutate.
    const { deriveGraph } = await load()
    const first = deriveGraph()
    ;(first.nodes as Array<{ id: string }>).push({ id: 'injected-by-caller' })
    const second = deriveGraph()
    expect((second.nodes as Array<{ id: string }>).some((n) => n.id === 'injected-by-caller')).toBe(
      false
    )
  })

  it('agrees with deriveGraph on the same memo generation', async () => {
    const { deriveGraph, deriveNodeMtimes } = await load()
    const a = deriveNodeMtimes()
    const viaGraph = new Map<string, number>()
    for (const n of deriveGraph().nodes as Array<{ id: string; mtime?: number }>) {
      if (n.mtime) viaGraph.set(n.id, n.mtime)
    }
    expect([...a.entries()].sort()).toEqual([...viaGraph.entries()].sort())
  })
})
