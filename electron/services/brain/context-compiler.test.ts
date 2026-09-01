import { describe, it, expect } from 'vitest'
import { compileContext, tokenize } from './context-compiler'
import type { Citation, GraphView } from './retrieve-agent'

const cit = (note: string, snippet: string, why = 'because'): Citation => ({ note, snippet, why })

// A small graph: two topic clusters.
//  cluster A: a1 — a2 — aRescue   (aRescue is graph-central, uncited)
//  cluster B: b1 — b2
const GRAPH: GraphView = {
  nodes: [
    { id: 'a1.md', label: '风暴模拟器合作', kind: 'note' },
    { id: 'a2.md', label: '渠道策略', kind: 'note' },
    { id: 'aRescue.md', label: '模拟器渠道复盘', kind: 'note' },
    { id: 'b1.md', label: 'B站投放', kind: 'note' },
    { id: 'b2.md', label: '美林展位', kind: 'note' }
  ],
  edges: [
    { source: 'a1.md', target: 'a2.md', type: 'relates' },
    { source: 'a1.md', target: 'aRescue.md', type: 'relates' },
    { source: 'a2.md', target: 'aRescue.md', type: 'relates' },
    { source: 'b1.md', target: 'b2.md', type: 'relates' }
  ]
}
const COMMS = new Map<string, number>([
  ['a1.md', 0],
  ['a2.md', 0],
  ['aRescue.md', 0],
  ['b1.md', 1],
  ['b2.md', 1]
])

describe('tokenize (CJK-aware)', () => {
  it('keeps Latin words and bigrams CJK', () => {
    expect([...tokenize('北澜 TapTap')]).toEqual(['北澜', 'taptap'])
    expect([...tokenize('渠道复盘')]).toEqual(['渠道', '道复', '复盘'])
  })
})

describe('compileContext — degrade paths (never worse than flat)', () => {
  it('empty citations → flat empty sentinel', () => {
    const r = compileContext([], 'q', GRAPH, COMMS)
    expect(r.context).toBe('(no relevant notes found in the local index)')
    expect(r.clusters).toBe(0)
  })

  it('no graph → byte-identical to the legacy flat format', () => {
    const cites = [cit('x.md', 'hello world'), cit('y.md', 'second note')]
    const r = compileContext(cites, 'q', { nodes: [], edges: [] }, COMMS)
    // legacy citationsToContext shape: "[1] (x.md)\nhello world\nwhy: because\n\n[2] ..."
    expect(r.context).toBe('[1] (x.md)\nhello world\nwhy: because\n\n[2] (y.md)\nsecond note\nwhy: because')
    expect(r.clusters).toBe(0)
  })

  it('empty community map → flat fallback', () => {
    const cites = [cit('x.md', 'hello')]
    const r = compileContext(cites, 'q', GRAPH, new Map())
    expect(r.context).toContain('[1] (x.md)')
    expect(r.context).not.toContain('organized by topic')
  })

  it('uses an injected flatFallback when given (live wire passes citationsToContext)', () => {
    const r = compileContext([cit('x.md', 'h')], 'q', null, COMMS, {
      flatFallback: () => 'LEGACY'
    })
    expect(r.context).toBe('LEGACY')
  })
})

describe('compileContext — grouping by community', () => {
  it('renders one labeled cluster per community, larger first', () => {
    const cites = [cit('a1.md', 'sa1'), cit('a2.md', 'sa2'), cit('b1.md', 'sb1')]
    const r = compileContext(cites, 'unrelated', GRAPH, COMMS)
    expect(r.context).toContain('organized by topic:')
    // cluster A has 2 cited notes → comes before cluster B (1 note)
    const idxA = r.context.indexOf('▸')
    const idxB = r.context.indexOf('▸', idxA + 1)
    expect(idxA).toBeGreaterThanOrEqual(0)
    expect(idxB).toBeGreaterThan(idxA)
    expect(r.clusters).toBe(2)
    // header is the highest-degree note's label; a1 has degree 2 in cluster A
    expect(r.context).toContain('▸ 风暴模拟器合作')
  })

  it('a note absent from the community map lands in the "other notes" bucket, last', () => {
    const cites = [cit('a1.md', 'sa1'), cit('orphan.md', 'so')]
    const r = compileContext(cites, 'unrelated', GRAPH, COMMS)
    expect(r.context).toContain('▸ other notes')
    expect(r.context.indexOf('other notes')).toBeGreaterThan(r.context.indexOf('风暴'))
    expect(r.clusters).toBe(1) // 'other' not counted as a topic cluster
  })
})

describe('compileContext — rescue pass', () => {
  it('rescues a graph-central, query-relevant, uncited neighbor', () => {
    // cite a1 + a2; aRescue is their shared neighbor and matches the query "渠道复盘"
    const cites = [cit('a1.md', 'sa1'), cit('a2.md', 'sa2')]
    const r = compileContext(cites, '渠道复盘', GRAPH, COMMS)
    expect(r.rescued).toContain('aRescue.md')
    expect(r.context).toContain('(linked)')
    expect(r.context).toContain('rescued')
  })

  it('does NOT rescue a neighbor that fails the query-relevance gate', () => {
    const cites = [cit('a1.md', 'sa1'), cit('a2.md', 'sa2')]
    // query shares no tokens with aRescue's id/label
    const r = compileContext(cites, 'completely unrelated english', GRAPH, COMMS)
    expect(r.rescued).not.toContain('aRescue.md')
    expect(r.context).not.toContain('(linked)')
  })

  it('caps rescued notes at 2', () => {
    // a star graph: center cited, 4 query-matching uncited neighbors
    const star: GraphView = {
      nodes: [
        { id: 'c.md', label: 'center', kind: 'note' },
        { id: 'n1.md', label: 'alpha topic', kind: 'note' },
        { id: 'n2.md', label: 'alpha topic', kind: 'note' },
        { id: 'n3.md', label: 'alpha topic', kind: 'note' },
        { id: 'n4.md', label: 'alpha topic', kind: 'note' }
      ],
      edges: [1, 2, 3, 4].map((i) => ({ source: 'c.md', target: `n${i}.md`, type: 'r' }))
    }
    const comms = new Map([['c.md', 0], ['n1.md', 0], ['n2.md', 0], ['n3.md', 0], ['n4.md', 0]])
    const r = compileContext([cit('c.md', 's')], 'alpha', star, comms)
    expect(r.rescued.length).toBe(2)
  })

  it('uses snippetFor for a rescued note when provided, else the label', () => {
    const cites = [cit('a1.md', 'sa1'), cit('a2.md', 'sa2')]
    const withResolver = compileContext(cites, '渠道复盘', GRAPH, COMMS, {
      snippetFor: (id) => (id === 'aRescue.md' ? 'FULL RESCUED TEXT' : undefined)
    })
    expect(withResolver.context).toContain('FULL RESCUED TEXT')
    const noResolver = compileContext(cites, '渠道复盘', GRAPH, COMMS)
    expect(noResolver.context).toContain('模拟器渠道复盘') // falls back to the graph label
  })
})

describe('compileContext — dedup', () => {
  it('drops a near-duplicate snippet', () => {
    const cites = [
      cit('a1.md', 'the lightning emulator partnership was terminated on may 14'),
      cit('a2.md', 'lightning emulator partnership terminated may 14'), // ~subset
      cit('b1.md', 'an entirely different note about bilibili spend')
    ]
    const r = compileContext(cites, 'unrelated', GRAPH, COMMS)
    // a2's snippet is covered by a1 → dropped; a1 and b1 remain
    expect(r.context).toContain('the lightning emulator partnership')
    expect(r.context).toContain('bilibili spend')
    const occurrences = (r.context.match(/\(a2\.md\)/g) ?? []).length
    expect(occurrences).toBe(0)
  })
})
