import { describe, it, expect, vi, beforeEach } from 'vitest'

// U5 — every review:* git action must run against the ACTIVE WORKSPACE (the
// folder the user picked), not process.cwd() (the folder DUIN itself was
// launched from). On a packaged install process.cwd() is the install dir,
// which is not a git repo at all — so Review/Environment were permanently
// inert; on a dev launch it is DUIN's OWN repo, so Stage/Discard operated on
// the wrong tree. review.ts was the only workspace-touching IPC module with
// zero references to getActiveWorkspace.

const handlers = new Map<string, (event: unknown, args?: unknown) => Promise<unknown>>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args?: unknown) => Promise<unknown>): void => {
      handlers.set(channel, fn)
    }
  },
  BrowserWindow: { getAllWindows: (): unknown[] => [] }
}))

// Keep the real chokidar off the disk — ensureWatcher() runs inside review:status.
vi.mock('chokidar', () => ({
  default: {
    watch: () => ({ on: () => undefined, close: async () => undefined })
  }
}))

const WORKSPACE = process.platform === 'win32' ? 'C:\\picked\\workspace' : '/picked/workspace'

vi.mock('../services/workspace-state', () => ({
  getActiveWorkspace: (): string => WORKSPACE
}))

interface GitCall {
  args: string[]
  cwd: string
}
const gitCalls: GitCall[] = []
let gitReply: (args: string[]) => { stdout: string; stderr: string; code: number } = () => ({
  stdout: '',
  stderr: '',
  code: 0
})

vi.mock('../services/git-runner', () => ({
  runGit: async (args: string[], cwd: string) => {
    gitCalls.push({ args, cwd })
    return gitReply(args)
  }
}))

const { registerReviewHandlers } = await import('./review')

registerReviewHandlers()

function call(channel: string, args?: unknown): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return fn({}, args)
}

beforeEach(() => {
  gitCalls.length = 0
  gitReply = () => ({ stdout: '', stderr: '', code: 0 })
})

describe('review:* resolves the active workspace, never process.cwd()', () => {
  // Every renderer caller omits `cwd` (ReviewPanel, BranchPickerPopover,
  // EnvironmentPanel, FloatingEnvironmentCard, useEnvironment all invoke with
  // `{}` / no args), so the no-cwd case IS the production case.
  const cases: Array<[string, unknown]> = [
    ['review:status', {}],
    ['review:diff', { path: 'a.ts' }],
    ['review:stage', { path: 'a.ts' }],
    ['review:unstage', { path: 'a.ts' }],
    ['review:discard', { path: 'a.ts' }],
    ['review:branches', undefined],
    ['review:checkout', { name: 'main' }],
    ['review:createBranch', { name: 'feat' }],
    ['review:summary', undefined],
    ['review:commit', { message: 'msg' }],
    ['review:push', undefined]
  ]

  for (const [channel, args] of cases) {
    it(`${channel} runs git in the active workspace when no cwd is passed`, async () => {
      await call(channel, args)
      expect(gitCalls.length).toBeGreaterThan(0)
      for (const c of gitCalls) {
        expect(c.cwd).toBe(WORKSPACE)
        expect(c.cwd).not.toBe(process.cwd())
      }
    })
  }

  it('still honours an explicit cwd argument (caller override wins)', async () => {
    const explicit = process.platform === 'win32' ? 'C:\\other\\repo' : '/other/repo'
    await call('review:status', { cwd: explicit })
    expect(gitCalls.every((c) => c.cwd === explicit)).toBe(true)
  })
})

describe('review:status reports the resolved cwd and a not-a-repository state', () => {
  it('returns the resolved workspace as data.cwd on success', async () => {
    gitReply = (args) => {
      if (args[0] === 'rev-parse') return { stdout: 'feature/x\n', stderr: '', code: 0 }
      if (args[0] === 'status') return { stdout: ' M src/a.ts\n', stderr: '', code: 0 }
      return { stdout: '0', stderr: '', code: 0 }
    }
    const res = (await call('review:status', {})) as {
      success: boolean
      data: { cwd: string; branch: string | null; isRepository: boolean }
    }
    expect(res.success).toBe(true)
    expect(res.data.cwd).toBe(WORKSPACE)
    expect(res.data.branch).toBe('feature/x')
    expect(res.data.isRepository).toBe(true)
  })

  it('flags a non-git workspace explicitly instead of returning an empty diff', async () => {
    gitReply = () => ({
      stdout: '',
      stderr: `fatal: not a git repository (or any of the parent directories): .git\n`,
      code: 128
    })
    const res = (await call('review:status', {})) as {
      success: boolean
      error: string
      notARepository?: boolean
      cwd?: string
    }
    expect(res.success).toBe(false)
    expect(res.notARepository).toBe(true)
    expect(res.cwd).toBe(WORKSPACE)
    expect(res.error).toContain('Not a git repository')
    expect(res.error).toContain(WORKSPACE)
  })

  it('leaves other git failures as ordinary errors (not mislabelled)', async () => {
    gitReply = () => ({ stdout: '', stderr: 'fatal: index file corrupt', code: 128 })
    const res = (await call('review:status', {})) as {
      success: boolean
      error: string
      notARepository?: boolean
    }
    expect(res.success).toBe(false)
    expect(res.notARepository).toBeUndefined()
    expect(res.error).toBe('fatal: index file corrupt')
  })
})
