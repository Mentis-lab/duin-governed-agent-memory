import { useEffect } from 'react'
import { useUiStore } from '@/stores/ui-store'
import { syncDraft, clearDraft } from '@/lib/dirty-guard'

/**
 * Register a pane as holding unsaved edits. Every dismissal path in the app
 * (closeSettings, the Settings tab buttons, brain setDetail, the titlebar close
 * button) consults the same registry, so one hook call protects a pane against
 * all of them.
 *
 *   useDirtyGuard('settings:foundations:SOUL.md', 'the SOUL.md editor', isDirty)
 *
 * The id is a SCOPED path, not a random key: dismissals ask about a prefix, so a
 * Settings close does not prompt over an unsaved Brain note.
 *
 * Unregisters on unmount — a pane that no longer exists cannot be discarded.
 */
export function useDirtyGuard(id: string, label: string, isDirty: boolean): void {
  const markDirty = useUiStore((s) => s.markDirty)
  const clearDirtyPane = useUiStore((s) => s.clearDirty)

  useEffect(() => {
    if (isDirty) markDirty(id, label)
    else clearDirtyPane(id)
  }, [id, label, isDirty, markDirty, clearDirtyPane])

  useEffect(() => {
    return () => clearDirtyPane(id)
  }, [id, clearDirtyPane])
}

/**
 * The BELT half, and the one that matters more: mirror the draft into
 * sessionStorage keyed by identity, so the work survives a reload, a crash, and a
 * confirm the operator dismissed by reflex. Cleared automatically once the draft
 * matches what is saved.
 */
export function useDraftMirror(key: string, draft: string, saved: string, ready: boolean): void {
  useEffect(() => {
    // DO NOT SYNC BEFORE THE EDITOR HAS LOADED. On mount both `draft` and `saved` are the
    // empty initial state, so they compare EQUAL and syncDraft clears the stored draft —
    // deleting the work this belt exists to preserve, milliseconds before the restore path
    // reads it. The belt was destroying exactly the case it was written for: a reload with
    // unsaved edits.
    //
    // `ready` is REQUIRED rather than defaulted true. A default would silently reintroduce
    // this the first time a new caller forgot it, and the failure is invisible — the draft is
    // simply gone, with nothing to observe.
    if (!ready) return
    syncDraft(key, draft, saved)
  }, [key, draft, saved, ready])
}

/** Drop a mirrored draft — call after a successful save or an explicit discard. */
export function dropDraft(key: string): void {
  clearDraft(key)
}
