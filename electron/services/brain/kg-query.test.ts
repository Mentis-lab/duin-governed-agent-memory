import { describe, it, expect } from 'vitest'
import { kgQuery, type KgQueryDeps } from './kg-query'
import { classifyMutability, type Claim } from './claim-metabolism'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 1)

function claim(id: string, subject: string, object: string, validFrom = T0, validTo: number | null = null): Claim {
  return {
    id,
    chunkId: `c-${id}`,
    notePath: `${id}.md`,
    subject,
    relation: 'status',
    object,
    validFrom,
    validTo,
    observedAt: validFrom,
    supersededBy: null,
    mutability: classifyMutability('status'),
    justifications: [],
    verdict: 'current',
    verdictBy: null
  }
}

/** A small graph:  alpha -> beta -> gamma ,  alpha -> delta  */
const NODES = [
  { id: 'n-alpha', label: 'Alpha Project', kind: 'project' },
  { id: 'n-beta', label: 'Beta Vendor', kind: 'org' },
  { id: 'n-gamma', label: 'Gamma Person', kind: 'person' },
  { id: 'n-delta', label: 'Delta Track', kind: 'track' },
  { id: 'n-island', label: 'Island', kind: 'misc' }
]
const EDGES: Record<string, string[]> = {
  'n-alpha': ['n-beta', 'n-delta'],
  'n-beta': ['n-gamma'],
  'n-gamma': [],
  'n-delta': [],
  'n-island': []
}

function deps(claims: Claim[] = [], nodes = NODES): KgQueryDeps {
  return {
    liveNodes: () => nodes,
    neighborsOf: (id) => EDGES[id] ?? [],
    loadClaims: () => claims
  }
}

describe('kg-query — multi-hop traversal', () => {
  it('resolves a seed by exact id, exact label, then substring — most precise first', () => {
    expect(kgQuery('/v', { seed: 'n-alpha', hops: 0 }, deps()).resolvedSeeds).toEqual(['n-alpha'])
    expect(kgQuery('/v', { seed: 'Alpha Project', hops: 0 }, deps()).resolvedSeeds).toEqual(['n-alpha'])
    expect(kgQuery('/v', { seed: 'alpha', hops: 0 }, deps()).resolvedSeeds).toEqual(['n-alpha'])
  })

  it('hop is shortest-path distance, and depth is respected', () => {
    const r1 = kgQuery('/v', { seed: 'n-alpha', hops: 1 }, deps())
    expect(r1.nodes.map((n) => n.id).sort()).toEqual(['n-alpha', 'n-beta', 'n-delta'])
    expect(r1.nodes.find((n) => n.id === 'n-beta')!.hop).toBe(1)
    // gamma is 2 hops out — absent at depth 1, present at depth 2.
    expect(r1.nodes.some((n) => n.id === 'n-gamma')).toBe(false)
    const r2 = kgQuery('/v', { seed: 'n-alpha', hops: 2 }, deps())
    expect(r2.nodes.find((n) => n.id === 'n-gamma')!.hop).toBe(2)
  })

  it('hops is clamped to 0..4 and an unresolvable seed yields no nodes', () => {
    expect(kgQuery('/v', { seed: 'n-alpha', hops: 99 }, deps()).hops).toBe(4)
    expect(kgQuery('/v', { seed: 'n-alpha', hops: -3 }, deps()).hops).toBe(0)
    expect(kgQuery('/v', { seed: 'nothing-matches-this', hops: 2 }, deps()).nodes).toEqual([])
  })

  it('limit truncates the walk and reports it rather than silently capping', () => {
    const r = kgQuery('/v', { seed: 'n-alpha', hops: 3, limit: 2 }, deps())
    expect(r.truncated).toBe(true)
    expect(r.nodes.length).toBeLessThanOrEqual(2)
  })
})

describe('kg-query — as-of (bitemporal) filtering', () => {
  const claims = [
    // "Alpha Project is green" was true for the first 100 days, then superseded.
    claim('old', 'Alpha Project', 'green', T0, T0 + 100 * DAY),
    claim('new', 'Alpha Project', 'red', T0 + 100 * DAY, null),
    claim('unrelated', 'Island', 'blue', T0, null)
  ]

  it('returns the claim that was true AT the instant, not merely the current one', () => {
    const past = kgQuery('/v', { seed: 'n-alpha', hops: 0, asOf: T0 + 50 * DAY }, deps(claims))
    expect(past.claims.map((c) => c.id)).toEqual(['old'])

    const later = kgQuery('/v', { seed: 'n-alpha', hops: 0, asOf: T0 + 150 * DAY }, deps(claims))
    expect(later.claims.map((c) => c.id)).toEqual(['new'])
  })

  it('restricts claims to the reached subgraph — an unrelated entity does not leak in', () => {
    const r = kgQuery('/v', { seed: 'n-alpha', hops: 2, asOf: T0 + 150 * DAY }, deps(claims))
    expect(r.claims.some((c) => c.id === 'unrelated')).toBe(false)
  })

  it('a multi-hop walk pulls in claims about entities the seed only reaches transitively', () => {
    const withGamma = [...claims, claim('g', 'Gamma Person', 'engaged', T0, null)]
    expect(kgQuery('/v', { seed: 'n-alpha', hops: 1, asOf: T0 + 150 * DAY }, deps(withGamma)).claims.some((c) => c.id === 'g')).toBe(false)
    expect(kgQuery('/v', { seed: 'n-alpha', hops: 2, asOf: T0 + 150 * DAY }, deps(withGamma)).claims.some((c) => c.id === 'g')).toBe(true)
  })
})

describe('kg-query — degraded graph', () => {
  it('an EMPTY entity graph still answers from the ledger by seed string, and says so', () => {
    const claims = [claim('a', 'Alpha Project', 'green', T0, null)]
    const r = kgQuery('/v', { seed: 'Alpha Project', hops: 2 }, deps(claims, []))
    expect(r.entityGraph).toBe('empty')
    expect(r.note).toMatch(/empty/i)
    expect(r.claims.map((c) => c.id)).toEqual(['a'])
  })

  it('a ledger read failure degrades to no claims instead of throwing', () => {
    const bad: KgQueryDeps = {
      ...deps(),
      loadClaims: () => {
        throw new Error('ledger unreadable')
      }
    }
    expect(kgQuery('/v', { seed: 'n-alpha', hops: 1 }, bad).claims).toEqual([])
  })
})
