import { describe, it, expect, vi, beforeEach } from 'vitest'

// The keep/discard review, with a fake git runner and the capability/notice seams mocked at the
// module boundary. Pins the operator's contract: a settled run with changes raises a decision;
// Keep commits and (only on a clean base) merges; Discard removes worktree + branch; each records
// the trust signal and resolves the notice; nothing can lose the work.

const recordNotice = vi.fn()
const resolveByActionId = vi.fn()
const recordExecutorOutcome = vi.fn()

vi.mock('../proactive/notices-store', () => ({
  recordNotice: (...a: unknown[]) => recordNotice(...(a as [])),
  resolveByActionId: (...a: unknown[]) => resolveByActionId(...(a as []))
}))
vi.mock('./executor-capability', () => ({
  recordExecutorOutcome: (...a: unknown[]) => recordExecutorOutcome(...(a as []))
}))

import {
  onExecutorRunSettled,
  executorReviewDiff,
  keepExecutorReview,
  discardExecutorReview,
  listExecutorReviews,
  __executorReviewTest,
  type GitResult
} from './executor-review'

const WT = '/work/wt-1'
const BASE = '/work/repo'

/** A scriptable git: keyed by the joined argv, returns the queued result (default clean success). */
function fakeGit(script: Record<string, Partial<GitResult>> = {}) {
  const calls: { args: string[]; cwd: string }[] = []
  const runGit = async (args: string[], cwd: string): Promise<GitResult> => {
    calls.push({ args, cwd })
    for (const [key, res] of Object.entries(script)) {
      if (args.join(' ').includes(key)) return { stdout: '', stderr: '', code: 0, ...res }
    }
    return { stdout: '', stderr: '', code: 0 }
  }
  return { runGit, calls }
}

beforeEach(() => {
  recordNotice.mockClear()
  resolveByActionId.mockClear()
  recordExecutorOutcome.mockClear()
  __executorReviewTest.reviews.clear()
})

describe('onExecutorRunSettled', () => {
  it('raises a keep/discard notice when the worktree has changes', async () => {
    const g = fakeGit({ 'status --porcelain': { stdout: ' M a.ts\n M b.ts\n' } })
    await onExecutorRunSettled({ runId: 'r1', label: 'dsh: fix bug', worktreePath: WT, baseCwd: BASE }, { runGit: g.runGit, now: () => 1000 })
    expect(listExecutorReviews()).toHaveLength(1)
    expect(listExecutorReviews()[0]).toMatchObject({ runId: 'r1', changedFiles: 2, branch: 'lamprey-agent/r1' })
    expect(recordNotice).toHaveBeenCalledWith(expect.objectContaining({ needsDecision: true, actionId: 'r1', kind: 'approval' }))
  })
  it('is silent when the run left no changes, and when there was no worktree', async () => {
    const g = fakeGit({ 'status --porcelain': { stdout: '' } })
    await onExecutorRunSettled({ runId: 'r2', label: 'x', worktreePath: WT, baseCwd: BASE }, { runGit: g.runGit })
    await onExecutorRunSettled({ runId: 'r3', label: 'x', worktreePath: null, baseCwd: BASE }, { runGit: g.runGit })
    expect(listExecutorReviews()).toHaveLength(0)
    expect(recordNotice).not.toHaveBeenCalled()
  })
})

async function seed(runId: string, runGit: (a: string[], c: string) => Promise<GitResult>): Promise<void> {
  __executorReviewTest.reviews.set(runId, { runId, label: `dsh: ${runId}`, branch: `lamprey-agent/${runId}`, worktreePath: WT, baseCwd: BASE, changedFiles: 2, createdAt: 1 })
  void runGit
}

describe('executorReviewDiff', () => {
  it('returns the stat and a capped patch', async () => {
    const g = fakeGit({ 'diff --stat': { stdout: ' a.ts | 2 +-\n' }, 'diff': { stdout: '@@ patch @@' } })
    await seed('r1', g.runGit)
    const d = await executorReviewDiff('r1', { runGit: g.runGit })
    expect('error' in d).toBe(false)
    if (!('error' in d)) {
      expect(d.stat).toContain('a.ts')
      expect(d.branch).toBe('lamprey-agent/r1')
    }
  })
  it('errors for an unknown review', async () => {
    expect(await executorReviewDiff('nope')).toEqual({ error: 'no pending review with that id' })
  })
})

describe('keepExecutorReview', () => {
  it('commits then merges when the base is clean; records ratify and resolves the notice', async () => {
    const g = fakeGit({ 'status --porcelain': { stdout: '' } /* base clean */, 'merge --no-ff': { code: 0 } })
    await seed('r1', g.runGit)
    const res = await keepExecutorReview('r1', { runGit: g.runGit })
    expect(res).toMatchObject({ ok: true, outcome: 'merged' })
    const argv = g.calls.map((c) => c.args.join(' '))
    expect(argv.some((a) => a.startsWith('add -A'))).toBe(true)
    expect(argv.some((a) => a.startsWith('commit -m'))).toBe(true)
    expect(argv.some((a) => a.includes('merge --no-ff'))).toBe(true)
    expect(argv.some((a) => a.includes('worktree remove'))).toBe(true)
    // F10: once merged, the redundant branch is deleted so lamprey-agent/* don't accumulate.
    expect(argv.some((a) => a.startsWith('branch -D'))).toBe(true)
    expect(recordExecutorOutcome).toHaveBeenCalledWith(true)
    expect(resolveByActionId).toHaveBeenCalledWith('r1')
    expect(listExecutorReviews()).toHaveLength(0)
  })

  it('commits to the branch but does NOT merge when the base is dirty — the work is never lost', async () => {
    const g = fakeGit({ 'status --porcelain': { stdout: ' M other.ts\n' } /* base dirty */ })
    await seed('r1', g.runGit)
    const res = await keepExecutorReview('r1', { runGit: g.runGit })
    expect(res).toMatchObject({ ok: true, outcome: 'branch' })
    expect(g.calls.some((c) => c.args.join(' ').includes('merge --no-ff'))).toBe(false)
    expect(recordExecutorOutcome).toHaveBeenCalledWith(true)
  })

  it('a conflicting merge aborts cleanly and leaves the committed branch', async () => {
    const g = fakeGit({ 'status --porcelain': { stdout: '' }, 'merge --no-ff': { code: 1, stderr: 'CONFLICT (content)' } })
    await seed('r1', g.runGit)
    const res = await keepExecutorReview('r1', { runGit: g.runGit })
    expect(res).toMatchObject({ ok: true, outcome: 'branch' })
    expect(g.calls.some((c) => c.args.join(' ').includes('merge --abort'))).toBe(true)
  })

  it('a failed commit is a clean error, not a half-done keep', async () => {
    const g = fakeGit({ 'commit -m': { code: 1, stderr: 'nothing to commit' } })
    await seed('r1', g.runGit)
    const res = await keepExecutorReview('r1', { runGit: g.runGit })
    expect(res.ok).toBe(false)
    expect(res.outcome).toBe('error')
    expect(recordExecutorOutcome).not.toHaveBeenCalled()
    expect(listExecutorReviews()).toHaveLength(1) // still pending — nothing was thrown away
  })
})

describe('discardExecutorReview', () => {
  it('removes the worktree and branch, records revert, resolves the notice', async () => {
    const g = fakeGit()
    await seed('r1', g.runGit)
    const res = await discardExecutorReview('r1', { runGit: g.runGit })
    expect(res.ok).toBe(true)
    const argv = g.calls.map((c) => c.args.join(' '))
    expect(argv.some((a) => a.includes('worktree remove'))).toBe(true)
    expect(argv.some((a) => a.startsWith('branch -D'))).toBe(true)
    expect(recordExecutorOutcome).toHaveBeenCalledWith(false)
    expect(resolveByActionId).toHaveBeenCalledWith('r1')
    expect(listExecutorReviews()).toHaveLength(0)
  })
  it('errors for an unknown review', async () => {
    expect((await discardExecutorReview('nope')).ok).toBe(false)
  })
})
