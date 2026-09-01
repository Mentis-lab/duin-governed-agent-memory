// Write the interview-generated foundation files (ME.md + BRAIN.md) to a notes-dir
// root, so the grounding loader (brain-root.ts `loadBrain`) picks them up on the next
// turn. This is the write half of the A1 cold-start flow; the pure generator lives in
// the renderer lib (src/lib/brain-identity.ts) and its output is passed here via IPC.
//
// SAFETY: no-clobber by default. A returning user (or one who hand-wrote their own
// identity) must never have it silently overwritten — we only create these when absent
// unless `overwrite` is explicitly set. New file (not an edit) so it stays clear of the
// engine session's in-flight route work in this dir.
//
// SAFETY (the `overwrite: true` branch): the existsSync check above was this module's ONLY
// protection, so a caller that set `overwrite` — for any reason, right or wrong — got a bare
// writeFileSync over the operator's ME.md/BRAIN.md with no snapshot, no tombstone and no diff.
// These are root vault notes; nothing else backs them up. Every sibling identity/note writer in
// this tree already preserves before it replaces (memory-store's snapshotPriorVersion,
// agui-executors' executeWriteNote, doc-save, library-brain-bridge, and import-agent-system's
// preservePriorIdentity, whose doc-comment cites THIS file as the guard it should have reused).
// write-identity was the one that did not. Preserve+record rather than refuse-to-write: replacing
// a stub identity with the real interview one is legitimate — it just has to be recoverable. And
// as vault-trash documents, if the snapshot FAILS the caller must not write: the live bytes are
// the thing at risk and proceeding blind is the one outcome that cannot be undone.

import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join, resolve, sep, basename } from 'path'
import { ensureBrainRoot } from './brain-root'
import { snapshotToTrash } from '../local-brain/vault-trash'

export interface WriteIdentityInput {
  /** The user's notes/vault dir — the root the grounding loader reads from. */
  notesDir: string
  /** ME.md body; '' → skip (no fake identity). */
  meMd: string
  /** BRAIN.md body; always written (grounding needs at least the contract). */
  brainMd: string
  /** When true, overwrite existing foundation files. Default false (no-clobber). */
  overwrite?: boolean
}

export interface WriteIdentityResult {
  ok: boolean
  /** Filenames actually written this call. */
  wrote: string[]
  /** Filenames skipped because they already existed (no-clobber), or because the prior
   *  content could not be preserved before an `overwrite` (an untraceable replacement is
   *  refused rather than performed). */
  skipped: string[]
  /** For each file whose prior content was REPLACED, where that prior content was preserved
   *  (a `.trash` path relative to `notesDir`). Recovery lives in the same place as every other
   *  vault overwrite, and the trash journal records who/when/why. */
  replaced?: Record<string, string>
  error?: string
}

/**
 * Write ME.md / BRAIN.md into `notesDir` (creating the `.brain/` scaffold too).
 * No-clobber by default: an existing file is left untouched and reported in `skipped`.
 * Pure filesystem + electron-free, so it unit-tests against a temp dir.
 */
export function writeIdentityFiles(input: WriteIdentityInput): WriteIdentityResult {
  const notesDir = typeof input.notesDir === 'string' ? input.notesDir.trim() : ''
  if (!notesDir) return { ok: false, wrote: [], skipped: [], error: 'notesDir is required' }
  if (!existsSync(notesDir)) return { ok: false, wrote: [], skipped: [], error: `notesDir not found: ${notesDir}` }

  const wrote: string[] = []
  const skipped: string[] = []
  const replaced: Record<string, string> = {}
  const unpreserved: string[] = []
  const overwrite = input.overwrite === true

  const put = (name: string, body: string): void => {
    if (!body.trim()) return
    const full = join(notesDir, name)
    if (existsSync(full)) {
      if (!overwrite) {
        skipped.push(name)
        return
      }
      // Overwrite was authorized — but authorization is not preservation. Snapshot the live
      // bytes first so the replacement is recoverable and recorded.
      let prior: string | null = null
      try {
        prior = readFileSync(full, 'utf-8')
      } catch {
        // Unreadable prior content is exactly the case worth preserving — snapshot anyway.
      }
      if (prior !== body) {
        const snap = snapshotToTrash(notesDir, full, 'write-identity', `interview identity replaced ${name}`)
        if (!snap.ok) {
          // vault-trash documents the caller's safe side as skipping the destructive write.
          unpreserved.push(`${name}: ${snap.error}`)
          skipped.push(name)
          return
        }
        if (snap.trashRel) replaced[name] = snap.trashRel
      }
    }
    writeFileSync(full, body, 'utf-8')
    wrote.push(name)
  }

  const out = (ok: boolean, error?: string): WriteIdentityResult => ({
    ok,
    wrote,
    skipped,
    ...(Object.keys(replaced).length ? { replaced } : {}),
    ...(error ? { error } : {})
  })

  try {
    put('BRAIN.md', input.brainMd)
    put('ME.md', input.meMd)
    // Scaffold the durable .brain/ root (memory/, skills/, …) — idempotent no-op if present.
    ensureBrainRoot(notesDir)
    // A refused overwrite is a real failure to report, not a silent skip: the caller asked for the
    // identity to supersede and it did not, because the existing file could not be made recoverable.
    if (unpreserved.length) {
      return out(false, `the existing identity could not be preserved: ${unpreserved.join('; ')}`)
    }
    return out(true)
  } catch (err) {
    return out(false, (err as Error)?.message ?? 'write failed')
  }
}

// ----------------------------------------------------------------------------
// Foundations pane writer — the SINGLE safe write path for the operator editing
// the vault-root foundation files (SOUL.md / ME.md / BRAIN.md / GOALS.md) from Settings.
//
// SECURITY SPINE: this writer accepts a BASENAME only, membership-checked against
// FOUNDATION_BASENAMES, then re-asserts that join(vault, name) stays inside the
// resolved vault root. A compromised renderer can at most rewrite these four
// known files (each recoverable from .trash) — never drop arbitrary content
// anywhere under the vault. There is deliberately NO generic vault writer.
//
// It reuses write-identity's invariant verbatim: before overwriting an existing
// file it snapshots the prior bytes to .trash, and if that snapshot FAILS it
// REFUSES the write — an untraceable replacement is never performed. Unlike
// writeIdentityFiles it (a) supports SOUL.md/GOALS.md and (b) allows an empty body, so
// the operator can intentionally clear a file (the prior bytes are still
// snapshotted first).
// ----------------------------------------------------------------------------

/** The exact, exhaustive set of files the Foundations pane may write. Basenames only. */
export const FOUNDATION_BASENAMES = new Set(['SOUL.md', 'ME.md', 'BRAIN.md', 'GOALS.md'])

export interface WriteFoundationResult {
  ok: boolean
  /** true when the body was written to disk this call. */
  wrote: boolean
  /** When an existing file was replaced, the `.trash` path (relative to the vault) its prior
   *  bytes were preserved at, so the operator can recover the version they just overwrote. */
  replacedTrashRel?: string
  error?: string
}

export function writeFoundationFile(vaultDir: string, name: string, body: string): WriteFoundationResult {
  // 1. Whitelist: exact basename membership. This alone excludes every path
  //    component, traversal sequence, drive letter and dotdir — but assert the
  //    negatives explicitly too (defense-in-depth against a future whitelist typo).
  if (typeof name !== 'string' || !FOUNDATION_BASENAMES.has(name)) {
    return { ok: false, wrote: false, error: 'not a foundation file' }
  }
  if (
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('..') ||
    name.includes(':') ||
    basename(name) !== name
  ) {
    return { ok: false, wrote: false, error: 'not a foundation file' }
  }
  if (typeof body !== 'string') return { ok: false, wrote: false, error: 'body must be a string' }

  const dir = typeof vaultDir === 'string' ? vaultDir.trim() : ''
  if (!dir || !existsSync(dir)) return { ok: false, wrote: false, error: `vault dir not found: ${dir}` }

  // 2. Re-assert containment: the resolved target MUST be exactly <resolvedVault>/<name>
  //    and stay under the vault root. Belt-and-suspenders against a whitelist mistake.
  const resolvedVault = resolve(dir)
  const full = join(dir, name)
  const resolvedFull = resolve(full)
  if (resolvedFull !== join(resolvedVault, name) || !resolvedFull.startsWith(resolvedVault + sep)) {
    return { ok: false, wrote: false, error: 'path escapes vault' }
  }

  // 3. Snapshot-before-overwrite; refuse the write if the snapshot fails.
  let replacedTrashRel: string | undefined
  if (existsSync(full)) {
    let prior: string | null = null
    try {
      prior = readFileSync(full, 'utf-8')
    } catch {
      // Unreadable prior content is exactly the case worth preserving — snapshot anyway.
    }
    if (prior !== body) {
      const snap = snapshotToTrash(dir, full, 'foundations-pane', `edited ${name} via Settings`)
      if (!snap.ok) {
        // Same invariant as writeIdentityFiles: the live bytes are the thing at risk, so an
        // un-snapshottable overwrite is refused rather than performed.
        return { ok: false, wrote: false, error: `could not preserve prior ${name}: ${snap.error}` }
      }
      replacedTrashRel = snap.trashRel
    }
  }

  try {
    writeFileSync(full, body, 'utf-8')
  } catch (err) {
    return { ok: false, wrote: false, error: (err as Error)?.message ?? 'write failed' }
  }
  return { ok: true, wrote: true, ...(replacedTrashRel ? { replacedTrashRel } : {}) }
}
