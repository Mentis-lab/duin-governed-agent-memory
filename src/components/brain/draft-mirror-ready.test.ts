// Backlog finding 7 (critical). The Brain note editor mirrors unsaved text into
// sessionStorage specifically so it survives a reload — and syncDraft CLEARS that mirror
// whenever draft === saved. The readiness guard already excluded the mount case, where
// both are '' and compare equal. It did NOT exclude the load-FAILURE case, which sets
// `{ loading: false, text: '', err: true }` and reproduces the identical collapse. So any
// transient reload or reconnect glitch silently deleted the only copy of the unsaved edit,
// defeating the exact safety feature built to prevent that.
//
// This repo's vitest env has no jsdom (see FoundationsSettings.test.tsx), so the panel's
// behaviour is tested through the pure predicate the call site uses.

import { describe, it, expect } from 'vitest'
import { draftMirrorReady } from './draft-mirror-ready'

const doc = (over: Partial<{ nodeId: string | null; loading: boolean; err: boolean }> = {}) => ({
  nodeId: 'n1',
  loading: false,
  err: false,
  ...over
})

describe('draftMirrorReady — when the draft mirror may be synced (and therefore cleared)', () => {
  it('is ready for the selected, loaded, healthy doc', () => {
    expect(draftMirrorReady(doc(), 'n1')).toBe(true)
  })

  it('is NOT ready when the fetch failed — the finding', () => {
    // text is '' here, so syncDraft would see draft === saved === '' and wipe the mirror.
    expect(draftMirrorReady(doc({ err: true }), 'n1')).toBe(false)
  })

  it('is NOT ready while loading', () => {
    expect(draftMirrorReady(doc({ loading: true }), 'n1')).toBe(false)
  })

  it('is NOT ready for a doc belonging to a different node', () => {
    expect(draftMirrorReady(doc({ nodeId: 'n2' }), 'n1')).toBe(false)
  })

  it('is NOT ready before any doc has been selected', () => {
    expect(draftMirrorReady(doc({ nodeId: null }), 'n1')).toBe(false)
    expect(draftMirrorReady(doc(), null)).toBe(false)
    expect(draftMirrorReady(doc(), undefined)).toBe(false)
  })

  it('a null nodeId never matches a null selection — two unknowns are not a match', () => {
    // Guards the shape of the identity check: `doc.nodeId === selectedNodeId` alone would
    // return true for null === null and re-open the collapse on a fresh panel.
    expect(draftMirrorReady(doc({ nodeId: null }), null)).toBe(false)
  })
})
