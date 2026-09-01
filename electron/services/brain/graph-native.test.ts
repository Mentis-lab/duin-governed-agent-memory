import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readGraphNative, type GraphReadResult } from './graph-native'

let VAULT: string
let G: GraphReadResult

function write(rel: string, content: string): void {
  const p = join(VAULT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
}

beforeAll(() => {
  VAULT = mkdtempSync(join(tmpdir(), 'graph-native-'))

  // track registry ← tracks.json. Cold-start A2 emptied DEFAULT_TRACKS (they were one operator's
  // real lanes), so the `track` store kind and its track→move `contains` edges only exist for a
  // vault that declares its own lanes. The fixture declares one.
  write(
    '.duin/_state/tracks.json',
    JSON.stringify([{ id: 'duin', label: 'DUIN · second brain', lane: 'duin', keywords: ['duin'] }])
  )
  // goal→project domain map ← goal-domains.json. Same story as tracks.json: A3 moved the built-in
  // (operator-specific) map to per-vault state, so `guides` edges exist only for a vault that
  // declares one.
  write(
    '.duin/_state/goal-domains.json',
    JSON.stringify({ 'gaming-ecosystem-brand-synergy': ['北澜', 'gaming', 'game'] })
  )
  // move ← future-nodes.jsonl (feeds an anchor via anchor_id)
  write(
    '.duin/_state/future-nodes.jsonl',
    JSON.stringify({
      id: 'm1',
      title: 'DUIN move one',
      track: 'duin',
      anchor_id: 'rel1',
      target: '2027-01-01',
      decide_by: '2026-08'
    })
  )
  // insight ← insights.jsonl
  write(
    '.duin/_state/insights.jsonl',
    JSON.stringify({ id: 'ins1', type: 'idea', headline: 'An idea', why: 'because', track: 'DUIN', confidence: 0.6 })
  )
  // anchors ← (C) anchor-*.md decls (release + a milestone that builds_toward it)
  write(
    '03 Projects/proj/(C) anchor-rel.md',
    ['---', 'type: anchor', 'anchor-id: rel1', 'name: Release One', 'kind: release', 'date: 2027-01-01', '---', '', 'body'].join('\n')
  )
  write(
    '03 Projects/proj/(C) anchor-mile.md',
    ['---', 'type: anchor', 'anchor-id: mile1', 'name: Milestone One', 'kind: milestone', 'date: 2026-12-01', 'builds-toward: rel1', '---', '', 'body'].join('\n')
  )
  // cards + project + action + reference
  write('北澜/C1-card.md', ['---', 'type: card', 'project: 北澜', 'status: draft', '---', '', '# Card one'].join('\n'))
  write(
    'DUIN/Meta/C2-card.md',
    ['---', 'type: card', 'source-project: meta', 'source-note: "[[T1-action]]"', 'status: live', '---', '', '# Card two'].join('\n')
  )
  write('DUIN/Active/T1-action.md', ['---', 'type: action', 'status: open', '---', '', '# Action one'].join('\n'))
  // North-Star goals
  write(
    'GOALS.md',
    [
      '## Strategic Tracks (cross-cycle)',
      '### 1. Gaming Ecosystem & Brand Synergy',
      'x',
      '### 2. AIT (AI Transformation) & Operational Efficiency',
      'x'
    ].join('\n')
  )
  // person ← entities
  write('People/Alice.md', ['---', 'type: person', 'org: Acme', '---', '', '# Alice'].join('\n'))
  // risk/issue ← problems-native
  write(
    '05 Decisions/_Owed-Decisions.md',
    ['## Risks', '', '- **R1 · A risk** — `open` `src`', '  a detail', '', '## Problems', '', '- **P1 · A problem** — `mitigated`', '  a detail'].join('\n')
  )

  G = readGraphNative(VAULT)
})

afterAll(() => {
  rmSync(VAULT, { recursive: true, force: true })
})

describe('readGraphNative — shape + rollups', () => {
  it('returns the identical GraphReadResult 6-key shape', () => {
    expect(Object.keys(G).sort()).toEqual(['by_edge', 'by_kind', 'edge_count', 'edges', 'node_count', 'nodes'].sort())
    expect(G.node_count).toBe(G.nodes.length)
    expect(G.edge_count).toBe(G.edges.length)
  })

  it('by_kind splits declared/inferred correctly (move & insight are inferred)', () => {
    // recompute by_kind independently and compare
    const recomputed: Record<string, { declared: number; inferred: number }> = {}
    for (const n of G.nodes as { kind: string; declared: number }[]) {
      if (!recomputed[n.kind]) recomputed[n.kind] = { declared: 0, inferred: 0 }
      recomputed[n.kind][n.declared ? 'declared' : 'inferred'] += 1
    }
    expect(G.by_kind).toEqual(recomputed)
    // move + insight live in the inferred bucket; everything else declared
    expect(G.by_kind.move).toEqual({ declared: 0, inferred: 1 })
    expect(G.by_kind.insight).toEqual({ declared: 0, inferred: 1 })
    expect(G.by_kind.card.declared).toBeGreaterThan(0)
    expect(G.by_kind.card.inferred).toBe(0)
  })

  it('produces each expected store kind from the fixture', () => {
    for (const k of ['move', 'insight', 'track', 'risk', 'issue', 'person', 'card', 'project', 'goal', 'action', 'release', 'milestone']) {
      expect(G.by_kind[k], `kind ${k} present`).toBeTruthy()
    }
  })

  it('by_edge equals a fresh recomputation over edges', () => {
    const recomputed: Record<string, number> = {}
    for (const e of G.edges) recomputed[e.type] = (recomputed[e.type] ?? 0) + 1
    expect(G.by_edge).toEqual(recomputed)
    // the substrate + net-new edge types are all exercised by the fixture
    expect(G.by_edge.contains).toBeGreaterThan(0)
    expect(G.by_edge.feeds).toBeGreaterThan(0)
    expect(G.by_edge.builds_toward).toBeGreaterThan(0)
    expect(G.by_edge.references).toBe(1)
    expect(G.by_edge.guides).toBeGreaterThan(0)
  })

  it('has no dangling edges — every endpoint is a node', () => {
    const ids = new Set((G.nodes as { id: string }[]).map((n) => n.id))
    for (const e of G.edges) {
      expect(ids.has(e.src), `src ${e.src} (${e.type}) exists`).toBe(true)
      expect(ids.has(e.dst), `dst ${e.dst} (${e.type}) exists`).toBe(true)
      expect(e.src).not.toBe(e.dst)
    }
  })

  it('emits BARE store ids (no kind-prefix on move/anchor; vault:/ kept on person)', () => {
    const ids = new Set((G.nodes as { id: string }[]).map((n) => n.id))
    expect(ids.has('m1')).toBe(true) // move: bare, not move:m1
    expect(ids.has('rel1')).toBe(true) // release: bare, not anchor:rel1
    expect([...ids].some((i) => i.startsWith('vault:/'))).toBe(true) // person kept as vault:/
    expect([...ids].some((i) => i.startsWith('move:') || i.startsWith('anchor:'))).toBe(false)
  })

  it('returns EMPTY for a null vault', () => {
    const e = readGraphNative(null)
    expect(e.node_count).toBe(0)
    expect(e.edge_count).toBe(0)
  })
})
