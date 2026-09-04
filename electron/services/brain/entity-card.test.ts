import { describe, it, expect } from 'vitest'
import { assembleEntityCard, sentenceFor, namesOf, materialHashOf, slugName, type CardInputs } from './entity-card'
import type { Claim } from './claim-metabolism'

const DAY = 86_400_000
const NOW = Date.parse('2026-09-03T00:00:00Z')

const claim = (over: Partial<Claim>): Claim => ({
  id: over.id ?? `c-${Math.random().toString(36).slice(2, 8)}`,
  chunkId: 'chunk',
  notePath: 'notes/a.md',
  subject: 'person:tessa-varga',
  relation: 'leads',
  object: 'DUIN',
  validFrom: NOW - 10 * DAY,
  validTo: null,
  observedAt: NOW - 10 * DAY,
  supersededBy: null,
  mutability: 'stable' as Claim['mutability'],
  justifications: [],
  verdict: 'current' as Claim['verdict'],
  verdictBy: null,
  ...over
})

function inputs(over: Partial<CardInputs> = {}): CardInputs {
  return {
    id: 'person:tessa-varga',
    graph: {
      nodes: [
        { id: 'person:tessa-varga', label: 'Tessa VARGA', kind: 'person', layer: 'construction' },
        { id: 'person:tessa', label: 'Tessa', kind: 'person', layer: 'construction' },
        { id: 'topic:duin', label: 'DUIN', kind: 'topic', layer: 'construction' },
        { id: 'org:mentis', label: 'Mentis', kind: 'org', layer: 'construction' },
        { id: 'notes/a.md', label: 'a', kind: 'note', mtime: NOW - 3 * DAY },
        { id: 'notes/b.md', label: 'b', kind: 'note', mtime: NOW - 30 * DAY }
      ],
      links: [
        { source: 'notes/a.md', target: 'person:tessa-varga', type: 'mentions' },
        { source: 'notes/b.md', target: 'person:tessa-varga', type: 'mentions' },
        { source: 'person:tessa-varga', target: 'topic:duin', type: 'owns' },
        { source: 'org:mentis', target: 'person:tessa-varga', type: 'affects' },
        { source: 'person:tessa-varga', target: 'notes/a.md', type: 'wiki' }
      ]
    },
    construction: {
      entities: [{ id: 'person:tessa-varga', kind: 'person', label: 'Tessa VARGA', note: 'notes/b.md' }],
      triples: [
        { subject: 'Tessa Varga', relation: 'prefers', object: 'local-first tools', note: 'notes/a.md' },
        { subject: 'TV', relation: 'reports to', object: 'the board', note: 'notes/b.md', validFrom: '2025-01-01', validUntil: '2026-01-01' },
        { subject: 'Someone else', relation: 'likes', object: 'tea', note: 'notes/b.md' }
      ]
    },
    claims: [
      claim({ id: 'c1' }),
      // the same fact as the triple above, as a claim: the claim wins the dedupe
      claim({ id: 'c2', subject: 'Tessa VARGA', relation: 'prefers', object: 'local-first tools', observedAt: NOW - 2 * DAY }),
      claim({ id: 'c3', relation: 'lives in', object: 'Shanghai', validTo: NOW - DAY, verdict: 'stale' as Claim['verdict'] }),
      // provenance, not a fact
      claim({ id: 'c4', subject: 'notes/a.md', relation: 'mentions', object: 'person:tessa-varga' }),
      // the object is an entity id: shown by its served label
      claim({ id: 'c5', relation: 'advises', object: 'org:mentis', validFrom: NOW - 100 * DAY })
    ],
    aliasGroups: [{ canonicalId: 'person:tessa-varga', canonical: 'Tessa VARGA', aliases: ['TV', 'tessa varga'], by: 'auto' } as never],
    overlay: new Map([['tessa v', 'person:tessa-varga']]),
    readNote: (rel) =>
      rel === 'notes/a.md'
        ? '---\ntitle: a\n---\n# Heading\n\nSome intro line. Tessa VARGA prefers **local-first** tools for [[DUIN|the product]]. Another sentence.'
        : rel === 'notes/b.md'
          ? 'Nothing about anyone here.\n\nTV reports to the board.'
          : null,
    timestamps: { createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
    now: NOW,
    ...over
  }
}

describe('sentenceFor', () => {
  it('returns the first sentence naming the entity, with markdown stripped', () => {
    const s = sentenceFor('# Title\n\nIntro. **Tessa VARGA** owns [[DUIN|the product]]! Later.', ['Tessa VARGA'])
    expect(s).toBe('Tessa VARGA owns the product!')
  })
  it('splits on CJK sentence marks', () => {
    const s = sentenceFor('第一句。云雀是一个项目！第三句。', ['云雀'])
    expect(s).toBe('云雀是一个项目！')
  })
  it('is null when no sentence names the entity', () => {
    expect(sentenceFor('Nothing here.', ['Tessa'])).toBeNull()
    expect(sentenceFor('', ['Tessa'])).toBeNull()
  })
  it('truncates long sentences', () => {
    const s = sentenceFor(`Tessa ${'x'.repeat(400)}`, ['Tessa'], 50)
    expect(s?.length).toBe(50)
    expect(s?.endsWith('…')).toBe(true)
  })
})

describe('namesOf', () => {
  it('collects label, extracted label, slug, alias-group forms and overlay labels once each', () => {
    const names = namesOf('person:tessa-varga', 'Tessa VARGA', 'Tessa Varga', [{ canonicalId: 'person:tessa-varga', canonical: 'Tessa VARGA', aliases: ['TV'], by: 'auto' } as never], new Map([['tessa v', 'person:tessa-varga'], ['other', 'person:x']]))
    expect(names).toEqual(['Tessa VARGA', 'TV', 'tessa v'])
  })
  it('slugName reads the id', () => {
    expect(slugName('person:tessa-varga')).toBe('tessa varga')
    expect(slugName('no-kind')).toBe('no kind')
  })
})

describe('assembleEntityCard', () => {
  it('is null for an unknown id', () => {
    expect(assembleEntityCard(inputs({ id: 'person:nobody' }))).toBeNull()
  })

  it('joins facts by id, label, alias and slug; a claim beats its triple twin; retired facts sort last', () => {
    const card = assembleEntityCard(inputs())!
    expect(card.label).toBe('Tessa VARGA')
    expect(card.kind).toBe('person')
    const rel = card.facts.map((f) => `${f.direction}:${f.relation}:${f.other}:${f.current ? 1 : 0}:${f.source}`)
    expect(rel).toEqual([
      'subject:prefers:local-first tools:1:claim',
      'subject:advises:Mentis:1:claim',
      'subject:leads:DUIN:1:claim',
      'subject:lives in:Shanghai:0:claim',
      'subject:reports to:the board:0:triple'
    ])
    expect(card.factsTotal).toBe(5)
    // a claim's default validFrom (its observation time) is not shown; a stated one is
    expect(card.facts.find((f) => f.relation === 'leads')?.validFrom).toBeNull()
    expect(card.facts.find((f) => f.relation === 'advises')?.validFrom).toBe(new Date(NOW - 100 * DAY).toISOString().slice(0, 10))
  })

  it('keeps typed relations, folds mentions and note links into sources with a sentence each', () => {
    const card = assembleEntityCard(inputs())!
    expect(card.relations).toEqual([
      { type: 'affects', dir: 'in', id: 'org:mentis', label: 'Mentis', kind: 'org' },
      { type: 'owns', dir: 'out', id: 'topic:duin', label: 'DUIN', kind: 'topic' }
    ])
    expect(card.sources.map((s) => s.path)).toEqual(['notes/a.md', 'notes/b.md'])
    expect(card.sources[0].snippet).toBe('Tessa VARGA prefers local-first tools for the product.')
    expect(card.sources[1].snippet).toBe('TV reports to the board.')
    expect(card.sourcesTotal).toBe(2)
  })

  it('reports aliases, first/last seen across evidence, and merge candidates', () => {
    const card = assembleEntityCard(inputs())!
    expect(card.aliases).toEqual(['TV', 'tessa v'])
    expect(card.firstSeen).toBe('2025-01-01T00:00:00.000Z')
    expect(card.facts.some((f) => f.relation === 'mentions')).toBe(false)
    expect(card.lastSeen).toBe('2026-09-01T00:00:00.000Z')
    expect(card.mergeCandidates).toEqual([])
  })

  it('flags a same-label, alias or same-slug node as a merge candidate', () => {
    const i = inputs()
    i.graph.nodes.push({ id: 'topic:tessa-varga', label: 'Tessa Varga', kind: 'topic', layer: 'construction' }, { id: 'person:tv', label: 'TV', kind: 'person', layer: 'construction' })
    const card = assembleEntityCard(i)!
    expect(card.mergeCandidates).toEqual([
      { id: 'topic:tessa-varga', label: 'Tessa Varga', kind: 'topic', reason: 'same-label' },
      { id: 'person:tv', label: 'TV', kind: 'person', reason: 'alias' }
    ])
  })

  it('carries the operator label and the extracted label', () => {
    const i = inputs()
    i.graph.nodes[0] = { ...i.graph.nodes[0], label: 'Tessa', labelBy: 'operator' }
    const card = assembleEntityCard(i)!
    expect(card.labelBy).toBe('operator')
    expect(card.extractedLabel).toBe('Tessa VARGA')
    expect(card.aliases).toContain('Tessa VARGA')
  })

  it('works with no construction cache and no notes', () => {
    const card = assembleEntityCard(inputs({ construction: null, readNote: () => null, claims: [], timestamps: null }))!
    expect(card.facts).toEqual([])
    expect(card.sources.every((s) => s.snippet === null)).toBe(true)
    expect(card.firstSeen).toBe(new Date(NOW - 30 * DAY).toISOString())
  })

  it('material hash is order-independent and changes with the material', () => {
    const a = assembleEntityCard(inputs())!
    const b = assembleEntityCard(inputs())!
    expect(a.materialHash).toBe(b.materialHash)
    const shuffled = materialHashOf({ label: a.label, kind: a.kind, aliases: a.aliases, facts: [...a.facts].reverse(), relations: [...a.relations].reverse(), sources: [...a.sources].reverse() })
    expect(shuffled).toBe(a.materialHash)
    const c = assembleEntityCard(inputs({ claims: [] }))!
    expect(c.materialHash).not.toBe(a.materialHash)
  })
})
