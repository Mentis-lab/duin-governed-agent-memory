// Long-run L1 — artifact commit-per-step. Every completed iteration commits its
// artifact working tree so progress is durable in git, not in memory (the L1
// invariant: no in-memory-only progress). The reconcile anchor (last committed
// HEAD sha) is journaled alongside the commit so a restart can prove the step
// landed (see reconcile.ts).
//
// All git I/O goes through the injected `ExecSeam` — production wraps
// child_process, tests pass a scripted fake. Args are an array (never a shell
// string) so there is no interpolation surface.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** Normalized result of one git invocation. */
export interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

/**
 * Injected process-exec boundary. Production wraps child_process; tests pass a
 * scripted fake. No shell string interpolation — the args array is passed
 * straight to the process.
 */
export type ExecSeam = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<ExecResult>

const execFileAsync = promisify(execFile)

/**
 * The production ExecSeam: args-array `execFile` (never a shell — no interpolation
 * surface), a non-zero git exit returned as `code` rather than thrown, windowsHide,
 * generous maxBuffer. The same construction the loop-controller wires for its own git
 * I/O, exported so the ratify flow (ipc/loops.ts) uses an identical seam.
 */
export const defaultExecSeam: ExecSeam = async (cmd, args, opts) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts?.cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    })
    return { stdout: String(stdout), stderr: String(stderr), code: 0 }
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown; code?: unknown }
    return {
      stdout: String(e?.stdout ?? ''),
      stderr: String(e?.stderr ?? e?.message ?? ''),
      code: typeof e?.code === 'number' ? e.code : 1
    }
  }
}

/**
 * `git rev-parse HEAD` in `dir`. Returns the trimmed sha, or null on an
 * unborn/empty repo (no commits yet — rev-parse exits non-zero). The artifact
 * HEAD used as the reconcile anchor.
 */
export async function currentSha(dir: string, exec: ExecSeam): Promise<string | null> {
  const res = await exec('git', ['rev-parse', 'HEAD'], { cwd: dir })
  if (res.code !== 0) return null
  const sha = res.stdout.trim()
  return sha.length > 0 ? sha : null
}

/**
 * `git status --porcelain` empty ⇒ clean. Used to assert a step actually
 * committed everything before the loop advances (L1: no in-memory-only
 * progress).
 */
export async function isClean(dir: string, exec: ExecSeam): Promise<boolean> {
  const res = await exec('git', ['status', '--porcelain'], { cwd: dir })
  return res.stdout.trim().length === 0
}

/**
 * `git add -A` then commit `msg` in `dir`; returns the new HEAD sha.
 * Idempotent-friendly: if there is nothing to commit (the tree is already
 * clean after staging), resolve to the current HEAD sha rather than throwing —
 * a no-op step must not fail the iteration. Only an unborn repo with nothing to
 * commit (no sha to return at all) is an error.
 */
export async function commitStep(dir: string, msg: string, exec: ExecSeam): Promise<string> {
  await exec('git', ['add', '-A'], { cwd: dir })
  if (await isClean(dir, exec)) {
    const sha = await currentSha(dir, exec)
    if (sha == null) {
      throw new Error('commitStep: nothing to commit and repo has no HEAD (unborn repo)')
    }
    return sha
  }
  const res = await exec('git', ['commit', '-m', msg], { cwd: dir })
  if (res.code !== 0) {
    throw new Error(`commitStep: git commit failed (code ${res.code}): ${res.stderr.trim()}`)
  }
  const sha = await currentSha(dir, exec)
  if (sha == null) {
    throw new Error('commitStep: commit succeeded but HEAD is unresolvable')
  }
  return sha
}

// ──────────────────── output-holding staging (governor 4a-correct) ────────────────────
//
// When an autonomous loop is at the `stage` rung, an iteration's output must be
// HELD — genuinely, not cosmetically (the reverted 14071bb only *labelled* output
// that had already landed). The acceptance bar: `git log` on the artifact branch
// shows NOTHING until ratify, and a revert leaves the tree untouched.
//
// Mechanism (robust for untracked/binary/mode changes, which `git stash create`
// misses): commit the work → park that commit on a SIDE REF (refs/duin/staged/<key>)
// so it is not orphaned → reset the branch HARD back to its prior HEAD. The branch
// is now byte-identical to pre-iteration; the only thing pointing at the work is the
// side ref. Ratify fast-forwards the branch to it; revert deletes the ref (the
// commit becomes unreachable and git GCs it) and the tree — already reset — is
// untouched. One iteration is staged at a time (the loop pauses on stage), so the
// staged commit's parent is always current HEAD and the ratify ff-only always applies.

/** Side-ref namespace for a staged (held) iteration. Key is sanitized to the
 *  git-ref-safe charset so a backlog id can never inject a ref path. */
export function stagedRef(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_')
  return `refs/duin/staged/${safe}`
}

/**
 * Hold an iteration's output instead of landing it. Commits the working tree, parks
 * the commit on `stagedRef(key)`, then resets the branch back to its prior HEAD so
 * the branch shows nothing until ratify. Returns the staged commit sha + the prior
 * HEAD it was reset to. Throws (caller must fail SAFE — pause, never land) if:
 *   - the repo is unborn (no prior HEAD to reset back to), or
 *   - there is nothing to hold (a clean tree) — a stage with no output is a caller bug.
 */
export async function stageStep(
  dir: string,
  msg: string,
  key: string,
  exec: ExecSeam
): Promise<{ stagedSha: string; prevSha: string }> {
  const prevSha = await currentSha(dir, exec)
  if (prevSha == null) {
    throw new Error('stageStep: cannot hold output on an unborn repo (no prior HEAD)')
  }
  await exec('git', ['add', '-A'], { cwd: dir })
  if (await isClean(dir, exec)) {
    throw new Error('stageStep: nothing to hold (working tree clean after staging)')
  }
  // Build the commit object WITHOUT advancing HEAD (write-tree + commit-tree), rather
  // than `git commit` + reset-back. This is the atomicity fix: the branch ref never
  // moves, so `git log` shows NOTHING regardless of whether the worktree cleanup below
  // succeeds or a crash intervenes — a failed cleanup can only leave a dirty tree, never
  // a landed commit. (The old commit-then-reset left output ON the branch if the reset
  // failed.)
  const treeRes = await exec('git', ['write-tree'], { cwd: dir })
  if (treeRes.code !== 0) {
    throw new Error(`stageStep: write-tree failed (code ${treeRes.code}): ${treeRes.stderr.trim()}`)
  }
  const tree = treeRes.stdout.trim()
  const ctRes = await exec('git', ['commit-tree', tree, '-p', prevSha, '-m', msg], { cwd: dir })
  if (ctRes.code !== 0) {
    throw new Error(`stageStep: commit-tree failed (code ${ctRes.code}): ${ctRes.stderr.trim()}`)
  }
  const stagedSha = ctRes.stdout.trim()
  if (stagedSha.length === 0) {
    throw new Error('stageStep: commit-tree produced no sha')
  }
  const ref = stagedRef(key)
  const up = await exec('git', ['update-ref', ref, stagedSha], { cwd: dir })
  if (up.code !== 0) {
    // Could not park the commit → clean the worktree (HEAD never moved, so the branch is
    // already correct) and fail. The dangling commit-tree object GCs on its own.
    await cleanTo(dir, prevSha, exec)
    throw new Error(`stageStep: update-ref ${ref} failed (code ${up.code}): ${up.stderr.trim()}`)
  }
  // Restore the working tree to prevSha. HEAD is ALREADY at prevSha (commit-tree didn't
  // move it), so this only cleans the index + worktree. A failure here leaves a dirty
  // tree but the branch stays clean and the work is safely parked on the side ref.
  const cleaned = await cleanTo(dir, prevSha, exec)
  if (!cleaned.ok) {
    throw new Error(`stageStep: worktree cleanup failed: ${cleaned.error}`)
  }
  return { stagedSha, prevSha }
}

/** Restore the index + working tree to `sha` (HEAD is expected to already be `sha`):
 *  `reset --hard` for tracked changes, then `clean -fd` for the now-unstaged new files
 *  the held commit captured. Safe in a loop ARTIFACT dir (its only untracked files are
 *  the loop's own per-step output; there is no human scratch to lose). */
async function cleanTo(dir: string, sha: string, exec: ExecSeam): Promise<{ ok: boolean; error?: string }> {
  const rst = await exec('git', ['reset', '--hard', sha], { cwd: dir })
  if (rst.code !== 0) return { ok: false, error: `reset --hard ${sha}: ${rst.stderr.trim()}` }
  const cln = await exec('git', ['clean', '-fd'], { cwd: dir })
  if (cln.code !== 0) return { ok: false, error: `clean -fd: ${cln.stderr.trim()}` }
  return { ok: true }
}

/**
 * RATIFY: land a previously staged commit onto the artifact branch (fast-forward
 * only — the branch has not moved since staging, so this always applies cleanly),
 * then delete the side ref. Returns the new HEAD sha. Throws if the ref is missing
 * (nothing staged for this key) or the ff-only merge is refused.
 */
export async function applyStaged(dir: string, key: string, exec: ExecSeam): Promise<string> {
  const ref = stagedRef(key)
  const resolve = await exec('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: dir })
  const stagedSha = resolve.stdout.trim()
  if (resolve.code !== 0 || stagedSha.length === 0) {
    throw new Error(`applyStaged: no staged ref ${ref} (nothing to ratify)`)
  }
  const merged = await exec('git', ['merge', '--ff-only', stagedSha], { cwd: dir })
  if (merged.code !== 0) {
    throw new Error(`applyStaged: ff-only merge of ${ref} refused (code ${merged.code}): ${merged.stderr.trim()}`)
  }
  await exec('git', ['update-ref', '-d', ref], { cwd: dir })
  const sha = await currentSha(dir, exec)
  if (sha == null) {
    throw new Error('applyStaged: merge succeeded but HEAD is unresolvable')
  }
  return sha
}

/**
 * REVERT/discard a staged commit: delete the side ref (the commit becomes
 * unreachable → GC). The working tree was already reset at stage time, so it stays
 * untouched. Idempotent: a missing ref is not an error (already discarded).
 */
export async function discardStaged(dir: string, key: string, exec: ExecSeam): Promise<void> {
  const ref = stagedRef(key)
  const resolve = await exec('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: dir })
  if (resolve.code !== 0 || resolve.stdout.trim().length === 0) return // already gone
  await exec('git', ['update-ref', '-d', ref], { cwd: dir })
}
