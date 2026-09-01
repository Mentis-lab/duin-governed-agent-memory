// P4 — the Tier-1 GRAPH-PARITY GATE + shipping-whitelist goldens for the identity spine.
//
// The parity gate is the key safety net: it proves the entity resolver (DUIN_ENTITY_RESOLVER,
// now default-ON) is MONOTONIC vs OFF over the SHARED builder buildDuinGraph — dedup MERGES
// nodes, it never DROPS knowledge. Concretely, with the resolver ON:
//   1. no note (spine-anchor) node disappears,
//   2. every real entity still has a representative node (its canonical id),
//   3. note-reachability only GROWS (merging unions edges; it never disconnects),
//   4. the knowledge node-set never grows (dedup collapses the churning fragments).
// This is the guard that a FUTURE whitelist edit can't silently delete knowledge from the graph.
//
// The goldens exercise the ACTIVE whitelist (not an ad-hoc per-call one): the 4 Aurora variants
// collapse to project:曙光 with edges preserved, and two distinct high-degree same-label entities
// do NOT merge (over-merge tripwire).
//
// Cold-start A1 moved the whitelist out of source into per-vault state — `ENTITY_ALIAS` now ships
// EMPTY and `loadAliasGroups`/`setActiveAliasGroups` install the vault's. So these goldens install
// a whitelist the way a loaded vault does, and one extra case pins the shipped default: a fresh
// install with no vault whitelist merges NOTHING.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildDuinGraph } from './build-duin-graph'
import {
  resolveEntityIdentity,
  ENTITY_ALIAS,
  activeAliasGroups,
  setActiveAliasGroups
} from './entity-resolver'
import type { ConstructedData } from './types'

// The whitelist a loaded vault would supply. Canonical ids are deliberately CJK where the
// original goldens were, so the byte-stability coverage is retained.
const VAULT_ALIASES = [
  { canonicalId: 'project:曙光', canonical: '曙光', aliases: ['曙光', 'aurora', 'aurora one', 'morgenstern'] },
  { canonicalId: 'org:northwind', canonical: 'Northwind', aliases: ['northwind', 'northwind inc', 'northwind, inc.'] },
  { canonicalId: 'person:sam-carter', canonical: 'Sam Carter', aliases: ['sam carter', 'sam'] }
]

// Installed at module scope as well as per-test: the parity gate below builds its OFF/ON graphs in
// the describe body (collection time), which runs before any beforeEach hook.
setActiveAliasGroups(VAULT_ALIASES)
beforeEach(() => setActiveAliasGroups(VAULT_ALIASES))
afterEach(() => setActiveAliasGroups(VAULT_ALIASES))

// ──────────────────── local graph helpers (no cross-module coupling) ────────────────────

interface G {
  nodes: Record<string, unknown>[]
  edges: Record<string, unknown>[]
}
const ids = (g: G): Set<string> => new Set(g.nodes.map((n) => String(n.id)))
const isNote = (id: string): boolean => /\.md$/i.test(id)
const noteIds = (g: G): Set<string> => new Set([...ids(g)].filter(isNote))

/** Undirected note-reachability within k hops from a seed (self excluded). */
function reachableNotes(g: G, seed: string, k = 3): Set<string> {
  const adj = new Map<string, Set<string>>()
  const known = ids(g)
  for (const e of g.edges) {
    const s = String(e.source)
    const t = String(e.target)
    if (!known.has(s) || !known.has(t)) continue
    ;(adj.get(s) ?? adj.set(s, new Set()).get(s)!).add(t)
    ;(adj.get(t) ?? adj.set(t, new Set()).get(t)!).add(s)
  }
  const dist = new Map<string, number>([[seed, 0]])
  const reached = new Set<string>()
  let frontier = [seed]
  for (let d = 1; d <= k; d++) {
    const next: string[] = []
    for (const u of frontier)
      for (const v of adj.get(u) ?? []) {
        if (dist.has(v)) continue
        dist.set(v, d)
        next.push(v)
        if (v !== seed && isNote(v)) reached.add(v)
      }
    frontier = next
  }
  return reached
}

const base = (over: Partial<ConstructedData> = {}): ConstructedData => ({
  entities: [],
  edges: [],
  classifications: [],
  triples: [],
  ...over
})

// The base note graph (spine anchors) shared by every case — these MUST never be dropped.
const NOTE_BASE = {
  nodes: [
    { id: '曙光/pitch.md', label: 'pitch', kind: 'note' },
    { id: '曙光/roadmap.md', label: 'roadmap', kind: 'note' },
    { id: 'People/Sam.md', label: 'Sam', kind: 'note' },
    { id: 'inbox/raw.md', label: 'raw', kind: 'note' }
  ],
  edges: [{ source: '曙光/pitch.md', target: '曙光/roadmap.md', type: 'wiki' }]
}

/** Build the MAP-shape graph (undirected dedup, construction layer) from a construction. */
function buildMap(c: ConstructedData): G {
  return buildDuinGraph({
    base: { nodes: NOTE_BASE.nodes, edges: NOTE_BASE.edges },
    construction: c,
    dedup: 'undirected',
    productLayer: 'construction'
  })
}

// ──────────────────── the monotonicity parity gate ────────────────────

describe('identity-spine parity gate — resolver ON is MONOTONIC vs OFF (never drops knowledge)', () => {
  // A fragmented construction: the project minted 4 ways (the live churn) + the org twice, each
  // entity tethered to a provenance note, plus inter-entity edges. The shape the resolver folds.
  const fragmented = base({
    entities: [
      { id: 'project:aurora', kind: 'project', label: 'Aurora', note: '曙光/pitch.md' },
      { id: 'project:moon', kind: 'project', label: '曙光', note: '曙光/roadmap.md' },
      { id: 'project:aurora-one', kind: 'project', label: 'Aurora One', note: '曙光/pitch.md' },
      { id: 'project:morgenstern', kind: 'project', label: 'Morgenstern', note: '曙光/roadmap.md' },
      { id: 'org:northwind', kind: 'org', label: 'Northwind', note: 'inbox/raw.md' },
      { id: 'org:northwind-inc', kind: 'org', label: 'Northwind Inc', note: 'inbox/raw.md' },
      { id: 'person:sam-carter', kind: 'person', label: 'Sam Carter', note: 'People/Sam.md' }
    ],
    edges: [
      { source: 'project:aurora', target: 'person:sam-carter', type: 'about' },
      { source: 'project:morgenstern', target: 'org:northwind', type: 'about' },
      { source: 'project:moon', target: 'org:northwind-inc', type: 'about' }
    ]
  })

  const off = buildMap(fragmented) // DUIN_ENTITY_RESOLVER OFF (raw construction)
  const on = buildMap(resolveEntityIdentity(fragmented)!) // resolver ON

  it('drops NO note (spine-anchor) node — every gold/seed note survives', () => {
    for (const nid of noteIds(off)) expect(ids(on).has(nid)).toBe(true)
    // all 4 base notes present in both
    expect(noteIds(on).size).toBe(4)
  })

  it('never GROWS the knowledge node-set (dedup only collapses churning fragments)', () => {
    expect(on.nodes.length).toBeLessThanOrEqual(off.nodes.length)
    // project×4 → 1 (3 fewer) and org×2 → 1 (1 fewer); sam-carter already canonical ⇒ 4 fewer.
    expect(off.nodes.length - on.nodes.length).toBe(4)
  })

  it('note-reachability MONOTONICALLY grows (merge unions edges, never disconnects)', () => {
    for (const seed of noteIds(off)) {
      const before = reachableNotes(off, seed)
      const after = reachableNotes(on, seed)
      for (const r of before) expect(after.has(r)).toBe(true) // ON ⊇ OFF
    }
  })

  it('every real entity keeps a representative node at its canonical id (nothing deleted)', () => {
    // Each OFF entity id maps (via the resolver) to a canonical id that MUST exist ON.
    const remapped = resolveEntityIdentity(fragmented)!
    for (const e of remapped.entities) expect(ids(on).has(e.id)).toBe(true)
  })

  it('the resolver is a pure passthrough shape when disabled elsewhere (OFF == raw build)', () => {
    // Sanity: OFF graph is exactly what buildMap(raw) produces — no hidden resolution.
    expect(off.nodes.length).toBe(NOTE_BASE.nodes.length + fragmented.entities.length)
  })
})

// ──────────────────── golden #1: 北澜-dedup over the SHIPPED whitelist ────────────────────

describe('golden — the 4 Aurora variants collapse to project:曙光 (edges preserved)', () => {
  const c = base({
    entities: [
      { id: 'project:aurora', kind: 'project', label: '曙光', note: '曙光/pitch.md' },
      { id: 'project:x1', kind: 'project', label: 'aurora', note: '曙光/pitch.md' },
      { id: 'project:x2', kind: 'project', label: 'aurora one', note: '曙光/roadmap.md' },
      { id: 'project:x3', kind: 'project', label: 'morgenstern', note: '曙光/roadmap.md' }
    ],
    edges: [
      { source: 'project:aurora', target: 'project:x1', type: 'about' },
      { source: 'project:x2', target: 'project:x3', type: 'about' }
    ]
  })

  it('uses the ACTIVE whitelist (no per-call groups) → one canonical id', () => {
    const out = resolveEntityIdentity(c)! // no opts → the groups the vault installed
    expect(new Set(out.entities.map((e) => e.id))).toEqual(new Set(['project:曙光']))
    // edges preserved, endpoints rewired onto the canonical id (self-edges collapse but survive as such)
    for (const ed of out.edges) {
      expect(ed.source).toBe('project:曙光')
      expect(ed.target).toBe('project:曙光')
    }
    // the ACTIVE whitelist is what did it — it is what `loadAliasGroups` installs
    expect(activeAliasGroups().some((g) => g.canonicalId === 'project:曙光')).toBe(true)
  })

  it('the SHIPPED default whitelist is empty, so a fresh install merges nothing', () => {
    // Cold-start A1: 14 hand-audited groups of the author's real people/orgs/projects used to be
    // compiled in and applied by default. A second operator's entities were merged onto them.
    expect(ENTITY_ALIAS).toEqual([])
    setActiveAliasGroups([])
    const out = resolveEntityIdentity(c)!
    expect(new Set(out.entities.map((e) => e.id))).toEqual(
      new Set(['project:aurora', 'project:x1', 'project:x2', 'project:x3'])
    )
  })

  it('in the merged graph the 4 fragments become ONE node tethered to its notes', () => {
    const on = buildMap(resolveEntityIdentity(c)!)
    const projectNodes = on.nodes.filter((n) => String(n.id) === 'project:曙光')
    expect(projectNodes).toHaveLength(1)
    // entity→note spine edges (P1) connect the single node to its provenance notes
    const nbrs = new Set(
      on.edges
        .filter((e) => e.source === 'project:曙光' || e.target === 'project:曙光')
        .flatMap((e) => [String(e.source), String(e.target)])
        .filter((id) => /\.md$/i.test(id))
    )
    expect(nbrs.has('曙光/pitch.md')).toBe(true)
    expect(nbrs.has('曙光/roadmap.md')).toBe(true)
  })
})

// ──────────────────── golden #2: over-merge tripwire (distinct entities never fold) ──────────

describe('golden — over-merge tripwire: two distinct high-degree same-label entities do NOT merge', () => {
  it('a bad whitelist entry conflating two real companies is BLOCKED by the tripwire', () => {
    // Both carry the whitelisted label "Northwind" but each anchors a rich, edge-DISJOINT subgraph
    // — the signature of two genuinely-distinct entities. The tripwire must veto the whole group.
    const entities = [
      { id: 'org:aaa', kind: 'org' as const, label: 'Northwind', note: 'a.md' },
      { id: 'org:bbb', kind: 'org' as const, label: 'Northwind', note: 'b.md' }
    ]
    const edges = [
      ...['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((t) => ({ source: 'org:aaa', target: t, type: 'about' as const })),
      ...['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((t) => ({ source: 'org:bbb', target: t, type: 'about' as const }))
    ]
    const out = resolveEntityIdentity(base({ entities, edges }))! // the active whitelist
    // NEITHER was rewritten to the canonical org:northwind.
    expect(out.entities.map((e) => e.id).sort()).toEqual(['org:aaa', 'org:bbb'])
    expect(out.entities.some((e) => e.id === 'org:northwind')).toBe(false)
  })

  it('a NON-whitelisted label (distinct real entity) is never merged', () => {
    const c = base({
      entities: [
        { id: 'person:sam-carter', kind: 'person', label: 'Sam Carter', note: 'a.md' }, // whitelisted → canonical
        { id: 'person:sam-okafor', kind: 'person', label: 'Sam Okafor', note: 'b.md' } // distinct — NOT whitelisted
      ]
    })
    const out = resolveEntityIdentity(c)!
    const outIds = new Set(out.entities.map((e) => e.id))
    expect(outIds.has('person:sam-okafor')).toBe(true) // untouched
    expect(outIds.has('person:sam-carter')).toBe(true) // already canonical
  })
})
