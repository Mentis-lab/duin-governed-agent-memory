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

import { buildDuinGraph, topicFloorEnabled, mergeKey, mergeMechanicalDuplicates, linkSubtopicsToParents, isStructuralNode, eventBase, foldEventFamilies, dropUnanchoredEntities, spansCompatible } from './build-duin-graph'
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

  it('a synonym edge to a document is never provenance for the floor', () => {
    const g = build(
      [t('alias'), note('a.md'), note('b.md')],
      [{ source: 'alias', target: 'a.md', type: 'mentions' }, { source: 'alias', target: 'b.md', type: 'synonym' }]
    )
    expect(ids(g)).toEqual(['a.md', 'b.md']) // one real note, one alias edge: not "recurs across documents"
  })

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

  it('a document WINS its own name: the extracted entity folds INTO the note, the note is never folded', () => {
    const g = mergeMechanicalDuplicates({
      nodes: [n('People/王鑫.md', 'person', '王鑫'), n('person:wang-xin', 'person', '王鑫'), n('c', 'org', 'Acme')],
      edges: [{ source: 'person:wang-xin', target: 'c', type: 'works-at' }]
    })
    expect(g.nodes.map((z) => z.id).sort()).toEqual(['People/王鑫.md', 'c'])
    expect(g.edges).toEqual([{ source: 'People/王鑫.md', target: 'c', type: 'works-at' }]) // rewired onto the note
  })

  it('absorbing an entity into a document keeps its hard relations and drops its co-mention bookkeeping', () => {
    // topic:duin (a hub) folds into DUIN.md. Its `affects` relation follows; its entity↔entity
    // `mentions`/`synonym` edges do NOT become entity→note "provenance" for the floor to count.
    const g = mergeMechanicalDuplicates({
      nodes: [n('DUIN.md', 'note', 'DUIN'), n('topic:duin', 'topic', 'DUIN'), n('topic:x', 'topic', 'X'), n('topic:y', 'topic', 'Y')],
      edges: [
        { source: 'topic:x', target: 'topic:duin', type: 'mentions' },
        { source: 'topic:y', target: 'topic:duin', type: 'synonym' },
        { source: 'topic:y', target: 'topic:duin', type: 'affects' },
        { source: 'topic:x', target: 'Other.md', type: 'mentions' }
      ]
    })
    expect(g.nodes.map((z) => z.id).sort()).toEqual(['DUIN.md', 'topic:x', 'topic:y'])
    expect(g.edges).toEqual([
      { source: 'topic:y', target: 'DUIN.md', type: 'affects' },
      { source: 'topic:x', target: 'Other.md', type: 'mentions' }
    ])
  })

  it('two documents with one title stay two documents', () => {
    const g = mergeMechanicalDuplicates({
      nodes: [n('A/王鑫.md', 'note', '王鑫'), n('B/王鑫.md', 'note', '王鑫')],
      edges: []
    })
    expect(g.nodes).toHaveLength(2)
  })

  it('the key ignores punctuation, spacing and width, and still keeps different names apart', () => {
    expect(mergeKey('Bilibili World 2026')).toBe(mergeKey('BilibiliWorld 2026'))
    expect(mergeKey('上海差旅 2026-05-18')).toBe(mergeKey('上海差旅2026-05-18'))
    expect(mergeKey('风信 AI 工业智能体平台（MES 2.0）')).toBe(mergeKey('风信 AI 工业智能体平台 (MES 2.0)'))
    expect(mergeKey('方案一：定向增发回购')).toBe(mergeKey('方案一·定向增发回购'))
    expect(mergeKey('ENACT_ENABLED = False')).toBe(mergeKey('ENACT_ENABLED=False'))
    expect(mergeKey('上海差旅 2026-05-18')).not.toBe(mergeKey('上海差旅 2026-07-07'))
    expect(mergeKey('云雀')).not.toBe(mergeKey('云雀 2.0'))
  })

  it('NEVER folds the skeleton: the core and a folder hub survive a same-label entity', () => {
    // The live failure (2026-09-02): "DUIN core" the core vs "DUIN core" the extracted topic, and
    // "DUIN" the folder vs "DUIN" the extracted person. KIND_RANK ranks person/topic above the
    // unlisted core/folder kinds, so the skeleton lost and the map had no centre and no legend.
    const g = mergeMechanicalDuplicates({
      nodes: [
        { id: '__core__', kind: 'core', label: 'DUIN core', layer: 'core' },
        n('topic:duin-core', 'topic', 'DUIN core'),
        { id: '__folder__DUIN', kind: 'folder', label: 'DUIN', layer: 'folder' },
        n('person:duin', 'person', 'DUIN'),
        { id: '__projidx__DUIN__Docs', kind: 'index', label: 'Docs' },
        n('topic:docs', 'topic', 'Docs')
      ],
      edges: [
        { source: '__core__', target: '__folder__DUIN', type: 'anchors' },
        { source: 'person:duin', target: 'topic:duin-core', type: 'about' }
      ]
    })
    expect(g.nodes.map((z) => z.id).sort()).toEqual(
      ['__core__', '__folder__DUIN', '__projidx__DUIN__Docs', 'person:duin', 'topic:docs', 'topic:duin-core']
    )
    expect(g.edges).toHaveLength(2) // nothing rewired: the core still anchors its folder
    expect(isStructuralNode({ id: '__core__' })).toBe(true)
    expect(isStructuralNode({ id: 'x', kind: 'folder' })).toBe(true)
    expect(isStructuralNode({ id: 'x', layer: 'folder' })).toBe(true)
    expect(isStructuralNode({ id: 'person:duin', kind: 'person' })).toBe(false)
  })

  it('a product-store node WINS its fold, whatever kind the mention was extracted as', () => {
    // Before: person (KIND_RANK 0) beat project (2), so the declared project folded into a
    // stray extracted person and the roadmap lost a node.
    const g = mergeMechanicalDuplicates({
      nodes: [
        { id: 'proj-1', kind: 'project', label: 'DUIN', layer: 'product' },
        n('person:duin', 'person', 'DUIN'),
        n('c', 'org', 'Acme')
      ],
      edges: [{ source: 'person:duin', target: 'c', type: 'owns' }]
    })
    expect(g.nodes.map((z) => z.id)).toEqual(['proj-1', 'c'])
    expect(g.edges).toEqual([{ source: 'proj-1', target: 'c', type: 'owns' }])
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

describe('event families — one weekend, one node', () => {
  const n = (id: string, label: string, kind = 'event') => ({ id, kind, label })

  it('reads the base and the date off an event label', () => {
    expect(eventBase('春分试玩会 2026-06-19')).toMatchObject({ base: '春分试玩会', year: '2026', monthDay: '6-19' })
    expect(eventBase('2026春分试玩会').base).toBe('春分试玩会')
    expect(eventBase('春分试玩会 2026-06-19/20').span).toEqual([170, 171])
    expect(eventBase('试玩会 6/19-20')).toMatchObject({ base: '试玩会', monthDay: '6-19' })
    expect(eventBase('8月二测')).toMatchObject({ base: '二测', year: null })
    expect(eventBase('《云雀》春分试玩会 × 蓝湾专项').base).toBe('春分试玩会') // a leading 《project》 is a qualifier
    expect(eventBase('Bilibili World 2026')).toMatchObject({ base: 'bilibiliworld', year: '2026', span: null })
  })

  it('overlapping day spans are one occasion; distant days are not', () => {
    expect(spansCompatible([[170, 172], [170, 171], [171, 171]])).toBe(true) // 6/19-21, 6/19/20, 6/20
    expect(spansCompatible([[170, 170], [171, 171]])).toBe(true) // one day of slack
    expect(spansCompatible([[138, 138], [188, 188]])).toBe(false) // 5/18 vs 7/07
    const g = foldEventFamilies({
      nodes: [n('a', '春分试玩会 6/19-21'), n('b', '春分试玩会 2026-06-19/20'), n('c', '春分试玩会 6/20'), n('d', '《云雀》春分试玩会'), n('e', '春分试玩会筹备')],
      edges: [{ source: 'a', target: 'b', type: 'depends' }]
    })
    expect(g.nodes.map((z) => z.id).sort()).toEqual(['b', 'e']) // one weekend (the dated, most specific name wins the tie) + the preparation, which is another thing
  })

  it('folds date-compatible variants onto the most connected member', () => {
    const g = foldEventFamilies({
      nodes: [n('e1', '春分试玩会'), n('e2', '春分试玩会 2026-06-19'), n('e3', '2026春分试玩会'), n('e4', '春分试玩会 2026-06-19/20'), n('p', 'X', 'person')],
      edges: [
        { source: 'p', target: 'e2', type: 'attends' }, { source: 'p', target: 'e1', type: 'attends' },
        { source: 'e3', target: 'p', type: 'affects' }, { source: 'e2', target: 'e4', type: 'depends' }
      ]
    })
    expect(g.nodes.map((z) => z.id).sort()).toEqual(['e2', 'p']) // e2 has 2 edges, the rest fold into it
    expect(g.edges).toEqual([{ source: 'p', target: 'e2', type: 'attends' }, { source: 'e2', target: 'p', type: 'affects' }])
  })

  it('never folds two dates into one event', () => {
    const g = foldEventFamilies({ nodes: [n('a', '上海差旅 2026-05-18'), n('b', '上海差旅 2026-07-07'), n('c', '上海差旅')], edges: [] })
    expect(g.nodes).toHaveLength(3) // month-days conflict across the family: nothing folds
    const h = foldEventFamilies({ nodes: [n('a', 'IPO期限2025-12-31'), n('b', 'IPO期限2026-12-31')], edges: [] })
    expect(h.nodes).toHaveLength(2)
  })

  it('leaves non-events and documents alone', () => {
    const g = foldEventFamilies({ nodes: [n('t1', 'Brain Unification', 'topic'), n('t2', 'Brain Unification 2026', 'topic'), n('Notes/e.md', '春分试玩会 2026'), n('e', '春分试玩会')], edges: [] })
    expect(g.nodes).toHaveLength(4)
  })
})

describe('unanchored entities — no document on the map behind them', () => {
  const n = (id: string, kind: string, label: string, layer = 'construction') => ({ id, kind, label, layer, note: layer === 'construction' ? 'Gone/x.md' : undefined })

  it('drops an extracted node with no edge to any document, keeps one that has', () => {
    const g = dropUnanchoredEntities({
      nodes: [n('t1', 'topic', 'Promoted operator fact'), n('t2', 'topic', 'Anchor'), n('Notes/a.md', 'note', 'a', 'vault'), n('t3', 'topic', 'Friend')],
      edges: [{ source: 't2', target: 'Notes/a.md', type: 'about' }, { source: 't3', target: 't2', type: 'affects' }, { source: 't1', target: 't3', type: 'mentions' }]
    })
    expect(g.nodes.map((z) => z.id).sort()).toEqual(['Notes/a.md', 't2']) // t3 is related but anchored to nothing on the map
    expect(g.edges).toEqual([{ source: 't2', target: 'Notes/a.md', type: 'about' }])
  })

  it('never touches documents, the skeleton or product nodes', () => {
    const g = dropUnanchoredEntities({
      nodes: [{ id: '__core__', kind: 'core', label: 'core' }, { id: 'proj', kind: 'project', label: 'P', layer: 'product' }, n('Notes/a.md', 'note', 'a', 'vault')],
      edges: []
    })
    expect(g.nodes).toHaveLength(3)
  })
})
