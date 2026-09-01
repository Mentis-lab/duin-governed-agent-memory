// CALL-SITE coverage for the `artifact:saveToLibrary` IPC handler.
//
// THE GAP these tests close: 4385db4 fixed a data-loss defect in
// saveHtmlToVault AND changed the handler in electron/ipc/artifact.ts, because
// the return type became a discriminated union. There was no
// electron/ipc/artifact.test.ts at all — reverting the artifact.ts hunk left
// 9/9 of library-brain-bridge-save-snapshot.test.ts green. Two things were
// therefore unproven:
//
//  1. That the snapshot guard is actually WIRED to the handler the renderer
//     calls. `replaced` never reaching the toast is the whole point of the fix:
//     an overwrite rendering as a clean create is what made the original data
//     loss silent.
//  2. A LATENT BUG in the old check. The pre-fix handler read `if (!r)` — valid
//     when saveHtmlToVault returned `{...} | null`. After the union change,
//     `{ ok: false, error: '...' }` is TRUTHY, so `!r` is false and the
//     "no vault configured" case falls through to `return { success: true, data: r }`
//     — reporting SUCCESS, with the failure object itself as the payload. The
//     renderer would show `Saved "..." to your library` for a save that never
//     happened, and read `data.path`/`data.title` as undefined.
//
// These tests drive the REAL registered ipcMain handler against a REAL temp
// vault. electron is mocked only for ipcMain (to capture handlers) and app;
// settings-helper is stubbed to point at the temp vault (the same value
// production reads from settings.json). vault-trash and the JSONL journal run
// for real.
//
// POWER CONTROL: reverting ONLY the artifact.ts hunk fails both the `replaced`
// test and the no-vault test.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let vault = ''

type Handler = (event: unknown, ...args: any[]) => Promise<any>
const handlers = new Map<string, Handler>()

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
    getPath: () => process.cwd(),
    getVersion: () => '0.0.0-test'
  },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openPath: async () => '' }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

// The vault dir production reads out of settings.json. `vault = ''` is the real
// "no vault/library folder is configured" state.
vi.mock('../services/settings-helper', () => ({
  readSettings: () => ({ localBrainNotesDir: vault }),
  patchSettings: () => {}
}))

import { registerArtifactHandlers } from './artifact'
import { TRASH_DIR_NAME, TOMBSTONE_JOURNAL } from '../services/local-brain/vault-trash'

// The shape ArtifactPanel produces when deriveArtifactName finds no <title>/<h1>:
// both saves land on Documents/artifact.html.
const FIRST = '<html><body><h2>quarterly dashboard</h2><p>hand-edited in the workbench</p></body></html>'
const SECOND = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'

function docPath(title = 'artifact'): string {
  return join(vault, 'Documents', `${title}.html`)
}

function trashFiles(): string[] {
  const d = join(vault, TRASH_DIR_NAME)
  return existsSync(d) ? readdirSync(d).filter((f) => f !== TOMBSTONE_JOURNAL).sort() : []
}

function save(name: string, html: string): Promise<any> {
  return handlers.get('artifact:saveToLibrary')!({}, name, html)
}

beforeEach(() => {
  handlers.clear()
  vault = mkdtempSync(join(tmpdir(), 'duin-artifact-ipc-'))
  registerArtifactHandlers()
})

afterEach(() => {
  if (vault && existsSync(vault)) rmSync(vault, { recursive: true, force: true })
})

describe('artifact:saveToLibrary IPC handler (real call site)', () => {
  it('is registered', () => {
    expect(handlers.has('artifact:saveToLibrary')).toBe(true)
  })

  it('creates a new page with no snapshot and no `replaced`', async () => {
    const res = await save('artifact', FIRST)

    expect(res.success).toBe(true)
    expect(res.data.title).toBe('artifact')
    expect(res.data.path).toBe(docPath())
    expect(res.data.replaced).toBeUndefined()
    expect(readFileSync(docPath(), 'utf-8')).toBe(FIRST)
    expect(trashFiles()).toHaveLength(0)
  })

  it('preserves the prior page and surfaces `replaced` through the handler', async () => {
    mkdirSync(join(vault, 'Documents'), { recursive: true })
    writeFileSync(docPath(), FIRST, 'utf-8')

    const res = await save('artifact', SECOND)

    expect(res.success).toBe(true)
    // The overwrite must NOT render to the renderer as a clean create — this is
    // the field the toast reads to say a prior page was preserved.
    expect(typeof res.data.replaced).toBe('string')
    expect(String(res.data.replaced)).toContain('artifact')
    // New bytes landed; old bytes are recoverable.
    expect(readFileSync(docPath(), 'utf-8')).toBe(SECOND)
    const snaps = trashFiles()
    expect(snaps).toHaveLength(1)
    expect(readFileSync(join(vault, TRASH_DIR_NAME, snaps[0]), 'utf-8')).toBe(FIRST)
  })

  it('does not snapshot an unchanged re-save', async () => {
    mkdirSync(join(vault, 'Documents'), { recursive: true })
    writeFileSync(docPath(), FIRST, 'utf-8')

    const res = await save('artifact', FIRST)

    expect(res.success).toBe(true)
    expect(res.data.replaced).toBeUndefined()
    expect(trashFiles()).toHaveLength(0)
  })

  it('reports a real FAILURE when no vault is configured (not success with bogus data)', async () => {
    // LATENT BUG GUARD. saveHtmlToVault returns { ok: false, error } — a TRUTHY
    // object. The pre-fix `if (!r)` check therefore does not fire, and the handler
    // falls through to `{ success: true, data: r }`: the renderer is told the save
    // succeeded, with the failure object as the payload and no path/title.
    vault = ''

    const res = await save('artifact', FIRST)

    expect(res.success).toBe(false)
    expect(res.error).toBe('No vault/library folder is configured')
    // And nothing that looks like a successful save comes back.
    expect(res.data).toBeUndefined()
  })

  it('keeps a separator-bearing title sandboxed inside the vault', async () => {
    // sanitizeTitle folds whitespace, '-', '/' and ':' to '_' — the same folding
    // that makes "Q3 Plan"/"Q3-Plan"/"Q3/Plan" collide onto one file.
    const res = await save('../../escape', FIRST)

    expect(res.success).toBe(true)
    expect(String(res.data.path).startsWith(vault)).toBe(true)
  })
})
