// Shared path jail for tools that accept a caller-supplied absolute path.
//
// Two copies of `isInside` already existed (apply-patch-tool.ts, artifacts-files-store.ts)
// and neither was reachable from the ACT / output tool packs, which is how those packs
// ended up taking any absolute path at all. This is the apply-patch variant — the sounder
// of the two, because `isAbsolute(rel)` is what catches a different Windows drive, where
// `relative()` returns an absolute path rather than a `..` chain.

import { existsSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import { app } from 'electron'
import { getActiveWorkspace } from './workspace-state'
import { readSettings } from './settings-helper'

/** True when `candidate` resolves to a location strictly inside `root`.
 *
 *  Strictly: the root itself is not "inside" it, so a jail can never be satisfied by
 *  naming the root. An empty/unset root is never a match — a jail with no root must
 *  refuse everything, not admit everything. PURE. */
export function isInsideRoot(root: string | undefined | null, candidate: string): boolean {
  if (!root || !root.trim() || !candidate || !candidate.trim()) return false
  try {
    const rel = relative(resolve(root), resolve(candidate))
    // '' ⇒ the root itself. '..' prefix ⇒ escapes upward. absolute ⇒ another drive.
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  } catch {
    return false
  }
}

/** True when `candidate` sits inside ANY of `roots` (blank/undefined roots ignored). PURE. */
export function isInsideAnyRoot(
  roots: readonly (string | undefined | null)[],
  candidate: string
): boolean {
  return roots.some((r) => isInsideRoot(r, candidate))
}

/**
 * Resolve a caller-supplied path, or throw naming the jail it escaped.
 *
 * The message deliberately does NOT echo the resolved path back into an error a model
 * may relay onward — the point of the jail is that this path was not ours to read.
 */
export function assertInsideRoots(
  roots: readonly (string | undefined | null)[],
  candidate: string,
  label: string
): string {
  const known = roots.filter((r): r is string => !!r && !!r.trim())
  if (known.length === 0) {
    throw new Error(`${label}: no permitted directory is configured, so no local path can be read`)
  }
  if (!isInsideAnyRoot(known, candidate)) {
    throw new Error(
      `${label}: refused — the path is outside every permitted directory ` +
        `(${known.length} configured). Move the file into the workspace, the vault, or the ` +
        'artifacts folder, or pass the content inline instead of a path.'
    )
  }
  return resolve(candidate)
}

/**
 * The directories a tool may read a caller-supplied local path from.
 *
 * NOT PURE (reads app paths + settings) — kept beside the predicates so the jail's
 * roots and its rules stay in one place rather than being re-invented per tool pack.
 *
 * Deliberately narrow: the active workspace, the brain vault, and DUIN's own artifacts
 * folder. Somewhere like Downloads is NOT included — widening the jail to wherever a
 * user happens to keep files gives back most of what the jail is for, and the refusal
 * message tells them where to move it instead.
 */
export function permittedLocalRoots(): string[] {
  const roots: (string | undefined)[] = []
  try {
    roots.push(getActiveWorkspace())
  } catch {
    // No Electron app layer (headless/test) — the other roots still apply.
  }
  try {
    const notes = (readSettings() as { localBrainNotesDir?: unknown }).localBrainNotesDir
    if (typeof notes === 'string') roots.push(notes)
  } catch {
    // Unreadable settings must not widen the jail; it just contributes no root.
  }
  try {
    roots.push(join(app.getPath('userData'), 'artifacts'))
  } catch {
    // Same.
  }
  return roots.filter((r): r is string => !!r && !!r.trim())
}

/**
 * Refuse to write over a file that already exists.
 *
 * `export_artifact` / `generate_{pdf,docx,xlsx,pptx}` write a caller-supplied ABSOLUTE
 * path with no existence check, so "save this to my Desktop as notes.docx" silently and
 * permanently replaced whatever was already there — no confirmation, no backup, on
 * every chat surface, from a path the model chose.
 *
 * NOT jailed, deliberately: writing outside the workspace is the entire point of an
 * export, so a root jail here would remove the feature rather than protect it. The
 * destructive part is the clobber, and that is what this refuses.
 *
 * There is deliberately NO caller-settable `overwrite` flag either. Handing the model a
 * switch that disables the guard gives back exactly the capability the guard removes,
 * on the same call it would have clobbered. Replacing a file stays a human act.
 */
export function assertNotOverwriting(target: string, label: string): void {
  if (existsSync(target)) {
    throw new Error(
      `${label}: refused — a file already exists at that path, and overwriting it would ` +
        'be permanent and unprompted. Choose a different filename, or remove the ' +
        'existing file first if replacing it is intended.'
    )
  }
}
