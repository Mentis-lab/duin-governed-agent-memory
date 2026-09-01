import { describe, it, expect } from 'vitest'
import { buildEntityEgoGraph, beliefsAbout, governableBeliefFacts, resolveEgoAnchor, type EgoDeps } from './entity-ego'
import type { OperatorFact } from './operator-model'

// A small fixture world:  bili -publishes-> wy -employs-> dana ; wy -ships-> beta ; beta -on-> steam
const EDGES: Record<string, Array<{ src: string; dst: string; type: string }>> = {
  'project:wy': [
    { src: 'org:bili', dst: 'project:wy', type: 'publishes' },
    { src: 'project:wy', dst: 'person:dana', type: 'employs' },
    { src: 'project:wy', dst: 'event:beta', type: 'ships' }
  ],
  'org:bili': [{ src: 'org:bili', dst: 'project:wy', type: 'publishes' }],
  'person:dana': [{ src: 'project:wy', dst: 'person:dana', type: 'employs' }],
  'event:beta': [
    { src: 'project:wy', dst: 'event:beta', type: 'ships' },
    { src: 'event:beta', dst: 'org:steam', type: 'on' }
  ],
  'org:steam': [{ src: 'event:beta', dst: 'org:steam', type: 'on' }]
}
const NODES: Record<string, { id: string; label: string; kind: string; source: string }> = {
  'project:wy': { id: 'project:wy', label: '北澜', kind: 'project', source: 'construction' },
  'org:bili': { id: 'org:bili', label: 'Bilibili', kind: 'org', source: 'construction' },
  'person:dana': { id: 'person:dana', label: 'Dana', kind: 'person', source: 'construction' },
  'event:beta': { id: 'event:beta', label: '二测', kind: 'event', source: 'construction' },
  'org:steam': { id: 'org:steam', label: 'Steam', kind: 'org', source: 'construction' }
}
const deps: EgoDeps = {
  edgesOf: (id) => EDGES[id] ?? [],
  nodesByIds: (ids) => ids.map((i) => NODES[i]).filter(Boolean)
}

function fact(over: Partial<OperatorFact> = {}): OperatorFact {
  return {
    id: 'f1',
    fact: 'Works on the Beilan launch.',
    kind: 'context',
    status: 'promoted',
    ts: 1,
    source: 'operator',
    ...over
  } as OperatorFact
}

describe('buildEntityEgoGraph', () => {
  it('depth 1: anchor + direct neighbors, edges carry dir relative to the discovery node', () => {
    const g = buildEntityEgoGraph('project:wy', deps, { depth: 1 })
    expect(g.anchor).toBe('project:wy')
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['event:beta', 'org:bili', 'person:dana', 'project:wy'])
    expect(g.edges).toContainEqual({ src: 'org:bili', dst: 'project:wy', type: 'publishes', dir: 'in' })
    expect(g.edges).toContainEqual({ src: 'project:wy', dst: 'person:dana', type: 'employs', dir: 'out' })
    expect(g.stats.truncated).toBe(false)
  })

  it('depth 2 walks a hop further and dedupes nodes/edges', () => {
    const g = buildEntityEgoGraph('project:wy', deps, { depth: 2 })
    expect(g.nodes.some((n) => n.id === 'org:steam')).toBe(true)
    const edgeKeys = g.edges.map((e) => `${e.src}→${e.dst}`)
    expect(new Set(edgeKeys).size).toBe(edgeKeys.length)
  })

  it('caps: perNodeCap clips fan-out deterministically and flags truncated', () => {
    const bigDeps: EgoDeps = {
      edgesOf: (id) =>
        id === 'hub'
          ? Array.from({ length: 10 }, (_, i) => ({ src: 'hub', dst: `n${String(i).padStart(2, '0')}`, type: 'rel' }))
          : [],
      nodesByIds: (ids) => ids.map((i) => ({ id: i, label: i, kind: 'org', source: 'construction' }))
    }
    const g = buildEntityEgoGraph('hub', bigDeps, { depth: 1, perNodeCap: 3 })
    expect(g.edges).toHaveLength(3)
    expect(g.edges.map((e) => e.dst)).toEqual(['n00', 'n01', 'n02']) // deterministic order
    expect(g.stats.truncated).toBe(true)
  })

  it('totalCap stops expansion and flags truncated', () => {
    const g = buildEntityEgoGraph('project:wy', deps, { depth: 3, totalCap: 3 })
    expect(g.nodes.length).toBeLessThanOrEqual(3)
    expect(g.stats.truncated).toBe(true)
  })

  it('unknown anchor yields an empty graph, never throws', () => {
    const g = buildEntityEgoGraph('nope:x', deps, { depth: 1 })
    expect(g.nodes).toEqual([])
    expect(g.stats).toMatchObject({ nodes: 0, edges: 0 })
  })
})

describe('resolveEgoAnchor', () => {
  const groups = [{ canonicalId: 'project:北澜', canonical: '北澜', aliases: ['beilan', '《北澜》'] }]
  const probe = (byLabel: Record<string, string>, ids: string[] = []) => ({
    hasNode: (id: string) => ids.includes(id),
    findByLabel: (label: string) => byLabel[label.toLowerCase()] ?? null
  })

  it('store id and store label win before the whitelist', () => {
    expect(resolveEgoAnchor('entity:x', groups, probe({}, ['entity:x']))).toEqual({ id: 'entity:x' })
    expect(resolveEgoAnchor('Crunchyroll', groups, probe({ crunchyroll: 'org:cr' }))).toEqual({ id: 'org:cr' })
  })

  it('a whitelist alias resolves to a store node carrying ANY surface form of the group', () => {
    // the store has no bare 北澜 node, but it has one labeled 《北澜》 — the group bridges them
    const r = resolveEgoAnchor('beilan', groups, probe({ '《北澜》': 'entity:wy-store' }))
    expect(r).toEqual({ id: 'entity:wy-store' })
  })

  it('a whitelist-only entity falls back to a VIRTUAL anchor (beliefs still join)', () => {
    const r = resolveEgoAnchor('北澜', groups, probe({}))
    expect(r).toEqual({ virtual: { id: 'project:北澜', label: '北澜', kind: 'project' } })
  })

  it('a total miss returns null', () => {
    expect(resolveEgoAnchor('nonexistent', groups, probe({}))).toBeNull()
  })
})

describe('beliefsAbout', () => {
  it('joins facts to the anchor via label/alias matching (same rules as the seam)', () => {
    const anchor = NODES['project:wy']
    const groups = [{ canonicalId: 'project:wy', canonical: '北澜', aliases: ['beilan', '《北澜》'] }]
    const beliefs = beliefsAbout(anchor, groups, [
      fact({ id: 'f1', fact: 'Works on the Beilan launch.' }),
      fact({ id: 'f2', fact: 'Prefers quiet mornings.' }),
      fact({ id: 'f3', fact: '推进《北澜》二测节奏。' })
    ])
    expect(beliefs.map((b) => b.factId).sort()).toEqual(['f1', 'f3'])
    expect(beliefs[0]).toMatchObject({ kind: 'context', status: 'promoted' })
  })

  it('anchor with no whitelist group still matches on its own label', () => {
    const beliefs = beliefsAbout(NODES['org:bili'], [], [fact({ id: 'f9', fact: 'Bilibili co-marketing owed.' })])
    expect(beliefs.map((b) => b.factId)).toEqual(['f9'])
  })

  it('orders promoted → provisional → candidate (the drawer read order)', () => {
    const anchor = NODES['project:wy']
    const groups = [{ canonicalId: 'project:wy', canonical: '北澜', aliases: ['beilan'] }]
    const beliefs = beliefsAbout(anchor, groups, [
      fact({ id: 'c1', fact: 'Beilan candidate note.', status: 'candidate' }),
      fact({ id: 'p1', fact: 'Beilan governing rule.', status: 'promoted' }),
      fact({ id: 'v1', fact: 'Beilan probation rule.', status: 'provisional' })
    ])
    expect(beliefs.map((b) => b.factId)).toEqual(['p1', 'v1', 'c1'])
  })
})

describe('governableBeliefFacts', () => {
  it('keeps live candidate/provisional/promoted; drops vetoed, reverted, and invalidated', () => {
    const kept = governableBeliefFacts([
      fact({ id: 'a', status: 'candidate' }),
      fact({ id: 'b', status: 'provisional' }),
      fact({ id: 'c', status: 'promoted' }),
      fact({ id: 'd', status: 'vetoed' }),
      fact({ id: 'e', status: 'reverted' }),
      // Superseded facts keep their status on purpose (bitemporal audit) — liveness must gate.
      fact({ id: 'f', status: 'promoted', invalidatedAt: 123, supersededBy: 'c' })
    ])
    expect(kept.map((f) => f.id)).toEqual(['a', 'b', 'c'])
  })
})
