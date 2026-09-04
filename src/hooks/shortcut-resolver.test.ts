import { describe, it, expect } from 'vitest'
import { resolveShortcut, isEditableTarget, type ShortcutContext } from './shortcut-resolver'

// U8 — the hook needs a DOM to mount and this repo's vitest env is node-only
// (see vitest.config.ts), so the decision half is a pure exported function and
// is asserted here. Same convention as FoundationsSettings.test.tsx.

const IDLE: ShortcutContext = { isStreaming: false, settingsOpen: false, searchQuery: '' }

/** Stand-ins for focused elements. `resolveShortcut` duck-types the target
 *  (node has no HTMLElement), so plain objects are faithful fixtures. */
const TEXTAREA = { tagName: 'TEXTAREA' } as unknown as EventTarget
const INPUT = { tagName: 'INPUT' } as unknown as EventTarget
const CONTENT_EDITABLE = { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget
const PLAIN_DIV = { tagName: 'DIV', isContentEditable: false } as unknown as EventTarget

describe('isEditableTarget', () => {
  it('recognises inputs, textareas and contentEditable hosts', () => {
    expect(isEditableTarget(TEXTAREA)).toBe(true)
    expect(isEditableTarget(INPUT)).toBe(true)
    expect(isEditableTarget(CONTENT_EDITABLE)).toBe(true)
  })

  it('does not claim ordinary elements, null or non-objects', () => {
    expect(isEditableTarget(PLAIN_DIV)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(undefined)).toBe(false)
  })
})

describe('resolveShortcut — Escape ordering (U8)', () => {
  // THE fix. The editable-target guard used to be evaluated AFTER the
  // settingsOpen branch, so Escape inside the SOUL.md / ME.md / BRAIN.md /
  // GOALS.md editors closed the whole Settings modal and discarded the draft.
  it('consults isEditableTarget BEFORE the settingsOpen branch', () => {
    const inEditorWithSettingsOpen = { ...IDLE, settingsOpen: true }
    expect(resolveShortcut({ key: 'Escape', target: TEXTAREA }, inEditorWithSettingsOpen)).toBeNull()
    expect(resolveShortcut({ key: 'Escape', target: INPUT }, inEditorWithSettingsOpen)).toBeNull()
    expect(
      resolveShortcut({ key: 'Escape', target: CONTENT_EDITABLE }, inEditorWithSettingsOpen)
    ).toBeNull()
  })

  it('still closes Settings when Escape comes from a non-editable target', () => {
    expect(
      resolveShortcut({ key: 'Escape', target: PLAIN_DIV }, { ...IDLE, settingsOpen: true })
    ).toBe('closeSettings')
  })

  it('keeps cancelStream ahead of the editable guard (Esc in the composer stops the stream)', () => {
    expect(resolveShortcut({ key: 'Escape', target: TEXTAREA }, { ...IDLE, isStreaming: true })).toBe(
      'cancelStream'
    )
  })

  it('still clears the sidebar search query from a non-editable target', () => {
    expect(
      resolveShortcut({ key: 'Escape', target: PLAIN_DIV }, { ...IDLE, searchQuery: 'abc' })
    ).toBe('clearSearch')
    // ...and never steals Escape from the search input itself.
    expect(resolveShortcut({ key: 'Escape', target: INPUT }, { ...IDLE, searchQuery: 'abc' })).toBeNull()
  })

  it('returns null for Escape with nothing to do, so preventDefault is not called', () => {
    expect(resolveShortcut({ key: 'Escape', target: PLAIN_DIV }, IDLE)).toBeNull()
  })

  // 2026-09-03 (settings evaluation, API Keys): ApiKeyModal dismisses itself on Escape, and
  // because focus sits on one of its buttons the resolver ALSO fired closeSettings, so adding
  // a key from Models closed the whole Settings view. A modal dialog owns Escape while open.
  it('yields Escape to an open modal dialog instead of closing Settings under it', () => {
    const g = globalThis as { document?: unknown }
    const prior = g.document
    g.document = { querySelector: (sel: string) => (sel.includes('aria-modal') ? {} : null) }
    try {
      expect(resolveShortcut({ key: 'Escape', target: PLAIN_DIV }, { ...IDLE, settingsOpen: true })).toBeNull()
      expect(resolveShortcut({ key: 'Escape', target: PLAIN_DIV }, { ...IDLE, isStreaming: true })).toBeNull()
    } finally {
      if (prior === undefined) delete g.document
      else g.document = prior
    }
    // With no dialog in the document the ordinary ordering is untouched.
    expect(resolveShortcut({ key: 'Escape', target: PLAIN_DIV }, { ...IDLE, settingsOpen: true })).toBe('closeSettings')
  })
})

describe('resolveShortcut — Cmd/Ctrl+K guard (U8)', () => {
  it('does not open the global search palette from inside an editor', () => {
    expect(resolveShortcut({ key: 'k', metaKey: true, target: TEXTAREA }, IDLE)).toBeNull()
    expect(resolveShortcut({ key: 'K', ctrlKey: true, target: INPUT }, IDLE)).toBeNull()
    expect(resolveShortcut({ key: 'k', ctrlKey: true, target: CONTENT_EDITABLE }, IDLE)).toBeNull()
  })

  it('still opens the palette from a non-editable target', () => {
    expect(resolveShortcut({ key: 'k', metaKey: true, target: PLAIN_DIV }, IDLE)).toBe(
      'toggleGlobalSearch'
    )
  })

  it('leaves Cmd/Ctrl+Shift+K (workflow palette) on its own branch', () => {
    expect(resolveShortcut({ key: 'k', metaKey: true, shiftKey: true, target: PLAIN_DIV }, IDLE)).toBe(
      'toggleWorkflowPalette'
    )
  })
})

describe('resolveShortcut — extraction parity', () => {
  // Every other binding must resolve exactly as the inline handler did. U8
  // changes ONLY the two guards above; Cmd+N and friends were never guarded
  // and this item does not change that.
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ key: 'n', metaKey: true }, 'newConversation'],
    [{ key: 'b', ctrlKey: true }, 'toggleSidebar'],
    [{ key: 'u', metaKey: true }, 'attachFiles'],
    [{ key: 'm', metaKey: true, shiftKey: true }, 'toggleMemory'],
    [{ key: 'p', metaKey: true }, 'toggleQuickOpen'],
    [{ key: 't', metaKey: true }, 'tool:browser'],
    [{ key: 'g', metaKey: true, shiftKey: true }, 'tool:review'],
    [{ key: '`', metaKey: true }, 'tool:terminal'],
    [{ key: 'e', metaKey: true, shiftKey: true }, 'tool:environment'],
    [{ key: 's', metaKey: true, shiftKey: true }, 'tool:sources'],
    [{ key: ',', metaKey: true }, 'toggleSettings']
  ]

  it.each(cases)('%o resolves to %s', (ev, expected) => {
    expect(
      resolveShortcut({ key: String(ev.key), ...ev, target: PLAIN_DIV } as never, IDLE)
    ).toBe(expected)
  })

  it('ignores unmodified letters so typing is never swallowed', () => {
    expect(resolveShortcut({ key: 'k', target: PLAIN_DIV }, IDLE)).toBeNull()
    expect(resolveShortcut({ key: 'n', target: TEXTAREA }, IDLE)).toBeNull()
  })
})
