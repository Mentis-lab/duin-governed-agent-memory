import { describe, it, expect } from 'vitest'
import { proseTripleClaimId, migrateLegacyProseTripleIds, encClaimSeg } from './claim-ids'
import { constructionClaims } from './claim-extract'
import type { Claim } from './claim-metabolism'
import type { ConstructedData } from './types'

const NOW = Date.UTC(2026, 5, 1) // 2026-06-01, after the retirement date below

describe('proseTripleClaimId', () => {
  it('includes the note so same-fact rows from different notes get distinct ids', () => {
    const a = proseTripleClaimId('Project Atlas', 'targets', 'GA', 'atlas-kickoff.md')
    const b = proseTripleClaimId('Project Atlas', 'targets', 'GA', 'atlas-slip.md')
    expect(a).not.toBe(b)
    expect(a).toContain('atlas-kickoff.md')
    expect(b).toContain('atlas-slip.md')
  })
})

describe('constructionClaims — the note-in-key bug fix', () => {
  it('keeps BOTH same-subject/relation/object triples when they come from different notes', () => {
    const c: ConstructedData = {
      entities: [],
      edges: [],
      classifications: [],
      triples: [
        { subject: 'Project Atlas', relation: 'targets', object: 'GA', note: 'atlas-kickoff.md', validFrom: '2025-06' },
        // a LATER note retires the same fact (validUntil in the past relative to NOW)
        { subject: 'Project Atlas', relation: 'targets', object: 'GA', note: 'atlas-slip.md', validFrom: '2026-01', validUntil: '2026-02-01' }
      ]
    } as ConstructedData

    const claims = constructionClaims(c, NOW)
    // Before the fix this collapsed to ONE claim (second silently dropped by the seen-set).
    expect(claims).toHaveLength(2)
    const byNote = new Map(claims.map((x) => [x.notePath, x]))
    expect(byNote.get('atlas-kickoff.md')!.verdict).toBe('current')
    // the retiring row now survives and its born-retired temporal verdict fires
    const retired = byNote.get('atlas-slip.md')!
    expect(retired.verdict).toBe('stale')
    expect(retired.verdictBy).toBe('temporal')
    expect(retired.validTo).toBe(Date.UTC(2026, 1, 1))
    // ids are distinct
    expect(claims[0].id).not.toBe(claims[1].id)
  })
})

describe('migrateLegacyProseTripleIds', () => {
  const legacy = (over: Partial<Claim> = {}): Claim =>
    ({
      id: 'prose:t:Project Atlas|targets|GA',
      chunkId: 'prose:t:Project Atlas|targets|GA',
      notePath: 'atlas-kickoff.md',
      subject: 'Project Atlas',
      relation: 'targets',
      object: 'GA',
      validFrom: NOW,
      validTo: null,
      observedAt: NOW,
      supersededBy: null,
      mutability: 'stable',
      justifications: ['atlas-kickoff.md'],
      verdict: 'current',
      verdictBy: null,
      source: 'prose',
      ...over
    }) as Claim

  it('re-keys a legacy note-less id using notePath, and matches a fresh extraction id', () => {
    const [m] = migrateLegacyProseTripleIds([legacy()])
    expect(m.id).toBe(proseTripleClaimId('Project Atlas', 'targets', 'GA', 'atlas-kickoff.md'))
    expect(m.chunkId).toBe(m.id) // chunkId tracked the id, migrated together
  })

  it('preserves verdict / reviewState (human pins) and all other fields', () => {
    const pinned = legacy({ verdict: 'stale', verdictBy: 'temporal', reviewState: 'confirmed' } as Partial<Claim>)
    const [m] = migrateLegacyProseTripleIds([pinned])
    expect(m.verdict).toBe('stale')
    expect((m as unknown as { reviewState?: string }).reviewState).toBe('confirmed')
    expect(m.notePath).toBe('atlas-kickoff.md')
  })

  it('is idempotent — an already-migrated 4-segment id is untouched', () => {
    const once = migrateLegacyProseTripleIds([legacy()])
    const twice = migrateLegacyProseTripleIds(once)
    expect(twice[0].id).toBe(once[0].id)
    expect(twice).toBe(once) // no change → same array reference (no needless churn)
  })

  it('leaves prose EDGE claims (prose: without t:) and non-prose claims untouched', () => {
    const edge = legacy({ id: 'prose:person:foo|works_on|project:bar', chunkId: 'prose:person:foo|works_on|project:bar' })
    const decision = legacy({ id: 'dec:d1', chunkId: 'dec:d1', source: 'structured' as Claim['source'] })
    const out = migrateLegacyProseTripleIds([edge, decision])
    expect(out[0].id).toBe('prose:person:foo|works_on|project:bar')
    expect(out[1].id).toBe('dec:d1')
  })

  it('handles an empty notePath consistently with a fresh extraction', () => {
    const [m] = migrateLegacyProseTripleIds([legacy({ notePath: '' })])
    expect(m.id).toBe('prose:t:Project Atlas|targets|GA|')
    expect(m.id).toBe(proseTripleClaimId('Project Atlas', 'targets', 'GA', ''))
  })

  it('escapes the pipe delimiter in a note path (no collision)', () => {
    expect(encClaimSeg('a|b')).toBe('a%7Cb')
  })
})
