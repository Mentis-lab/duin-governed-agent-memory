import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  branchNameForRun,
  createAgentWorktreeManager,
  hasUncommittedChanges,
  worktreePathForRun
} from './worktree-runner'

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('branchNameForRun', () => {
  it('namespaces under lamprey-agent/ to keep the global branch table clean', () => {
    expect(branchNameForRun('abc-123')).toBe('lamprey-agent/abc-123')
  })
  it('strips characters that would break git refname grammar', () => {
    expect(branchNameForRun('a/b;c?')).toBe('lamprey-agent/abc')
  })
})

describe('worktreePathForRun', () => {
  it('joins root + safe runId', () => {
    expect(worktreePathForRun('/wt', 'r1')).toBe(join('/wt', 'r1'))
  })
})

describe('hasUncommittedChanges', () => {
  it('returns false for empty output', () => {
    expect(hasUncommittedChanges('')).toBe(false)
    expect(hasUncommittedChanges('\n')).toBe(false)
    expect(hasUncommittedChanges('  \n  ')).toBe(false)
  })
  it('returns true for any non-empty porcelain line', () => {
    expect(hasUncommittedChanges('?? new.ts\n')).toBe(true)
    expect(hasUncommittedChanges(' M foo.ts\n')).toBe(true)
    expect(hasUncommittedChanges('M  bar.ts\n')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// createAgentWorktreeManager (with stubbed runGit)
// ---------------------------------------------------------------------------

function makeManager(stubGit: ReturnType<typeof vi.fn>): ReturnType<typeof createAgentWorktreeManager> {
  // The workspacesRoot must be absolute and exist; use a real tmpdir so the
  // manager's mkdir is a no-op.
  const root = mkdtempSync(join(tmpdir(), 'lamprey-wt-root-'))
  return createAgentWorktreeManager({
    baseCwd: '/some/repo',
    workspacesRoot: root,
    runGit: stubGit as unknown as typeof import('./git-runner').runGit
  })
}

describe('createAgentWorktreeManager.create', () => {
  it('calls git worktree add with the runId-derived branch + path', async () => {
    const runGit = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }) // worktree add
      .mockResolvedValueOnce({ stdout: 'abc123def\n', stderr: '', code: 0 }) // rev-parse HEAD
    const mgr = makeManager(runGit)
    const ctx = await mgr.create('run-1')
    const [args, cwd] = runGit.mock.calls[0]
    expect(cwd).toBe('/some/repo')
    expect(args[0]).toBe('worktree')
    expect(args[1]).toBe('add')
    expect(args).toContain('-b')
    expect(args).toContain('lamprey-agent/run-1')
    expect(ctx.branch).toBe('lamprey-agent/run-1')
    expect(ctx.path.endsWith('run-1')).toBe(true)
    // The branch's starting commit is captured so finalize can detect committed work.
    expect(runGit.mock.calls[1][0]).toEqual(['rev-parse', 'HEAD'])
    expect(ctx.baseSha).toBe('abc123def')
  })

  it('throws when git worktree add fails', async () => {
    const runGit = vi.fn().mockResolvedValue({ stdout: '', stderr: 'fatal: nope', code: 128 })
    const mgr = makeManager(runGit)
    await expect(mgr.create('r1')).rejects.toThrow(/code 128/)
    await expect(mgr.create('r1')).rejects.toThrow(/nope/)
  })

  it('three parallel create() calls produce three disjoint worktree paths', async () => {
    const runGit = vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 0 })
    const mgr = makeManager(runGit)
    const [a, b, c] = await Promise.all([mgr.create('r1'), mgr.create('r2'), mgr.create('r3')])
    expect(new Set([a.path, b.path, c.path]).size).toBe(3)
    expect(new Set([a.branch, b.branch, c.branch]).size).toBe(3)
    // Each create() is now two git calls: `worktree add` + `rev-parse HEAD` (baseSha capture).
    expect(runGit).toHaveBeenCalledTimes(6)
    expect(runGit.mock.calls.filter((c2) => c2[0][0] === 'worktree').length).toBe(3)
    expect(runGit.mock.calls.filter((c2) => c2[0][0] === 'rev-parse').length).toBe(3)
  })
})

describe('createAgentWorktreeManager.finalize', () => {
  it('removes the worktree + deletes the branch when porcelain is empty', async () => {
    const runGit = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }) // status --porcelain
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }) // worktree remove
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }) // branch -D
    const mgr = makeManager(runGit)
    const result = await mgr.finalize({ path: '/wt/r1', branch: 'lamprey-agent/r1' })
    expect(result.keep).toBe(false)
    expect(result.hasChanges).toBe(false)
    expect(result.removed).toBe(true)
    // Verify exact argv shape on the remove + branch-delete calls.
    expect(runGit.mock.calls[1][0]).toEqual(['worktree', 'remove', '--force', '--', '/wt/r1'])
    expect(runGit.mock.calls[2][0]).toEqual(['branch', '-D', '--', 'lamprey-agent/r1'])
  })

  it('preserves the worktree when porcelain shows changes', async () => {
    const runGit = vi.fn().mockResolvedValue({ stdout: '?? new.ts\n', stderr: '', code: 0 })
    const mgr = makeManager(runGit)
    const result = await mgr.finalize({ path: '/wt/r1', branch: 'lamprey-agent/r1' })
    expect(result.keep).toBe(true)
    expect(result.hasChanges).toBe(true)
    expect(result.removed).toBe(false)
    expect(result.path).toBe('/wt/r1')
    expect(result.branch).toBe('lamprey-agent/r1')
    // Only the status call was made — no remove/branch-delete.
    expect(runGit).toHaveBeenCalledTimes(1)
  })

  it('PRESERVES committed work: a clean tree but commits ahead of baseSha is NOT deleted (F1)', async () => {
    // The agent ran `git add -A && git commit` — working tree is clean, but the commit lives only
    // on the branch. finalize must keep it, not delete the worktree AND branch.
    const runGit = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }) // status --porcelain: clean
      .mockResolvedValueOnce({ stdout: '2\n', stderr: '', code: 0 }) // rev-list baseSha..HEAD: 2 commits
    const mgr = makeManager(runGit)
    const result = await mgr.finalize({ path: '/wt/r1', branch: 'lamprey-agent/r1', baseSha: 'base000' })
    expect(result.keep).toBe(true)
    expect(result.hasChanges).toBe(true)
    expect(result.removed).toBe(false)
    // No worktree-remove / branch-delete happened.
    expect(runGit.mock.calls.every((c) => !c[0].includes('remove') && !c[0].includes('-D'))).toBe(true)
    expect(runGit.mock.calls[1][0]).toEqual(['rev-list', '--count', 'base000..HEAD'])
  })

  it('removes when clean AND no commits ahead of baseSha', async () => {
    const runGit = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }) // porcelain clean
      .mockResolvedValueOnce({ stdout: '0\n', stderr: '', code: 0 }) // rev-list: 0
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }) // worktree remove
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }) // branch -D
    const mgr = makeManager(runGit)
    const result = await mgr.finalize({ path: '/wt/r1', branch: 'lamprey-agent/r1', baseSha: 'base000' })
    expect(result.keep).toBe(false)
    expect(result.removed).toBe(true)
  })

  it('PRESERVES on an uncertain commits-ahead check (rev-list errors) — never risk the data-loss path', async () => {
    const runGit = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }) // porcelain clean
      .mockResolvedValueOnce({ stdout: '', stderr: 'fatal', code: 128 }) // rev-list failed
    const mgr = makeManager(runGit)
    const result = await mgr.finalize({ path: '/wt/r1', branch: 'lamprey-agent/r1', baseSha: 'base000' })
    expect(result.keep).toBe(true)
    expect(result.hasChanges).toBe(true)
  })

  it('falls back to preserving when status fails', async () => {
    const runGit = vi.fn().mockResolvedValue({ stdout: '', stderr: 'not a git repo', code: 128 })
    const mgr = makeManager(runGit)
    const result = await mgr.finalize({ path: '/wt/r1', branch: 'lamprey-agent/r1' })
    expect(result.keep).toBe(true)
    expect(result.warning).toMatch(/git status failed/)
  })

  it('warns but reports removed when branch -D fails', async () => {
    const runGit = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }) // status
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }) // remove
      .mockResolvedValueOnce({ stdout: '', stderr: 'branch in use', code: 1 }) // branch -D
    const mgr = makeManager(runGit)
    const result = await mgr.finalize({ path: '/wt/r1', branch: 'lamprey-agent/r1' })
    expect(result.keep).toBe(false)
    expect(result.removed).toBe(true)
    expect(result.warning).toMatch(/branch delete failed/)
  })

  it('keeps + warns when worktree remove fails', async () => {
    const runGit = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }) // status (clean)
      .mockResolvedValueOnce({ stdout: '', stderr: 'locked', code: 128 }) // remove fails
    const mgr = makeManager(runGit)
    const result = await mgr.finalize({ path: '/wt/r1', branch: 'lamprey-agent/r1' })
    expect(result.keep).toBe(true)
    expect(result.removed).toBe(false)
    expect(result.warning).toMatch(/worktree remove failed/)
  })
})

describe('createAgentWorktreeManager validation', () => {
  it('rejects a missing baseCwd', () => {
    expect(() =>
      createAgentWorktreeManager({
        baseCwd: '',
        workspacesRoot: '/abs',
        runGit: vi.fn() as unknown as typeof import('./git-runner').runGit
      })
    ).toThrow(/baseCwd/)
  })
  it('rejects a non-absolute workspacesRoot', () => {
    expect(() =>
      createAgentWorktreeManager({
        baseCwd: '/repo',
        workspacesRoot: 'relative',
        runGit: vi.fn() as unknown as typeof import('./git-runner').runGit
      })
    ).toThrow(/absolute/)
  })
})
