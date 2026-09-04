import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Real tmp userData so settings.ts reads/writes a real settings.json. The
// event-log + projects-store layers are forced into their memory fallbacks
// so we don't open a real SQLite db.
const userDataDir = mkdtempSync(join(tmpdir(), 'lamprey-p4-misc-'))

const ipcRegistered: Map<string, (...args: any[]) => any> = new Map()

vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData') return userDataDir
      throw new Error(`unexpected getPath("${which}") in test`)
    }
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      ipcRegistered.set(channel, handler)
    }
  }
}))

// projects-store relies on getDb. Stub the four mutating fns so we can
// directly observe whether the wrapping emit call fires; we don't need real
// SQLite here because the producers are the unit under test.
vi.mock('./database', () => ({
  getDb: () => ({
    prepare: () => ({
      run: () => ({ changes: 0 }),
      get: () => undefined,
      all: () => []
    })
  }),
  // deleteProject wraps its detach+delete in transactional() + withWriteRetry()
  // so a failed DELETE can't leave conversations severed from a surviving
  // project. Both are pass-throughs here — the real transactional() likewise
  // degrades to fn() when no DB handle is cached, and the atomicity itself is
  // covered against a real DB in projects-delete-node.test.ts.
  transactional: <T,>(fn: () => T): T => fn(),
  withWriteRetry: <T,>(fn: () => T): T => fn()
}))

// keychain + deepseek + providers are imported by settings.ts but the test
// only exercises settings:set. Stub the ones that would otherwise reach a
// real keychain file or network.
vi.mock('./keychain', () => ({
  setKey: vi.fn(),
  deleteKey: vi.fn(),
  isEncryptionAvailable: () => true,
  grantPlaintextConsent: vi.fn(),
  hasPlaintextConsent: () => true
}))
vi.mock('./deepseek', () => ({
  deepseekClient: { resetClient: vi.fn() }
}))

import {
  __forceMemoryFallback,
  __resetEventLog,
  listEvents
} from './event-log'

beforeEach(() => {
  __resetEventLog()
  __forceMemoryFallback()
  ipcRegistered.clear()
  const settingsPath = join(userDataDir, 'settings.json')
  if (existsSync(settingsPath)) rmSync(settingsPath)
})

// ──────────────────── settings.updated ────────────────────

describe('settings:set emits settings.updated with changed key NAMES only', () => {
  it('first set writes settings.json + emits a settings.updated event for the changed keys', async () => {
    const { registerSettingsHandlers } = await import('../ipc/settings')
    registerSettingsHandlers()
    const handler = ipcRegistered.get('settings:set')!
    const before = listEvents({ type: 'settings.updated' }).length
    await handler(undefined, { language: 'zh', fontSize: 16 })
    const after = listEvents({ type: 'settings.updated' })
    expect(after.length).toBe(before + 1)
    const payload = after[after.length - 1].payload as {
      changedKeys: string[]
      sensitiveChanged: string[]
      partialKeys: string[]
    }
    expect(payload.changedKeys).toEqual(expect.arrayContaining(['language', 'fontSize']))
    expect(payload.sensitiveChanged).toEqual([])
    expect(payload.partialKeys).toEqual(['language', 'fontSize'])
    // settings.json itself wrote the values, but the event payload must NOT.
    const written = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf-8'))
    expect(written.language).toBe('zh')
    expect(written.fontSize).toBe(16)
    const json = JSON.stringify(after[after.length - 1].payload)
    expect(json).not.toContain('"zh"')
    expect(json).not.toContain('"16"')
  })

  it('setting a value identical to the existing one emits NO event', async () => {
    const { registerSettingsHandlers } = await import('../ipc/settings')
    registerSettingsHandlers()
    const handler = ipcRegistered.get('settings:set')!
    await handler(undefined, { language: 'zh' })
    const baseline = listEvents({ type: 'settings.updated' }).length
    await handler(undefined, { language: 'zh' })
    expect(listEvents({ type: 'settings.updated' }).length).toBe(baseline)
  })

  // 2026-09-03 (settings evaluation D5): `apiKey` is not a setting — keys live encrypted in
  // keys.json — so settings:set now refuses it by name instead of persisting a secret in
  // plaintext and flagging it sensitive after the fact. No event, no file.
  it('refuses a secret written as a settings key, and emits no event for it', async () => {
    const { registerSettingsHandlers } = await import('../ipc/settings')
    registerSettingsHandlers()
    const handler = ipcRegistered.get('settings:set')!
    const baseline = listEvents({ type: 'settings.updated' }).length
    const res = await handler(undefined, { apiKey: 'sk-newvalue' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/apiKey is not a setting DUIN knows/)
    expect(listEvents({ type: 'settings.updated' }).length).toBe(baseline)
    const path = join(userDataDir, 'settings.json')
    if (existsSync(path)) expect(readFileSync(path, 'utf-8')).not.toContain('sk-newvalue')
  })
})

// ──────────────────── project.* ────────────────────

describe('projects-store emits project.* events for discrete actions', () => {
  it('createProject emits project.created tagged with projectId', async () => {
    const { createProject } = await import('./projects-store')
    const p = createProject({ name: 'Spike', path: '/tmp/spike' })
    const events = listEvents({ type: 'project.created', projectId: p.id })
    expect(events).toHaveLength(1)
    expect(events[0].projectId).toBe(p.id)
    expect((events[0].payload as { name: string }).name).toBe('Spike')
  })

  it('setProjectArchived emits project.archived with the new flag', async () => {
    const { setProjectArchived } = await import('./projects-store')
    setProjectArchived('proj-X', true)
    setProjectArchived('proj-X', false)
    const events = listEvents({ type: 'project.archived', projectId: 'proj-X', order: 'asc' })
    expect(events.map((e) => (e.payload as { archived: boolean }).archived)).toEqual([
      true,
      false
    ])
  })

  it('setProjectPinned emits project.pinned', async () => {
    const { setProjectPinned } = await import('./projects-store')
    setProjectPinned('proj-Y', true)
    const events = listEvents({ type: 'project.pinned', projectId: 'proj-Y' })
    expect(events).toHaveLength(1)
    expect((events[0].payload as { pinned: boolean }).pinned).toBe(true)
  })

  it('deleteProject emits project.deleted', async () => {
    const { deleteProject } = await import('./projects-store')
    deleteProject('proj-Z')
    const events = listEvents({ type: 'project.deleted', projectId: 'proj-Z' })
    expect(events).toHaveLength(1)
    expect(events[0].projectId).toBe('proj-Z')
  })

  it('renameProject is intentionally silent (noisy bookkeeping, not a spine event)', async () => {
    const { renameProject } = await import('./projects-store')
    renameProject('proj-Q', 'new name')
    const events = listEvents({ projectId: 'proj-Q' })
    expect(events).toHaveLength(0)
  })
})
