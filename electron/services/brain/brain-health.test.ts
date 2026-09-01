import { describe, it, expect } from 'vitest'
import {
  computeBrainHealth,
  scoreCoherence,
  scoreGrounding,
  scoreFreshness,
  scorePurity,
  connectedComponents,
  reachableNotes,
  distinctEntityCount,
  normLabel,
  isNoteNode,
  type BrainHealthDeps,
  type HealthGraph,
  type HealthEntity
} from './brain-health'

// ──────────────────── fixtures ────────────────────

const BUILT_AT = '2026-07-16T02:00:00.000Z'

/** A clean, well-connected graph: a note hub linking 8 notes, plus 2 construction
 *  entities each TETHERED to their provenance note (the entity→note bridge the
 *  identity-spine fix restores ⇒ entities are in-main AND citable). */
function healthyGraph(): HealthGraph {
  const notes = ['hub.md', 'a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md', 'h.md']
  const nodes = [
    ...notes.map((id) => ({ id, kind: 'note', layer: 'vault', label: id })),
    { id: 'person:theo', kind: 'person', layer: 'construction', label: 'Theo' },
    { id: 'org:acme', kind: 'org', layer: 'construction', label: 'Acme' }
  ]
  const edges = [
    // hub links to every other note (hub is the top-degree seed)
    ...notes.slice(1).map((id) => ({ source: 'hub.md', target: id, type: 'link' })),
    // entities hang off the hub (1-hop entity-neighbours of the seed) …
    { source: 'hub.md', target: 'person:theo', type: 'mentions' },
    { source: 'hub.md', target: 'org:acme', type: 'mentions' },
    // … AND are tethered to their provenance note (the entity→note bridge ⇒ citable)
    { source: 'person:theo', target: 'a.md', type: 'about' },
    { source: 'org:acme', target: 'b.md', type: 'about' }
  ]
  return { nodes, edges }
}

/** Healthy construction: 2 distinct entities, each with a note that resolves. */
function healthyConstruction(): { entities: HealthEntity[]; builtAt: string } {
  return {
    builtAt: '2026-07-16T01:45:00.000Z', // 15 min before the report → fresh
    entities: [
      { id: 'person:theo', kind: 'person', label: 'Theo', note: 'a.md' },
      { id: 'org:acme', kind: 'org', label: 'Acme', note: 'b.md' }
    ]
  }
}

function healthyDeps(): BrainHealthDeps {
  return {
    builtAt: BUILT_AT,
    graph: healthyGraph(),
    construction: healthyConstruction(),
    index: { indexedNoteFiles: 9, indexedChunkFiles: 9, vaultNoteFiles: 9 },
    liveness: { storeGraphLive: true, learningResolved: 7 }
  }
}

/** A fragmented / orphaned / polluted graph: entities float as their own
 *  disconnected island (0 note bridge), duplicate labels, scaffolding + a
 *  prompt-echo fixture, and a stale chunk store. */
function sickGraph(): HealthGraph {
  const nodes = [
    { id: 'hub.md', kind: 'note', layer: 'vault', label: 'Hub' },
    { id: 'a.md', kind: 'note', layer: 'vault', label: 'A' },
    { id: 'b.md', kind: 'note', layer: 'vault', label: 'B' },
    { id: '_concept-index.md', kind: 'note', layer: 'vault', label: 'index' }, // scaffolding
    { id: 'DUIN/Meta/_scratch.md', kind: 'note', layer: 'vault', label: 'meta' }, // scaffolding
    // construction entities — ALL orphaned (no edges to notes), incl. a prompt echo + dupes
    { id: 'person:jordan-lee', kind: 'person', layer: 'construction', label: 'Jordan Lee' },
    { id: 'org:orbis-inc', kind: 'org', layer: 'construction', label: 'Orbis Inc' },
    { id: 'org:orbis-inc-2', kind: 'org', layer: 'construction', label: 'Orbis Inc.' }, // duplicate
    { id: 'org:orbis-inc-3', kind: 'org', layer: 'construction', label: '《Orbis Inc》' } // duplicate
  ]
  const edges = [
    { source: 'hub.md', target: 'a.md', type: 'link' },
    { source: 'hub.md', target: 'b.md', type: 'link' }
    // notes _concept-index/DUIN-Meta are degree-0; entities are a disconnected clump (below)
  ]
  return { nodes, edges }
}

function sickConstruction(): { entities: HealthEntity[]; builtAt: string } {
  return {
    builtAt: '2026-07-15T20:00:00.000Z', // 6h before the report → stale
    entities: [
      { id: 'person:jordan-lee', kind: 'person', label: 'Jordan Lee', note: 'missing/ghost.md' },
      { id: 'org:orbis-inc', kind: 'org', label: 'Orbis Inc', note: 'missing/x.md' },
      { id: 'org:orbis-inc-2', kind: 'org', label: 'Orbis Inc.', note: 'missing/x.md' },
      { id: 'org:orbis-inc-3', kind: 'org', label: '《Orbis Inc》', note: 'missing/x.md' }
    ]
  }
}

function sickDeps(): BrainHealthDeps {
  return {
    builtAt: BUILT_AT,
    graph: sickGraph(),
    construction: sickConstruction(),
    // stale chunk store: 283 chunk files vs 50 real notes (the pollution signal)
    index: { indexedNoteFiles: 40, indexedChunkFiles: 283, vaultNoteFiles: 50 },
    liveness: { storeGraphLive: false, learningResolved: 0 }
  }
}

// ──────────────────── pure helpers ────────────────────

describe('pure graph helpers', () => {
  it('connectedComponents finds the main component + fragment sizes', () => {
    const g: HealthGraph = {
      nodes: [{ id: 'x' }, { id: 'y' }, { id: 'z' }, { id: 'lone' }],
      edges: [{ source: 'x', target: 'y' }, { source: 'y', target: 'z' }]
    }
    const { main, sizes } = connectedComponents(g)
    expect(main.size).toBe(3)
    expect(sizes).toEqual([3, 1])
  })

  it('reachableNotes bounds expansion at k hops and counts only note nodes', () => {
    const g: HealthGraph = {
      nodes: [
        { id: 's.md', kind: 'note', layer: 'vault' },
        { id: 'n1.md', kind: 'note', layer: 'vault' },
        { id: 'person:e', kind: 'person', layer: 'construction' }, // an entity, not a note
        { id: 'n2.md', kind: 'note', layer: 'vault' }, // 2 hops away (s→person:e→n2)
        { id: 'far.md', kind: 'note', layer: 'vault' } // 3 hops → out of range
      ],
      edges: [
        { source: 's.md', target: 'n1.md' },
        { source: 's.md', target: 'person:e' },
        { source: 'person:e', target: 'n2.md' },
        { source: 'n2.md', target: 'far.md' }
      ]
    }
    const reached = reachableNotes(g, 's.md', 2)
    expect(reached.has('n1.md')).toBe(true) // k1 note
    expect(reached.has('n2.md')).toBe(true) // k2 note (through the entity)
    expect(reached.has('far.md')).toBe(false) // k3 — out of range
    expect(reached.has('person:e')).toBe(false) // entity, not counted as a note
    expect(reached.has('s.md')).toBe(false) // excludes the seed
  })

  it('distinctEntityCount folds normalized-label duplicates without an embedder', () => {
    expect(distinctEntityCount(['Orbis Inc', 'Orbis Inc.', '《Orbis Inc》', 'TapTap'])).toBe(2)
  })

  it('distinctEntityCount uses semantic vectors when aligned', () => {
    const labels = ['北澜', 'beilan', 'other']
    const vecs = [
      [1, 0],
      [0.99, 0.14], // ~cosine 0.99 with 北澜 → same entity
      [0, 1]
    ]
    expect(distinctEntityCount(labels, vecs)).toBe(2)
  })

  it('normLabel + isNoteNode classify correctly', () => {
    expect(normLabel('《Orbis Inc.》')).toBe('orbisinc')
    expect(isNoteNode({ id: 'x.md' })).toBe(true)
    expect(isNoteNode({ id: 'person:theo', kind: 'person', layer: 'construction' })).toBe(false)
  })
})

// ──────────────────── COHERENCE ────────────────────

describe('scoreCoherence', () => {
  it('healthy graph: entities reach the spine, no dupes, one component → high', () => {
    const r = scoreCoherence(healthyDeps())
    expect(r.metrics.entityNoteConnectivity).toBe(1)
    expect(r.metrics.dedupRate).toBe(0)
    expect(r.metrics.mainComponentFraction).toBe(1)
    expect(r.score).toBeGreaterThan(90)
  })

  it('0% entity→note connectivity TANKS coherence (the killer metric)', () => {
    const r = scoreCoherence(sickDeps())
    expect(r.metrics.entityNoteConnectivity).toBe(0) // entities orphaned, notes unresolved
    expect(r.metrics.dedupRate).toBeGreaterThan(0) // orbis-inc ×3 collapse to 1
    expect(r.metrics.mainComponentFraction).toBeLessThan(0.5)
    expect(r.score).toBeLessThan(30)
  })

  it('duplicate entities raise dedupRate and lower the score', () => {
    const clean = scoreCoherence(healthyDeps())
    const dup = scoreCoherence({
      ...healthyDeps(),
      construction: {
        builtAt: healthyConstruction().builtAt,
        entities: [
          ...healthyConstruction().entities,
          { id: 'person:rick2', kind: 'person', label: 'Theo', note: 'a.md' } // dup label
        ]
      }
    })
    expect(dup.metrics.dedupRate).toBeGreaterThan(clean.metrics.dedupRate)
  })

  it('idStability contributes only when injected', () => {
    const withStab = scoreCoherence({ ...healthyDeps(), idStabilityJaccard: 1 })
    expect(withStab.metrics.idStability).toBe(1)
    const without = scoreCoherence(healthyDeps())
    expect('idStability' in without.metrics).toBe(false)
  })
})

// ──────────────────── GROUNDING ────────────────────

describe('scoreGrounding', () => {
  it('healthy graph: seeds reach notes AND have citable folded neighbours → decent', () => {
    const r = scoreGrounding(healthyDeps())
    expect(r.metrics.avgNotesReachedK2).toBeGreaterThan(0)
    // person node folded onto a note id ⇒ its entity-neighbour is citable
    expect(r.metrics.citableNeighborFraction).toBe(1)
    expect(r.score).toBeGreaterThan(0)
  })

  it('orphaned entities → seeds reach NO entities → citable + entity-reachability both 0', () => {
    const r = scoreGrounding(sickDeps())
    expect(r.metrics.entityNeighbours).toBe(0) // note seeds never touch the entity clump
    expect(r.metrics.citableNeighborFraction).toBe(0)
    // ⑧ v1.1 sub-signal: 4 orphaned construction entities, NONE reachable from a note.
    expect(r.metrics.entityNodes).toBe(4)
    expect(r.metrics.entityReachability).toBe(0)
  })

  it('⑧ entity-reachability sub-signal: tethered entities register, orphaned entities do not', () => {
    // healthy: both entities tethered to their provenance note (P1 edge) ⇒ reachable.
    const healthy = scoreGrounding(healthyDeps())
    expect(healthy.metrics.entityNodes).toBe(2)
    expect(healthy.metrics.entityReachability).toBe(1)
    // sick: same entity clump but NO note bridge ⇒ 0 reachable ⇒ drags grounding DOWN.
    const sick = scoreGrounding(sickDeps())
    expect(sick.metrics.entityReachability).toBe(0)
    expect(healthy.score).toBeGreaterThan(sick.score)
  })

  it('reachability scales with connectivity', () => {
    const rich = scoreGrounding(healthyDeps())
    const sparse = scoreGrounding({
      ...healthyDeps(),
      graph: {
        nodes: [{ id: 'a.md', kind: 'note', layer: 'vault' }, { id: 'b.md', kind: 'note', layer: 'vault' }],
        edges: []
      }
    })
    expect(rich.metrics.avgNotesReachedK2).toBeGreaterThan(sparse.metrics.avgNotesReachedK2)
  })
})

// ──────────────────── FRESHNESS ────────────────────

describe('scoreFreshness', () => {
  it('fresh index + recent construction + live cascade + learning → high', () => {
    const r = scoreFreshness(healthyDeps())
    expect(r.metrics.indexCoverage).toBe(1)
    expect(r.metrics.cascadeLive).toBe(1)
    expect(r.metrics.constructionAgeMin).toBeLessThanOrEqual(30)
    expect(r.score).toBeGreaterThan(90)
  })

  it('stale construction + frozen cascade + no learning → low', () => {
    const r = scoreFreshness(sickDeps())
    expect(r.metrics.cascadeLive).toBe(0)
    expect(r.metrics.constructionAgeMin).toBeGreaterThan(180) // 6h old
    expect(r.metrics.learningResolved).toBe(0)
    expect(r.metrics.indexCoverage).toBeLessThan(1)
    expect(r.score).toBeLessThan(50)
  })

  it('construction age within cadence scores full even a few minutes over 0', () => {
    const r = scoreFreshness({
      ...healthyDeps(),
      construction: { entities: [], builtAt: '2026-07-16T01:31:00.000Z' } // 29 min → fresh
    })
    expect(r.metrics.constructionAgeMin).toBeLessThanOrEqual(30)
  })
})

// ──────────────────── PURITY ────────────────────

describe('scorePurity', () => {
  it('clean graph: no scaffolding, no fixtures, chunk store matches notes → high', () => {
    const r = scorePurity(healthyDeps())
    expect(r.metrics.scaffoldingLeak).toBe(0)
    expect(r.metrics.fixtureLeak).toBe(0)
    expect(r.metrics.staleChunkRatio).toBe(1)
    expect(r.score).toBeGreaterThan(90)
  })

  it('scaffolding + prompt-echo entities TANK purity', () => {
    const r = scorePurity(sickDeps())
    expect(r.metrics.fixtureLeak).toBeGreaterThanOrEqual(1) // jordan-lee prompt echo
    expect(r.metrics.scaffoldNodes).toBeGreaterThanOrEqual(2) // _concept-index.md + DUIN/Meta/_scratch.md (both `_`-basename)
    expect(r.metrics.staleChunkRatio).toBeGreaterThan(1) // 283 vs 50 pollution
    expect(r.metrics.degree0Junk).toBeGreaterThan(0)
    expect(r.score).toBeLessThan(50)
  })

  it('P5 "machine files only": DUIN/Meta design cards are KEPT; only `_`-basename files are scaffolding', () => {
    const r = scorePurity({
      ...healthyDeps(),
      graph: {
        nodes: [
          ...healthyGraph().nodes,
          // REAL knowledge — a DUIN/Meta design card with a normal basename → NOT scaffolding (kept).
          { id: 'DUIN/Meta/entity-spine-card.md', kind: 'note', layer: 'vault', label: 'Entity Spine' },
          // A real note inside a `_`-prefixed content DIR (normal filename) → NOT scaffolding (kept).
          { id: '北澜/_原始转录/transcript.md', kind: 'note', layer: 'vault', label: 'transcript' },
          // A machine file (`_`-basename), even under DUIN/Meta → scaffolding (the ONLY flagged node).
          { id: 'DUIN/Meta/_scratch.md', kind: 'note', layer: 'vault', label: 'scratch' }
        ],
        edges: healthyGraph().edges
      }
    })
    expect(r.metrics.scaffoldNodes).toBe(1) // ONLY DUIN/Meta/_scratch.md; the design card + _dir note are kept
  })

  it('a jordan-lee fixture alone is flagged even in an otherwise clean graph', () => {
    const r = scorePurity({
      ...healthyDeps(),
      graph: {
        nodes: [
          ...healthyGraph().nodes,
          { id: 'person:jordan-lee', kind: 'person', layer: 'construction', label: 'Jordan Lee' }
        ],
        edges: healthyGraph().edges
      }
    })
    expect(r.metrics.fixtureLeak).toBe(1)
  })

  it('stale chunk ratio penalizes BOTH over- and under-indexing symmetrically', () => {
    const over = scorePurity({ ...healthyDeps(), index: { indexedNoteFiles: 50, indexedChunkFiles: 200, vaultNoteFiles: 50 } })
    const under = scorePurity({ ...healthyDeps(), index: { indexedNoteFiles: 12, indexedChunkFiles: 12, vaultNoteFiles: 50 } })
    expect(over.metrics.staleChunkRatio).toBe(4)
    expect(under.metrics.staleChunkRatio).toBeCloseTo(0.24, 2)
    // both are far from 1.0 → both depress the stale sub-score
    expect(over.score).toBeLessThan(90)
    expect(under.score).toBeLessThan(90)
  })
})

// ──────────────────── the whole benchmark ────────────────────

describe('computeBrainHealth', () => {
  it('healthy brain scores high overall', () => {
    const rep = computeBrainHealth(healthyDeps())
    expect(rep.overall).toBeGreaterThan(85)
    expect(rep.builtAt).toBe(BUILT_AT)
    expect(['coherence', 'grounding', 'freshness', 'purity']).toContain(rep.weakestAxis)
  })

  it('sick brain scores low overall and names a weak axis', () => {
    const rep = computeBrainHealth(sickDeps())
    expect(rep.overall).toBeLessThan(45)
    // coherence (0 connectivity) or purity (leaks) should be the weakest
    expect(['coherence', 'grounding', 'purity']).toContain(rep.weakestAxis)
  })

  it('injects builtAt verbatim (the pure fn never reads a clock)', () => {
    const rep = computeBrainHealth({ ...healthyDeps(), builtAt: '1999-01-01T00:00:00.000Z' })
    expect(rep.builtAt).toBe('1999-01-01T00:00:00.000Z')
  })

  it('respects axis-weight overrides', () => {
    const base = computeBrainHealth(sickDeps())
    const purityOnly = computeBrainHealth({
      ...sickDeps(),
      weights: { coherence: 0, grounding: 0, freshness: 0, purity: 1 }
    })
    expect(purityOnly.overall).toBe(base.axes.purity.score)
  })

  it('degrades gracefully with no construction (component-only coherence)', () => {
    const rep = computeBrainHealth({ ...healthyDeps(), construction: null })
    expect(rep.axes.coherence.notes).toContain('unmeasurable')
    expect(Number.isFinite(rep.overall)).toBe(true)
  })
})
