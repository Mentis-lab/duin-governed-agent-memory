import { describe, it, expect } from 'vitest'
import { normalizeStoreId, normalizeEdgeEndpoint, STORE_PROJECT_ALIAS } from './canonical-id'

describe('normalizeStoreId — canonical DUIN-native id normalization', () => {
  it('strips vault:/ on person/org so they merge onto the note node', () => {
    expect(normalizeStoreId('vault:/ARGOSY/Noah Kell.md', 'person')).toBe('ARGOSY/Noah Kell.md')
    expect(normalizeStoreId('vault:/DUIN/Knowledge/Advantest.md', 'org')).toBe('DUIN/Knowledge/Advantest.md')
  })

  it('is byte-safe on CJK ids (NFC exact-string collision)', () => {
    // The same bytes the entities producer wrote and the note graph carries.
    expect(normalizeStoreId('vault:/DUIN/People/Janey 李.md', 'person')).toBe('DUIN/People/Janey 李.md')
    expect(normalizeStoreId('vault:/北澜/李云娇.md', 'person')).toBe('北澜/李云娇.md')
  })

  it('keeps already-namespaced ids as identity (goal:, construction kind:slug)', () => {
    expect(normalizeStoreId('goal:gaming-ecosystem-brand-synergy', 'goal')).toBe('goal:gaming-ecosystem-brand-synergy')
    expect(normalizeStoreId('project:argosy-fund-i', 'project')).toBe('project:argosy-fund-i')
    expect(normalizeStoreId('person:theo-q', 'person')).toBe('person:theo-q')
  })

  it('kind-prefixes bare cascade ids to prevent cross-kind over-merge', () => {
    expect(normalizeStoreId('221c135f', 'move')).toBe('move:221c135f')
    expect(normalizeStoreId('e8834298', 'insight')).toBe('insight:e8834298')
    expect(normalizeStoreId('R28', 'risk')).toBe('risk:R28')
    expect(normalizeStoreId('P2', 'issue')).toBe('issue:P2')
    expect(normalizeStoreId('beilan-channels', 'track')).toBe('track:beilan-channels')
    expect(normalizeStoreId('erce-2026', 'milestone')).toBe('milestone:erce-2026')
    expect(normalizeStoreId('release-202708', 'release')).toBe('release:release-202708')
  })

  it('does NOT over-merge a bare track onto a construction project of the same slug', () => {
    // `duin` is both a store track and a construction `project:duin` — they must stay distinct.
    expect(normalizeStoreId('duin', 'track')).toBe('track:duin')
    expect(normalizeStoreId('project:duin', 'project')).toBe('project:duin')
    expect(normalizeStoreId('duin', 'track')).not.toBe(normalizeStoreId('project:duin', 'project'))
  })

  it('routes unmapped bare projects to folder:<name> (byte-stable, islands cleanly)', () => {
    expect(normalizeStoreId('04 Notes', 'project')).toBe('folder:04 Notes')
    expect(normalizeStoreId('Documents', 'project')).toBe('folder:Documents')
    // Two distinct CJK folder names must NOT collide (why we keep the raw name, not slug()).
    expect(normalizeStoreId('半导体', 'project')).toBe('folder:半导体')
    expect(normalizeStoreId('影视制作', 'project')).toBe('folder:影视制作')
    expect(normalizeStoreId('半导体', 'project')).not.toBe(normalizeStoreId('影视制作', 'project'))
  })

  it('ships an EMPTY alias table, so no store folder folds by default (cold-start A3)', () => {
    // The table used to carry the author's own store-folder → construction-id mappings, which
    // shipped to every user. It is now extended per vault; the default folds nothing, and an
    // unmapped folder islands cleanly as `folder:<name>` (the case above).
    expect(STORE_PROJECT_ALIAS).toEqual({})
    expect(normalizeStoreId('北澜', 'project')).toBe('folder:北澜')
  })

  it('honours an audited alias when present', () => {
    const saved = STORE_PROJECT_ALIAS['__test__']
    STORE_PROJECT_ALIAS['__test__'] = 'project:test-slug'
    try {
      expect(normalizeStoreId('__test__', 'project')).toBe('project:test-slug')
    } finally {
      if (saved === undefined) delete STORE_PROJECT_ALIAS['__test__']
      else STORE_PROJECT_ALIAS['__test__'] = saved
    }
  })

  it('keeps card ids (globally-unique C-prefix) as identity', () => {
    expect(normalizeStoreId('C260618-a-card-slug', 'card')).toBe(
      'C260618-a-card-slug'
    )
  })

  it('returns empty string for an empty/whitespace id', () => {
    expect(normalizeStoreId('', 'move')).toBe('')
    expect(normalizeStoreId('   ', 'move')).toBe('')
  })
})

describe('normalizeEdgeEndpoint', () => {
  it('maps an endpoint via the node id map, and drops (→"") a dangling one', () => {
    const map = new Map<string, string>([
      ['221c135f', 'move:221c135f'],
      ['vault:/ARGOSY/Noah Kell.md', 'ARGOSY/Noah Kell.md']
    ])
    expect(normalizeEdgeEndpoint('221c135f', map)).toBe('move:221c135f')
    expect(normalizeEdgeEndpoint('vault:/ARGOSY/Noah Kell.md', map)).toBe('ARGOSY/Noah Kell.md')
    expect(normalizeEdgeEndpoint('ghost:missing', map)).toBe('')
  })
})
