// dirty-guard — unsaved-work protection. There was NONE anywhere in this app.
//
// The two verified losses (audit pattern C):
//   • The Brain note editor: BrainExplorerPanel's detailNode effect calls
//     setEditing(false) UNCONDITIONALLY on every node change, with no autosave, no
//     dirty check and no draft retention — so clicking a [[wikilink]] inside your
//     own unsaved paragraph discards it, and Edit re-seeds from doc.text.
//   • The Foundations editors: Esc, or clicking any other Settings tab, destroys
//     the BRAIN.md / SOUL.md / ME.md / GOALS.md draft, because SettingsDialog
//     unmounts the tab conditionally. There is a dirty badge and no confirm. And
//     PersonalitySettings writes on EVERY KEYSTROKE, which trains exactly the Esc
//     reflex that destroys this.
//
// Two independent mechanisms, because they fail differently:
//   1. A REGISTRY of dirty panes, consulted by every dismissal path (confirm).
//   2. sessionStorage DRAFTS keyed by identity, which make most of these
//      non-lossy with no prompt at all — including a window reload, which no
//      confirm can survive.
// The belt matters more than the braces: a confirm the operator dismisses by
// reflex still loses the work.

/** Registry entry: a stable id → the human label used in the confirm text. */
export type DirtyPanes = Readonly<Record<string, string>>

export function addDirty(panes: DirtyPanes, id: string, label: string): DirtyPanes {
  if (panes[id] === label) return panes
  return { ...panes, [id]: label }
}

export function removeDirty(panes: DirtyPanes, id: string): DirtyPanes {
  if (!(id in panes)) return panes
  const next = { ...panes }
  delete next[id]
  return next
}

/**
 * Which dirty panes are in scope for a dismissal. `scope` is an id PREFIX, so a
 * Settings tab switch can ask about `settings:` without prompting for an unsaved
 * Brain note in a completely different surface. No scope = everything.
 */
export function dirtyIn(panes: DirtyPanes, scope?: string): string[] {
  const ids = Object.keys(panes)
  return scope ? ids.filter((id) => id === scope || id.startsWith(scope)) : ids
}

/** The confirm text. Named panes, deduped, so the operator knows what is at risk. */
export function discardMessage(panes: DirtyPanes, scope?: string): string {
  const labels = [...new Set(dirtyIn(panes, scope).map((id) => panes[id]))]
  const what =
    labels.length === 0
      ? 'unsaved changes'
      : labels.length === 1
        ? labels[0]
        : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
  return `You have unsaved changes in ${what}. Discard them?`
}

/**
 * The decision every dismissal path funnels through. Returns true when it is safe
 * to proceed. `confirm` is injected so this is testable and so a host without
 * window.confirm (a detached surface) cannot silently answer "yes".
 */
export function shouldDiscard(
  panes: DirtyPanes,
  scope: string | undefined,
  confirm: (message: string) => boolean
): boolean {
  if (dirtyIn(panes, scope).length === 0) return true
  return confirm(discardMessage(panes, scope))
}

// ── sessionStorage drafts ────────────────────────────────────────────────────
// Keyed by IDENTITY (node id, foundation filename, workflow name) rather than by
// position, so reopening the same thing restores the same draft. sessionStorage,
// not localStorage: a draft should survive a reload and an accidental navigation,
// not outlive the session and resurrect over a note edited elsewhere since.

const PREFIX = 'duin.draft.'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function storage(): StorageLike | null {
  try {
    return (globalThis as { sessionStorage?: StorageLike }).sessionStorage ?? null
  } catch {
    // Access itself throws in some sandboxed contexts.
    return null
  }
}

export function draftKey(kind: string, identity: string): string {
  return `${PREFIX}${kind}:${identity}`
}

export function saveDraft(key: string, value: string): void {
  try {
    storage()?.setItem(key, value)
  } catch {
    // Quota or a disabled store: losing the belt is survivable, the confirm remains.
  }
}

export function readDraft(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function clearDraft(key: string): void {
  try {
    storage()?.removeItem(key)
  } catch {
    /* ignore */
  }
}

/**
 * Persist a draft only while it DIFFERS from what is saved on disk; drop it the
 * moment it matches. Without this the store fills with drafts identical to the
 * file, and every reopen shows a spurious "restored draft" banner.
 */
export function syncDraft(key: string, draft: string, saved: string): void {
  if (draft === saved) clearDraft(key)
  else saveDraft(key, draft)
}
