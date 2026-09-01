// Identity-spine P6 — the UNIFORM identity spine. Before P6 the resolver was applied
// per-caller and mergedGraph() fed RAW construction to /graph + graphCommunities +
// graph-report/snapshot, so those surfaces carried fragment ids (topic:aurora) while the
// MAP/retrieval showed canonical (topic:曙光). P6 routes every graph-assembly consumer
// through the ONE shared getResolvedConstruction() accessor. These tests drive the REAL
// construct cache (no construct mock) so the real entity-resolver actually fires; only
// deriveGraph is stubbed (empty base — no notes indexed in the test env).
//
// Cold-start A1 moved the alias whitelist out of source into per-vault state
// (`.duin/_state/entity-aliases.json`); the fixture writes one, and getResolvedConstruction()
// loads it. The canonical id is deliberately CJK to keep the byte-stability coverage that the
// previous (operator-named) fixture had.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'

vi.mock('../local-brain/graph-derive', () => ({ deriveGraph: vi.fn(() => ({ nodes: [], edges: [] })) }))

import { mergedGraph } from './merged-graph'
import { buildCommunityAssignments } from './graph-insight'
import { buildBrainGraph } from './brain-graph-native'
import { setConstructPaths, __resetConstructionForTest } from './construct'
import { setActiveAliasGroups } from './entity-resolver'
import type { ConstructedData } from './types'
import type { GraphReadResult } from './graph-native'

const ALIAS_GROUPS = [
  { canonicalId: 'topic:曙光', canonical: '曙光', aliases: ['曙光', 'aurora', 'aurora one'] }
]

function dirKeyFor(dir: string): string {
  return createHash('sha1').update(dir).digest('hex').slice(0, 16)
}

/** A construction cache carrying the churning fragment id 'topic:aurora' (label 'aurora'),
 *  which the vault's alias whitelist collapses onto the canonical 'topic:曙光'. Written to the
 *  legacy cache path (no `.brain/` root) keyed to `notesDir`. */
function seedCache(notesDir: string, userData: string): void {
  const data: ConstructedData = {
    entities: [
      { id: 'topic:aurora', kind: 'topic', label: 'aurora', note: 'note.md' },
      { id: 'topic:other', kind: 'topic', label: 'Other', note: 'note.md' }
    ],
    edges: [{ source: 'topic:aurora', target: 'topic:other', type: 'about' }],
    classifications: []
  }
  writeFileSync(
    join(userData, 'brain-construction.json'),
    JSON.stringify({ key: dirKeyFor(notesDir), builtAt: new Date().toISOString(), data }),
    'utf-8'
  )
  // the per-vault alias whitelist (cold-start A1) — the SOLE merge authority
  mkdirSync(join(notesDir, '.duin', '_state'), { recursive: true })
  writeFileSync(
    join(notesDir, '.duin', '_state', 'entity-aliases.json'),
    JSON.stringify(ALIAS_GROUPS),
    'utf-8'
  )
  // the per-vault store-project fold table (cold-start A3) — closes the product seam in (c)
  writeFileSync(
    join(notesDir, '.duin', '_state', 'store-project-alias.json'),
    JSON.stringify({ 曙光: 'topic:曙光' }),
    'utf-8'
  )
  setConstructPaths(userData, () => notesDir)
}

/** Minimal product store with a bare-id '曙光' project node (cards-native mints id = raw
 *  `project` field) — the seam counterpart of the construction canonical 'topic:曙光'. */
function prodWithAuroraProject(): GraphReadResult {
  return {
    nodes: [{ id: '曙光', kind: 'project', declared: 1, title: '曙光', project: '', body: '', extra: null }],
    edges: [],
    by_kind: {},
    by_edge: {},
    node_count: 1,
    edge_count: 0
  }
}

describe('identity-spine P6 — uniform resolved construction across surfaces', () => {
  let tmp = ''
  const prevFlag = process.env.DUIN_ENTITY_RESOLVER
  const prevOverlay = process.env.DUIN_MAP_ENTITY_OVERLAY

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'p6-'))
    // tmp is BOTH the notes dir (buildBrainGraph reads it — empty of .md) and userData (legacy cache).
    seedCache(tmp, tmp)
    delete process.env.DUIN_ENTITY_RESOLVER // default-on
    delete process.env.DUIN_MAP_ENTITY_OVERLAY // default-on
    // The MAP applies a topic floor (pruneUnstructuredTopics). These fixtures give their
    // topics fewer relations than it requires, and this suite is exercising the entity
    // overlay / resolver, not the floor — so switch the floor off and keep the two features
    // independently testable. The floor has its own tests in build-duin-graph.test.ts.
    process.env.DUIN_GRAPH_TOPIC_FLOOR = '0'
  })
  afterEach(() => {
    __resetConstructionForTest()
    setActiveAliasGroups([]) // leave the process-global whitelist as a fresh install finds it
    if (prevFlag === undefined) delete process.env.DUIN_ENTITY_RESOLVER
    else process.env.DUIN_ENTITY_RESOLVER = prevFlag
    delete process.env.DUIN_GRAPH_TOPIC_FLOOR
    if (prevOverlay === undefined) delete process.env.DUIN_MAP_ENTITY_OVERLAY
    else process.env.DUIN_MAP_ENTITY_OVERLAY = prevOverlay
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  const mapGraph = () => buildBrainGraph(tmp, { prod: prodWithAuroraProject(), logoDir: tmp, now: new Date() })

  // (a) mergedGraph()/`/graph` now returns the CANONICAL id for a whitelisted duplicate
  //     (it was the fragment before P6).
  it('(a) mergedGraph returns the canonical id (was fragment)', () => {
    const g = mergedGraph()
    const ids = g.nodes.map((n) => n.id)
    expect(ids).toContain('topic:曙光')
    expect(ids).not.toContain('topic:aurora')
  })

  // (b) The community-assignment id space now MATCHES the MAP node id space — the mis-color
  //     (community keyed on project:aurora vs a MAP node project:曙光) is closed.
  it('(b) community-assignment ids match the MAP node ids for the resolved entity', () => {
    const comm = buildCommunityAssignments().map((c) => c.id)
    const mapIds = mapGraph().nodes.map((n) => String(n.id))
    expect(comm).toContain('topic:曙光')
    expect(comm).not.toContain('topic:aurora')
    // the SAME canonical id is the MAP's node id → the color lens keys line up
    expect(mapIds).toContain('topic:曙光')
  })

  // (c) Product-seam: a product '曙光' + construction 'topic:曙光' render as ONE MAP node.
  it('(c) product 曙光 + construction 曙光 collapse to ONE MAP node', () => {
    const ids = mapGraph().nodes.map((n) => String(n.id))
    expect(ids.filter((id) => id === 'topic:曙光')).toHaveLength(1)
    expect(ids).not.toContain('曙光') // the bare product id folded onto the canonical id
  })

  // (d) DUIN_ENTITY_RESOLVER=0 ⇒ raw passthrough UNIFORMLY: mergedGraph keeps the fragment id,
  //     and the MAP product node stays a separate bare '曙光' (the seam fold is gated off too).
  it('(d) kill-switch (DUIN_ENTITY_RESOLVER=0): raw fragment ids on every surface', () => {
    process.env.DUIN_ENTITY_RESOLVER = '0'
    const mIds = mergedGraph().nodes.map((n) => n.id)
    expect(mIds).toContain('topic:aurora')
    expect(mIds).not.toContain('topic:曙光')

    const mapIds = mapGraph().nodes.map((n) => String(n.id))
    expect(mapIds).toContain('topic:aurora') // construction fragment, unresolved
    expect(mapIds).toContain('曙光') // product node, NOT folded (seam gated off)
    expect(mapIds).not.toContain('topic:曙光')
  })

  // (e) A vault with NO alias whitelist (the shipped cold-start default) merges nothing —
  //     empty-and-honest rather than folding a stranger's entities onto the author's ids.
  it('(e) no per-vault whitelist ⇒ the fragment id survives (nothing merged)', () => {
    rmSync(join(tmp, '.duin', '_state', 'entity-aliases.json'))
    __resetConstructionForTest()
    setConstructPaths(tmp, () => tmp)
    const ids = mergedGraph().nodes.map((n) => n.id)
    expect(ids).toContain('topic:aurora')
    expect(ids).not.toContain('topic:曙光')
  })
})
