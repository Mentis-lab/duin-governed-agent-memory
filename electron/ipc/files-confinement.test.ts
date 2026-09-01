import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const handlers = new Map<string, (event: unknown, args?: unknown) => Promise<unknown>>()
const fixtureRoot = mkdtempSync(join(tmpdir(), 'duin-files-confine-'))
const workspace = join(fixtureRoot, 'workspace')
const outside = join(fixtureRoot, 'outside')
mkdirSync(workspace)
mkdirSync(outside)

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args?: unknown) => Promise<unknown>): void => {
      handlers.set(channel, fn)
    }
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  BrowserWindow: { getAllWindows: (): unknown[] => [] },
  shell: { openPath: async (): Promise<string> => '' }
}))

let activeWorkspace = workspace
let explicitWorkspace: string | null = workspace
const setActiveWorkspace = vi.fn((candidate: string) => {
  activeWorkspace = candidate
  return { path: candidate }
})

vi.mock('../services/workspace-state', () => ({
  getActiveWorkspace: (): string => activeWorkspace,
  getExplicitActiveWorkspace: (): string | null => explicitWorkspace,
  setActiveWorkspace: (candidate: string): { path: string } => setActiveWorkspace(candidate),
  clearActiveWorkspace: (): void => undefined
}))

vi.mock('../services/settings-helper', () => ({
  readSettings: (): Record<string, unknown> => ({})
}))

vi.mock('../services/sandbox/operator-write-paths', () => ({
  operatorWritePaths: (): string[] => [],
  // Full access OFF in these tests: assertConfined is deliberately permissive under the
  // full-computer-access default, and this suite pins the locked-down jail behavior.
  fullComputerAccess: (): boolean => false
}))

const processFiles = vi.fn(async (paths: string[]) => paths)
vi.mock('../services/file-handler', () => ({
  processFiles: (paths: string[]): Promise<string[]> => processFiles(paths),
  processPastedImage: async (): Promise<unknown> => ({})
}))

const { registerFilesHandlers } = await import('./files')
registerFilesHandlers()

function call(channel: string, args?: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`handler not registered: ${channel}`)
  return handler({}, args)
}

beforeEach(() => {
  activeWorkspace = workspace
  explicitWorkspace = workspace
  processFiles.mockClear()
  setActiveWorkspace.mockClear()
})

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('renderer-selected file confinement', () => {
  it('processes a dropped file inside the active workspace', async () => {
    const file = join(workspace, 'inside.md')
    writeFileSync(file, 'inside')

    const result = (await call('files:process', [file])) as { success: boolean }

    expect(result.success).toBe(true)
    expect(processFiles).toHaveBeenCalledWith([realpathSync(file)])
  })

  // files:process re-jailed 2026-08-25: its one legitimate out-of-jail caller (drag-drop attach)
  // now sends genuine File objects through files:processDropped — the preload resolves their
  // paths inside the isolated world, so a renderer string cannot impersonate an OS drop. The
  // 2026-08-22 unconfinement (drag-ingest consent argument) is thereby retired, not reverted.
  it('rejects a dropped file outside trusted roots', async () => {
    const file = join(outside, 'outside.md')
    writeFileSync(file, 'outside')

    const result = (await call('files:process', [file])) as {
      success: boolean
      error?: string
    }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/outside the workspace\/vault/i)
    expect(processFiles).not.toHaveBeenCalled()
  })

  it('reads an OS-dropped external file without granting its parent directory', async () => {
    const file = join(outside, 'external.md')
    writeFileSync(file, 'external')

    const result = (await call('files:processDropped', [file])) as { success: boolean }

    expect(result.success).toBe(true)
    expect(processFiles).toHaveBeenCalledWith([realpathSync(file)])
    expect(explicitWorkspace).toBe(workspace)
  })

  it('rejects a pathless browser File instead of reporting an empty success', async () => {
    const result = (await call('files:processDropped', [])) as {
      success: boolean
      error?: string
    }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no readable dropped file paths/i)
    expect(processFiles).not.toHaveBeenCalled()
  })

  it('rejects a symlink or junction that escapes an allowed root', async () => {
    const file = join(outside, 'escaped.md')
    const linkedDir = join(workspace, 'linked-outside')
    writeFileSync(file, 'outside')
    symlinkSync(outside, linkedDir, process.platform === 'win32' ? 'junction' : 'dir')

    const result = (await call('files:process', [join(linkedDir, 'escaped.md')])) as {
      success: boolean
      error?: string
    }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/outside the workspace\/vault/i)
  })

  it('allows selecting the current trusted workdir but rejects a new renderer-chosen root', async () => {
    const accepted = (await call('files:setWorkdir', workspace)) as { success: boolean }
    const rejected = (await call('files:setWorkdir', outside)) as {
      success: boolean
      error?: string
    }

    expect(accepted.success).toBe(true)
    expect(setActiveWorkspace).toHaveBeenCalledWith(realpathSync(workspace))
    expect(rejected.success).toBe(false)
    expect(rejected.error).toMatch(/outside the workspace\/vault/i)
  })

  it('rejects outside and UNC Explorer launch targets', async () => {
    const outsideResult = (await call('files:openInExplorer', {
      targetPath: outside
    })) as { success: boolean }
    expect(outsideResult.success).toBe(false)
    if (process.platform === 'win32') {
      const uncResult = (await call('files:openInExplorer', {
        targetPath: '\\\\server\\share'
      })) as { success: boolean }
      expect(uncResult.success).toBe(false)
    }
  })
})
