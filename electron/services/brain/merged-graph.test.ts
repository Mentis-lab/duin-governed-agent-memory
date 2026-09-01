// Track 0 — mergedGraph() unions the file-level structural graph (deriveGraph)
// with the cached LLM construction via the real applyConstruction. Identity-spine P6:
// mergedGraph now reads getResolvedConstruction() (the shared, memoized alias-collapse
// accessor), so THAT is what we stub here; applyConstruction stays REAL so the merge is
// exercised end-to-end.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mergedGraph } from './merged-graph'
import { deriveGraph } from '../local-brain/graph-derive'
import { getResolvedConstruction } from './construct'
import type { CausalGraph } from '../local-brain/graph-derive'
import type { ConstructedData } from './types'

vi.mock('../local-brain/graph-derive', () => ({ deriveGraph: vi.fn() }))
vi.mock('./construct', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./construct')>()
  return { ...actual, getResolvedConstruction: vi.fn() }
})

const base: CausalGraph = {
  nodes: [{ id: 'note-a.md', kind: 'stream', label: 'A' }],
  edges: []
}

describe('mergedGraph — Track 0 unified graph builder', () => {
  beforeEach(() => {
    vi.mocked(deriveGraph).mockReturnValue(base)
  })

  it('with no construction, equals deriveGraph()', () => {
    vi.mocked(getResolvedConstruction).mockReturnValue(null)
    expect(mergedGraph()).toEqual(base)
  })

  it('with a construction, includes its entity node and edge', () => {
    const construction: ConstructedData = {
      entities: [{ id: 'person:jordan', kind: 'person', label: 'Jordan', note: 'note-a.md' }],
      edges: [{ source: 'person:jordan', target: 'note-a.md', type: 'attends' }],
      classifications: []
    }
    vi.mocked(getResolvedConstruction).mockReturnValue(construction)

    const g = mergedGraph()
    expect(g.nodes.some((n) => n.id === 'person:jordan')).toBe(true)
    expect(
      g.edges.some((e) => e.source === 'person:jordan' && e.target === 'note-a.md' && e.type === 'attends')
    ).toBe(true)
    // Additive: the base note node is preserved.
    expect(g.nodes.some((n) => n.id === 'note-a.md')).toBe(true)
  })
})
