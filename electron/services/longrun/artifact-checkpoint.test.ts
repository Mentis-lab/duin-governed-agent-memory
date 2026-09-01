import { describe, it, expect } from 'vitest'
import {
  commitStep,
  currentSha,
  isClean,
  type ExecResult,
  type ExecSeam
} from './artifact-checkpoint'

// A scripted git fake. It models a tiny repo: a HEAD sha, whether the tree is
// dirty, and whether the repo is unborn (no commits). Each git invocation is
// recorded so tests can assert argument shape (no shell string).
interface FakeRepo {
  head: string | null
  dirty: boolean
}

function makeExec(repo: FakeRepo): { exec: ExecSeam; calls: string[][] } {
  const calls: string[][] = []
  let commitCounter = 0
  const exec: ExecSeam = async (cmd, args) => {
    calls.push([cmd, ...args])
    const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', code: 0 })
    const fail = (stderr: string): ExecResult => ({ stdout: '', stderr, code: 128 })
    const sub = args[0]
    if (cmd === 'git' && sub === 'rev-parse') {
      return repo.head == null
        ? fail("fatal: ambiguous argument 'HEAD': unknown revision")
        : ok(repo.head + '\n')
    }
    if (cmd === 'git' && sub === 'status') {
      return ok(repo.dirty ? ' M file.txt\n' : '')
    }
    if (cmd === 'git' && sub === 'add') {
      return ok()
    }
    if (cmd === 'git' && sub === 'commit') {
      if (!repo.dirty) return fail('nothing to commit')
      repo.dirty = false
      commitCounter += 1
      repo.head = `sha-${commitCounter}`
      return ok(`[main ${repo.head}] committed\n`)
    }
    return fail('unexpected git command')
  }
  return { exec, calls }
}

describe('currentSha', () => {
  it('returns the trimmed HEAD sha', async () => {
    const { exec } = makeExec({ head: 'deadbeef', dirty: false })
    expect(await currentSha('/repo', exec)).toBe('deadbeef')
  })

  it('returns null on an unborn/empty repo (rev-parse exits non-zero)', async () => {
    const { exec } = makeExec({ head: null, dirty: false })
    expect(await currentSha('/repo', exec)).toBeNull()
  })
})

describe('isClean', () => {
  it('true when git status --porcelain is empty', async () => {
    const { exec, calls } = makeExec({ head: 'x', dirty: false })
    expect(await isClean('/repo', exec)).toBe(true)
    expect(calls).toContainEqual(['git', 'status', '--porcelain'])
  })

  it('false when the tree has changes', async () => {
    const { exec } = makeExec({ head: 'x', dirty: true })
    expect(await isClean('/repo', exec)).toBe(false)
  })
})

describe('commitStep (L1 commit-per-step)', () => {
  it('stages, commits a dirty tree, and returns the NEW head sha', async () => {
    const repo: FakeRepo = { head: 'sha-0', dirty: true }
    const { exec, calls } = makeExec(repo)
    const sha = await commitStep('/repo', 'iter 1: do a thing', exec)
    expect(sha).toBe('sha-1')
    // args are an array — no shell string interpolation of the message.
    expect(calls).toContainEqual(['git', 'add', '-A'])
    expect(calls).toContainEqual(['git', 'commit', '-m', 'iter 1: do a thing'])
    // and the tree is clean afterward (the step actually committed everything).
    expect(await isClean('/repo', exec)).toBe(true)
  })

  it('is a no-op that resolves to the current sha when nothing changed', async () => {
    const repo: FakeRepo = { head: 'sha-7', dirty: false }
    const { exec, calls } = makeExec(repo)
    const sha = await commitStep('/repo', 'noop', exec)
    expect(sha).toBe('sha-7')
    // never ran `git commit` — a clean no-op step must not throw or create a commit.
    expect(calls.some((c) => c[1] === 'commit')).toBe(false)
  })

  it('throws on an unborn repo with nothing to commit (no sha to anchor to)', async () => {
    const repo: FakeRepo = { head: null, dirty: false }
    const { exec } = makeExec(repo)
    await expect(commitStep('/repo', 'noop', exec)).rejects.toThrow(/unborn/i)
  })

  it('throws when git commit fails', async () => {
    // A dirty tree but commit returns non-zero (e.g. missing identity).
    const calls: string[][] = []
    const exec: ExecSeam = async (cmd, args) => {
      calls.push([cmd, ...args])
      if (args[0] === 'status') return { stdout: ' M f\n', stderr: '', code: 0 }
      if (args[0] === 'add') return { stdout: '', stderr: '', code: 0 }
      if (args[0] === 'commit')
        return { stdout: '', stderr: 'Author identity unknown', code: 128 }
      return { stdout: '', stderr: '', code: 0 }
    }
    await expect(commitStep('/repo', 'm', exec)).rejects.toThrow(/git commit failed/i)
  })
})
