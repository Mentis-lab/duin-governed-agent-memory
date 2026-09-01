import { describe, it, expect } from 'vitest'
import { ARENA_GENERIC, isArenaCandidate } from './arena-folders'

// The one canonical "is this top-level folder a user arena" rule shared by the Spaces
// lens, the Projects rail, and card-project rejection. See ARCHITECTURE/
// EXPLORER_CATEGORIZATION_AUDIT.md P0-1.
describe('isArenaCandidate — the canonical arena rule', () => {
  it('accepts real user arena folder names', () => {
    expect(isArenaCandidate('北澜')).toBe(true)
    expect(isArenaCandidate('AI-strategy')).toBe(true)
  })
  it('rejects dot/underscore folders', () => {
    expect(isArenaCandidate('.obsidian')).toBe(false)
    expect(isArenaCandidate('_agui_outputs')).toBe(false)
  })
  it('rejects generic pillar / doc-container names (case-insensitive)', () => {
    for (const n of ['Documents', 'Outputs', 'DUIN-Docs', 'meta', 'DUIN']) {
      expect(isArenaCandidate(n)).toBe(false)
    }
  })
  it('rejects numbered pillar folders ("04 Notes")', () => {
    expect(isArenaCandidate('04 Notes')).toBe(false)
    expect(isArenaCandidate('09 Rules')).toBe(false)
  })
  it('ARENA_GENERIC holds the doc-container names that were leaking into Projects/Spaces', () => {
    for (const n of ['documents', 'docs', 'duin-docs', 'outputs', 'meta']) {
      expect(ARENA_GENERIC.has(n)).toBe(true)
    }
  })
})
