import { describe, it, expect } from 'vitest'
import { detectCommunities, analyzeGraph, renderGraphReport, communityAssignments, graphSnapshot } from './graph-insight'
import type { CausalGraph } from '../local-brain/graph-derive'

/** Two fully-connected clusters (A*, B*) joined by a single bridge edge a1→b1 —
 *  the classic planted-partition Louvain should recover. */
function plantedTwoClusters(): CausalGraph {
  const nodes: CausalGraph['nodes'] = [
    { id: 'a1', kind: 'stream', label: 'Alpha 1', track: 'A' },
    { id: 'a2', kind: 'stream', label: 'Alpha 2', track: 'A' },
    { id: 'a3', kind: 'stream', label: 'Alpha 3', track: 'A' },
    { id: 'a4', kind: 'stream', label: 'Alpha 4', track: 'A' },
    { id: 'b1', kind: 'stream', label: 'Beta 1', track: 'B' },
    { id: 'b2', kind: 'stream', label: 'Beta 2', track: 'B' },
    { id: 'b3', kind: 'stream', label: 'Beta 3', track: 'B' },
    { id: 'b4', kind: 'stream', label: 'Beta 4', track: 'B' }
  ]
  const clique = (ids: string[]): CausalGraph['edges'] => {
    const out: CausalGraph['edges'] = []
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) out.push({ source: ids[i], target: ids[j], type: 'wikilink' })
    return out
  }
  const edges = [
    ...clique(['a1', 'a2', 'a3', 'a4']),
    ...clique(['b1', 'b2', 'b3', 'b4']),
    { source: 'a1', target: 'b1', type: 'wikilink' } // the bridge
  ]
  return { nodes, edges, stats: { nodes: nodes.length, edges: edges.length } }
}

describe('graph-insight: community detection', () => {
  it('recovers the two planted clusters', () => {
    const comm = detectCommunities(plantedTwoClusters())
    const cA = ['a1', 'a2', 'a3', 'a4'].map((id) => comm.get(id))
    const cB = ['b1', 'b2', 'b3', 'b4'].map((id) => comm.get(id))
    expect(new Set(cA).size).toBe(1) // all Alpha together
    expect(new Set(cB).size).toBe(1) // all Beta together
    expect(cA[0]).not.toBe(cB[0]) // Alpha != Beta
  })

  it('puts every node in its own community when there are no edges', () => {
    const g: CausalGraph = {
      nodes: [
        { id: 'x', kind: 'stream', label: 'X' },
        { id: 'y', kind: 'stream', label: 'Y' }
      ],
      edges: []
    }
    const comm = detectCommunities(g)
    expect(comm.get('x')).not.toBe(comm.get('y'))
  })

  it('is deterministic across runs', () => {
    const g = plantedTwoClusters()
    expect([...detectCommunities(g).entries()]).toEqual([...detectCommunities(g).entries()])
  })
})

describe('graph-insight: analysis', () => {
  it('reports two clusters and the single cross-cluster bridge', () => {
    const insight = analyzeGraph(plantedTwoClusters())
    expect(insight.stats.communities).toBe(2)
    expect(insight.stats.isolated).toBe(0)
    expect(insight.bridges).toHaveLength(1)
    const b = insight.bridges[0]
    expect(new Set([b.source, b.target])).toEqual(new Set(['a1', 'b1']))
    expect(b.surprise).toBeGreaterThan(0)
  })

  it('surfaces hubs and seeds suggested questions', () => {
    const insight = analyzeGraph(plantedTwoClusters())
    expect(insight.highDegree.length).toBeGreaterThan(0)
    expect(insight.highDegree[0].degree).toBeGreaterThan(0)
    expect(insight.suggestedQuestions.length).toBeGreaterThan(0)
    // a bridge-seeded question references both lanes
    expect(insight.suggestedQuestions.join('\n')).toMatch(/connect/i)
  })

  it('gives every cluster a unique label even when lanes collide', () => {
    // Two separate cliques, BOTH in track "X" and no bridge → two communities
    // that would both label as "X"; disambiguation must make them unique.
    const clique = (ids: string[]): CausalGraph['edges'] => {
      const out: CausalGraph['edges'] = []
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) out.push({ source: ids[i], target: ids[j], type: 'wikilink' })
      return out
    }
    const g: CausalGraph = {
      nodes: [
        { id: 'p1', kind: 'stream', label: 'P1', track: 'X' },
        { id: 'p2', kind: 'stream', label: 'P2', track: 'X' },
        { id: 'p3', kind: 'stream', label: 'P3', track: 'X' },
        { id: 'q1', kind: 'stream', label: 'Q1', track: 'X' },
        { id: 'q2', kind: 'stream', label: 'Q2', track: 'X' },
        { id: 'q3', kind: 'stream', label: 'Q3', track: 'X' }
      ],
      edges: [...clique(['p1', 'p2', 'p3']), ...clique(['q1', 'q2', 'q3'])]
    }
    const insight = analyzeGraph(g)
    expect(insight.stats.communities).toBe(2)
    const labels = insight.communities.map((c) => c.label)
    expect(new Set(labels).size).toBe(labels.length) // unique
  })

  it('classifies edge provenance (declared vs inferred vs ambiguous)', () => {
    const insight = analyzeGraph(plantedTwoClusters())
    // planted graph is all wikilinks → fully declared
    expect(insight.edgeProvenance.declared).toBe(insight.stats.edges)
    expect(insight.edgeProvenance.inferred).toBe(0)
    expect(insight.bridges[0].provenance).toBe('declared')

    // a graph with a constructed (inferred) edge + a low-confidence (ambiguous) one
    const g: CausalGraph = {
      nodes: [
        { id: 'a', kind: 'stream', label: 'A' },
        { id: 'b', kind: 'stream', label: 'B' },
        { id: 'c', kind: 'stream', label: 'C' }
      ],
      edges: [
        { source: 'a', target: 'b', type: 'wikilink', confidence: 0.7 },
        { source: 'b', target: 'c', type: 'builds_toward', confidence: 0.6 },
        { source: 'a', target: 'c', type: 'guides', confidence: 0.3 }
      ]
    }
    const p = analyzeGraph(g).edgeProvenance
    expect(p.declared).toBe(1)
    expect(p.inferred).toBe(1)
    expect(p.ambiguous).toBe(1)
  })

  it('assigns distinct cluster colors and per-node community assignments', () => {
    const g = plantedTwoClusters()
    const insight = analyzeGraph(g)
    const colors = insight.communities.map((c) => c.color)
    expect(new Set(colors).size).toBe(colors.length) // distinct per cluster
    colors.forEach((c) => expect(c).toMatch(/^#[0-9a-f]{6}$/i))

    const assign = communityAssignments(g)
    expect(assign).toHaveLength(g.nodes.length)
    const byId = new Map(assign.map((a) => [a.id, a]))
    // same cluster → same color; different clusters → different color
    expect(byId.get('a1')?.color).toBe(byId.get('a2')?.color)
    expect(byId.get('a1')?.color).not.toBe(byId.get('b1')?.color)
  })

  it('suggests a wikilink to wire an island in (densifier)', () => {
    const g: CausalGraph = {
      nodes: [
        { id: 'mochi-bd.md', kind: 'stream', label: 'Hokuran BD plan', track: 'beilan' },
        { id: 'mochi-launch.md', kind: 'stream', label: 'Hokuran launch', track: 'beilan' },
        { id: 'mochi-island.md', kind: 'stream', label: 'Hokuran orphan', track: 'beilan' } // degree 0
      ],
      edges: [{ source: 'mochi-bd.md', target: 'mochi-launch.md', type: 'wikilink' }]
    }
    const sugs = analyzeGraph(g).linkSuggestions
    const island = sugs.find((s) => s.source === 'mochi-island.md')
    expect(island).toBeTruthy()
    expect(island?.kind).toBe('island')
    expect(island?.wikilink).toMatch(/^\[\[.+\]\]$/)
    expect(island?.confidence).toBeGreaterThan(0)
  })

  it('produces a structural snapshot for growth tracking', () => {
    const snap = graphSnapshot(plantedTwoClusters())
    expect(snap.nodes).toBe(8)
    expect(snap.communities).toBe(2)
    expect(snap.declared).toBeGreaterThan(0)
  })

  it('handles an empty graph without throwing', () => {
    const insight = analyzeGraph({ nodes: [], edges: [] })
    expect(insight.stats.nodes).toBe(0)
    expect(insight.communities).toHaveLength(0)
    expect(insight.bridges).toHaveLength(0)
  })
})

describe('graph-insight: report rendering', () => {
  it('renders markdown with the expected sections', () => {
    const md = renderGraphReport(analyzeGraph(plantedTwoClusters()))
    expect(md).toContain('# Brain Graph Report')
    expect(md).toContain('## Clusters')
    expect(md).toContain('## Hubs')
    expect(md).toContain('## Surprising connections')
    expect(md).toContain('## Questions to explore')
    expect(md).toMatch(/source: graph-insight/)
  })
})
