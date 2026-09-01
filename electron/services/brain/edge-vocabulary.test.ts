import { describe, it, expect } from 'vitest'
import { edgeTypeForClaimRelation, EDGE_TYPE_FALLBACK, RELATION_TO_EDGE } from './construct'

// Phase 1.4 of PLANNING/DUIN_GAP_BRIDGE_PLAN.md, pinned.
//
// The claim path wrote `canonicalRelation()` straight into entity_edges.type. That
// function is a SUPERSESSION SORT KEY — it alphabetizes tokens — so the column
// filled with word-salad: 692 distinct types, 564 of them occurring exactly once,
// and no rebuild path to clear them. One function serving two concepts.
//
// The property that matters is not "does it map nicely", it is **closed**: the
// column can only ever hold a value from the vocabulary.

const CLOSED = new Set([...Object.values(RELATION_TO_EDGE), EDGE_TYPE_FALLBACK])

describe('edgeTypeForClaimRelation is closed', () => {
  it('never returns anything outside the vocabulary', () => {
    // The real word-salad from the live graph, plus junk and edge cases.
    const inputs = [
      'and ceo founder',
      'about confirmed note',
      'from migrated',
      'committed not',
      'date due',
      'because wrong',
      'founder and ceo',
      'decided',
      '11 candidates',
      '2026-04-22 incident',
      'は の に',
      '!!!',
      '',
      '   ',
      'a'.repeat(400)
    ]
    for (const raw of inputs) {
      const out = edgeTypeForClaimRelation(raw)
      expect(CLOSED.has(out), `${JSON.stringify(raw)} -> ${out}`).toBe(true)
    }
  })

  it('falls back rather than inventing a type', () => {
    expect(edgeTypeForClaimRelation('and ceo founder')).toBe(EDGE_TYPE_FALLBACK)
    expect(edgeTypeForClaimRelation('date due')).toBe(EDGE_TYPE_FALLBACK)
    expect(edgeTypeForClaimRelation('')).toBe(EDGE_TYPE_FALLBACK)
  })

  it('recognises the vocabulary it does know, in prose', () => {
    expect(edgeTypeForClaimRelation('about')).toBe('about')
    expect(edgeTypeForClaimRelation('confirmed note about')).toBe('about')
    expect(edgeTypeForClaimRelation('depends on')).toBe('depends')
    expect(edgeTypeForClaimRelation('blocks')).toBe('blocks')
    expect(edgeTypeForClaimRelation('is blocked by')).toBe('blocks')
    expect(edgeTypeForClaimRelation('owns')).toBe('owns')
    expect(edgeTypeForClaimRelation('mentioned')).toBe('mentions')
  })

  it('passes structured types through unchanged', () => {
    // The other two writers already emit these; round-tripping them is what keeps
    // the claim path from forking the vocabulary a second time.
    for (const t of Object.values(RELATION_TO_EDGE)) {
      expect(edgeTypeForClaimRelation(t)).toBe(t)
    }
    expect(edgeTypeForClaimRelation('depends_on')).toBe('depends')
  })

  it('the construction path cannot emit an out-of-vocabulary type either', () => {
    // syncGraphFromConstruction wrote `ed.type` RAW, so the PERSISTED column held
    // `depends_on` while build-duin-graph rendered the same relation as `depends`.
    // Two spellings of one relation, split by writer. Both now map through
    // RELATION_TO_EDGE, so every construction RelationType lands in the closed set.
    for (const [relationType, edgeType] of Object.entries(RELATION_TO_EDGE)) {
      expect(CLOSED.has(edgeType), `${relationType} -> ${edgeType}`).toBe(true)
    }
    // And the specific pair that showed up live: 23 rows of `depends_on`.
    expect(RELATION_TO_EDGE.depends_on).toBe('depends')
    expect(CLOSED.has('depends_on')).toBe(false)
  })

  it('is case- and punctuation-insensitive', () => {
    expect(edgeTypeForClaimRelation('  ABOUT!  ')).toBe('about')
    expect(edgeTypeForClaimRelation('Depends-On')).toBe('depends')
  })
})
