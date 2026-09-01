// Track-0 Phase 2b: liveGraph()'s optional DUIN product-store overlay.
//
// SAFETY CONTRACT: the overlay is OFF unless DUIN_RETRIEVAL_PRODUCT_OVERLAY=1, so
// flag-OFF liveGraph() output is byte-identical to today (no product nodes/edges).
// Flag-ON overlays the product-store cascade (readGraph), deduped by id, dropping
// self- and dangling edges. deriveGraph / getConstruction / readGraph / readSettings
// are mocked so the base graph is deterministic and the product store is stubbed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Deterministic empty base graph (no notes indexed in the test env).
vi.mock('../local-brain/graph-derive', () => ({
  deriveGraph: vi.fn(() => ({ nodes: [], edges: [] }))
}))
// No LLM construction — isolates the product overlay as the ONLY post-base mutation.
vi.mock('./construct', () => ({
  getConstruction: vi.fn(() => null),
  RELATION_TO_EDGE: {}
}))
// Stubbed product store (native readGraphNative) — a small cascade with one dangling + one self edge.
const readGraphMock = vi.fn()
vi.mock('./graph-native', () => ({
  readGraphNative: (...args: unknown[]) => readGraphMock(...args)
}))
// Vault dir resolution for readGraphNative — same source liveGraph uses (localBrainNotesDir).
vi.mock('../settings-helper', () => ({
  readSettings: vi.fn(() => ({ localBrainNotesDir: '/fake/vault' }))
}))

import { liveGraph, __resetGroundingCache } from './retrieve-agent'

const PRODUCT_GRAPH = {
  nodes: [
    { id: 'goal:north-star', kind: 'goal', title: 'North Star' },
    { id: 'track:track-0', kind: 'track', title: 'Track 0' },
    { id: 'move:phase-2b', kind: 'move', title: 'Phase 2b' },
    { id: 'person:theo', kind: 'person', title: 'Theo' }
  ],
  edges: [
    { src: 'track:track-0', dst: 'goal:north-star', type: 'serves' },
    { src: 'move:phase-2b', dst: 'track:track-0', type: 'advances' },
    { src: 'goal:north-star', dst: 'goal:north-star', type: 'self' }, // self-edge → dropped
    { src: 'move:phase-2b', dst: 'goal:ghost', type: 'dangling' } // dangling endpoint → dropped
  ],
  by_kind: {},
  by_edge: {},
  node_count: 4,
  edge_count: 4
}

describe('liveGraph — DUIN product-store overlay (Track-0 Phase 2b)', () => {
  const prev = process.env.DUIN_RETRIEVAL_PRODUCT_OVERLAY
  const prevEnt = process.env.DUIN_ENTITY_RESOLVER
  beforeEach(() => {
    __resetGroundingCache() // liveGraph is now vault-version-cached; tests re-setup without bumping the version
    readGraphMock.mockReset()
    readGraphMock.mockReturnValue(PRODUCT_GRAPH)
    // Isolate the PRODUCT overlay: pin the (now default-on) entity resolver OFF so its
    // profile-index read doesn't touch the unmocked vault. getConstruction is mocked null.
    process.env.DUIN_ENTITY_RESOLVER = '0'
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.DUIN_RETRIEVAL_PRODUCT_OVERLAY
    else process.env.DUIN_RETRIEVAL_PRODUCT_OVERLAY = prev
    if (prevEnt === undefined) delete process.env.DUIN_ENTITY_RESOLVER
    else process.env.DUIN_ENTITY_RESOLVER = prevEnt
  })

  it('flag "0" (opt-out kill-switch): NO product nodes/edges — readGraph is never consulted', () => {
    process.env.DUIN_RETRIEVAL_PRODUCT_OVERLAY = '0'
    const g = liveGraph()
    expect(g.nodes).toEqual([])
    expect(g.edges).toEqual([])
    expect(readGraphMock).not.toHaveBeenCalled()
  })

  it('flag unset (default ON, P3 flip): product IS overlaid (opt-out, not opt-in)', () => {
    delete process.env.DUIN_RETRIEVAL_PRODUCT_OVERLAY
    const g = liveGraph()
    expect(readGraphMock).toHaveBeenCalledWith('/fake/vault')
    expect(g.nodes.length).toBeGreaterThan(0)
  })

  it('flag ON (=1): product nodes + edges appear; self/dangling edges dropped', () => {
    process.env.DUIN_RETRIEVAL_PRODUCT_OVERLAY = '1'
    const g = liveGraph()
    expect(readGraphMock).toHaveBeenCalledWith('/fake/vault')

    // All 4 product nodes present, converted to GraphNode (id/label/kind).
    expect(g.nodes).toHaveLength(4)
    const byId = new Map(g.nodes.map((n) => [n.id, n]))
    expect(byId.get('goal:north-star')).toEqual({
      id: 'goal:north-star',
      label: 'North Star',
      kind: 'goal'
    })
    expect(byId.get('track:track-0')?.kind).toBe('track')
    expect(byId.get('move:phase-2b')?.label).toBe('Phase 2b')

    // Only the two valid edges survive; self-edge and dangling edge dropped.
    expect(g.edges).toHaveLength(2)
    expect(g.edges).toContainEqual({ source: 'track:track-0', target: 'goal:north-star', type: 'serves' })
    expect(g.edges).toContainEqual({ source: 'move:phase-2b', target: 'track:track-0', type: 'advances' })
    expect(g.edges.some((e) => e.type === 'self')).toBe(false)
    expect(g.edges.some((e) => e.target === 'goal:ghost')).toBe(false)
  })

  it('flag ON: product-store id is authoritative on collision (overwrites in place, no dup)', () => {
    process.env.DUIN_RETRIEVAL_PRODUCT_OVERLAY = '1'
    readGraphMock.mockReturnValue({
      ...PRODUCT_GRAPH,
      nodes: [{ id: 'goal:north-star', kind: 'goal', title: 'Renamed Goal' }],
      edges: []
    })
    const g = liveGraph()
    const matches = g.nodes.filter((n) => n.id === 'goal:north-star')
    expect(matches).toHaveLength(1)
    expect(matches[0].label).toBe('Renamed Goal')
  })
})
