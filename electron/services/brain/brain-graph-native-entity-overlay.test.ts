// Track 0 Phase 3 — the flag-gated entity overlay for the home MAP.
// buildBrainGraph composes the product store + vault cloud but does NOT include
// the LLM-constructed entity layer (getConstruction). It is overlaid by DEFAULT
// now; DUIN_MAP_ENTITY_OVERLAY==='0' disables it. This test pins BOTH halves:
//   - flag OFF (='0') ⇒ a PURE no-op: node/edge counts identical to a no-construction
//     baseline and NO construction-only node appears (this is what keeps the
//     /state/brain-graph Python golden green when explicitly disabled);
//   - flag ON  ⇒ entity nodes + edges appear, id-collisions keep the native node,
//     and self/dangling edges are dropped.
// Identity-spine P6: the MAP overlay reads the shared getResolvedConstruction() accessor,
// so THAT is stubbed here (merged-graph.test.ts pattern); RELATION_TO_EDGE real.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildBrainGraph } from './brain-graph-native'
import { getResolvedConstruction } from './construct'
import type { GraphReadResult } from './graph-native'
import type { ConstructedData } from './types'

vi.mock('./construct', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./construct')>()
  return { ...actual, getResolvedConstruction: vi.fn() }
})

describe('brain-graph-native — entity overlay (DUIN_MAP_ENTITY_OVERLAY)', () => {
  let dir: string
  let logoDir: string
  const write = (rel: string, text: string): void => {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text, 'utf-8')
  }

  const prod: GraphReadResult = {
    nodes: [
      { id: 'DUIN', kind: 'project', declared: 1, title: 'DUIN · 第二大脑', project: '', body: '', extra: null },
      { id: 'goal:x', kind: 'goal', declared: 1, title: 'Ship', project: '', body: '', extra: null }
    ],
    edges: [{ src: 'DUIN', dst: 'goal:x', type: 'rel' }],
    by_kind: {},
    by_edge: {},
    node_count: 2,
    edge_count: 1
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-bgraph-overlay-'))
    logoDir = join(dir, '_logos')
    mkdirSync(logoDir, { recursive: true })
    write('Knowledge/note-a.md', '[[note-b]]\n')
    write('Knowledge/note-b.md', 'b\n')
    vi.mocked(getResolvedConstruction).mockReset()
    delete process.env.DUIN_MAP_ENTITY_OVERLAY
    // The MAP applies a topic floor (pruneUnstructuredTopics). These fixtures give their
    // topics fewer relations than it requires, and this suite is exercising the entity
    // overlay / resolver, not the floor — so switch the floor off and keep the two features
    // independently testable. The floor has its own tests in build-duin-graph.test.ts.
    process.env.DUIN_GRAPH_TOPIC_FLOOR = '0'
  })
  afterEach(() => {
    delete process.env.DUIN_MAP_ENTITY_OVERLAY
    delete process.env.DUIN_GRAPH_TOPIC_FLOOR
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  const build = () => buildBrainGraph(dir, { prod, logoDir, now: new Date('2026-07-06T00:00:00') })

  // A construction with: a fresh entity + edge to an existing vault note (should land),
  // an entity id that COLLIDES with the native 'DUIN' project (native must win),
  // a self edge (dropped), and a dangling edge to an unknown id (dropped).
  const construction: ConstructedData = {
    entities: [
      { id: 'person:jordan', kind: 'person', label: 'Jordan', note: 'Knowledge/note-a.md' },
      { id: 'topic:retrieval', kind: 'topic', label: 'Retrieval', note: 'Knowledge/note-b.md' },
      { id: 'DUIN', kind: 'topic', label: 'COLLIDES', note: 'Knowledge/note-a.md' } // id collision with native project
    ],
    edges: [
      { source: 'person:jordan', target: 'Knowledge/note-a.md', type: 'mentions' }, // entity→existing note: lands
      { source: 'person:jordan', target: 'topic:retrieval', type: 'about' }, // entity→entity: lands
      { source: 'topic:retrieval', target: 'topic:retrieval', type: 'about' }, // self: dropped
      { source: 'person:jordan', target: 'ghost:missing', type: 'owns' } // dangling: dropped
    ],
    classifications: []
  }

  it('flag OFF (=0) ⇒ pure no-op: no construction-only node, counts equal the no-construction baseline', () => {
    // Default is now ON, so the OFF path must be selected explicitly with '0'.
    process.env.DUIN_MAP_ENTITY_OVERLAY = '0'
    // Baseline: construction present but the module ignores it because the flag is off.
    vi.mocked(getResolvedConstruction).mockReturnValue(null)
    const baseline = build()

    vi.mocked(getResolvedConstruction).mockReturnValue(construction)
    const off = build() // flag = '0'

    expect(off.stats).toEqual(baseline.stats)
    expect(off.nodes.length).toBe(baseline.nodes.length)
    expect(off.links.length).toBe(baseline.links.length)
    // No construction-only entity leaked onto the MAP.
    expect(off.nodes.some((n) => n.id === 'person:jordan')).toBe(false)
    expect(off.nodes.some((n) => n.id === 'topic:retrieval')).toBe(false)
    // getConstruction is not even consulted with the flag off.
    expect(getResolvedConstruction).not.toHaveBeenCalled()
  })

  it('flag ON ⇒ entity nodes + edges appear, deduped, self/dangling dropped', () => {
    vi.mocked(getResolvedConstruction).mockReturnValue(null)
    const baseline = build()

    process.env.DUIN_MAP_ENTITY_OVERLAY = '1'
    vi.mocked(getResolvedConstruction).mockReturnValue(construction)
    const on = build()

    const nodeById = (id: string) => on.nodes.find((n) => n.id === id)
    const hasEdge = (a: string, b: string) =>
      on.links.find((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a))

    // Two NEW entity nodes appear (the third, 'DUIN', collides with the native project).
    expect(nodeById('person:jordan')).toMatchObject({ kind: 'person', label: 'Jordan', layer: 'construction' })
    expect(nodeById('topic:retrieval')).toMatchObject({ kind: 'topic', layer: 'construction' })
    expect(on.nodes.length).toBe(baseline.nodes.length + 2)

    // Collision: the native DUIN project node is preserved, NOT clobbered by the topic entity.
    expect(nodeById('DUIN')).toMatchObject({ kind: 'project', layer: 'product' })

    // Landing edges (relation mapped: 'mentions'→'mentions', 'about'→'about').
    expect(hasEdge('person:jordan', 'Knowledge/note-a.md')?.type).toBe('mentions')
    expect(hasEdge('person:jordan', 'topic:retrieval')?.type).toBe('about')
    // identity-spine ②: topic:retrieval is now tethered to its provenance note too.
    expect(hasEdge('topic:retrieval', 'Knowledge/note-b.md')?.type).toBe('mentions')
    // Self + dangling dropped. +3 edges over baseline: 2 entity→note spine edges
    // (jordan→note-a, retrieval→note-b) + 1 landed entity→entity (jordan→retrieval about).
    // The LLM's own jordan→note-a `mentions` edge dedups against the spine edge (same
    // undirected pair), so it does NOT double-count.
    expect(on.links.length).toBe(baseline.links.length + 3)
    expect(on.links.some((e) => e.source === e.target)).toBe(false)
    expect(on.links.some((e) => e.source === 'ghost:missing' || e.target === 'ghost:missing')).toBe(false)

    // No duplicate undirected pairs introduced.
    const seen = new Set<string>()
    for (const e of on.links) {
      const k = e.source < e.target ? e.source + ' ' + e.target : e.target + ' ' + e.source
      expect(seen.has(k)).toBe(false)
      seen.add(k)
    }
    expect(on.stats).toEqual({ nodes: on.nodes.length, edges: on.links.length })
  })
})
