// executor-review — the operator sees what a delegated run did, then keeps or discards it.
//
// A dsh run works in an isolated git worktree on branch `lamprey-agent/<runId>`. When it ends
// with changes there, forkAgent's finalize keeps the worktree and stamps its path on the run.
// This module turns that into a decision the operator actually gets: a Needs-you notice, a diff
// they can read, and two buttons — Keep (commit the work and, if the workspace is clean, merge it
// in) or Discard (throw the worktree away). That decision is also the trust signal
// (executor-capability): keep → ratify, discard → revert.
//
// Safety for a non-coder: Keep never forces a merge into a dirty or diverged workspace — it
// commits the work to its branch (durable, named) and merges only when the base tree is clean and
// fast-forward-or-clean-merge safe; otherwise it says the branch is ready and leaves the merge to
// the operator. Nothing here can lose the work: a failed merge leaves the committed branch.

import { execFile } from 'child_process'
import { recordNotice, resolveByActionId } from '../proactive/notices-store'
import { recordExecutorOutcome } from './executor-capability'
import { messageOf } from '../guarded'

export interface GitResult {
  stdout: string
  stderr: string
  code: number
}
export type RunGit = (args: string[], cwd: string) => Promise<GitResult>

const DIFF_CAP = 60_000

const defaultRunGit: RunGit = (args, cwd) =>
  new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotePath=false', ...args], { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: err ? ((err as { code?: number }).code ?? 1) : 0 })
    })
  })

export interface PendingReview {
  runId: string
  label: string
  branch: string
  worktreePath: string
  baseCwd: string
  changedFiles: number
  createdAt: number
}

export interface ReviewDeps {
  runGit?: RunGit
  now?: () => number
}

const reviews = new Map<string, PendingReview>()

export function listExecutorReviews(): PendingReview[] {
  return [...reviews.values()].sort((a, b) => b.createdAt - a.createdAt)
}

export function getExecutorReview(runId: string): PendingReview | undefined {
  return reviews.get(runId)
}

function branchForRun(runId: string): string {
  return `lamprey-agent/${runId}`
}

/**
 * Called when a dsh run settles. If its worktree still exists with changes, register a review and
 * raise the Needs-you notice. Best-effort: a run must never fail because the review couldn't be
 * filed. `baseCwd` is the repo the worktree was forked from (the delegate_task cwd).
 */
export async function onExecutorRunSettled(
  run: { runId: string; label: string; worktreePath: string | null; baseCwd: string },
  deps: ReviewDeps = {}
): Promise<void> {
  if (!run.worktreePath) return
  const runGit = deps.runGit ?? defaultRunGit
  const now = deps.now ?? Date.now
  try {
    const status = await runGit(['status', '--porcelain'], run.worktreePath)
    const changed = status.code === 0 ? status.stdout.split(/\r?\n/).filter((l) => l.trim()).length : 0
    if (changed === 0) return
    const branch = branchForRun(run.runId)
    reviews.set(run.runId, { runId: run.runId, label: run.label, branch, worktreePath: run.worktreePath, baseCwd: run.baseCwd, changedFiles: changed, createdAt: now() })
    recordNotice({
      kind: 'approval',
      severity: 'info',
      needsDecision: true,
      title: 'A delegated run left changes to review',
      body: `${run.label} changed ${changed} file${changed === 1 ? '' : 's'} on branch ${branch}. Keep or discard.`,
      actionId: run.runId,
      dedupKey: `executor-review:${run.runId}`,
      // Land the operator on the Keep/Discard buttons themselves (Settings → Executors),
      // not the notices hub — the decision lives there. Route added in src/lib/deep-link.ts.
      deepLink: 'duin://settings/executors'
    })
  } catch (err) {
    console.debug('[executor-review] settle best-effort:', messageOf(err))
  }
}

export interface ReviewDiff {
  runId: string
  branch: string
  changedFiles: number
  stat: string
  patch: string
  truncated: boolean
}

/** The diff the operator reads before deciding. Working-tree changes in the worktree. */
export async function executorReviewDiff(runId: string, deps: ReviewDeps = {}): Promise<ReviewDiff | { error: string }> {
  const r = reviews.get(runId)
  if (!r) return { error: 'no pending review with that id' }
  const runGit = deps.runGit ?? defaultRunGit
  const stat = await runGit(['--no-pager', 'diff', '--stat'], r.worktreePath)
  const patch = await runGit(['--no-pager', 'diff'], r.worktreePath)
  const full = patch.stdout ?? ''
  return {
    runId,
    branch: r.branch,
    changedFiles: r.changedFiles,
    stat: stat.stdout ?? '',
    patch: full.slice(0, DIFF_CAP),
    truncated: full.length > DIFF_CAP
  }
}

export interface KeepResult {
  ok: boolean
  /** 'merged' — committed and merged into the base workspace; 'branch' — committed to the branch,
   *  merge left to the operator (base not clean / would not fast-forward); 'error'. */
  outcome: 'merged' | 'branch' | 'error'
  branch: string
  message: string
}

/**
 * Keep the run's work. Always commits it to its branch first (durable, named), then merges into
 * the base ONLY when the base working tree is clean — otherwise leaves the branch for the operator.
 * Removes the worktree either way (the branch carries the commit). Records `ratify`.
 */
export async function keepExecutorReview(runId: string, deps: ReviewDeps = {}): Promise<KeepResult> {
  const r = reviews.get(runId)
  if (!r) return { ok: false, outcome: 'error', branch: '', message: 'no pending review with that id' }
  const runGit = deps.runGit ?? defaultRunGit
  const fail = (message: string): KeepResult => ({ ok: false, outcome: 'error', branch: r.branch, message })
  try {
    const add = await runGit(['add', '-A'], r.worktreePath)
    if (add.code !== 0) return fail(`git add failed: ${add.stderr.trim()}`)
    const commit = await runGit(['commit', '-m', `dsh executor: ${r.label}`.slice(0, 200), '--no-verify'], r.worktreePath)
    if (commit.code !== 0) return fail(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`)

    // Merge into the base only if the base tree is clean — never force work onto a dirty or
    // diverged workspace. The commit is safe on the branch regardless.
    const baseStatus = await runGit(['status', '--porcelain'], r.baseCwd)
    const baseClean = baseStatus.code === 0 && baseStatus.stdout.trim() === ''
    let outcome: KeepResult['outcome'] = 'branch'
    let message = `Kept on branch ${r.branch}. Your workspace has other uncommitted changes, so merge it when you're ready.`
    if (baseClean) {
      const merge = await runGit(['merge', '--no-ff', '--no-edit', '--', r.branch], r.baseCwd)
      if (merge.code === 0) {
        outcome = 'merged'
        message = `Kept and merged ${r.changedFiles} changed file${r.changedFiles === 1 ? '' : 's'} into your workspace.`
      } else {
        // Conflicts or refusal: abort cleanly, leave the branch.
        await runGit(['merge', '--abort'], r.baseCwd)
        message = `Kept on branch ${r.branch}. It didn't merge cleanly (${merge.stderr.trim().split('\n')[0] || 'conflict'}); merge it by hand.`
      }
    }
    await removeWorktree(runGit, r)
    // Once the work is merged in, its dedicated branch is redundant — delete it so
    // lamprey-agent/* branches don't pile up. Only when merged: an un-merged 'branch' outcome is
    // the operator's to keep, and deleting it there would be the F1 data loss again. Best-effort
    // (needs the worktree gone first, done above); a lingering branch is a tidiness issue, not a
    // failure, so it never flips the result.
    if (outcome === 'merged') {
      const del = await runGit(['branch', '-D', '--', r.branch], r.baseCwd)
      if (del.code !== 0) console.debug('[executor-review] merged-branch delete non-zero (continuing):', del.stderr.trim())
    }
    reviews.delete(runId)
    resolveByActionId(runId)
    recordExecutorOutcome(true)
    return { ok: true, outcome, branch: r.branch, message }
  } catch (err) {
    return fail(messageOf(err))
  }
}

export interface DiscardResult {
  ok: boolean
  branch: string
  message: string
}

/** Throw the run's work away: remove the worktree and delete the branch. Records `revert`. */
export async function discardExecutorReview(runId: string, deps: ReviewDeps = {}): Promise<DiscardResult> {
  const r = reviews.get(runId)
  if (!r) return { ok: false, branch: '', message: 'no pending review with that id' }
  const runGit = deps.runGit ?? defaultRunGit
  try {
    await removeWorktree(runGit, r)
    await runGit(['branch', '-D', '--', r.branch], r.baseCwd)
    reviews.delete(runId)
    resolveByActionId(runId)
    recordExecutorOutcome(false)
    return { ok: true, branch: r.branch, message: `Discarded the delegated run's changes and removed branch ${r.branch}.` }
  } catch (err) {
    return { ok: false, branch: r.branch, message: messageOf(err) }
  }
}

async function removeWorktree(runGit: RunGit, r: PendingReview): Promise<void> {
  const res = await runGit(['worktree', 'remove', '--force', '--', r.worktreePath], r.baseCwd)
  if (res.code !== 0) console.debug('[executor-review] worktree remove non-zero (continuing):', res.stderr.trim())
}

export const __executorReviewTest = { reviews, branchForRun }
