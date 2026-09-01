import { describe, it, expect } from 'vitest'
import { deriveInsights } from './insights'
import { causalGraph } from './causal-engine'
import type { Store } from './store'
import type { CausalNode, CausalEdge, Insight } from './types'

// The analytical derivation is now the pure deriveInsights(graph, tracks, riskCount) — shared by the
// Stack-A and Stack-B readers. These tests exercise the graph-based insights (convergence / coupling /
// orphan / ranking) with no tracks/risks. causalGraph() builds the fixture graph (in_degree etc.).
function graphOf(nodes: CausalNode[], edges: CausalEdge[], today = '2026-01-10') {
  const store: Store = {
    causalNodes: () => nodes.map((n) => ({ ...n })),
    causalEdges: () => edges.map((e) => ({ ...e })),
    today: () => today
  }
  return causalGraph(store)
}

describe('deriveInsights', () => {
  it('surfaces a convergence-bottleneck tension at the highest in-degree node', () => {
    const out: Insight[] = deriveInsights(
      graphOf(
        [
          { id: 'a', kind: 'driver', label: 'A', track: 'x' },
          { id: 'b', kind: 'stream', label: 'B', track: 'x' },
          { id: 'hub', kind: 'anchor', label: 'Hub', track: 'x' }
        ],
        [
          { source: 'a', target: 'hub', type: 'feeds' },
          { source: 'b', target: 'hub', type: 'builds_toward' }
        ]
      ),
      [],
      0
    )
    const conv = out.find((i) => i.id === 'conv::hub')
    expect(conv).toBeTruthy()
    expect(conv?.type).toBe('tension')
  })

  it('detects a cross-lane coupling node', () => {
    const out: Insight[] = deriveInsights(
      graphOf(
        [
          { id: 'src', kind: 'driver', label: 'Shared driver', track: 'ops' },
          { id: 'p', kind: 'stream', label: 'P', track: 'product' },
          { id: 'g', kind: 'stream', label: 'G', track: 'growth' }
        ],
        [
          { source: 'src', target: 'p', type: 'drives' },
          { source: 'src', target: 'g', type: 'drives' }
        ]
      ),
      [],
      0
    )
    const couple = out.find((i) => i.id === 'couple::src')
    expect(couple).toBeTruthy()
    // tracks are sorted before joining → deterministic headline regardless of edge order.
    expect(couple?.headline).toContain('growth & product')
  })

  it('ranks tensions/risks above patterns/opportunities and caps at 6', () => {
    const out: Insight[] = deriveInsights(
      graphOf(
        [
          { id: 'a', kind: 'driver', label: 'A', track: 'x' },
          { id: 'b', kind: 'stream', label: 'B', track: 'x' },
          { id: 'hub', kind: 'anchor', label: 'Hub', track: 'x' },
          { id: 'lonely', kind: 'driver', label: 'Lonely', track: 'x' }
        ],
        [
          { source: 'a', target: 'hub', type: 'feeds' },
          { source: 'b', target: 'hub', type: 'builds_toward' }
        ]
      ),
      [],
      0
    )
    expect(out.length).toBeLessThanOrEqual(6)
    expect(out[0].type).toBe('tension')
    expect(out.some((i) => i.id === 'orphan::lonely')).toBe(true)
  })
})
