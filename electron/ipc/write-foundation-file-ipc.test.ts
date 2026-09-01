// CALL-SITE coverage for `brain:writeFoundationFile` — the Foundations pane's write
// handler. Proves, at the real IPC boundary (temp-dir vault + mocked userData
// settings.json): the vault root is resolved main-side from settings (never trusted
// from the renderer); a missing brain folder returns a clear failure; a valid write
// busts the <agents_md> cache and broadcasts brain:updated; GOALS.md ALSO fires a
// reindex while ME/BRAIN do NOT; the whitelist rejects a non-foundation name at the
// boundary; and a written file round-trips through files:readText byte-for-byte.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let vault = ''
let userDataDir = ''

type Handler = (event: unknown, ...args: any[]) => Promise<any>
const handlers = new Map<string, Handler>()
const sent: { channel: string; payload: unknown }[] = []

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    },
    on: () => {}
  },
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => userDataDir,
    getVersion: () => '0.0.0-test'
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) }
      }
    ]
  },
  shell: { openPath: async () => '' },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

// Spy the side-effects the handler must fire. Hoisted so the mock factories (which
// vitest lifts to the top of the file) can reference them without a TDZ error.
const { invalidateAgentsMd, reindex } = vi.hoisted(() => ({
  invalidateAgentsMd: vi.fn(),
  reindex: vi.fn(async () => 0)
}))
vi.mock('../services/agents-md-loader', () => ({ invalidateAgentsMd }))
vi.mock('../services/local-brain/index-store', () => ({ reindex, indexedCount: () => 0 }))

import { registerOnboardingHandlers } from './onboarding'
import { registerFilesHandlers } from './files'
import { setActiveWorkspace } from '../services/workspace-state'

function setVault(dir: string): void {
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ localBrainNotesDir: dir }), 'utf-8')
}
function write(name: string, body: string): Promise<any> {
  return handlers.get('brain:writeFoundationFile')!({}, name, body)
}

beforeEach(() => {
  handlers.clear()
  sent.length = 0
  invalidateAgentsMd.mockClear()
  reindex.mockClear()
  vault = mkdtempSync(join(tmpdir(), 'duin-found-ipc-vault-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'duin-found-ipc-ud-'))
  setVault(vault)
  registerOnboardingHandlers()
  registerFilesHandlers()
})

afterEach(() => {
  for (const d of [vault, userDataDir]) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true })
  }
})

describe('brain:writeFoundationFile IPC handler', () => {
  it('is registered', () => {
    expect(handlers.has('brain:writeFoundationFile')).toBe(true)
  })

  it('fails clearly when no brain folder is set', async () => {
    writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({}), 'utf-8')
    const res = await write('ME.md', '# me\n')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/brain folder/i)
    expect(existsSync(join(vault, 'ME.md'))).toBe(false)
  })

  it('rejects a non-foundation name at the boundary and writes nothing', async () => {
    const res = await write('MEMORY.md', 'nope')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not a foundation file/)
    expect(existsSync(join(vault, 'MEMORY.md'))).toBe(false)
  })

  it('writes ME.md to the settings-resolved vault, busts agents_md cache, broadcasts, does NOT reindex', async () => {
    const res = await write('ME.md', '# Operator\n')
    expect(res.success).toBe(true)
    expect(res.data.name).toBe('ME.md')
    expect(readFileSync(join(vault, 'ME.md'), 'utf-8')).toBe('# Operator\n')
    expect(invalidateAgentsMd).toHaveBeenCalledTimes(1)
    expect(reindex).not.toHaveBeenCalled()
    expect(sent.some((s) => s.channel === 'brain:updated')).toBe(true)
  })

  it('saving GOALS.md fires a reindex (tracks re-parse on graph build)', async () => {
    const res = await write('GOALS.md', '# GOALS\n## Strategic Tracks (cross-cycle)\n### Ship\n')
    expect(res.success).toBe(true)
    expect(reindex).toHaveBeenCalledTimes(1)
    expect(reindex).toHaveBeenCalledWith(vault)
  })

  it('saving BRAIN.md does NOT reindex, still busts the agents_md cache', async () => {
    const res = await write('BRAIN.md', '# BRAIN\n')
    expect(res.success).toBe(true)
    expect(reindex).not.toHaveBeenCalled()
    expect(invalidateAgentsMd).toHaveBeenCalledTimes(1)
  })

  it('surfaces the .trash recovery path when overwriting an existing file', async () => {
    writeFileSync(join(vault, 'ME.md'), '# original\n', 'utf-8')
    const res = await write('ME.md', '# edited\n')
    expect(res.success).toBe(true)
    expect(res.data.replacedTrashRel).toBeDefined()
    const recovered = join(vault, ...String(res.data.replacedTrashRel).split('/'))
    expect(readFileSync(recovered, 'utf-8')).toBe('# original\n')
  })

  it('round-trips through files:readText exactly what was written', async () => {
    // files:readText confines to the workspace/vault — point the workspace at the vault.
    setActiveWorkspace(vault)
    const body = '# BRAIN\n\n## Contract\n- ground every answer\n'
    await write('BRAIN.md', body)
    const read = await handlers.get('files:readText')!({}, join(vault, 'BRAIN.md'))
    expect(read.success).toBe(true)
    expect(read.data.content).toBe(body)
  })
})
