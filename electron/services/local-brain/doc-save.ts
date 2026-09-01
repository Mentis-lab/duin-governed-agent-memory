// doc-save.ts — preserve-before-overwrite for the renderer's note-save path.
//
// Why this module exists: POST /state/doc/save (brain-native-routes-2.ts) was a bare
// mkdirSync + writeFileSync, commented "Create OR overwrite". That is fine for the three
// read-then-write callers (DocView, BrainExplorerPanel, GraphReportPanel all seed their
// draft from fetchDoc, so the new bytes contain the old), but OutputsPanel synthesizes
// BOTH the path and the body from scratch: it slugifies the user-typed title into
// `Outputs/<slug>.md` and writes a fresh 5-line frontmatter stub. Retyping the same title
// to "update my brief" — "Board brief" → board-brief — self-collides exactly, and the
// several hundred lines the note had grown into were overwritten with no .trash entry, no
// journal line and an unqualified toast.success('Output saved'). deriveOutputs projects
// FROM those notes (derive-knowledge.ts isOutput → inFolder(note, ['Outputs'])), so the
// markdown is the source of truth, not a rebuildable cache.
//
// The guard already existed one import away: brain-native-routes-2.ts imports
// tombstoneToTrash from vault-trash and uses it in the sibling /state/doc/delete route;
// vault-trash's snapshotToTrash is documented for precisely this rewrite case, and
// memory-store's structurally identical join(dir, `${slug}.md`) write already calls
// snapshotPriorVersion first. This is the same guard, on the one call site that skipped it.
//
// Shape mirrors executeWriteNote (agui-executors.ts) deliberately: snapshot only when the
// bytes actually change, refuse the destructive write when the prior bytes cannot be
// preserved, and hand the caller the tombstone so somebody is TOLD what was replaced.
// The vault SHOULD self-evolve — so this preserves and records rather than refusing.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { snapshotToTrash } from './vault-trash'

export type DocSaveResult = { ok: true; replaced?: string } | { ok: false; error: string }

/**
 * Write `content` to `absFile`, preserving whatever was there first.
 *
 * `absFile` must already be vault-sandboxed by the caller (docAbspath does this).
 * Returns the trash-relative snapshot name when a prior body was replaced, so the route
 * can report it to the renderer instead of an unqualified success.
 */
export function saveVaultDoc(
  vaultDir: string,
  absFile: string,
  content: string,
  actor = 'ui:doc-save',
  label?: string
): DocSaveResult {
  try {
    let replaced: string | undefined
    if (existsSync(absFile) && !statSync(absFile).isDirectory()) {
      let prior: string | null = null
      try {
        prior = readFileSync(absFile, 'utf-8')
      } catch {
        // Unreadable prior content is exactly the case worth preserving — snapshot anyway.
      }
      if (prior !== content) {
        const s = snapshotToTrash(vaultDir, absFile, actor, `overwritten by ${actor} of ${label ?? absFile}`)
        // vault-trash documents the caller's safe side as skipping the destructive write.
        if (!s.ok) return { ok: false, error: `the existing note could not be preserved: ${s.error}` }
        replaced = s.trashRel
      }
    }
    mkdirSync(dirname(absFile), { recursive: true })
    writeFileSync(absFile, content, 'utf8')
    return { ok: true, ...(replaced ? { replaced } : {}) }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'save failed' }
  }
}
