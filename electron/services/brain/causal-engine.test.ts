import { describe, it, expect } from 'vitest'
import { causalGraph, propagate } from './causal-engine'
import type { Store } from './store'
import type { CausalNode, CausalEdge } from './types'

// A hand-built Store for precise behavior assertions (independent of the demo
// fixture). Mirrors the structure DUIN's causal_graph()/propagate() expect.
function makeStore(nodes: CausalNode[], edges: CausalEdge[], today = '2026-01-01'): Store {
  return {
    causalNodes: () => nodes.map((n) => ({ ...n })),
    causalEdges: () => edges.map((e) => ({ ...e })),
    today: () => today
  }
}

describe('causalGraph', () => {
  it('decorates in_degree and converges (in_degree >= 2)', () => {
    const store = makeStore(
      [
        { id: 'a', kind: 'driver', label: 'A' },
        { id: 'b', kind: 'stream', label: 'B' },
        { id: 'c', kind: 'anchor', label: 'C' }
      ],
      [
        { source: 'a', target: 'c', type: 'feeds' },
        { source: 'b', target: 'c', type: 'builds_toward' }
      ]
    )
    const g = causalGraph(store)
    const c = g.nodes.find((n) => n.id === 'c')!
    expect(c.in_degree).toBe(2)
    expect(c.converges).toBe(true)
    expect(g.nodes.find((n) => n.id === 'a')!.converges).toBe(false)
    expect(g.stats?.converge_nodes).toBe(1)
  })

  it('narrows to an anchor upstream funnel when anchorId is given', () => {
    const store = makeStore(
      [
        { id: 'a', kind: 'driver', label: 'A' },
        { id: 'b', kind: 'stream', label: 'B' },
        { id: 'anchor:x', kind: 'anchor', label: 'X' },
        { id: 'unrelated', kind: 'stream', label: 'U' }
      ],
      [
        { source: 'a', target: 'b', type: 'drives' },
        { source: 'b', target: 'anchor:x', type: 'builds_toward' }
      ]
    )
    const g = causalGraph(store, 'anchor:x')
    const ids = g.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['a', 'anchor:x', 'b'])
    expect(g.nodes.some((n) => n.id === 'unrelated')).toBe(false)
  })
})

describe('propagate', () => {
  const store = makeStore(
    [
      { id: 'a', kind: 'driver', label: 'A' },
      { id: 'b', kind: 'stream', label: 'B' },
      { id: 'c', kind: 'anchor', label: 'C' },
      { id: 'g', kind: 'gate', label: 'Gate', fork: { cleared: 'go', blocked: 'stop' } },
      { id: 'oc', kind: 'outcome', label: 'Cleared path' },
      { id: 'ob', kind: 'risk', label: 'Blocked path' },
      { id: 'slow', kind: 'gate', label: 'Overdue', slack: -4 }
    ],
    [
      { source: 'a', target: 'b', type: 'drives', lag_days: 5 },
      { source: 'b', target: 'c', type: 'builds_toward', lag_days: 10 },
      { source: 'a', target: 'c', type: 'feeds', lag_days: 3 },
      { source: 'g', target: 'oc', type: 'if_cleared', branch: true },
      { source: 'g', target: 'ob', type: 'if_blocked', branch: true },
      { source: 'slow', target: 'b', type: 'enables' }
    ]
  )

  it('flows a slip downstream along FLOW edges (max-wins per node)', () => {
    const r = propagate(store, 'a', 7)
    const byId = new Map(r.affected.map((x) => [x.id, x]))
    expect(byId.get('b')?.shift_days).toBe(7)
    expect(byId.get('c')?.shift_days).toBe(7) // reached via a→b→c and a→c; max-wins
    expect(r.origin).toBe('a')
    expect(r.count).toBe(2)
  })

  it('activates the chosen fork branch and prunes the other', () => {
    const r = propagate(store, 'g', 0, 'cleared')
    const byId = new Map(r.affected.map((x) => [x.id, x]))
    expect(byId.get('oc')?.branch).toBe('activated')
    expect(byId.get('ob')?.branch).toBe('pruned')
  })

  it('clamps a negative slip to zero (no spurious +0d affected nodes)', () => {
    const r = propagate(store, 'a', -5)
    expect(r.shift_days).toBe(0)
    expect(r.count).toBe(0)
  })

  it('clamps an absurd slip to the 3650-day bound', () => {
    const r = propagate(store, 'a', 99999)
    expect(r.shift_days).toBe(3650)
    expect(r.affected.every((x) => (x.shift_days ?? 0) <= 3650)).toBe(true)
  })

  it('propagates current slippage from negative-slack nodes when no origin given', () => {
    const r = propagate(store)
    expect(r.origin).toBe('live-slippage')
    const byId = new Map(r.affected.map((x) => [x.id, x]))
    expect(byId.get('b')?.shift_days).toBe(4) // slow(slack -4) → b → c
    expect(byId.get('c')?.shift_days).toBe(4)
  })
})
