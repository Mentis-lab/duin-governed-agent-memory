// Phase P2 (①) — the DEDUP KEYSTONE. Proves resolveEntityIdentity collapses whitelisted
// duplicate entities onto ONE stable canonical id, rewires edges, is IDEMPOTENT under slug
// churn (keyed on LABEL, not slug id), blocks a bad merge via the disjoint-subgraph tripwire,
// does NOT over-merge distinct entities, and is default-OFF. PURE: no I/O.

import { describe, it, expect, afterAll } from 'vitest'
import {
  resolveEntityIdentity,
  entityResolverEnabled,
  proposeAliasGroups,
  buildAliasCandidates,
  slugifyLabel,
  computeAliasCandidatesReport,
  normName,
  ENTITY_ALIAS,
  type AliasGroup,
  type BlockedMerge,
  type EntityRef,
  type AliasCandidateReport
} from './entity-resolver'
import type { ConstructedData } from './types'

const base = (over: Partial<ConstructedData> = {}): ConstructedData => ({
  entities: [],
  edges: [],
  classifications: [],
  triples: [],
  ...over
})

// A tiny test whitelist so tests don't depend on the live census contents.
const TEST_GROUPS: AliasGroup[] = [
  { canonicalId: 'project:北澜', canonical: '北澜', aliases: ['北澜', '《北澜》', 'beilan', 'hokuran'] },
  { canonicalId: 'org:orbis-inc', canonical: 'Orbis Inc', aliases: ['orbis inc', 'orbis incorporated'] },
  { canonicalId: 'person:liam-whitlock', canonical: 'Liam', aliases: ['liam', 'liam whitlock'] }
]

describe('resolveEntityIdentity — merge to canonical', () => {
  it('rewrites every whitelisted-label entity id to the group canonical id (cross-kind)', () => {
    const c = base({
      entities: [
        { id: 'project:beilan', kind: 'project', label: '北澜', note: 'a.md' },
        { id: 'project:hokuran', kind: 'project', label: 'Hokuran', note: 'b.md' },
        // cross-kind: a `project:` slug for what should be an `org:`.
        { id: 'project:orbis-inc', kind: 'project', label: 'Orbis Incorporated', note: 'c.md' }
      ]
    })
    const out = resolveEntityIdentity(c, { groups: TEST_GROUPS })!
    expect(out.entities.map((e) => e.id)).toEqual(['project:北澜', 'project:北澜', 'org:orbis-inc'])
    // labels/kinds/notes preserved — only id changed.
    expect(out.entities[1].label).toBe('Hokuran')
    expect(out.entities[2].kind).toBe('project')
    // PURE — input untouched.
    expect(c.entities[0].id).toBe('project:beilan')
  })

  it('rewires edge endpoints referencing a rewritten id', () => {
    const c = base({
      entities: [
        { id: 'project:beilan', kind: 'project', label: '北澜', note: 'a.md' },
        { id: 'topic:launch', kind: 'topic', label: 'Launch', note: 'a.md' }
      ],
      edges: [
        { source: 'project:beilan', target: 'topic:launch', type: 'about' },
        { source: 'topic:launch', target: 'project:beilan', type: 'about' }
      ]
    })
    const out = resolveEntityIdentity(c, { groups: TEST_GROUPS })!
    expect(out.edges).toEqual([
      { source: 'project:北澜', target: 'topic:launch', type: 'about' },
      { source: 'topic:launch', target: 'project:北澜', type: 'about' }
    ])
    // PURE — input edges untouched.
    expect(c.edges[0].source).toBe('project:beilan')
  })

  it('leaves non-whitelisted labels untouched (no over-merge of distinct entities)', () => {
    const c = base({
      entities: [
        { id: 'person:liam-whitlock', kind: 'person', label: 'Liam Whitlock', note: 'a.md' }, // → canonical
        { id: 'person:michael-chen', kind: 'person', label: 'Michael Chen', note: 'b.md' }, // distinct!
        { id: 'org:acme', kind: 'org', label: 'Acme Co', note: 'c.md' } // not whitelisted
      ]
    })
    const out = resolveEntityIdentity(c, { groups: TEST_GROUPS })!
    expect(out.entities.map((e) => e.id)).toEqual([
      'person:liam-whitlock', // 'Liam Whitlock' → canonical (unchanged, already ==)
      'person:michael-chen', // NOT merged — different label
      'org:acme'
    ])
  })

  it('matches case/whitespace-insensitively, CJK verbatim', () => {
    const c = base({
      entities: [{ id: 'project:x', kind: 'project', label: '  BEILAN  ', note: 'a.md' }]
    })
    const out = resolveEntityIdentity(c, { groups: TEST_GROUPS })!
    expect(out.entities[0].id).toBe('project:北澜')
  })
})

describe('resolveEntityIdentity — idempotence under slug churn', () => {
  // Two rebuilds mint DIFFERENT slug ids for the SAME labels. The label-keyed resolver
  // must produce IDENTICAL output — this is the whole reason it survives the ~30-min churn.
  const rebuildA = base({
    entities: [
      { id: 'project:beilan', kind: 'project', label: '北澜', note: 'a.md' },
      { id: 'project:hokuran', kind: 'project', label: 'Hokuran', note: 'b.md' }
    ],
    edges: [{ source: 'project:beilan', target: 'project:hokuran', type: 'about' }]
  })
  const rebuildB = base({
    entities: [
      // completely different churning slug ids, SAME labels/notes.
      { id: 'project:peilan', kind: 'project', label: '北澜', note: 'a.md' },
      { id: 'project:moon-2', kind: 'project', label: 'Hokuran', note: 'b.md' }
    ],
    edges: [{ source: 'project:peilan', target: 'project:moon-2', type: 'about' }]
  })

  it('different slug ids / same labels → identical canonical output', () => {
    const outA = resolveEntityIdentity(rebuildA, { groups: TEST_GROUPS })!
    const outB = resolveEntityIdentity(rebuildB, { groups: TEST_GROUPS })!
    expect(outA).toEqual(outB)
    expect(outA.entities.map((e) => e.id)).toEqual(['project:北澜', 'project:北澜'])
  })

  it('running the resolver twice is a no-op (already-canonical ids are skipped)', () => {
    const once = resolveEntityIdentity(rebuildA, { groups: TEST_GROUPS })!
    const twice = resolveEntityIdentity(once, { groups: TEST_GROUPS })!
    expect(twice).toEqual(once)
  })
})

describe('resolveEntityIdentity — disjoint-subgraph tripwire', () => {
  it('BLOCKS a merge when two same-label ids have high-degree, edge-disjoint neighbourhoods', () => {
    // Two entities share the label 'Orbis Inc' but each anchors a rich, SEPARATE subgraph
    // (a bad whitelist entry conflating two real companies). Must NOT merge.
    const entities = [
      { id: 'org:aaa', kind: 'org' as const, label: 'Orbis Inc', note: 'a.md' },
      { id: 'org:bbb', kind: 'org' as const, label: 'Orbis Inc', note: 'b.md' }
    ]
    const edges = [
      // aaa's neighbourhood
      ...['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((t) => ({ source: 'org:aaa', target: t, type: 'about' as const })),
      // bbb's neighbourhood — fully disjoint from aaa's
      ...['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((t) => ({ source: 'org:bbb', target: t, type: 'about' as const }))
    ]
    const blockedLog: BlockedMerge[] = []
    const out = resolveEntityIdentity(base({ entities, edges }), {
      groups: TEST_GROUPS,
      onBlocked: (i) => blockedLog.push(i)
    })!
    // Neither id was rewritten.
    expect(out.entities.map((e) => e.id)).toEqual(['org:aaa', 'org:bbb'])
    expect(blockedLog).toHaveLength(1)
    expect(blockedLog[0].canonicalId).toBe('org:orbis-inc')
    expect(blockedLog[0].reason).toBe('disjoint-high-degree')
  })

  it('does NOT block when the duplicates share neighbours (the real-duplicate case)', () => {
    // Both fragments of 北澜 point at a shared hub → clearly the same entity → merge.
    const entities = [
      { id: 'project:beilan', kind: 'project' as const, label: '北澜', note: 'a.md' },
      { id: 'project:hokuran', kind: 'project' as const, label: 'Hokuran', note: 'b.md' }
    ]
    const edges = [
      ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((t) => ({ source: 'project:beilan', target: t, type: 'about' as const })),
      ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((t) => ({ source: 'project:hokuran', target: t, type: 'about' as const }))
    ]
    const out = resolveEntityIdentity(base({ entities, edges }), { groups: TEST_GROUPS })!
    expect(out.entities.every((e) => e.id === 'project:北澜')).toBe(true)
  })

  it('does NOT block low-degree disjoint fragments (below the high-degree threshold)', () => {
    const entities = [
      { id: 'project:beilan', kind: 'project' as const, label: '北澜', note: 'a.md' },
      { id: 'project:hokuran', kind: 'project' as const, label: 'Hokuran', note: 'b.md' }
    ]
    // each degree 1 — disjoint but LOW degree → not a distinct-entity signal.
    const edges = [
      { source: 'project:beilan', target: 'x1', type: 'about' as const },
      { source: 'project:hokuran', target: 'y1', type: 'about' as const }
    ]
    const out = resolveEntityIdentity(base({ entities, edges }), { groups: TEST_GROUPS })!
    expect(out.entities.every((e) => e.id === 'project:北澜')).toBe(true)
  })
})

describe('resolveEntityIdentity — null / no-match', () => {
  it('returns null when construction is null', () => {
    expect(resolveEntityIdentity(null, { groups: TEST_GROUPS })).toBeNull()
  })
  it('returns an equivalent NEW object when nothing matches', () => {
    const c = base({ entities: [{ id: 'org:acme', kind: 'org', label: 'Acme', note: 'a.md' }] })
    const out = resolveEntityIdentity(c, { groups: TEST_GROUPS })!
    expect(out).not.toBe(c)
    expect(out).toEqual(c)
  })
})

describe('entityResolverEnabled — flag default-ON (P3 opt-out kill-switch)', () => {
  const prev = process.env.DUIN_ENTITY_RESOLVER
  afterAll(() => {
    if (prev === undefined) delete process.env.DUIN_ENTITY_RESOLVER
    else process.env.DUIN_ENTITY_RESOLVER = prev
  })
  it('defaults ON when unset (the identity spine is the cornerstone)', () => {
    delete process.env.DUIN_ENTITY_RESOLVER
    expect(entityResolverEnabled()).toBe(true)
  })
  it('is OFF only for exactly "0" (opt-out kill-switch); any other value stays ON', () => {
    process.env.DUIN_ENTITY_RESOLVER = '0'
    expect(entityResolverEnabled()).toBe(false)
    process.env.DUIN_ENTITY_RESOLVER = '1'
    expect(entityResolverEnabled()).toBe(true)
    process.env.DUIN_ENTITY_RESOLVER = 'true'
    expect(entityResolverEnabled()).toBe(true)
  })
})

describe('proposeAliasGroups — SURFACES candidates, never merges', () => {
  it('proposes a NEW cosine cluster not in the whitelist, without touching any construction', () => {
    const labels = ['Foo Corp', 'FooCorp', 'Totally Different']
    // Foo Corp ~ FooCorp (cosine 1.0), Totally Different orthogonal.
    const vecs = [
      [1, 0],
      [1, 0],
      [0, 1]
    ]
    const candidates = proposeAliasGroups(labels, vecs, { groups: TEST_GROUPS })
    expect(candidates).toHaveLength(1)
    expect(candidates[0].members).toEqual(['Foo Corp', 'FooCorp'])
  })
  it('does not re-propose a group already fully covered by the whitelist', () => {
    const labels = ['北澜', 'beilan']
    const vecs = [
      [1, 0],
      [1, 0]
    ]
    expect(proposeAliasGroups(labels, vecs, { groups: TEST_GROUPS })).toHaveLength(0)
  })
})

describe('slugifyLabel — stable <slug> from a label (CJK verbatim)', () => {
  it('lowercases and hyphenates English, keeps CJK letters, drops punctuation', () => {
    expect(slugifyLabel('Orbis Inc')).toBe('orbis-inc')
    expect(slugifyLabel('Orbis, Inc.')).toBe('orbis-inc')
    expect(slugifyLabel('  Theo  Quill ')).toBe('theo-quill')
    expect(slugifyLabel('北澜')).toBe('北澜') // CJK kept verbatim, matching the whitelist convention
  })
})

describe('buildAliasCandidates — enriched review report', () => {
  // Two construction nodes with NEAR-identical labels ('Foo Corp' ~ 'FooCorp'), NOT in the whitelist,
  // plus an orthogonal one. The surfacer must flag exactly the Foo pair, mapped back to their nodes.
  const entities: EntityRef[] = [
    { id: 'org:foo-corp', label: 'Foo Corp', kind: 'org' },
    { id: 'org:foocorp-2', label: 'FooCorp', kind: 'org' },
    { id: 'topic:other', label: 'Totally Different', kind: 'topic' }
  ]
  const labels = ['Foo Corp', 'FooCorp', 'Totally Different']
  const vecs = [
    [1, 0],
    [1, 0],
    [0, 1]
  ]

  it('surfaces the planted un-whitelisted duplicate as ONE enriched group with node ids + paste snippet', () => {
    const out = buildAliasCandidates(entities, labels, vecs, { groups: TEST_GROUPS })
    expect(out).toHaveLength(1)
    const g = out[0]
    expect(g.suggestedCanonicalLabel).toBe('Foo Corp') // longest form (tie → lexicographic)
    expect(g.suggestedCanonicalId).toBe('org:foo-corp') // <kind>:<slug> from the LABEL, not a churn slug
    expect(g.members.map((m) => m.id).sort()).toEqual(['org:foo-corp', 'org:foocorp-2'])
    expect(g.cosineMin).toBeCloseTo(1, 5) // identical vectors → tight cluster
    // paste snippet is a ready-to-drop ENTITY_ALIAS literal.
    expect(g.pasteSnippet).toContain("canonicalId: 'org:foo-corp'")
    expect(g.pasteSnippet).toContain("aliases: ['foo corp', 'foocorp']")
  })

  it('EXCLUDES a pair already fully covered by ENTITY_ALIAS', () => {
    const wl: EntityRef[] = [
      { id: 'project:beilan', label: '北澜', kind: 'project' },
      { id: 'project:x', label: 'beilan', kind: 'project' }
    ]
    // both labels are in TEST_GROUPS' 北澜 group → no new information → not surfaced.
    const out = buildAliasCandidates(wl, ['北澜', 'beilan'], [[1, 0], [1, 0]], { groups: TEST_GROUPS })
    expect(out).toEqual([])
  })

  it('returns [] when there are no near-duplicate labels', () => {
    const distinct: EntityRef[] = [
      { id: 'org:a', label: 'Alpha', kind: 'org' },
      { id: 'org:b', label: 'Beta', kind: 'org' }
    ]
    expect(buildAliasCandidates(distinct, ['Alpha', 'Beta'], [[1, 0], [0, 1]], { groups: TEST_GROUPS })).toEqual([])
  })
})

describe('computeAliasCandidatesReport — the /debug/alias-candidates route core', () => {
  const construction: ConstructedData = base({
    entities: [
      { id: 'org:foo-corp', kind: 'org', label: 'Foo Corp', note: 'a.md' },
      { id: 'org:foocorp-2', kind: 'org', label: 'FooCorp', note: 'b.md' },
      { id: 'topic:other', kind: 'topic', label: 'Totally Different', note: 'c.md' }
    ]
  })
  // A deterministic mock embedder: identical vectors for the Foo pair, orthogonal for the other.
  const mockEmbed = async (texts: string[]): Promise<number[][]> =>
    texts.map((t) => (/foo\s*corp/i.test(t) ? [1, 0] : [0, 1]))

  it('returns well-formed JSON surfacing the un-whitelisted duplicate', async () => {
    const r = (await computeAliasCandidatesReport(construction, mockEmbed)) as {
      candidateCount: number
      candidates: AliasCandidateReport[]
      note: string
      entityCount: number
    }
    expect(r.entityCount).toBe(3)
    expect(r.candidateCount).toBe(1)
    expect(r.candidates[0].members.map((m) => m.id).sort()).toEqual(['org:foo-corp', 'org:foocorp-2'])
    expect(r.note).toContain('SURFACE-ONLY')
  })

  it('returns {error:no-construction} when there are no entities', async () => {
    const r = (await computeAliasCandidatesReport(null, mockEmbed)) as { error: string }
    expect(r.error).toBe('no-construction')
  })

  it('returns {error:embeddings-unavailable} when the embedder yields []', async () => {
    const r = (await computeAliasCandidatesReport(construction, async () => [])) as { error: string; reason: string }
    expect(r.error).toBe('embeddings-unavailable')
    expect(r.reason).toMatch(/embedder/i)
  })
})

describe('ENTITY_ALIAS whitelist integrity', () => {
  it('every canonical id is `<kind>:<slug>` and stable', () => {
    for (const g of ENTITY_ALIAS) expect(g.canonicalId).toMatch(/^[a-z]+:.+/)
  })
  it('no normalized alias key maps to two different canonical ids (zero-conflict audit)', () => {
    const seen = new Map<string, string>()
    for (const g of ENTITY_ALIAS) {
      for (const surface of [g.canonical, ...g.aliases]) {
        const key = normName(surface)
        if (seen.has(key)) expect(seen.get(key)).toBe(g.canonicalId)
        else seen.set(key, g.canonicalId)
      }
    }
  })
})
