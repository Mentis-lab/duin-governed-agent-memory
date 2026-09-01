// Convergent construction — the merge that gives the knowledge graph MEMORY across rebuilds so a
// non-deterministic LLM re-extraction can't re-roll the entity set every build (the live 44↔260 churn).
import { describe, it, expect } from 'vitest'
import { convergeConstruction } from './construct'
import type { ConstructedData, ConstructedEntity, ConstructedEdge, ConstructedTriple } from './types'

const ent = (id: string, note: string, label = id): ConstructedEntity => ({
  id,
  kind: 'topic',
  label,
  note
})
const edge = (source: string, target: string, type = 'mentions'): ConstructedEdge =>
  ({ source, target, type } as ConstructedEdge)
const triple = (subject: string, object: string, note: string): ConstructedTriple => ({
  subject,
  relation: 'about',
  object,
  note,
  validFrom: null,
  validUntil: null
})
const data = (over: Partial<ConstructedData> = {}): ConstructedData => ({
  entities: [],
  edges: [],
  classifications: [],
  triples: [],
  ...over
})

describe('convergeConstruction', () => {
  it('first build (no prior) is a passthrough', () => {
    const cur = data({ entities: [ent('topic:a', 'n1')] })
    expect(convergeConstruction(null, cur, new Set(['n1']))).toBe(cur)
  })

  it('UNION: keeps both prior-only and current-only entities', () => {
    const prior = data({ entities: [ent('topic:a', 'n1')] })
    const cur = data({ entities: [ent('topic:b', 'n2')] })
    const m = convergeConstruction(prior, cur, new Set(['n1', 'n2']))
    expect(m.entities.map((e) => e.id).sort()).toEqual(['topic:a', 'topic:b'])
    // current-first ordering (deterministic)
    expect(m.entities[0].id).toBe('topic:b')
  })

  it('RETAIN flakily-missed: a prior entity the run missed but whose note still lives is kept', () => {
    const prior = data({ entities: [ent('topic:a', 'n1'), ent('topic:b', 'n2')] })
    const cur = data({ entities: [ent('topic:a', 'n1')] }) // run happened to miss topic:b this pass
    const m = convergeConstruction(prior, cur, new Set(['n1', 'n2']))
    expect(m.entities.map((e) => e.id).sort()).toEqual(['topic:a', 'topic:b']) // topic:b survives the flaky run
  })

  it('PRUNE deletion: a prior entity whose source note is GONE is dropped', () => {
    const prior = data({ entities: [ent('topic:a', 'n1'), ent('topic:gone', 'deleted-note')] })
    const cur = data({ entities: [ent('topic:a', 'n1')] })
    const m = convergeConstruction(prior, cur, new Set(['n1'])) // deleted-note no longer live
    expect(m.entities.map((e) => e.id)).toEqual(['topic:a']) // topic:gone pruned (real deletion)
  })

  // The live duplicate generator. Extraction is non-deterministic about SLUGS, so the model mints a
  // fresh id every time it meets the same entity — the cross-batch merge documents this and keys on
  // kind+label because of it. Convergence kept keying on `e.id`, so every re-extraction looked like
  // a brand-new entity and the prior was retained beside it: duplicates accrued once per run,
  // forever. Measured on the live brain 2026-07-31 once partial runs began accumulating: 2,277
  // entities carrying 1,970 distinct kind+label pairs, 204 labels holding more than one id.
  it('DEDUP: the same entity re-slugged under a NEW id collapses onto one', () => {
    const prior = data({ entities: [ent('org:acme-old', 'n1', 'Acme Studio')] })
    const cur = data({ entities: [ent('org:acme-new', 'n1', 'Acme Studio')] }) // same entity, fresh slug

    const m = convergeConstruction(prior, cur, new Set(['n1']))

    expect(m.entities).toHaveLength(1)
    expect(m.entities[0].id).toBe('org:acme-new') // current wins
  })

  // Collapsing duplicate NODES must not quietly delete the RELATIONSHIPS they carried. Without the
  // remap the prior edge's endpoint would no longer resolve and the dangling-prune would drop it,
  // so dedup would silently cost edges.
  it('DEDUP: a prior edge is REMAPPED onto the surviving id, not pruned as dangling', () => {
    const prior = data({
      entities: [ent('org:acme-old', 'n1', 'Acme Studio'), ent('topic:x', 'n1', 'X')],
      edges: [edge('org:acme-old', 'topic:x')]
    })
    const cur = data({ entities: [ent('org:acme-new', 'n1', 'Acme Studio')] })

    const m = convergeConstruction(prior, cur, new Set(['n1']))

    expect(m.edges).toHaveLength(1)
    expect(m.edges[0].source).toBe('org:acme-new') // remapped, not dropped
    expect(m.edges[0].target).toBe('topic:x')
  })

  it('DEDUP: an edge BETWEEN two ids that collapse onto one entity is dropped, not kept as a self-loop', () => {
    const prior = data({
      entities: [ent('org:a1', 'n1', 'Acme'), ent('org:a2', 'n1', 'Acme')],
      edges: [edge('org:a1', 'org:a2')]
    })
    const cur = data({ entities: [ent('org:acme', 'n1', 'Acme')] })

    const m = convergeConstruction(prior, cur, new Set(['n1']))

    expect(m.entities).toHaveLength(1)
    expect(m.edges).toHaveLength(0)
  })

  // Stopping the bleeding is not enough on its own. A duplicate already sitting in the prior is
  // only re-collapsed on a run that happens to re-extract that exact label, so filtering
  // prior-against-current would have left the accumulated backlog (307 surplus entities on the live
  // brain) in place indefinitely. Folding collapses the prior against ITSELF too.
  it('DEDUP: duplicates already inside the PRIOR collapse, even when the run never sees them', () => {
    const prior = data({
      entities: [ent('org:a1', 'n1', 'Acme'), ent('org:a2', 'n1', 'Acme'), ent('org:a3', 'n1', 'Acme')],
      edges: [edge('org:a2', 'topic:x')]
    })
    const cur = data({ entities: [ent('topic:x', 'n1', 'X')] }) // this run found something unrelated

    const m = convergeConstruction(prior, cur, new Set(['n1']))

    expect(m.entities.filter((e) => e.label === 'Acme')).toHaveLength(1)
    // …and the edge hanging off the collapsed duplicate followed the survivor.
    expect(m.edges).toHaveLength(1)
    expect(m.edges[0].source).toBe('org:a1')
  })

  it('DEDUP: an entity in both prior and current appears once (current wins)', () => {
    const prior = data({ entities: [ent('topic:a', 'n1', 'old-label')] })
    const cur = data({ entities: [ent('topic:a', 'n1', 'new-label')] })
    const m = convergeConstruction(prior, cur, new Set(['n1']))
    expect(m.entities).toHaveLength(1)
    expect(m.entities[0].label).toBe('new-label') // current wins
  })

  it('EDGES: union + dangling-prune (an edge to a pruned entity is dropped)', () => {
    const prior = data({
      entities: [ent('topic:a', 'n1'), ent('topic:gone', 'deleted-note')],
      edges: [edge('topic:a', 'topic:gone'), edge('topic:a', 'n1')]
    })
    const cur = data({ entities: [ent('topic:a', 'n1')], edges: [] })
    const m = convergeConstruction(prior, cur, new Set(['n1']))
    // topic:gone is pruned, so the edge to it dangles → dropped; the edge to the live note survives
    expect(m.edges).toEqual([edge('topic:a', 'n1')])
  })

  it('TRIPLES: union, retain only those whose provenance note still lives (or is unattributed)', () => {
    const prior = data({
      triples: [triple('a', 'x', 'n1'), triple('b', 'y', 'deleted-note'), triple('c', 'z', '')]
    })
    const cur = data({ triples: [triple('d', 'w', 'n1')] })
    const m = convergeConstruction(prior, cur, new Set(['n1']))
    const keys = m.triples!.map((t) => `${t.subject}:${t.note}`)
    expect(keys).toContain('d:n1') // current
    expect(keys).toContain('a:n1') // prior, note live
    expect(keys).toContain('c:') // prior, unattributed → kept
    expect(keys).not.toContain('b:deleted-note') // prior, note deleted → pruned
  })

  it('FIXPOINT: converging a settled construction over live notes is idempotent', () => {
    const settled = data({
      entities: [ent('topic:a', 'n1'), ent('topic:b', 'n2')],
      edges: [edge('topic:a', 'topic:b')]
    })
    const live = new Set(['n1', 'n2'])
    const once = convergeConstruction(settled, settled, live)
    const twice = convergeConstruction(once, once, live)
    expect(once.entities.map((e) => e.id).sort()).toEqual(['topic:a', 'topic:b'])
    expect(twice.entities.map((e) => e.id).sort()).toEqual(['topic:a', 'topic:b']) // stable — no growth
    expect(twice.edges).toHaveLength(1)
  })
})
