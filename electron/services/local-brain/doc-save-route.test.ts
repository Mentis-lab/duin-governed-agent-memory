// CALL-SITE coverage for POST /state/doc/save (brain-native-routes-2.ts).
//
// THE GAP these tests close: 47c7f8f fixed a data-loss defect in the ROUTE by
// replacing a bare `mkdirSync + writeFileSync` with a call to the new
// saveVaultDoc(). doc-save-snapshot.test.ts has a describe block literally named
// `/state/doc/save` — but it only imports `saveVaultDoc`. So reverting the
// brain-native-routes-2.ts hunk back to the pre-fix mkdirSync + writeFileSync
// (the original defect, verbatim) left all 8 of those tests green: the library
// guard was proven, the WIRE was not, and un-wired == un-fixed.
//
// These tests drive the REAL route handler, handleRequestNativeImpl2, through a
// fake IncomingMessage/ServerResponse pair against a REAL temp vault. Nothing
// about the save path is stubbed: docAbspath, the settings reader seam
// (setLocalBrainSettingsReader — the same injection production uses at boot),
// saveVaultDoc, vault-trash and the JSONL journal all run for real.
//
// POWER CONTROL: reverting ONLY the routes-2 hunk fails the overwrite tests —
// the grown note is gone from disk with no .trash entry and an unqualified
// { ok: true }.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { IncomingMessage, ServerResponse } from 'http'

// The route module's import graph reaches electron (artifact-sandbox reads
// app.isPackaged at module load). Stubbed only so the module can be imported —
// nothing on the save path consults it.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    getVersion: () => '0.0.0-test'
  },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openPath: async () => '' },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { setLocalBrainSettingsReader } from './server'
import { handleRequestNativeImpl2 } from './brain-native-routes-2'
import { TRASH_DIR_NAME, TOMBSTONE_JOURNAL } from './vault-trash'

let vault = ''

const OUTPUT_REL = 'Outputs/board-brief.md'

/** What the note grew into after OutputsPanel first created it. */
const GROWN =
  `---\ntype: output\ntitle: Board brief\nstatus: in-review\nproject: Q3 Board\n---\n\n` +
  Array.from({ length: 400 }, (_, i) => `line ${i + 1}: hand-written board brief detail`).join('\n') +
  '\n'

/** What OutputsPanel synthesizes on the second save — path AND body from scratch. */
const STUB = `---\ntype: output\ntitle: Board brief\n---\n\nfirst line\nsecond line`

interface RouteReply {
  status: number
  body: Record<string, unknown>
}

/** POST a JSON body at the real route and await the response it writes. */
function postDocSave(payload: unknown): Promise<RouteReply> {
  return new Promise((resolve) => {
    const req = new EventEmitter() as IncomingMessage
    req.method = 'POST'
    req.url = '/state/doc/save'
    req.headers = {}

    let status = 0
    const res = {
      writeHead: (code: number) => {
        status = code
        return res
      },
      end: (chunk?: string) => {
        resolve({ status, body: JSON.parse(String(chunk || '{}')) })
        return res
      },
      setHeader: () => res,
      write: () => true
    } as unknown as ServerResponse

    handleRequestNativeImpl2(req, res)
    // readBody attaches its listeners synchronously inside the route's async IIFE,
    // so feed the body on the next tick.
    setImmediate(() => {
      req.emit('data', JSON.stringify(payload))
      req.emit('end')
    })
  })
}

function abs(rel: string): string {
  return join(vault, ...rel.split('/'))
}

function seed(rel: string, body: string): void {
  const p = abs(rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body, 'utf-8')
}

function trashFiles(): string[] {
  const d = join(vault, TRASH_DIR_NAME)
  return existsSync(d) ? readdirSync(d).filter((f) => f !== TOMBSTONE_JOURNAL).sort() : []
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'duin-docsave-route-'))
  // The same seam main.ts uses at boot to inject settings-helper.readSettings.
  setLocalBrainSettingsReader(() => ({ localBrainNotesDir: vault }))
})

afterEach(() => {
  setLocalBrainSettingsReader(() => ({}))
  if (vault && existsSync(vault)) rmSync(vault, { recursive: true, force: true })
})

describe('POST /state/doc/save (real route handler)', () => {
  it('preserves the prior note to .trash before overwriting it', async () => {
    seed(OUTPUT_REL, GROWN)

    const reply = await postDocSave({ path: OUTPUT_REL, content: STUB })

    expect(reply.status).toBe(200)
    expect(reply.body.ok).toBe(true)
    // The new bytes did land — the vault still self-evolves.
    expect(readFileSync(abs(OUTPUT_REL), 'utf-8')).toBe(STUB)
    // ...but the 400 hand-written lines are preserved, not deleted.
    const snapshots = trashFiles()
    expect(snapshots).toHaveLength(1)
    expect(readFileSync(join(vault, TRASH_DIR_NAME, snapshots[0]), 'utf-8')).toBe(GROWN)
  })

  it('reports `replaced` to the renderer instead of an unqualified success', async () => {
    seed(OUTPUT_REL, GROWN)

    const reply = await postDocSave({ path: OUTPUT_REL, content: STUB })

    // OutputsPanel warns with this instead of a bare toast.success('Output saved').
    expect(typeof reply.body.replaced).toBe('string')
    expect(String(reply.body.replaced)).toContain('board-brief')
  })

  it('records the overwrite in the tombstone journal', async () => {
    seed(OUTPUT_REL, GROWN)

    await postDocSave({ path: OUTPUT_REL, content: STUB })

    const journal = join(vault, TRASH_DIR_NAME, TOMBSTONE_JOURNAL)
    expect(existsSync(journal)).toBe(true)
    const entries = readFileSync(journal, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(entries).toHaveLength(1)
    expect(entries[0].actor).toBe('ui:doc-save')
  })

  it('creates a brand-new note with no snapshot and no `replaced`', async () => {
    const reply = await postDocSave({ path: 'Outputs/fresh-note.md', content: STUB })

    expect(reply.body.ok).toBe(true)
    expect(reply.body.replaced).toBeUndefined()
    expect(readFileSync(abs('Outputs/fresh-note.md'), 'utf-8')).toBe(STUB)
    expect(trashFiles()).toHaveLength(0)
  })

  it('does not snapshot an unchanged re-save', async () => {
    seed(OUTPUT_REL, STUB)

    const reply = await postDocSave({ path: OUTPUT_REL, content: STUB })

    expect(reply.body.ok).toBe(true)
    expect(reply.body.replaced).toBeUndefined()
    expect(trashFiles()).toHaveLength(0)
  })

  it('still rejects a path outside the vault', async () => {
    const reply = await postDocSave({ path: '../escape.md', content: STUB })

    expect(reply.status).toBe(404)
    expect(reply.body.ok).toBe(false)
  })
})
