import { describe, it, expect, vi, beforeEach } from 'vitest'

// U5 (adjacent bug) — the working-folder picker lied.
//
// files:pickWorkdir opened the dialog and RETURNED the chosen path without
// persisting it, yet Titlebar.tsx and WorkModePopover.tsx both toast
// "Working folder set: <name>" off that return value alone. Only ChatInput
// followed up with files:setWorkdir, so two of the three picker surfaces set
// nothing at all — every workspace-resolving consumer (review, chat tools,
// monitor, tasks) kept pointing at the previous folder.
//
// Persisting inside the handler fixes all three call sites at once and keeps
// the toast honest; ChatInput's follow-up setWorkdir is then idempotent.

const handlers = new Map<string, (event: unknown, args?: unknown) => Promise<unknown>>()

let dialogResult: { canceled: boolean; filePaths: string[] } = { canceled: true, filePaths: [] }

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args?: unknown) => Promise<unknown>): void => {
      handlers.set(channel, fn)
    }
  },
  dialog: { showOpenDialog: async () => dialogResult },
  BrowserWindow: { getAllWindows: (): unknown[] => [] },
  shell: { openPath: async (): Promise<string> => '' }
}))

const setCalls: string[] = []
let setThrows: Error | null = null

vi.mock('../services/workspace-state', () => ({
  getActiveWorkspace: (): string => '/previous/workspace',
  setActiveWorkspace: (p: string): { path: string } => {
    if (setThrows) throw setThrows
    setCalls.push(p)
    return { path: p }
  },
  clearActiveWorkspace: (): void => undefined
}))

vi.mock('../services/settings-helper', () => ({
  readSettings: (): Record<string, unknown> => ({})
}))

vi.mock('../services/file-handler', () => ({
  processFiles: async (): Promise<unknown[]> => [],
  processPastedImage: async (): Promise<unknown> => ({})
}))

const { registerFilesHandlers } = await import('./files')

registerFilesHandlers()

function call(channel: string, args?: unknown): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return fn({}, args)
}

beforeEach(() => {
  setCalls.length = 0
  setThrows = null
  dialogResult = { canceled: true, filePaths: [] }
})

describe('files:pickWorkdir persists the chosen folder', () => {
  it('sets the active workspace to the picked directory', async () => {
    const picked = process.platform === 'win32' ? 'C:\\picked\\repo' : '/picked/repo'
    dialogResult = { canceled: false, filePaths: [picked] }
    const res = (await call('files:pickWorkdir')) as {
      success: boolean
      data: { path: string; name: string } | null
    }
    expect(res.success).toBe(true)
    expect(res.data?.path).toBe(picked)
    // The claim the toast makes must actually be true in main-process state.
    expect(setCalls).toEqual([picked])
  })

  it('persists nothing when the dialog is cancelled', async () => {
    dialogResult = { canceled: true, filePaths: [] }
    const res = (await call('files:pickWorkdir')) as { success: boolean; data: unknown }
    expect(res.success).toBe(true)
    expect(res.data).toBe(null)
    expect(setCalls).toEqual([])
  })

  it('reports failure instead of a false success when persisting fails', async () => {
    const picked = process.platform === 'win32' ? 'C:\\gone' : '/gone'
    dialogResult = { canceled: false, filePaths: [picked] }
    setThrows = new Error('setActiveWorkspace: "/gone" does not exist')
    const res = (await call('files:pickWorkdir')) as { success: boolean; error?: string }
    expect(res.success).toBe(false)
    expect(res.error).toBeTruthy()
  })
})
