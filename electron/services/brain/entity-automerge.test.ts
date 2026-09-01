// entity-automerge.test — the policy that decides whether a duplicate merges unattended.
//
// The tests that matter here are the REFUSALS. A merge collapses two entities into one and is
// close to invisible afterwards, so a wrong auto-merge is far more expensive than a missed one.
// The containment cases below are the whole reason this is not just "lower the cosine".
import { describe, it, expect } from 'vitest'
import {
  tokensOf,
  isContained,
  hasContainmentSpine,
  decideAutoMerges,
  toAliasGroup,
  applyAutoMerges,
  AUTOMERGE_MIN_COSINE
} from './entity-automerge'
import type { AliasGroup } from './entity-resolver'
import type { AliasCandidate } from './entity-resolver'

const cand = (canonical: string, members: string[]): AliasCandidate => ({ canonical, members })
const always = (v: number) => () => v

describe('containment — evidence, not similarity', () => {
  it('a short form contained in a long one', () => {
    expect(isContained('kepano', 'Steve Kepano Gordon')).toBe(true)
    expect(isContained('北澜', '北澜 (Hokuran)')).toBe(true)
  })

  it('REFUSES two names that merely look alike', () => {
    // The case that makes cosine alone unsafe: very close in embedding space, different people.
    expect(isContained('John Smith', 'Jane Smith')).toBe(false)
    expect(isContained('Jane Smith', 'John Smith')).toBe(false)
    expect(hasContainmentSpine(['John Smith', 'Jane Smith'])).toBe(false)
  })

  it('ignores single-character tokens — an initial is not evidence', () => {
    expect(isContained('J Smith', 'Jane Smith')).toBe(false)
  })

  it('a spine chains every member through the longest label', () => {
    expect(hasContainmentSpine(['kepano', 'steve kepano', 'Steve Kepano Gordon'])).toBe(true)
    expect(hasContainmentSpine(['kepano', 'Steve Kepano Gordon', 'Acme Corp'])).toBe(false)
  })

  it('tokenizes CJK labels without splitting them into nothing', () => {
    expect(tokensOf('北澜 Hokuran').size).toBeGreaterThan(1)
  })
})

describe('decideAutoMerges', () => {
  const kepano = cand('Steve Kepano Gordon', ['kepano', 'Steve Kepano Gordon'])

  it('merges the real-world case from the live vault', () => {
    const [d] = decideAutoMerges([kepano], [], always(0.885 + 0.02))
    expect(d.merged).toBe(true)
  })

  it('refuses below the unattended cosine floor, which is ABOVE the surfacing threshold', () => {
    // 0.886 surfaces for review but must not auto-merge — that gap is the point.
    const [d] = decideAutoMerges([kepano], [], always(0.886))
    expect(d.merged).toBe(false)
    expect(d.reason).toBe('below-cosine')
    expect(AUTOMERGE_MIN_COSINE).toBeGreaterThan(0.86)
  })

  it('refuses a candidate with NO score rather than assuming it is good', () => {
    const [d] = decideAutoMerges([kepano], [], () => undefined)
    expect(d.merged).toBe(false)
    expect(d.reason).toBe('below-cosine')
  })

  it('refuses similar-but-uncontained names even at very high cosine', () => {
    const [d] = decideAutoMerges([cand('Jane Smith', ['John Smith', 'Jane Smith'])], [], always(0.99))
    expect(d.merged).toBe(false)
    expect(d.reason).toBe('no-containment')
  })

  it('refuses a large cluster — likely a topical blob, not one entity', () => {
    const big = cand('Acme', ['Acme', 'Acme Corp', 'Acme Ltd', 'Acme Group'])
    const [d] = decideAutoMerges([big], [], always(0.99))
    expect(d.merged).toBe(false)
    expect(d.reason).toBe('too-many-members')
  })

  it('refuses when the hand-audited whitelist already places members differently', () => {
    const existing: AliasGroup[] = [
      { canonicalId: 'person:a', canonical: 'A', aliases: ['kepano'] },
      { canonicalId: 'person:b', canonical: 'B', aliases: ['steve kepano gordon'] }
    ]
    const [d] = decideAutoMerges([kepano], existing, always(0.99))
    expect(d.merged).toBe(false)
    expect(d.reason).toBe('conflicts-with-whitelist')
  })
})

describe('applyAutoMerges — idempotent by construction', () => {
  const kepano = cand('Steve Kepano Gordon', ['kepano', 'Steve Kepano Gordon'])

  it('appends an approved group and preserves the existing whitelist', () => {
    const existing: AliasGroup[] = [
      { canonicalId: 'project:x', canonical: 'X', aliases: ['x'] }
    ]
    const decisions = decideAutoMerges([kepano], existing, always(0.99))
    const { groups, added } = applyAutoMerges(existing, decisions)
    expect(added).toHaveLength(1)
    expect(groups).toHaveLength(2)
    expect(groups.find((g) => g.canonicalId === 'project:x')).toBeTruthy()
  })

  it('a second pass adds nothing — a repeat tick must be a no-op', () => {
    const first = applyAutoMerges([], decideAutoMerges([kepano], [], always(0.99)))
    const second = applyAutoMerges(first.groups, decideAutoMerges([kepano], first.groups, always(0.99)))
    expect(second.added).toHaveLength(0)
    expect(second.groups).toHaveLength(first.groups.length)
  })

  it('never writes a refused candidate', () => {
    const refused = decideAutoMerges([cand('Jane Smith', ['John Smith', 'Jane Smith'])], [], always(0.99))
    const { added } = applyAutoMerges([], refused)
    expect(added).toHaveLength(0)
  })

  it('produces the same row shape a hand-pasted merge would', () => {
    const g = toAliasGroup(kepano)
    expect(g.canonicalId).toBe('person:steve-kepano-gordon')
    expect(g.canonical).toBe('Steve Kepano Gordon')
    expect(g.aliases).toContain('kepano')
  })
})
