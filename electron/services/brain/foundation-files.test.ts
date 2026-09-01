import { describe, it, expect } from 'vitest'
import {
  FOUNDATION_BASENAMES,
  FOUNDATION_FILES,
  IDENTITY_FOUNDATION_ORDER,
  isRootFoundation
} from './foundation-files'

// The point of this file is the FIRST test. Three separate lists used to encode
// "this is not a user note" and nothing kept them in agreement — SOUL.md was
// missing from one of them and the failure was silent. Now there is one list;
// this locks the invariant that the ordered identity subset never drifts out of
// it, which is the same drift in a new costume.
describe('foundation file lists agree', () => {
  it('every identity file is a known foundation file', () => {
    const known = new Set(FOUNDATION_BASENAMES.map((n) => n.toLowerCase()))
    for (const name of IDENTITY_FOUNDATION_ORDER) {
      expect(known.has(name.toLowerCase()), `${name} is not in FOUNDATION_BASENAMES`).toBe(true)
    }
  })

  it('the mover set is exactly the canonical basenames', () => {
    expect([...FOUNDATION_FILES].sort()).toEqual([...FOUNDATION_BASENAMES].sort())
  })

  it('keeps SOUL.md — a relocated character file stops loading silently', () => {
    expect(FOUNDATION_FILES.has('SOUL.md')).toBe(true)
    expect(isRootFoundation('SOUL.md')).toBe(true)
    expect(IDENTITY_FOUNDATION_ORDER).toContain('SOUL.md')
  })

  it('establishes character before the rules that constrain it', () => {
    const soul = IDENTITY_FOUNDATION_ORDER.indexOf('SOUL.md')
    const brain = IDENTITY_FOUNDATION_ORDER.indexOf('BRAIN.md')
    expect(soul).toBeGreaterThanOrEqual(0)
    expect(soul).toBeLessThan(brain)
  })

  it('excludes the files that reach the model another way', () => {
    // In every prompt is expensive; these have a cheaper route (graph, memory
    // block, retrieval). Regressing one into the identity block is a silent
    // per-turn cost, so pin it.
    for (const name of ['GOALS.md', 'MEMORY.md', 'VAULT-MAP.md', 'INDEX.md', 'DIAGNOSIS.md']) {
      expect(IDENTITY_FOUNDATION_ORDER).not.toContain(name)
    }
  })
})

describe('isRootFoundation', () => {
  it('matches root files case-insensitively, either separator style', () => {
    expect(isRootFoundation('brain.md')).toBe(true)
    expect(isRootFoundation('BRAIN.md')).toBe(true)
    expect(isRootFoundation('Vault-Map.md')).toBe(true)
  })

  it('treats a same-named file in a subdirectory as a user note', () => {
    // Load-bearing: the live vault really does hold DUIN/Archive/_pre-migration/BRAIN.md.
    expect(isRootFoundation('DUIN/Archive/_pre-migration/BRAIN.md')).toBe(false)
    expect(isRootFoundation('DUIN\\Archive\\BRAIN.md')).toBe(false)
  })

  it('rejects ordinary notes', () => {
    expect(isRootFoundation('some-note.md')).toBe(false)
    expect(isRootFoundation('')).toBe(false)
  })
})
