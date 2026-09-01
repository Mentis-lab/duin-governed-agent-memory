// Phase R — person/org identity resolver. Proves resolveEntityIdentity reconciles
// construction person:/org: entities onto their profile-note relpath (exact-name only,
// no fuzzy, no over-merge), rewires edges, and leaves everything else untouched. PURE:
// no vault I/O — the name→relpath index is injected.

import { describe, it, expect, afterAll } from 'vitest'
import {
  resolveEntityIdentity,
  personResolverEnabled,
  normName,
  type ProfileIndex
} from './person-resolver'
import type { ConstructedData } from './types'

/** Build an injected ProfileIndex the way buildProfileIndex would — keyed by normName. */
function idx(obj: Record<string, string>): ProfileIndex {
  const m = new Map<string, string>()
  for (const [name, rel] of Object.entries(obj)) m.set(normName(name), rel)
  return m
}

const base = (over: Partial<ConstructedData> = {}): ConstructedData => ({
  entities: [],
  edges: [],
  classifications: [],
  triples: [],
  ...over
})

describe('resolveEntityIdentity', () => {
  it('rewrites an exact-match person entity id to the profile relpath and rewires its edges', () => {
    const c = base({
      entities: [{ id: 'person:noah-kell', kind: 'person', label: 'Noah Kell', note: 'X/mention.md' }],
      edges: [{ source: 'person:noah-kell', target: 'topic:x', type: 'about' }]
    })
    const out = resolveEntityIdentity(c, idx({ 'Noah Kell': 'ARGOSY/Noah Kell.md' }))!
    expect(out.entities[0].id).toBe('ARGOSY/Noah Kell.md')
    // label/kind/note preserved; only the id changed.
    expect(out.entities[0].label).toBe('Noah Kell')
    expect(out.entities[0].note).toBe('X/mention.md')
    expect(out.edges[0]).toEqual({ source: 'ARGOSY/Noah Kell.md', target: 'topic:x', type: 'about' })
    // PURE — input untouched.
    expect(c.entities[0].id).toBe('person:noah-kell')
    expect(c.edges[0].source).toBe('person:noah-kell')
  })

  it('leaves an entity untouched when its name is not in the index', () => {
    const c = base({
      entities: [{ id: 'person:nobody', kind: 'person', label: 'No Body', note: 'X/mention.md' }],
      edges: [{ source: 'person:nobody', target: 'topic:x', type: 'about' }]
    })
    const out = resolveEntityIdentity(c, idx({ 'Noah Kell': 'ARGOSY/Noah Kell.md' }))!
    expect(out.entities[0].id).toBe('person:nobody')
    expect(out.edges[0].source).toBe('person:nobody')
  })

  it('keeps only the FIRST entity when two would map to the same relpath (no duplicate id)', () => {
    const c = base({
      entities: [
        { id: 'person:noah-a', kind: 'person', label: 'Noah Kell', note: 'A.md' },
        { id: 'person:noah-b', kind: 'person', label: 'Noah Kell', note: 'B.md' }
      ]
    })
    const out = resolveEntityIdentity(c, idx({ 'Noah Kell': 'ARGOSY/Noah Kell.md' }))!
    // First claims the relpath; second is left as its slug — so the relpath id is unique.
    expect(out.entities[0].id).toBe('ARGOSY/Noah Kell.md')
    expect(out.entities[1].id).toBe('person:noah-b')
    const relpathIds = out.entities.filter((e) => e.id === 'ARGOSY/Noah Kell.md')
    expect(relpathIds).toHaveLength(1)
  })

  it('matches case/whitespace-insensitively but NOT a different (shorter) name — no fuzzy', () => {
    // Case + collapsed whitespace → match.
    const match = resolveEntityIdentity(
      base({ entities: [{ id: 'person:d', kind: 'person', label: '  noah   KELL ', note: 'A.md' }] }),
      idx({ 'Noah Kell': 'ARGOSY/Noah Kell.md' })
    )!
    expect(match.entities[0].id).toBe('ARGOSY/Noah Kell.md')
    // A DIFFERENT name (missing surname) must NOT match — over-merge is the risk.
    const noMatch = resolveEntityIdentity(
      base({ entities: [{ id: 'person:d', kind: 'person', label: 'Noah', note: 'A.md' }] }),
      idx({ 'Noah Kell': 'ARGOSY/Noah Kell.md' })
    )!
    expect(noMatch.entities[0].id).toBe('person:d')
  })

  it('resolves org entities symmetrically', () => {
    const c = base({
      entities: [{ id: 'org:qufangkuai', kind: 'org', label: '趣方块', note: 'X/mention.md' }],
      edges: [{ source: 'org:qufangkuai', target: 'topic:games', type: 'about' }]
    })
    const out = resolveEntityIdentity(c, idx({ 趣方块: 'ORGS/趣方块.md' }))!
    expect(out.entities[0].id).toBe('ORGS/趣方块.md')
    expect(out.edges[0]).toEqual({ source: 'ORGS/趣方块.md', target: 'topic:games', type: 'about' })
  })

  it('does not touch non-person/org entities even when a name matches', () => {
    const c = base({
      entities: [{ id: 'topic:noah-kell', kind: 'topic', label: 'Noah Kell', note: 'A.md' }]
    })
    const out = resolveEntityIdentity(c, idx({ 'Noah Kell': 'ARGOSY/Noah Kell.md' }))!
    expect(out.entities[0].id).toBe('topic:noah-kell')
  })

  it('returns null when construction is null', () => {
    expect(resolveEntityIdentity(null, idx({}))).toBeNull()
  })
})

describe('personResolverEnabled', () => {
  const prev = process.env.DUIN_PERSON_RESOLVER
  afterAll(() => {
    if (prev === undefined) delete process.env.DUIN_PERSON_RESOLVER
    else process.env.DUIN_PERSON_RESOLVER = prev
  })

  it('defaults OFF when the env flag is unset', () => {
    delete process.env.DUIN_PERSON_RESOLVER
    expect(personResolverEnabled()).toBe(false)
  })

  it('is ON only for exactly "1"', () => {
    process.env.DUIN_PERSON_RESOLVER = '1'
    expect(personResolverEnabled()).toBe(true)
    process.env.DUIN_PERSON_RESOLVER = 'true'
    expect(personResolverEnabled()).toBe(false)
  })
})
