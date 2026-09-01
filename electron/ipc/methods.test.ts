import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import matter from 'gray-matter'

const handlers = new Map<string, (...args: any[]) => any>()
let vaultDir = ''
let userDataDir = ''

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: any[]) => any) => handlers.set(channel, fn)
  },
  app: { getPath: () => userDataDir },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] }
}))

vi.mock('../services/settings-helper', () => ({
  readSettings: () => ({ localBrainNotesDir: vaultDir })
}))

import { registerMethodsHandlers } from './methods'

const call = (channel: string, ...args: any[]): Promise<any> =>
  handlers.get(channel)!(null, ...args)

beforeEach(() => {
  handlers.clear()
  vaultDir = mkdtempSync(join(tmpdir(), 'duin-methods-vault-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'duin-methods-userdata-'))
  registerMethodsHandlers()
})

afterEach(() => {
  rmSync(vaultDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
})

const DRAFT = {
  name: 'Deal debrief',
  description: 'Turn a call into an internal debrief',
  deliverable: 'an internal debrief preserving judgment verbatim',
  callsSkills: ['meeting-note', 'preserve'],
  content: '## Method\n\nWhy.\n\n## Steps\n\n1. Capture.\n2. Rewrite.'
}

describe('methods:create — writes a note both readers can actually see', () => {
  it('lands in the vault with the frontmatter the method walk gates on', async () => {
    const res = await call('methods:create', DRAFT)
    expect(res.success).toBe(true)

    const abs = join(vaultDir, res.data.path)
    expect(existsSync(abs)).toBe(true)
    const parsed = matter(readFileSync(abs, 'utf-8'))

    // `type: method` is the gate — without it the note is invisible as a method.
    expect(parsed.data.type).toBe('method')
    expect(parsed.data.name).toBe('Deal debrief')
    expect(parsed.data['calls-skills']).toEqual(['meeting-note', 'preserve'])
    // prepareMethodRun lifts this heading verbatim; a different spelling loses the steps.
    expect(parsed.content).toContain('## Steps')
  })

  it('never contains "template", which the method walk skips outright', async () => {
    const res = await call('methods:create', { ...DRAFT, name: 'Template for debriefs' })
    expect(res.success).toBe(true)
    expect(res.data.path.toLowerCase()).not.toContain('template')
  })

  it('does not overwrite a method that already exists', async () => {
    const first = await call('methods:create', DRAFT)
    const second = await call('methods:create', DRAFT)
    expect(second.success).toBe(true)
    expect(second.data.path).not.toBe(first.data.path)
    expect(readdirSync(join(vaultDir, 'Methods'))).toHaveLength(2)
  })

  it('refuses without a name', async () => {
    const res = await call('methods:create', { ...DRAFT, name: '  ' })
    expect(res.success).toBe(false)
  })
})

describe('methods:read / update — round-trips the draft', () => {
  it('reads back what create wrote', async () => {
    const { data } = await call('methods:create', DRAFT)
    const res = await call('methods:read', data.path)
    expect(res.success).toBe(true)
    expect(res.data.name).toBe(DRAFT.name)
    expect(res.data.deliverable).toBe(DRAFT.deliverable)
    expect(res.data.callsSkills).toEqual(DRAFT.callsSkills)
  })

  it('archives the prior bytes before overwriting', async () => {
    const { data } = await call('methods:create', DRAFT)
    const before = readFileSync(join(vaultDir, data.path), 'utf-8')

    const res = await call('methods:update', data.path, { ...DRAFT, name: 'Renamed' })
    expect(res.success).toBe(true)
    expect(readFileSync(join(vaultDir, data.path), 'utf-8')).toContain('name: Renamed')
    // These are the user's own vault notes; an edit must leave the prior version recoverable.
    expect(readFileSync(res.data.archivePath, 'utf-8')).toBe(before)
  })
})

describe('methods:delete — recoverable, and only inside the vault', () => {
  it('archives before unlinking', async () => {
    const { data } = await call('methods:create', DRAFT)
    const before = readFileSync(join(vaultDir, data.path), 'utf-8')

    const res = await call('methods:delete', data.path)
    expect(res.success).toBe(true)
    expect(existsSync(join(vaultDir, data.path))).toBe(false)
    expect(readFileSync(res.data.archivePath, 'utf-8')).toBe(before)
  })

  it('refuses a path that climbs out of the vault', async () => {
    const outside = join(userDataDir, 'secret.md')
    writeFileSync(outside, 'not yours', 'utf-8')

    for (const bad of ['../secret.md', '../../secret.md', outside]) {
      const res = await call('methods:delete', bad)
      expect(res.success).toBe(false)
    }
    expect(existsSync(outside)).toBe(true)
  })
})

describe('no vault configured', () => {
  it('says so instead of reporting an empty library', async () => {
    vaultDir = ''
    const res = await call('methods:list')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/vault/i)
  })
})

describe('methods:list', () => {
  it('surfaces a created method through the same walk the panel uses', async () => {
    await call('methods:create', DRAFT)
    // A non-method note in the vault must not appear.
    mkdirSync(join(vaultDir, 'Notes'), { recursive: true })
    writeFileSync(join(vaultDir, 'Notes', 'plain.md'), '---\ntype: note\n---\nBody\n', 'utf-8')

    const res = await call('methods:list')
    expect(res.success).toBe(true)
    expect(res.data.map((m: any) => m.name)).toEqual(['Deal debrief'])
  })
})
