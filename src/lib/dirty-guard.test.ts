import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  addDirty,
  removeDirty,
  dirtyIn,
  discardMessage,
  shouldDiscard,
  draftKey,
  saveDraft,
  readDraft,
  clearDraft,
  syncDraft
} from './dirty-guard'

// U3 — there was NO dirty-state guard anywhere in the app. These pin the decision
// half; the wiring half is in ui-store.dirty.test.ts.

describe('the registry', () => {
  it('adds, removes, and is stable when nothing changed', () => {
    const a = addDirty({}, 'settings:foundations:SOUL.md', 'the SOUL.md editor')
    expect(dirtyIn(a)).toEqual(['settings:foundations:SOUL.md'])
    expect(addDirty(a, 'settings:foundations:SOUL.md', 'the SOUL.md editor')).toBe(a)
    expect(dirtyIn(removeDirty(a, 'settings:foundations:SOUL.md'))).toEqual([])
    expect(removeDirty({}, 'nope')).toEqual({})
  })

  it('scopes by prefix so one surface does not prompt about another', () => {
    // Closing Settings must not ask about an unsaved Brain note.
    const panes = addDirty(addDirty({}, 'settings:foundations:ME.md', 'ME.md'), 'brain:note-editor', 'the note editor')
    expect(dirtyIn(panes, 'settings:')).toEqual(['settings:foundations:ME.md'])
    expect(dirtyIn(panes, 'brain:')).toEqual(['brain:note-editor'])
    expect(dirtyIn(panes)).toHaveLength(2)
  })
})

describe('shouldDiscard', () => {
  const never = (): boolean => false
  const always = (): boolean => true

  it('proceeds without asking when nothing is dirty', () => {
    const asked = vi.fn(() => false)
    expect(shouldDiscard({}, undefined, asked)).toBe(true)
    expect(asked).not.toHaveBeenCalled()
  })

  it('BLOCKS the dismissal when the operator cancels', () => {
    const panes = addDirty({}, 'brain:note-editor', 'the note editor')
    expect(shouldDiscard(panes, 'brain:', never)).toBe(false)
  })

  it('allows it when the operator confirms', () => {
    const panes = addDirty({}, 'brain:note-editor', 'the note editor')
    expect(shouldDiscard(panes, 'brain:', always)).toBe(true)
  })

  it('does not ask about out-of-scope panes', () => {
    const panes = addDirty({}, 'brain:note-editor', 'the note editor')
    const asked = vi.fn(() => false)
    expect(shouldDiscard(panes, 'settings:', asked)).toBe(true)
    expect(asked).not.toHaveBeenCalled()
  })

  it('names what is at risk', () => {
    let panes = addDirty({}, 'settings:foundations:SOUL.md', 'the SOUL.md editor')
    expect(discardMessage(panes)).toBe(
      'You have unsaved changes in the SOUL.md editor. Discard them?'
    )
    panes = addDirty(panes, 'settings:foundations:ME.md', 'the ME.md editor')
    expect(discardMessage(panes)).toBe(
      'You have unsaved changes in the SOUL.md editor and the ME.md editor. Discard them?'
    )
  })
})

describe('sessionStorage drafts', () => {
  let store: Record<string, string>
  beforeEach(() => {
    store = {}
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v
      },
      removeItem: (k: string) => {
        delete store[k]
      }
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keys by IDENTITY, not position, so reopening the same note restores it', () => {
    expect(draftKey('note', 'DUIN/Notes/x.md')).toBe('duin.draft.note:DUIN/Notes/x.md')
    expect(draftKey('foundation', 'SOUL.md')).toBe('duin.draft.foundation:SOUL.md')
  })

  it('round-trips and clears', () => {
    const k = draftKey('note', 'a.md')
    saveDraft(k, 'half a paragraph')
    expect(readDraft(k)).toBe('half a paragraph')
    clearDraft(k)
    expect(readDraft(k)).toBeNull()
  })

  it('syncDraft drops the mirror once the draft matches the file', () => {
    // Otherwise every reopen shows a spurious "restored draft" banner.
    const k = draftKey('note', 'a.md')
    syncDraft(k, 'edited', 'on disk')
    expect(readDraft(k)).toBe('edited')
    syncDraft(k, 'on disk', 'on disk')
    expect(readDraft(k)).toBeNull()
  })

  it('survives a storage that throws — losing the belt must not break the app', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {
        throw new Error('denied')
      }
    })
    const k = draftKey('note', 'a.md')
    expect(() => saveDraft(k, 'x')).not.toThrow()
    expect(readDraft(k)).toBeNull()
    expect(() => clearDraft(k)).not.toThrow()
  })
})
