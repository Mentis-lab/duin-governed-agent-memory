import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  stageStep,
  applyStaged,
  discardStaged,
  stagedRef,
  currentSha,
  commitStep,
  type ExecSeam
} from './artifact-checkpoint'

// Real-git integration: the safety of output-holding rests on these git ops behaving
// EXACTLY right (branch shows nothing until ratify; revert leaves the tree untouched),
// so we exercise real `git` in a temp repo rather than a scripted fake.

const pexec = promisify(execFile)

// A real ExecSeam over child_process, with a fixed identity so commits work in CI.
const realExec: ExecSeam = async (cmd, args, opts) => {
  try {
    const { stdout, stderr } = await pexec(
      cmd,
      ['-c', 'user.email=test@duin.local', '-c', 'user.name=DUIN Test', ...args],
      { cwd: opts?.cwd }
    )
    return { stdout, stderr, code: 0 }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number }
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? String(e), code: err.code ?? 1 }
  }
}

async function gitLogCount(dir: string): Promise<number> {
  const r = await realExec('git', ['rev-list', '--count', 'HEAD'], { cwd: dir })
  return Number(r.stdout.trim())
}
async function refExists(dir: string, ref: string): Promise<boolean> {
  const r = await realExec('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: dir })
  return r.code === 0 && r.stdout.trim().length > 0
}
async function status(dir: string): Promise<string> {
  const r = await realExec('git', ['status', '--porcelain'], { cwd: dir })
  return r.stdout.trim()
}

describe('artifact staging (real git)', () => {
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'duin-stage-'))
    await realExec('git', ['init', '-q'], { cwd: dir })
    writeFileSync(join(dir, 'README.md'), 'seed\n')
    await realExec('git', ['add', '-A'], { cwd: dir })
    await realExec('git', ['commit', '-q', '-m', 'initial'], { cwd: dir })
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('stageStep HOLDS output — branch shows nothing, tree clean, work parked on the side ref', async () => {
    const prev = await currentSha(dir, realExec)
    const before = await gitLogCount(dir)

    // A turn produces output: a modified file + a brand-new (untracked) file.
    writeFileSync(join(dir, 'README.md'), 'seed\nmore\n')
    writeFileSync(join(dir, 'NEW.md'), 'fresh output\n')

    const { stagedSha, prevSha } = await stageStep(dir, 'iter 1', 'item-1', realExec)

    expect(prevSha).toBe(prev)
    expect(stagedSha).not.toBe(prev)
    // Branch did NOT advance — git log identical to before.
    expect(await gitLogCount(dir)).toBe(before)
    expect(await currentSha(dir, realExec)).toBe(prev)
    // Working tree is clean (the untracked NEW.md was captured into the staged commit and removed).
    expect(await status(dir)).toBe('')
    expect(existsSync(join(dir, 'NEW.md'))).toBe(false)
    // The work is parked on the side ref.
    expect(await refExists(dir, stagedRef('item-1'))).toBe(true)
  })

  it('applyStaged LANDS the held work (ratify) — branch advances, files reappear, ref gone', async () => {
    writeFileSync(join(dir, 'NEW.md'), 'fresh output\n')
    const before = await gitLogCount(dir)
    await stageStep(dir, 'iter 1', 'item-1', realExec)

    const landed = await applyStaged(dir, 'item-1', realExec)

    expect(await gitLogCount(dir)).toBe(before + 1) // branch advanced by exactly one commit
    expect(await currentSha(dir, realExec)).toBe(landed)
    expect(existsSync(join(dir, 'NEW.md'))).toBe(true) // the held file is now real
    expect(await refExists(dir, stagedRef('item-1'))).toBe(false) // side ref cleaned up
    expect(await status(dir)).toBe('')
  })

  it('discardStaged REVERTS (revert) — tree untouched, ref gone, branch never moved', async () => {
    writeFileSync(join(dir, 'NEW.md'), 'fresh output\n')
    const prev = await currentSha(dir, realExec)
    const before = await gitLogCount(dir)
    await stageStep(dir, 'iter 1', 'item-1', realExec)

    await discardStaged(dir, 'item-1', realExec)

    expect(await gitLogCount(dir)).toBe(before) // branch never advanced
    expect(await currentSha(dir, realExec)).toBe(prev)
    expect(await refExists(dir, stagedRef('item-1'))).toBe(false)
    expect(existsSync(join(dir, 'NEW.md'))).toBe(false) // discarded work does not resurface
    expect(await status(dir)).toBe('')
  })

  it('discardStaged is idempotent (a second discard / missing ref is a no-op)', async () => {
    await expect(discardStaged(dir, 'never-staged', realExec)).resolves.toBeUndefined()
    writeFileSync(join(dir, 'NEW.md'), 'x\n')
    await stageStep(dir, 'iter 1', 'item-1', realExec)
    await discardStaged(dir, 'item-1', realExec)
    await expect(discardStaged(dir, 'item-1', realExec)).resolves.toBeUndefined()
  })

  it('applyStaged rejects when nothing is staged (idempotent ratify guard)', async () => {
    await expect(applyStaged(dir, 'nope', realExec)).rejects.toThrow(/no staged ref/)
  })

  it('stageStep refuses a clean tree (a stage with no output is a caller bug)', async () => {
    await expect(stageStep(dir, 'iter empty', 'item-x', realExec)).rejects.toThrow(/nothing to hold/)
  })

  it('a NORMAL commitStep (non-held path) still lands immediately — regression guard', async () => {
    const before = await gitLogCount(dir)
    writeFileSync(join(dir, 'NEW.md'), 'landed\n')
    await commitStep(dir, 'normal', realExec)
    expect(await gitLogCount(dir)).toBe(before + 1)
    expect(existsSync(join(dir, 'NEW.md'))).toBe(true)
  })

  it('stagedRef sanitizes an unsafe key so a backlog id cannot inject a ref path', () => {
    expect(stagedRef('a/b c~1')).toBe('refs/duin/staged/a_b_c_1')
    expect(stagedRef('safe-id.9')).toBe('refs/duin/staged/safe-id.9')
  })
})
