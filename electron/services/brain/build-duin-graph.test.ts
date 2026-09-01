// Parity harness for buildDuinGraph — PROVES the ONE shared builder reproduces the
// construction-merge of the triplicated impls, plus the new product-canonicalization
// capability. Post B-2 the three impls now DELEGATE to buildDuinGraph:
//
//   dedup:'directed'   == applyConstruction()   (construct.ts)   → /graph render
//                         (now a buildDuinGraph wrapper; substance compared)
//   dedup:'undirected' == overlayConstruction()  — DELETED in B-2; asserted vs the
//                         inline golden it used to produce                → home MAP
//   dedup:'none'       == liveGraph()  (retrieve-agent.ts)               → retrieval
//                         (now a buildDuinGraph wrapper; exact parity)
//
// PARITY BOUNDARY. buildDuinGraph owns the shared SUBSTANCE (entity-node dedup,
// relation→type mapping, self/dangling drop, per-mode edge dedup, product inclusion).
// It does NOT own each caller's DECORATIONS, which B-2 re-applies:
//   - applyConstruction: edge `confidence: 0.6`, note-node `classification` stamping,
//     and note→`track` derivation on entity nodes;
//   - so the DIRECTED test compares node {id,kind,label} + edge {source,target,type}
//     (the merge substance), while the UNDIRECTED and NONE tests — whose node/edge
//     shapes buildDuinGraph reproduces exactly — assert full structural equality.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// deriveGraph + getConstruction are mocked ONLY so liveGraph() is driveable; the
// construct mock spreads the REAL module (applyConstruction, RELATION_TO_EDGE stay real).
vi.mock('../local-brain/graph-derive', () => ({
  deriveGraph: vi.fn(() => ({ nodes: [], edges: [] }))
}))
vi.mock('./construct', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./construct')>()
  return { ...actual, getResolvedConstruction: vi.fn() }
})
// retrieve-agent imports these at runtime; stubbed for a light, deterministic import.
vi.mock('./graph-native', () => ({ readGraphNative: vi.fn() }))
vi.mock('../settings-helper', () => ({ readSettings: vi.fn(() => ({ localBrainNotesDir: '' })) }))

import { buildDuinGraph, topicFloorEnabled, mergeKey, mergeMechanicalDuplicates, linkSubtopicsToParents } from './build-duin-graph'
import { applyConstruction } from './construct'
import { liveGraph } from './retrieve-agent'
import { deriveGraph } from '../local-brain/graph-derive'
import { getResolvedConstruction } from './construct'
import type { CausalGraph } from './types'
import type { ConstructedData } from './types'
import type { GraphReadResult } from './graph-native'

// ── shared construction fixture (same entities/edges across all three modes) ──
// person:jordan → note-a (lands), person:jordan → topic:retrieval (lands),
// a DUPLICATE of a base edge (dedup differs per mode), a self edge (dropped),
// a dangling edge (dropped), and an entity whose id COLLIDES with a base node
// (base/native wins — never clobbered).
const construction: ConstructedData = {
  entities: [
    { id: 'person:jordan', kind: 'person', label: 'Jordan', note: 'A/foo.md' },
    { id: 'topic:retrieval', kind: 'topic', label: 'Retrieval', note: 'B/bar.md' },
    { id: 'COLLIDE', kind: 'topic', label: 'CLOBBER', note: 'A/foo.md' }
  ],
  edges: [
    { source: 'person:jordan', target: 'A/foo.md', type: 'mentions' },
    { source: 'person:jordan', target: 'topic:retrieval', type: 'about' },
    { source: 'A/foo.md', target: 'B/bar.md', type: 'mentions' }, // dup of the base edge
    { source: 'topic:retrieval', target: 'topic:retrieval', type: 'about' }, // self
    { source: 'person:jordan', target: 'ghost:missing', type: 'owns' } // dangling
  ],
  classifications: []
}

const pickNode = (n: { id?: unknown; kind?: unknown; label?: unknown }): unknown => ({
  id: n.id,
  kind: n.kind,
  label: n.label
})
const pickEdge = (e: { source?: unknown; target?: unknown; type?: unknown }): unknown => ({
  source: e.source,
  target: e.target,
  type: e.type
})
const sortKey = (o: { id?: unknown; source?: unknown; target?: unknown; type?: unknown }): string =>
  o.id !== undefined ? String(o.id) : `${String(o.source)}|${String(o.target)}|${String(o.type)}`
const projSort = <T extends { id?: unknown; source?: unknown; target?: unknown; type?: unknown }>(
  arr: T[]
): T[] => [...arr].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))

describe('buildDuinGraph — parity with the three triplicated impls', () => {
  beforeEach(() => {
    vi.mocked(getResolvedConstruction).mockReset()
    delete process.env.DUIN_RETRIEVAL_PRODUCT_OVERLAY
  })
  afterEach(() => {
    delete process.env.DUIN_RETRIEVAL_PRODUCT_OVERLAY
  })

  // 1) DIRECTED == applyConstruction() — directed-triple (src|target|type) edge dedup.
  it("dedup:'directed' reproduces applyConstruction (substance: nodes + edges)", () => {
    const base: CausalGraph = {
      nodes: [
        { id: 'A/foo.md', kind: 'page', label: 'Foo' },
        { id: 'B/bar.md', kind: 'page', label: 'Bar' },
        { id: 'COLLIDE', kind: 'person', label: 'NativeWins' }
      ],
      edges: [{ source: 'A/foo.md', target: 'B/bar.md', type: 'mentions' }]
    }

    const real = applyConstruction(base, construction)
    const built = buildDuinGraph({ base, construction, dedup: 'directed' })

    // Same node set (id/kind/label) — the COLLIDE entity did NOT clobber the native node.
    expect(projSort(built.nodes.map(pickNode) as never[])).toEqual(
      projSort(real.nodes.map(pickNode) as never[])
    )
    // Same edge set (source/target/type) — the base-duplicate, self, and dangling edges dropped.
    expect(projSort(built.edges.map(pickEdge) as never[])).toEqual(
      projSort(real.edges.map(pickEdge) as never[])
    )
    // Native-wins is observable: the COLLIDE node keeps the base label.
    expect(built.nodes.find((n) => n.id === 'COLLIDE')?.label).toBe('NativeWins')
    // identity-spine ②: now 4 edges = 1 base + 2 entity→note spine edges (person:jordan→
    // A/foo.md, topic:retrieval→B/bar.md) + 1 landed construction edge (jordan→retrieval
    // about). The LLM's own jordan→A/foo.md `mentions` edge dedups against the spine edge
    // (directed key collision), and the base-triple dup / self / dangling still drop.
    expect(built.edges).toHaveLength(4)
    expect(real.edges).toHaveLength(4)
  })

  // 2) UNDIRECTED == overlayConstruction() — one typed edge per unordered pair, `layer` tag.
  it("dedup:'undirected' + productLayer reproduces overlayConstruction (exact)", () => {
    const graph = {
      nodes: [
        { id: 'A/foo.md', kind: 'note', label: 'Foo', layer: 'product' },
        { id: 'B/bar.md', kind: 'note', label: 'Bar', layer: 'product' },
        { id: 'COLLIDE', kind: 'project', label: 'NativeWins', layer: 'product' }
      ] as Record<string, unknown>[],
      links: [{ source: 'A/foo.md', target: 'B/bar.md', type: 'link' }],
      core: 'A/foo.md',
      stats: { nodes: 3, edges: 1 }
    }
    // Reverse-orientation duplicate of the base pair → undirected dedup must drop it.
    const undirCons: ConstructedData = {
      ...construction,
      edges: [
        { source: 'person:jordan', target: 'A/foo.md', type: 'mentions' },
        { source: 'person:jordan', target: 'topic:retrieval', type: 'about' },
        { source: 'B/bar.md', target: 'A/foo.md', type: 'about' }, // reversed dup of base pair
        { source: 'topic:retrieval', target: 'topic:retrieval', type: 'about' }, // self
        { source: 'person:jordan', target: 'ghost:missing', type: 'owns' } // dangling
      ]
    }

    const built = buildDuinGraph({
      base: { nodes: graph.nodes, edges: graph.links },
      construction: undirCons,
      dedup: 'undirected',
      productLayer: 'construction'
    })

    // B-2 contract migration: overlayConstruction() was DELETED (its logic folded into
    // buildDuinGraph), so we assert against the INLINE golden it used to produce — the
    // same node/edge shape (base nodes preserved + entity nodes {layer:'construction',
    // group:kind}; base link kept, reversed-pair/self/dangling construction edges dropped).
    expect(built.nodes).toEqual([
      { id: 'A/foo.md', kind: 'note', label: 'Foo', layer: 'product' },
      { id: 'B/bar.md', kind: 'note', label: 'Bar', layer: 'product' },
      { id: 'COLLIDE', kind: 'project', label: 'NativeWins', layer: 'product' },
      { id: 'person:jordan', kind: 'person', label: 'Jordan', layer: 'construction', group: 'person' },
      { id: 'topic:retrieval', kind: 'topic', label: 'Retrieval', layer: 'construction', group: 'topic' }
    ])
    // identity-spine ②: the two entity→note spine edges (person:jordan→A/foo.md,
    // topic:retrieval→B/bar.md) are now emitted. The LLM's own jordan→A/foo.md `mentions`
    // dedups against the spine edge (same undirected pair); the reversed base pair / self /
    // dangling still drop.
    expect(built.edges).toEqual([
      { source: 'A/foo.md', target: 'B/bar.md', type: 'link' },
      { source: 'person:jordan', target: 'A/foo.md', type: 'mentions' },
      { source: 'topic:retrieval', target: 'B/bar.md', type: 'mentions' },
      { source: 'person:jordan', target: 'topic:retrieval', type: 'about' }
    ])
    // Spot-check the load-bearing bits the plan calls out:
    expect(built.nodes.find((n) => n.id === 'person:jordan')).toMatchObject({
      kind: 'person',
      layer: 'construction',
      group: 'person'
    })
    expect(built.nodes.find((n) => n.id === 'COLLIDE')).toMatchObject({ kind: 'project' }) // native wins
    expect(built.nodes).toHaveLength(5) // 3 base + 2 entities (COLLIDE deduped)
    expect(built.edges).toHaveLength(4) // 1 base + 2 spine + 1 landed (reversed-pair/self/dangling dropped)
  })

  // 3) NONE == liveGraph() inline merge — entity nodes appended, NO edge dedup.
  it("dedup:'none' reproduces liveGraph's inline merge (exact)", () => {
    const base = {
      nodes: [
        { id: 'A/foo.md', label: 'Foo', kind: 'note' },
        { id: 'B/bar.md', label: 'Bar', kind: 'note' },
        { id: 'COLLIDE', label: 'NativeWins', kind: 'person' }
      ],
      edges: [{ source: 'A/foo.md', target: 'B/bar.md', type: 'mentions' }]
    }
    vi.mocked(deriveGraph).mockReturnValue(base as never)
    vi.mocked(getResolvedConstruction).mockReturnValue(construction)

    const real = liveGraph() // product overlay OFF (flag unset) → base ⊕ construction only
    const built = buildDuinGraph({ base, construction, dedup: 'none' })

    // Exact structural parity — same nodes, same edges, same order.
    expect(built.nodes).toEqual(real.nodes)
    expect(built.edges).toEqual(real.edges)
    // identity-spine ②: 6 edges = 1 base + 2 entity→note spine edges + 3 landed construction
    // edges. In 'none' mode there is NO dedup, so the LLM's jordan→A/foo.md `mentions` edge
    // survives ALONGSIDE the identical spine edge (a benign duplicate — 'none' mode's
    // documented contract already keeps the base-duplicate edge too).
    expect(built.edges).toHaveLength(6)
    expect(real.edges).toHaveLength(6)
    // Entity nodes carry `note` (retrieval snippet source), NOT a `layer` tag.
    expect(built.nodes.find((n) => n.id === 'person:jordan')).toEqual({
      id: 'person:jordan',
      kind: 'person',
      label: 'Jordan',
      note: 'A/foo.md'
    })
    expect(built.nodes.find((n) => n.id === 'COLLIDE')?.label).toBe('NativeWins') // native wins
  })

  // 4) PRODUCT + canonicalizeProduct — the NEW capability: the previously-inert
  //    retrieval overlay now actually merges the store onto the note/entity graph.
  it('product + canonicalizeProduct:true merges vault:/ onto the note, kind-prefixes bare cascade, drops dangling', () => {
    const base = {
      nodes: [{ id: 'ARGOSY/Noah Kell.md', kind: 'note', label: 'Noah Kell' }],
      edges: [] as Record<string, unknown>[]
    }
    const product: GraphReadResult = {
      nodes: [
        { id: 'vault:/ARGOSY/Noah Kell.md', kind: 'person', title: 'Noah Kell (person)' },
        { id: '221c135f', kind: 'move', title: 'Ship it' },
        { id: 'ARGOSY', kind: 'project', title: 'Argosy Project' }
      ],
      edges: [
        { src: '221c135f', dst: '04 Notes', type: 'contains' }, // 04 Notes unmapped → dangling drop
        { src: 'vault:/ARGOSY/Noah Kell.md', dst: '221c135f', type: 'about' } // both map → lands
      ],
      by_kind: {},
      by_edge: {},
      node_count: 3,
      edge_count: 2
    }

    const built = buildDuinGraph({ base, construction: null, product, dedup: 'none', canonicalizeProduct: true })

    // The vault:/ person MERGED onto the base note (count unchanged for it, kind updated).
    expect(built.nodes.some((n) => n.id === 'vault:/ARGOSY/Noah Kell.md')).toBe(false)
    const note = built.nodes.find((n) => n.id === 'ARGOSY/Noah Kell.md')
    expect(note).toMatchObject({ kind: 'person', label: 'Noah Kell (person)' })
    // Bare move id kind-prefixed → move:<hash>; bare project → folder:<name>.
    expect(built.nodes.some((n) => n.id === 'move:221c135f')).toBe(true)
    expect(built.nodes.some((n) => n.id === 'folder:ARGOSY')).toBe(true)
    // 3 nodes total: the merged note + move + folder (person added NO new node).
    expect(built.nodes).toHaveLength(3)
    // The dangling edge to unmapped '04 Notes' dropped; the about edge landed on canonical ids.
    expect(built.edges).toEqual([
      { source: 'ARGOSY/Noah Kell.md', target: 'move:221c135f', type: 'about' }
    ])
  })

  // 4b) Control: WITHOUT canonicalizeProduct the same product ISLANDS (proves canonicalize
  //     is what turns the inert overlay into a real merge).
  it('product + canonicalizeProduct:false leaves the vault:/ node islanded (bare id space)', () => {
    const base = {
      nodes: [{ id: 'ARGOSY/Noah Kell.md', kind: 'note', label: 'Noah Kell' }],
      edges: [] as Record<string, unknown>[]
    }
    const product: GraphReadResult = {
      nodes: [{ id: 'vault:/ARGOSY/Noah Kell.md', kind: 'person', title: 'Noah Kell (person)' }],
      edges: [],
      by_kind: {},
      by_edge: {},
      node_count: 1,
      edge_count: 0
    }
    const built = buildDuinGraph({ base, construction: null, product, dedup: 'none' })
    // Bare id kept → separate island node, base note untouched.
    expect(built.nodes).toHaveLength(2)
    expect(built.nodes.some((n) => n.id === 'vault:/ARGOSY/Noah Kell.md')).toBe(true)
    expect(built.nodes.find((n) => n.id === 'ARGOSY/Noah Kell.md')?.kind).toBe('note')
  })
})

describe('topic floor — a topic earns a node by carrying structure', () => {
  const t = (id: string) => ({ id, kind: 'topic', label: id })
  const note = (id: string) => ({ id, kind: 'note' })
  const build = (nodes: any[], edges: any[], on = true) =>
    buildDuinGraph({ base: { nodes, edges }, dedup: 'undirected', pruneUnstructuredTopics: on })
  const ids = (g: { nodes: Record<string, unknown>[] }) => g.nodes.map((n) => String(n.id)).sort()

  it('drops a topic that relates to nothing and lives in one note', () => {
    // The live shape: a design doc's glossary terms — one note, one `mentions` edge, nothing else.
    const g = build([t('术语'), note('a.md')], [{ source: '术语', target: 'a.md', type: 'mentions' }])
    expect(ids(g)).toEqual(['a.md'])
    expect(g.edges).toHaveLength(0) // its dangling edge goes with it
  })

  it('keeps a topic with THREE real relations, even from a single note', () => {
    const g = build(
      [t('hub-concept'), t('other'), t('third'), t('fourth'), note('a.md')],
      [{ source: 'hub-concept', target: 'other', type: 'depends' }, { source: 'hub-concept', target: 'third', type: 'affects' },
       { source: 'hub-concept', target: 'fourth', type: 'owns' }, { source: 'hub-concept', target: 'a.md', type: 'mentions' }]
    )
    expect(ids(g)).toContain('hub-concept')
  })


  it('TWO relations is no longer enough — the floor is a junction, not a link', () => {
    const g = build(
      [t('leaf'), t('other'), t('third'), note('a.md')],
      [{ source: 'leaf', target: 'other', type: 'depends' }, { source: 'leaf', target: 'third', type: 'affects' },
       { source: 'leaf', target: 'a.md', type: 'mentions' }]
    )
    expect(ids(g)).not.toContain('leaf')
  })

  it('keeps a topic that RECURS across notes even with no relation', () => {
    const g = build(
      [t('recurring-term'), note('a.md'), note('b.md')],
      [{ source: 'recurring-term', target: 'a.md', type: 'mentions' }, { source: 'recurring-term', target: 'b.md', type: 'mentions' }]
    )
    expect(ids(g)).toContain('recurring-term')
  })

  it('a `synonym` edge is bookkeeping, not structure — it cannot save a topic', () => {
    // 6,011 live synonym edges, 48% of them cross-kind; they must not confer relevance.
    const g = build(
      [t('x'), t('y'), note('a.md')],
      [{ source: 'x', target: 'y', type: 'synonym' }, { source: 'x', target: 'a.md', type: 'mentions' }]
    )
    expect(ids(g)).not.toContain('x')
  })

  it('the floor reaches org/person too, but at ONE relation rather than three', () => {
    // Operator-chosen (option 4). An unrelated org/person is dropped, but a SINGLE relation keeps
    // it — unlike a topic, which needs three — because those are usually real things the extractor
    // simply failed to relate, not glossary.
    const g = build(
      [{ id: 'lonely', kind: 'org', label: 'Lonely Co' }, { id: 'linked', kind: 'org', label: 'Linked Co' },
       { id: 'peer', kind: 'org', label: 'Peer Co' }, note('a.md')],
      [{ source: 'linked', target: 'peer', type: 'partners' }, { source: 'lonely', target: 'a.md', type: 'mentions' }]
    )
    expect(ids(g)).not.toContain('lonely')
    expect(ids(g)).toContain('linked')
  })

  it('DUIN_GRAPH_ENTITY_FLOOR=0 keeps the topic floor but spares org/person', () => {
    const prev = process.env.DUIN_GRAPH_ENTITY_FLOOR
    process.env.DUIN_GRAPH_ENTITY_FLOOR = '0'
    try {
      const g = build([{ id: 'lonely', kind: 'org', label: 'Lonely Co' }, t('z'), note('a.md')],
        [{ source: 'z', target: 'a.md', type: 'mentions' }])
      expect(ids(g)).toContain('lonely')
      expect(ids(g)).not.toContain('z') // the topic floor still applies
    } finally {
      if (prev === undefined) delete process.env.DUIN_GRAPH_ENTITY_FLOOR
      else process.env.DUIN_GRAPH_ENTITY_FLOOR = prev
    }
  })

  it('a file-backed node is never floored, however unconnected', () => {
    const g = build([note('orphan.md')], [])
    expect(ids(g)).toEqual(['orphan.md'])
  })

  it('is OPT-IN: a caller that does not ask keeps every node (retrieval + /graph parity)', () => {
    const g = build([t('术语'), note('a.md')], [{ source: '术语', target: 'a.md', type: 'mentions' }], false)
    expect(ids(g)).toEqual(['a.md', '术语'])
  })

  it('DUIN_GRAPH_TOPIC_FLOOR=0 restores the prior graph exactly', () => {
    const prev = process.env.DUIN_GRAPH_TOPIC_FLOOR
    process.env.DUIN_GRAPH_TOPIC_FLOOR = '0'
    try {
      expect(topicFloorEnabled()).toBe(false)
      const g = build([t('术语'), note('a.md')], [{ source: '术语', target: 'a.md', type: 'mentions' }])
      expect(ids(g)).toEqual(['a.md', '术语'])
    } finally {
      if (prev === undefined) delete process.env.DUIN_GRAPH_TOPIC_FLOOR
      else process.env.DUIN_GRAPH_TOPIC_FLOOR = prev
    }
  })
})


describe('mechanical duplicate fold', () => {
  const n = (id: string, kind: string, label: string) => ({ id, kind, label })

  it('the merge key strips an echoed id prefix, a gloss, and folds traditional to simplified', () => {
    expect(mergeKey('project:duin')).toBe(mergeKey('DUIN'))
    expect(mergeKey('北澜 (Beilan)')).toBe(mergeKey('北澜'))
    expect(mergeKey('中村匡慶')).toBe(mergeKey('中村匡庆'))          // 慶 -> 庆
    expect(mergeKey('中村匡慶 (Hiroki)')).toBe(mergeKey('中村匡庆'))
    expect(mergeKey('Alpha')).not.toBe(mergeKey('Beta'))
  })

  it('folds the variants onto one node and rewires its edges', () => {
    const g = mergeMechanicalDuplicates({
      nodes: [n('a', 'person', '中村匡慶'), n('b', 'person', '中村匡庆'), n('c', 'org', 'Acme')],
      edges: [{ source: 'a', target: 'c', type: 'works-at' }, { source: 'b', target: 'c', type: 'works-at' }]
    })
    expect(g.nodes).toHaveLength(2)
    expect(g.edges).toHaveLength(1) // the rewired duplicate edge collapses, degree is not inflated
  })

  it('a real name beats an id echoed as a label', () => {
    const g = mergeMechanicalDuplicates({ nodes: [n('x', 'topic', 'topic:duin'), n('y', 'project', 'DUIN')], edges: [] })
    expect(g.nodes.map((z) => z.label)).toEqual(['DUIN'])
  })

  it('NEVER folds a file-backed node — a document is identified by its path', () => {
    const g = mergeMechanicalDuplicates({
      nodes: [n('People/王鑫.md', 'person', '王鑫'), n('person:wang-xin', 'person', '王鑫')],
      edges: []
    })
    expect(g.nodes).toHaveLength(2)
  })

  it('a fold that would create a self-loop drops the edge instead', () => {
    const g = mergeMechanicalDuplicates({
      nodes: [n('a', 'person', 'Xylo'), n('b', 'person', 'xylo')],
      edges: [{ source: 'a', target: 'b', type: 'related' }]
    })
    expect(g.nodes).toHaveLength(1)
    expect(g.edges).toHaveLength(0)
  })
})

describe('sub-topic parent edges', () => {
  const n = (id: string, kind: string, label: string) => ({ id, kind, label })
  const hub = (id: string, label: string) => n(id, 'topic', label)
  // a parent must already be a hub, so give it two real relations
  const hubEdges = (pid: string) => [
    { source: pid, target: 'h1', type: 'depends' }, { source: pid, target: 'h2', type: 'affects' }
  ]

  it('links "<Parent> <qualifier>" to its parent', () => {
    const g = linkSubtopicsToParents({
      nodes: [hub('p', 'Claude'), hub('c', 'Claude Code'), hub('h1', 'h1'), hub('h2', 'h2')],
      edges: hubEdges('p')
    })
    expect(g.edges).toContainEqual({ source: 'c', target: 'p', type: 'part-of' })
  })

  it('refuses a parent that is not already a hub — a shared prefix is not a hierarchy', () => {
    const g = linkSubtopicsToParents({ nodes: [hub('p', 'Build'), hub('c', 'Build it now')], edges: [] })
    expect(g.edges).toHaveLength(0)
  })

  it('a STATEMENT kind is never a sub-topic (this is what "Build" adopting 21 decisions was)', () => {
    const g = linkSubtopicsToParents({
      nodes: [hub('p', 'Build'), n('c', 'decision', 'Build wxvault CLI'), hub('h1', 'h1'), hub('h2', 'h2')],
      edges: hubEdges('p')
    })
    expect(g.edges.filter((e) => e.type === 'part-of')).toHaveLength(0)
  })

  it('does not duplicate a parent link that already exists', () => {
    const g = linkSubtopicsToParents({
      nodes: [hub('p', 'Claude'), hub('c', 'Claude Code'), hub('h1', 'h1'), hub('h2', 'h2')],
      edges: [...hubEdges('p'), { source: 'c', target: 'p', type: 'depends' }]
    })
    expect(g.edges.filter((e) => e.type === 'part-of')).toHaveLength(0)
  })

  it('needs a real separator — "Claudex" is not a child of "Claude"', () => {
    const g = linkSubtopicsToParents({
      nodes: [hub('p', 'Claude'), hub('c', 'Claudex'), hub('h1', 'h1'), hub('h2', 'h2')],
      edges: hubEdges('p')
    })
    expect(g.edges.filter((e) => e.type === 'part-of')).toHaveLength(0)
  })
})
