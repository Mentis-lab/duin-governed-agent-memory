import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, relative, resolve } from 'path'
import { resolveWorkspaceRelative } from './path-utils'
import { messageOf } from './guarded'
import { snapshotToTrash, tombstoneToTrash } from './local-brain/vault-trash'

// Codex-style "Begin/End Patch" envelope with Add/Update/Delete file
// directives. Hand-rolled parser and applier - no shell, no `git apply`,
// no `patch`. Pure module - no electron imports - so the executor is
// unit-testable. Descriptor + registry wiring live in apply-patch-tool-pack;
// permission gating runs at the chat layer.

export interface ApplyPatchArgs {
  patch: string
}

/**
 * Optional context the tool pack supplies. `vaultDir` is
 * `settings.localBrainNotesDir` — the brain vault. It matters because the
 * workspace root DEFAULTS to the vault (workspace-state.ts
 * `vaultWorkspaceFallback`), and can also be a folder *inside* it, so a patch
 * path is very often a hand-authored note rather than tracked source code.
 */
export interface ApplyPatchOptions {
  vaultDir?: string
  /**
   * Opt-in ALL-OR-NOTHING mode. Default (false) is unchanged: destructive
   * branches route through the tombstone journal and a mid-patch write
   * failure surfaces as a PartialApplyError (earlier ops stay on disk,
   * recoverable via .trash). With `atomic: true` the applier snapshots the
   * bytes + existence of every affected file BEFORE the write loop and, on
   * ANY write-phase failure, restores every snapshot so the workspace ends
   * exactly as it began — then reports a plain `Error:` with no "partially
   * applied" warning (because nothing remains applied).
   *
   * The proposed-edit accept path sets this: a non-coder clicking Apply
   * expects the change to either land whole or not at all, never half.
   */
  atomic?: boolean
}

export interface ApplyPatchResult {
  result: string
}

type FileOp =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; hunks: Hunk[] }

interface Hunk {
  // Optional anchor (the `@@ <context>` line). We don't currently use the
  // anchor for matching — the deletion+context block has to find itself in
  // file order — but we capture it so error messages can identify the hunk.
  anchor?: string
  // Mixed body: each entry is a tag + raw line. `keep` (context) and
  // `remove` lines must match the file in sequence; `add` lines insert.
  body: BodyLine[]
}

type BodyLine =
  | { tag: 'keep'; text: string }
  | { tag: 'remove'; text: string }
  | { tag: 'add'; text: string }

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'

/**
 * Confine a candidate path to the workspace root. Returns the absolute
 * resolved path on success, or null on traversal. Rejects:
 *   - explicit `..` segments in the input
 *   - paths that, once resolved, sit outside the root
 *   - Windows drive-letter absolutes that don't resolve under the root
 */
export function resolvePathWithinWorkspace(
  workspaceRoot: string,
  candidate: string
): string | null {
  if (!candidate || candidate.trim() === '') return null
  // Reject `..` segments outright — even if `path.resolve` would flatten
  // them, an explicit traversal attempt is a smell we'd rather surface.
  const segments = candidate.replace(/\\/g, '/').split('/')
  if (segments.some((s) => s === '..')) return null

  const root = resolve(workspaceRoot)
  const target = resolveWorkspaceRelative(candidate, root)
  const rel = relative(root, target)
  if (rel === '') return null // refusing to operate on the root itself
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return target
}

/**
 * Parse a Codex-style patch envelope into a list of file operations.
 * Throws on malformed input with a message naming the offending line.
 */
export function parsePatch(patch: string): FileOp[] {
  if (typeof patch !== 'string' || patch.trim() === '') {
    throw new Error('patch is required and must be a non-empty string')
  }

  // Normalize line endings; keep trailing-newline information out of the
  // way by splitting and rebuilding.
  const lines = patch.replace(/\r\n/g, '\n').split('\n')

  // Find Begin/End. Allow surrounding blank lines but nothing meaningful
  // before/after.
  let beginIdx = -1
  let endIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === BEGIN) {
      beginIdx = i
      break
    }
    if (lines[i].trim() !== '') {
      throw new Error(`expected "${BEGIN}" header, found: ${JSON.stringify(lines[i])}`)
    }
  }
  if (beginIdx === -1) throw new Error(`missing "${BEGIN}" header`)

  for (let i = lines.length - 1; i > beginIdx; i--) {
    if (lines[i] === END) {
      endIdx = i
      break
    }
    if (lines[i].trim() !== '') {
      throw new Error(`expected "${END}" footer, found trailing content: ${JSON.stringify(lines[i])}`)
    }
  }
  if (endIdx === -1) throw new Error(`missing "${END}" footer`)

  const body = lines.slice(beginIdx + 1, endIdx)
  const ops: FileOp[] = []

  let i = 0
  while (i < body.length) {
    const line = body[i]
    if (line.trim() === '') {
      i++
      continue
    }

    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim()
      if (!path) throw new Error(`Add File directive missing path at body line ${i + 1}`)
      i++
      const addLines: string[] = []
      while (i < body.length && !body[i].startsWith('*** ')) {
        const ln = body[i]
        if (ln === '') {
          // Allow trailing blanks between adds — but only if they're truly
          // empty. A non-empty line that doesn't start with `+` is malformed.
          i++
          continue
        }
        if (!ln.startsWith('+')) {
          throw new Error(
            `Add File "${path}": every content line must start with "+"; got ${JSON.stringify(ln)} at body line ${i + 1}`
          )
        }
        addLines.push(ln.slice(1))
        i++
      }
      ops.push({ kind: 'add', path, lines: addLines })
      continue
    }

    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim()
      if (!path) throw new Error(`Delete File directive missing path at body line ${i + 1}`)
      i++
      // Delete has no body. If the next non-blank line isn't another
      // directive (or end), that's a grammar error.
      while (i < body.length && body[i] === '') i++
      ops.push({ kind: 'delete', path })
      continue
    }

    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim()
      if (!path) throw new Error(`Update File directive missing path at body line ${i + 1}`)
      i++
      const hunks: Hunk[] = []
      let current: Hunk | null = null
      const flush = () => {
        if (current && current.body.length > 0) hunks.push(current)
        current = null
      }
      while (i < body.length && !body[i].startsWith('*** ')) {
        const ln = body[i]
        if (ln.startsWith('@@')) {
          flush()
          current = { anchor: ln.slice(2).trim() || undefined, body: [] }
          i++
          continue
        }
        if (ln === '') {
          // An empty raw line is ambiguous. It is EITHER a context line of ""
          // (a blank line in the source file — models routinely emit it
          // unprefixed instead of as a lone " ", which is why this arm exists)
          // OR the blank separator that ends this file's block before the next
          // `*** ` directive / the `*** End Patch` footer. Only the first
          // reading is content.
          //
          // What made it invisible: this loop only STOPS on `*** `, so a
          // separator fell through to the context arm and silently became a
          // trailing `keep ""` on the last hunk. The sibling branches above
          // already strip theirs (Add's "trailing blanks between adds" skip,
          // Delete's `while (body[i] === '') i++`), so the asymmetry read as
          // deliberate. The phantom line never announces itself: it either
          // makes a CORRECT hunk unmatchable — and since applyOps plans every
          // hunk before any write, that rejects the whole patch while blaming
          // "hunk 1" — or, worse, slides the scan past the right occurrence
          // onto a later one that happens to be followed by a real blank line,
          // editing the wrong place and reporting success.
          //
          // Disambiguate by look-ahead: if nothing but blanks remains before
          // the next directive or the end of the body, these are separators.
          let j = i
          while (j < body.length && body[j] === '') j++
          if (j >= body.length || body[j].startsWith('*** ')) {
            i = j
            continue
          }
          if (!current) current = { body: [] }
          current.body.push({ tag: 'keep', text: '' })
          i++
          continue
        }
        const tag = ln[0]
        const rest = ln.slice(1)
        if (tag === '+') {
          if (!current) current = { body: [] }
          current.body.push({ tag: 'add', text: rest })
        } else if (tag === '-') {
          if (!current) current = { body: [] }
          current.body.push({ tag: 'remove', text: rest })
        } else if (tag === ' ') {
          if (!current) current = { body: [] }
          current.body.push({ tag: 'keep', text: rest })
        } else {
          throw new Error(
            `Update File "${path}": unexpected line prefix ${JSON.stringify(tag)} at body line ${i + 1}; expected "+", "-", " ", or "@@"`
          )
        }
        i++
      }
      flush()
      if (hunks.length === 0) {
        throw new Error(`Update File "${path}": no hunks found`)
      }
      ops.push({ kind: 'update', path, hunks })
      continue
    }

    throw new Error(`unrecognized directive at body line ${i + 1}: ${JSON.stringify(line)}`)
  }

  if (ops.length === 0) throw new Error('patch contains no file operations')
  return ops
}

/**
 * Apply a single update hunk to a list of file lines. Returns the new
 * line list, or throws if the hunk's context+deletion block can't be
 * located in order.
 */
function applyHunk(fileLines: string[], hunk: Hunk, hunkIndex: number): string[] {
  // Build the "expected" block (keep + remove, in order) and the
  // "replacement" block (keep + add). Then scan fileLines for the
  // expected block and splice in the replacement.
  const expected: string[] = []
  const replacement: string[] = []
  for (const b of hunk.body) {
    if (b.tag === 'keep') {
      expected.push(b.text)
      replacement.push(b.text)
    } else if (b.tag === 'remove') {
      expected.push(b.text)
    } else {
      replacement.push(b.text)
    }
  }

  if (expected.length === 0) {
    // Pure-add hunk with no context. Append at end of file — this is a
    // last-resort behavior; models should provide an anchor or context.
    return [...fileLines, ...replacement]
  }

  // Scan for an exact match of `expected` in `fileLines`.
  const max = fileLines.length - expected.length
  for (let start = 0; start <= max; start++) {
    let ok = true
    for (let j = 0; j < expected.length; j++) {
      if (fileLines[start + j] !== expected[j]) {
        ok = false
        break
      }
    }
    if (ok) {
      return [
        ...fileLines.slice(0, start),
        ...replacement,
        ...fileLines.slice(start + expected.length)
      ]
    }
  }
  throw new Error(`patch did not apply at hunk ${hunkIndex + 1}`)
}

/** True when `abs` sits strictly inside `root`. Empty/unset root ⇒ false. */
function isInside(root: string | undefined, abs: string): boolean {
  if (!root || root.trim() === '') return false
  try {
    const rel = relative(resolve(root), abs)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  } catch {
    return false
  }
}

/**
 * Thrown when an op failed AFTER earlier ops in the same patch already hit
 * disk. Carries the partial summary so the entry point can report it instead
 * of collapsing a half-applied patch into a bare `Error: <reason>` that both
 * the model and the operator read as "nothing happened".
 */
export class PartialApplyError extends Error {
  readonly applied: string[]
  constructor(message: string, applied: string[]) {
    super(message)
    this.name = 'PartialApplyError'
    this.applied = applied
  }
}

/**
 * Apply parsed ops to disk. Performs path validation AND a full in-memory
 * dry run of every update hunk before any write.
 *
 * Why the dry run: the pre-validation block below already existed to stop "a
 * typo in the third op leaving the first two half-applied", but it only checked
 * path resolution and existence — hunk matching, by far the most common
 * apply_patch failure, was left to the write loop. So the single most likely
 * real patch (`*** Delete File: old-draft.md` followed by an `*** Update File:`
 * whose context lines the model paraphrased) passed validation, deleted the
 * first file, then threw on the second. Planning the updates up front closes
 * that window: a hunk that cannot match now fails while the disk is still
 * untouched, which is what the guard was for.
 *
 * The plan carries a virtual overlay so ops in one patch still compose
 * sequentially (add-then-update, update-then-update, update-then-delete) —
 * a later op reads the earlier op's planned bytes, not the stale disk bytes.
 *
 * Writes that fail anyway (EPERM, ENOSPC, a tombstone that cannot be staged)
 * cannot be predicted, so the residual case is reported rather than hidden:
 * the loop rethrows as PartialApplyError carrying everything already written.
 * We deliberately do NOT roll back — every destructive branch below preserves
 * the prior bytes in .trash first, so the recovery path is the tombstone
 * journal, and unwinding writes on an already-failing disk would risk
 * destroying more than it restores.
 *
 * Destructive branches route through vault-trash — THE single soft-delete
 * primitive (see local-brain/vault-trash.ts). This call site used to be the
 * ONLY bare `unlinkSync` over workspace content while every sibling vault
 * writer (delete_file / move_file / doc-save / write_file / memory-store /
 * library-brain-bridge) already tombstoned. That asymmetry was live: the
 * workspace root defaults to the vault, so `*** Delete File: 01 Projects/
 * kickoff-notes.md` unlinked a hand-authored note with no `.trash` entry, no
 * journal line and no snapshot — while the SAME note deleted through
 * `delete_file` stayed recoverable. Nothing else covers it: moat-backup
 * explicitly never touches the notes, and index-store's pruneToKeep drops the
 * notes_chunks rows on the reindex the unlink itself triggers.
 *
 * Where the tombstone lands: the vault when the target is inside it (so vault
 * recovery stays in ONE place even when the workspace is a subfolder of the
 * vault), otherwise the workspace root.
 *
 * Delete is preserved unconditionally — a removal is unrecoverable wherever it
 * happens, and the actor is a model that is guessing. Update is snapshotted
 * only inside the vault, matching its siblings exactly (doc-save.ts:56,
 * agui-executors executeEditFile): a repo has version control and an editor
 * undo stack, a hand-authored note has neither.
 */
function applyOps(
  ops: FileOp[],
  workspaceRoot: string,
  vaultDir?: string,
  atomic = false
): string[] {
  // Pre-validate all paths AND plan every write before touching disk, so a
  // typo — or an unmatchable hunk — in the third op doesn't leave the first
  // two half-applied.
  const resolved: { op: FileOp; abs: string; content?: string; changed?: boolean }[] = []
  // Virtual overlay of what the workspace looks like part-way through this
  // patch: absolute path -> planned bytes, or null for "planned deleted".
  const pending = new Map<string, string | null>()
  const plannedExists = (abs: string): boolean =>
    pending.has(abs) ? pending.get(abs) !== null : existsSync(abs)

  for (const op of ops) {
    const abs = resolvePathWithinWorkspace(workspaceRoot, op.path)
    if (abs === null) {
      throw new Error(`path "${op.path}" escapes the workspace root or is invalid`)
    }
    if (op.kind === 'add') {
      if (plannedExists(abs)) {
        throw new Error(`Add File "${op.path}": file already exists`)
      }
      // Re-join with `\n`; trailing newline if the patch had one (i.e.
      // the body wasn't empty). Matches typical text-file convention.
      const content = op.lines.join('\n') + (op.lines.length > 0 ? '\n' : '')
      pending.set(abs, content)
      resolved.push({ op, abs, content })
      continue
    }
    if (!plannedExists(abs)) {
      throw new Error(`${op.kind === 'update' ? 'Update' : 'Delete'} File "${op.path}": file does not exist`)
    }
    if (op.kind === 'delete') {
      pending.set(abs, null)
      resolved.push({ op, abs })
      continue
    }
    // Update: apply every hunk in memory NOW. A hunk that cannot match
    // throws here, while nothing has been written or tombstoned yet.
    const planned = pending.get(abs)
    const raw = typeof planned === 'string' ? planned : readFileSync(abs, 'utf8')
    // Preserve trailing-newline behavior: split, apply, rejoin with the
    // same newline policy. If the file had a trailing newline, the split
    // produces an empty final element which we restore.
    const hadTrailingNl = raw.endsWith('\n')
    const fileLines = raw.split('\n')
    if (hadTrailingNl) fileLines.pop()
    let next = fileLines
    for (let h = 0; h < op.hunks.length; h++) {
      next = applyHunk(next, op.hunks[h], h)
    }
    const out = next.join('\n') + (hadTrailingNl ? '\n' : '')
    pending.set(abs, out)
    resolved.push({ op, abs, content: out, changed: out !== raw })
  }

  // Atomic mode: capture the pre-apply bytes + existence of every affected
  // file so a write-phase failure can be unwound to exactly the starting
  // state. Taken AFTER the plan pass (so an unmatchable hunk has already
  // thrown, disk still untouched) and BEFORE the first write.
  const rollbackSnapshots = atomic
    ? resolved.map(({ abs }) => {
        const existed = existsSync(abs)
        return { abs, existed, body: existed ? readFileSync(abs) : null }
      })
    : null

  const summary: string[] = []
  try {
    for (const { op, abs, content, changed } of resolved) {
    try {
      if (op.kind === 'add') {
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, content as string, 'utf8')
        summary.push(`+ ${op.path}`)
      } else if (op.kind === 'delete') {
        const inVault = isInside(vaultDir, abs)
        const trashRoot = inVault ? resolve(vaultDir as string) : resolve(workspaceRoot)
        const t = tombstoneToTrash(
          trashRoot,
          abs,
          'agent:apply_patch',
          `deleted by apply_patch of ${op.path}`
        )
        // vault-trash documents the caller's safe side as NOT performing the
        // destructive step when the bytes could not be preserved.
        if (!t.ok) {
          throw new Error(
            `Delete File "${op.path}": the existing file could not be preserved (${t.error}); nothing was deleted`
          )
        }
        // Tell the model/operator where the bytes went, so the delete is
        // traceable and undoable from the report alone.
        summary.push(`- ${op.path} (recoverable at ${t.trashRel})`)
      } else {
        // Hunks already applied in the planning pass above; `content` is the
        // final body. Snapshot only when the write actually changes bytes —
        // and only after planning proved every hunk matched, so an
        // unmatchable hunk never leaves a spurious copy in .trash.
        let replaced: string | undefined
        if (changed && isInside(vaultDir, abs)) {
          const s = snapshotToTrash(
            resolve(vaultDir as string),
            abs,
            'agent:apply_patch',
            `overwritten by apply_patch of ${op.path} (${op.hunks.length} hunk(s))`
          )
          if (!s.ok) {
            throw new Error(
              `Update File "${op.path}": the existing note could not be preserved (${s.error}); nothing was written`
            )
          }
          replaced = s.trashRel
        }
        writeFileSync(abs, content as string, 'utf8')
        summary.push(`~ ${op.path}${replaced ? ` (prior version at ${replaced})` : ''}`)
      }
    } catch (err) {
      // Atomic mode unwinds instead of reporting a partial: rethrow the raw
      // error so the outer catch restores every snapshot and surfaces a plain
      // `Error:` (nothing remains on disk).
      if (atomic) throw err
      // Earlier ops in this patch are already on disk. Surfacing only this
      // op's message would tell the model and the operator that the patch was
      // a no-op while a delete or an overwrite has in fact happened.
      if (summary.length > 0) {
        throw new PartialApplyError(messageOf(err) ?? String(err), summary)
      }
      throw err
    }
    }
  } catch (err) {
    // Atomic rollback: restore every snapshot to its pre-apply state, then
    // rethrow the ORIGINAL error. Best-effort per file so one un-restorable
    // path doesn't abort the rest of the unwind. `rollbackSnapshots` is null
    // outside atomic mode, so this catch is a pure passthrough there.
    if (rollbackSnapshots) {
      for (const snap of rollbackSnapshots) {
        try {
          if (snap.existed && snap.body) {
            mkdirSync(dirname(snap.abs), { recursive: true })
            writeFileSync(snap.abs, snap.body)
          } else if (!snap.existed && existsSync(snap.abs)) {
            unlinkSync(snap.abs)
          }
        } catch {
          // Keep unwinding; a partial restore is still better than a partial apply.
        }
      }
    }
    throw err
  }
  return summary
}

/**
 * Entry point. Parses, validates, applies. Returns a structured result
 * the registration handler can stringify for the model. All errors are
 * surfaced as `Error: <reason>` strings — never thrown — so the tool
 * round trip completes normally.
 */
export async function executeApplyPatch(
  args: ApplyPatchArgs,
  workspaceRoot: string,
  options?: ApplyPatchOptions
): Promise<ApplyPatchResult> {
  try {
    const ops = parsePatch(args?.patch ?? '')
    const summary = applyOps(ops, workspaceRoot, options?.vaultDir, options?.atomic ?? false)
    const adds = ops.filter((o) => o.kind === 'add').length
    const updates = ops.filter((o) => o.kind === 'update').length
    const deletes = ops.filter((o) => o.kind === 'delete').length
    const header = `Applied ${ops.length} change(s): +${adds}, ~${updates}, -${deletes}`
    return { result: [header, ...summary].join('\n') }
  } catch (err) {
    const reason = messageOf(err) ?? String(err)
    // A half-applied patch must never be reported as a total no-op: the model
    // would re-send a corrected patch whose Delete now fails with "file does
    // not exist", masking that the note was already removed, and the operator
    // would never learn to look in .trash.
    if (err instanceof PartialApplyError && err.applied.length > 0) {
      return {
        result: [
          `Error: ${reason}`,
          `WARNING: the patch was PARTIALLY applied. ${err.applied.length} earlier change(s) are already on disk and were NOT rolled back:`,
          ...err.applied,
          'Prior content is recoverable at the .trash path(s) listed above (see .trash/_tombstones.jsonl for what/when/who). Re-read the affected files before sending a corrected patch — do not repeat the changes listed above.'
        ].join('\n')
      }
    }
    return { result: `Error: ${reason}` }
  }
}
