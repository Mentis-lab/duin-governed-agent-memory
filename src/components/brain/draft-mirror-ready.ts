// Extracted from BrainExplorerPanel so it stays testable: importing the panel pulls in
// the chat/model stores, which need browser globals this repo's node-only vitest env
// does not provide (see FoundationsSettings.test.tsx on the same constraint).

/** Is the sessionStorage draft mirror safe to sync for this doc?
 *
 *  syncDraft CLEARS the mirror whenever draft === saved, so this predicate is the only
 *  thing standing between a transient load failure and the deletion of an unsaved edit:
 *
 *   - `loading` — on mount both draft and doc.text are '', they compare equal, and the
 *     mirror is cleared milliseconds before the restore path reads it.
 *   - `err` — a failed re-fetch sets `{ loading: false, text: '', err: true }`, which
 *     reproduces that exact empty-equals-empty collapse. This one was missing, so any
 *     reload or reconnect glitch silently deleted the only copy of the unsaved edit —
 *     defeating the belt built to survive precisely that.
 *   - identity — a doc for a different node says nothing about this one.
 *
 *  A load failure means we do not KNOW what is saved, and not knowing must never
 *  authorise a delete. PURE, and exported so that stays falsifiable: this repo's vitest
 *  env has no jsdom, so the panel's behaviour is tested through helpers like this one.
 */
export function draftMirrorReady(
  doc: { nodeId: string | null; loading: boolean; err: boolean },
  selectedNodeId: string | null | undefined
): boolean {
  if (!doc.nodeId || doc.nodeId !== selectedNodeId) return false
  return !doc.loading && !doc.err
}
