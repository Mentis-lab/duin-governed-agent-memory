// Backlog finding 8 (critical), at the tool. drive_upload_file passed a caller-supplied
// absolute `path` straight to uploadDriveFile with no jail, so it would read anything
// the OS user could open and ship it to the operator's real Google Drive.
//
// It sits at `write-reversible`, and action-tier.ts requires explicit approval only for
// `irreversible` — so one "Always allow" on any other network-risk prompt pre-approved
// this too, by the documented risk-class fan-out. A poisoned document naming a private
// key would exfiltrate it with no prompt anywhere.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => 'C:/userData', isReady: () => true },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.mock('../google-auth', () => ({ ensureFreshGoogleToken: async () => 'TEST_TOKEN' }))
vi.mock('../workspace-state', () => ({ getActiveWorkspace: () => 'C:/work' }))
vi.mock('../settings-helper', () => ({ readSettings: () => ({ localBrainNotesDir: 'C:/vault' }) }))

// Capture what actually reaches the uploader, so "refused" means the read never happened.
const uploaded: Array<{ path?: string; content?: string }> = []
vi.mock('./gdrive-write', () => ({
  uploadDriveFile: async (a: { path?: string; content?: string }) => {
    uploaded.push(a)
    return { ok: true, id: 'f1', name: 'x' }
  }
}))

import './act-tool-pack'
import { toolRegistry } from '../tool-registry'
import { setActExecContext, clearActExecContext } from './external-action'

const CTX = { conversationId: 'test-conv' } as never
const call = (args: Record<string, unknown>) =>
  toolRegistry.executeNative('drive_upload_file', args, CTX) as Promise<{
    result: string
    status: string
  }>

// The external-action gate denies every write on a de-privileged turn BEFORE the
// handler runs, so authorize the turn — otherwise these would pass for the wrong
// reason (denied by the gate, never reaching the jail under test).
beforeEach(() => setActExecContext(true))
afterEach(() => clearActExecContext())

describe('drive_upload_file — local path is jailed', () => {
  it('refuses a path outside every permitted root, and never reads it', async () => {
    uploaded.length = 0
    const r = await call({ name: 'id_rsa', path: 'C:/Users/theo/.ssh/id_rsa' })
    expect(r.status).not.toBe('done')
    expect(r.result).toMatch(/refused|outside every permitted/i)
    // The crux: the uploader was never reached, so nothing was read or sent.
    expect(uploaded).toHaveLength(0)
  })

  it('refuses a traversal escape out of a permitted root', async () => {
    uploaded.length = 0
    const r = await call({ name: 'x', path: 'C:/work/../../Windows/System32/config/SAM' })
    expect(r.status).not.toBe('done')
    expect(uploaded).toHaveLength(0)
  })

  it('refuses a sibling directory whose name merely starts with a root', async () => {
    uploaded.length = 0
    await call({ name: 'x', path: 'C:/work-secrets/notes.txt' })
    expect(uploaded).toHaveLength(0)
  })

  it('allows a path inside the workspace', async () => {
    uploaded.length = 0
    const r = await call({ name: 'report.md', path: 'C:/work/report.md' })
    expect(r.status).toBe('done')
    expect(uploaded).toHaveLength(1)
    expect(uploaded[0].path).toMatch(/report\.md$/)
  })

  it('allows a path inside the vault', async () => {
    uploaded.length = 0
    await call({ name: 'n.md', path: 'C:/vault/n.md' })
    expect(uploaded).toHaveLength(1)
  })

  it('leaves inline content untouched — it was never a filesystem read', async () => {
    uploaded.length = 0
    const r = await call({ name: 'note.txt', content: 'hello' })
    expect(r.status).toBe('done')
    expect(uploaded[0]).toMatchObject({ content: 'hello', path: undefined })
  })
})
