// grounding-currency.test.ts — the two halves of the STALE read failure, pinned.
//
// The last test reproduces the real one: a user said they wear a smartwatch daily, later said they
// had worn nothing on their wrists for months, and DUIN recommended a wearable. The superseding note
// was retrieved at RANK 1; the prompt just never said which of the two was current.
import { describe, it, expect } from 'vitest'
import { supersessionsIn, superseders, buildCurrencyBlock, isRetired, MAX_CURRENCY_LINES } from './grounding-currency'
import type { Claim } from './claim-metabolism'

const claim = (o: Partial<Claim> & { id: string; notePath: string }): Claim => ({
  chunkId: o.id, subject: 'user', relation: 'wears', object: 'smartwatch daily',
  validFrom: 1, validTo: null, observedAt: 1, supersededBy: null,
  mutability: 'mutable' as never, justifications: [], verdict: 'current' as never, verdictBy: null,
  ...o
}) as Claim

const STALE = claim({ id: 'c-old', notePath: 's01.md', object: 'smartwatch daily',
                      validTo: 900, verdict: 'contradicted' as never, supersededBy: 'c-new' })
const CURRENT = claim({ id: 'c-new', notePath: 's37.md', object: 'nothing on their wrists' })

describe('supersessionsIn', () => {
  it('finds a retired claim whose source note is in the prompt, and names its replacement', () => {
    const out = supersessionsIn(['s01.md'], [STALE, CURRENT])
    expect(out).toHaveLength(1)
    expect(out[0].stale).toContain('smartwatch daily')
    expect(out[0].replacement).toContain('nothing on their wrists')
    expect(out[0].replacementNoteId).toBe('s37.md')
  })

  it('ignores notes that are not in the prompt', () => {
    expect(supersessionsIn(['s99.md'], [STALE, CURRENT])).toHaveLength(0)
  })

  it('ignores CURRENT claims — only what the metabolism retired is labelled', () => {
    expect(supersessionsIn(['s37.md'], [STALE, CURRENT])).toHaveLength(0)
  })

  it('never labels an OPERATOR-authored fact: the metabolism treats those as evergreen', () => {
    const taught = claim({ id: 'c-t', notePath: 's05.md', validTo: 900,
                           verdict: 'contradicted' as never, operatorAuthored: true })
    expect(supersessionsIn(['s05.md'], [taught])).toHaveLength(0)
  })

  it('reports a retirement even when no replacement claim is named', () => {
    const orphan = claim({ id: 'c-o', notePath: 's02.md', validTo: 900, verdict: 'stale' as never })
    const out = supersessionsIn(['s02.md'], [orphan])
    expect(out[0].replacement).toBeNull()
    expect(buildCurrencyBlock(out)).toContain('a later note supersedes this')
  })

  it('isRetired covers validTo, contradicted and stale', () => {
    expect(isRetired(claim({ id: 'a', notePath: 'n', validTo: 5 }))).toBe(true)
    expect(isRetired(claim({ id: 'b', notePath: 'n', verdict: 'contradicted' as never }))).toBe(true)
    expect(isRetired(claim({ id: 'c', notePath: 'n', verdict: 'stale' as never }))).toBe(true)
    expect(isRetired(claim({ id: 'd', notePath: 'n' }))).toBe(false)
  })
})

describe('superseders — the co-retrieval half', () => {
  it('returns the note carrying the update when only the stale note was retrieved', () => {
    expect(superseders(['s01.md'], [STALE, CURRENT])).toEqual(['s37.md'])
  })

  it('returns nothing when the update is already in context — no pointless re-assembly', () => {
    expect(superseders(['s01.md', 's37.md'], [STALE, CURRENT])).toEqual([])
  })

  it('is empty on an empty ledger, so a vault with no claims behaves exactly as before', () => {
    expect(superseders(['s01.md'], [])).toEqual([])
  })
})

describe('buildCurrencyBlock', () => {
  it('is EMPTY with nothing to say — the prompt stays byte-identical on an un-exercised vault', () => {
    expect(buildCurrencyBlock([])).toBe('')
    expect(buildCurrencyBlock(supersessionsIn([], []))).toBe('')
  })

  it('labels rather than suppresses: it names the stale statement AND its replacement', () => {
    const b = buildCurrencyBlock(supersessionsIn(['s01.md'], [STALE, CURRENT]))
    expect(b).toContain('NO LONGER CURRENT')
    expect(b).toContain('smartwatch daily')     // the stale text is still named, not hidden
    expect(b).toContain('nothing on their wrists')
    expect(b).toMatch(/answer from the newer one/i)
  })

  it('caps output so a pathological ledger cannot flood the prompt', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      claim({ id: `c${i}`, notePath: 's01.md', object: `thing ${i}`, validTo: 9, verdict: 'contradicted' as never }))
    const b = buildCurrencyBlock(supersessionsIn(['s01.md'], many))
    // count LINES (the header repeats the phrase, which is why this counts the '- ' prefix)
    expect(b.match(/^- NO LONGER CURRENT/gm)!.length).toBe(MAX_CURRENCY_LINES)
    expect(b).toContain('more not shown')
  })

  it('REGRESSION — the smartwatch failure: both halves fire on the real shape', () => {
    // retrieval picked only the OLD note; the update lives in s37
    const retrieved = ['s01.md']
    expect(superseders(retrieved, [STALE, CURRENT])).toEqual(['s37.md'])   // (b) co-retrieve it
    const withUpdate = [...retrieved, 's37.md']
    const block = buildCurrencyBlock(supersessionsIn(withUpdate, [STALE, CURRENT]))
    expect(block).toContain('NO LONGER CURRENT')                          // (a) and label which is current
    expect(block).toContain('s37.md')
  })
})
