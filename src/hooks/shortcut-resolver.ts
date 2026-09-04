// U8 — pure decision half of `useKeyboardShortcuts`.
//
// It lives in its own module ON PURPOSE: `useKeyboardShortcuts.ts` imports the
// chat store, which reaches `src/lib/ipc-client.ts` and dereferences
// `window.api` at module scope. That makes the hook unimportable in this
// repo's node-only vitest environment (see vitest.config.ts — there is no
// jsdom), so the guard ordering this item fixes could not be tested from
// there. Nothing in this file imports anything.

/** Minimal shape the resolver reads off a KeyboardEvent. Declared structurally
 *  so a plain object is a faithful test fixture. */
export interface ShortcutKeyEvent {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  target?: EventTarget | null
}

/** Store state the resolver needs, passed in rather than read inside so the
 *  decision stays pure. */
export interface ShortcutContext {
  isStreaming: boolean
  settingsOpen: boolean
  searchQuery: string
}

export type ShortcutAction =
  | 'newConversation'
  | 'toggleWorkflowPalette'
  | 'toggleGlobalSearch'
  | 'toggleSidebar'
  | 'attachFiles'
  | 'toggleMemory'
  | 'toggleQuickOpen'
  | 'tool:browser'
  | 'tool:review'
  | 'tool:terminal'
  | 'tool:environment'
  | 'tool:sources'
  | 'toggleSettings'
  | 'cancelStream'
  | 'closeSettings'
  | 'clearSearch'

/**
 * Duck-typed rather than `instanceof HTMLElement`. Two reasons: the resolver is
 * unit tested in a node environment where `HTMLElement` does not exist, and the
 * `instanceof` form is realm-sensitive — an element belonging to another
 * document (webview/iframe) fails the check in the host realm even though it is
 * a genuine editable target.
 */
export function isEditableTarget(target: EventTarget | null | undefined): boolean {
  if (!target || typeof target !== 'object') return false
  const el = target as { tagName?: unknown; isContentEditable?: unknown }
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true
  return el.isContentEditable === true
}

/**
 * Returns the action a key press should trigger, or `null` for "not ours, let
 * it through". The caller must NOT preventDefault on `null` or typing breaks.
 *
 * Two editable-target guards live here and their ORDER is the U8 fix:
 *
 *  - Ctrl/Cmd+K opens the global search palette and had no guard at all, so
 *    Cmd+K inside a Brain note draft opened the palette and the next Enter
 *    navigated away — BrainExplorerPanel discards the draft on detail change.
 *
 *  - Escape's guard existed but was evaluated BELOW the `settingsOpen` branch,
 *    so it never ran for the SOUL.md / ME.md / BRAIN.md / GOALS.md editors
 *    inside Settings (FoundationsSettings): Escape closed the whole Settings
 *    modal and took the unsaved text with it. The guard now runs first.
 *
 * `isStreaming` deliberately stays AHEAD of the editable guard: Escape in the
 * chat composer cancelling the in-flight stream is intended and loses no draft
 * (cancelStream does not touch the composer text).
 */
export function resolveShortcut(e: ShortcutKeyEvent, ctx: ShortcutContext): ShortcutAction | null {
  const mod = e.ctrlKey === true || e.metaKey === true
  const shift = e.shiftKey === true

  // Ctrl/Cmd+N — new conversation
  if (mod && (e.key === 'n' || e.key === 'N')) return 'newConversation'

  // Ctrl/Cmd+Shift+K — workflow command palette (relocated from Cmd+K to free
  // that key for the global search palette below).
  if (mod && shift && (e.key === 'k' || e.key === 'K')) return 'toggleWorkflowPalette'

  // Ctrl/Cmd+K — global search command palette (keyboard-first vault + graph
  // search). U8: never while the caret is in an editor.
  if (mod && !shift && (e.key === 'k' || e.key === 'K')) {
    if (isEditableTarget(e.target)) return null
    return 'toggleGlobalSearch'
  }

  // Ctrl/Cmd+B — toggle sidebar
  if (mod && (e.key === 'b' || e.key === 'B')) return 'toggleSidebar'

  // Ctrl/Cmd+U — open file picker and attach
  if (mod && !shift && (e.key === 'u' || e.key === 'U')) return 'attachFiles'

  // Ctrl/Cmd+Shift+M — open Memory browser
  if (mod && shift && (e.key === 'm' || e.key === 'M')) return 'toggleMemory'

  // Ctrl/Cmd+P — open quick-open palette
  if (mod && !shift && (e.key === 'p' || e.key === 'P')) return 'toggleQuickOpen'

  // Ctrl/Cmd+T — toggle Browser tool
  if (mod && !shift && (e.key === 't' || e.key === 'T')) return 'tool:browser'

  // Ctrl/Cmd+Shift+G — toggle Review tool
  if (mod && shift && (e.key === 'g' || e.key === 'G')) return 'tool:review'

  // Ctrl/Cmd+` — toggle Terminal tool
  if (mod && e.key === '`') return 'tool:terminal'

  // Ctrl/Cmd+Shift+E — toggle Environment mode in the docked panel
  if (mod && shift && (e.key === 'e' || e.key === 'E')) return 'tool:environment'

  // Ctrl/Cmd+Shift+S — toggle Sources mode in the docked panel
  if (mod && shift && (e.key === 's' || e.key === 'S')) return 'tool:sources'

  // Ctrl/Cmd+, — open settings
  if (mod && e.key === ',') return 'toggleSettings'

  // Esc — cancel stream, or close settings, or clear search
  if (e.key === 'Escape') {
    // A modal dialog (ApiKeyModal) owns Escape while it is open. It dismisses itself on the
    // same keydown, and because focus sits on one of its buttons — not an editable target —
    // the resolver used to fire too and close the whole Settings view underneath it.
    if (typeof document !== 'undefined' && document.querySelector('[role="dialog"][aria-modal="true"]')) return null
    if (ctx.isStreaming) return 'cancelStream'
    // U8: this guard used to sit BELOW `settingsOpen`, which made the
    // Foundations editors unrecoverable. Sidebar's search input and the chat
    // composer own their own Escape handling.
    if (isEditableTarget(e.target)) return null
    if (ctx.settingsOpen) return 'closeSettings'
    if (ctx.searchQuery) return 'clearSearch'
  }

  return null
}
