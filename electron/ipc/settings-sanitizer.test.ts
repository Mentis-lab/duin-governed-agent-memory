import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Tests for the prototype-pollution + non-object defence added to
// settings:set. Mocks electron so the handler can run headlessly and
// captures the registered handler so we can call it directly.

const userDataDir = mkdtempSync(join(tmpdir(), 'lamprey-settings-sanit-'))
const ipcRegistered: Map<string, (...args: any[]) => any> = new Map()

vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData') return userDataDir
      throw new Error(`unexpected getPath("${which}")`)
    }
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      ipcRegistered.set(channel, handler)
    }
  }
}))

vi.mock('../services/database', () => ({
  getDb: () => ({
    prepare: () => ({
      run: () => ({ changes: 0 }),
      get: () => undefined,
      all: () => []
    })
  })
}))

vi.mock('../services/keychain', () => ({
  setKey: vi.fn(),
  deleteKey: vi.fn(),
  isEncryptionAvailable: () => true,
  grantPlaintextConsent: vi.fn(),
  hasPlaintextConsent: () => true
}))
vi.mock('../services/deepseek', () => ({
  deepseekClient: { resetClient: vi.fn() }
}))
vi.mock('../services/brain-vault-adoption', () => ({
  commitReadyBrainVault: async () => ({
    success: true,
    data: { indexedCount: 0, indexStatus: 'ready' }
  }),
  enqueueBrainVaultMutation: <T>(operation: () => Promise<T>) => operation(),
  reindexAndBuild: async () => 0
}))

import {
  __forceMemoryFallback,
  __resetEventLog
} from '../services/event-log'
import {
  __resetTrustedDirectoryGrants,
  grantTrustedDirectory
} from '../services/trusted-path-grants'

beforeEach(() => {
  __resetEventLog()
  __forceMemoryFallback()
  __resetTrustedDirectoryGrants()
  ipcRegistered.clear()
  const settingsPath = join(userDataDir, 'settings.json')
  if (existsSync(settingsPath)) rmSync(settingsPath)
})

describe('settings:set sanitizer', () => {
  it('rejects a renderer-minted vault root and accepts the same directory after a picker grant', async () => {
    const { registerSettingsHandlers } = await import('./settings')
    registerSettingsHandlers()
    const handler = ipcRegistered.get('settings:set')!

    const rejected = await handler(undefined, { localBrainNotesDir: userDataDir })
    expect(rejected.success).toBe(false)
    expect(rejected.error).toMatch(/native folder picker/i)

    grantTrustedDirectory(userDataDir)
    const accepted = await handler(undefined, { localBrainNotesDir: userDataDir })
    expect(accepted.success).toBe(true)
  })

  it('does not allow generic settings to add an ungranted sandbox write root', async () => {
    const { registerSettingsHandlers } = await import('./settings')
    registerSettingsHandlers()
    const handler = ipcRegistered.get('settings:set')!
    const result = await handler(undefined, { sandboxWritePaths: [userDataDir] })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/native folder picker/i)
  })

  it('non-object input is treated as an empty partial (no-op merge)', async () => {
    const { registerSettingsHandlers } = await import('./settings')
    registerSettingsHandlers()
    const handler = ipcRegistered.get('settings:set')!
    // Pass a string instead of an object.
    const res = await handler(undefined, 'not an object')
    expect(res.success).toBe(true)
    // settings.json should now contain only the defaults (no string leaked in).
    const written = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf-8'))
    expect(typeof written).toBe('object')
    expect(written).not.toEqual('not an object')
  })

  it('null input is treated as empty', async () => {
    const { registerSettingsHandlers } = await import('./settings')
    registerSettingsHandlers()
    const handler = ipcRegistered.get('settings:set')!
    const res = await handler(undefined, null)
    expect(res.success).toBe(true)
  })

  it('rejects __proto__ pollution attempts (key is dropped from the merge)', async () => {
    const { registerSettingsHandlers } = await import('./settings')
    registerSettingsHandlers()
    const handler = ipcRegistered.get('settings:set')!
    // Use a function-call shape that won't trigger native __proto__ semantics
    // but tests our defence against the literal key name.
    const malicious = JSON.parse(
      '{"__proto__": {"polluted": true}, "language": "en"}'
    )
    await handler(undefined, malicious)
    // The settings file must NOT contain __proto__ as an own property.
    const written = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf-8'))
    expect(Object.prototype.hasOwnProperty.call(written, '__proto__')).toBe(false)
    // Object.prototype must not have been polluted.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    // Legitimate key DID land.
    expect(written.language).toBe('en')
  })

  it('rejects `constructor` and `prototype` keys', async () => {
    const { registerSettingsHandlers } = await import('./settings')
    registerSettingsHandlers()
    const handler = ipcRegistered.get('settings:set')!
    await handler(undefined, {
      constructor: 'evil',
      prototype: 'evil',
      language: 'zh'
    })
    const written = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf-8'))
    expect(written.constructor).not.toBe('evil')
    expect(written.prototype).not.toBe('evil')
    expect(written.language).toBe('zh')
  })

  it('array input is treated as empty (not spread as numeric-keyed object)', async () => {
    const { registerSettingsHandlers } = await import('./settings')
    registerSettingsHandlers()
    const handler = ipcRegistered.get('settings:set')!
    await handler(undefined, ['a', 'b', 'c'])
    const written = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf-8'))
    expect(written[0]).toBeUndefined()
    expect(written[1]).toBeUndefined()
  })

  it('strips NESTED __proto__ inside a deep object', async () => {
    const { registerSettingsHandlers } = await import('./settings')
    registerSettingsHandlers()
    const handler = ipcRegistered.get('settings:set')!
    // JSON.parse preserves __proto__ as an own property — the recursion
    // contract is that we strip it at every depth.
    const malicious = JSON.parse(
      '{"modelConfig": {"deepseek-v4-pro": {"__proto__": {"polluted": "yes"}}}}'
    )
    await handler(undefined, malicious)
    const written = JSON.parse(
      readFileSync(join(userDataDir, 'settings.json'), 'utf-8')
    )
    expect(
      Object.prototype.hasOwnProperty.call(
        written.modelConfig['deepseek-v4-pro'],
        '__proto__'
      )
    ).toBe(false)
    // The legitimate nesting structure is preserved.
    expect(written.modelConfig['deepseek-v4-pro']).toBeDefined()
  })

  it('strips __proto__ inside an array element', async () => {
    const { registerSettingsHandlers } = await import('./settings')
    registerSettingsHandlers()
    const handler = ipcRegistered.get('settings:set')!
    const malicious = JSON.parse(
      '{"customModels": [{"__proto__": {"bad": true}, "id": "x"}]}'
    )
    await handler(undefined, malicious)
    const written = JSON.parse(
      readFileSync(join(userDataDir, 'settings.json'), 'utf-8')
    )
    const first = written.customModels?.[0]
    expect(first).toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(first, '__proto__')).toBe(false)
    expect(first.id).toBe('x')
  })

  it('persists ONLY the patch (+ prior on-disk keys), not the whole defaults-merged object', async () => {
    // Regression: settings:set used to write `{...readSettings(), ...patch}`,
    // and readSettings() merges in every DEFAULT_APP_SETTINGS key. That froze
    // all ~40 defaults onto disk as if user-set, so a later version that lowered
    // a default could never reach a user who had ever toggled one unrelated
    // setting. The fix writes onDisk+patch, leaving untouched keys absent so they
    // keep resolving from the live defaults.
    const { registerSettingsHandlers } = await import('./settings')
    registerSettingsHandlers()
    const handler = ipcRegistered.get('settings:set')!
    // User toggles ONE unrelated setting, starting from an absent settings.json.
    const res = await handler(undefined, { minimizeToTray: true })
    expect(res.success).toBe(true)
    const written = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf-8'))
    // The touched key landed.
    expect(written.minimizeToTray).toBe(true)
    // Defaults the user never touched must NOT be materialised on disk — that is
    // exactly the freezing this fix prevents. Pre-fix, all of these were present.
    expect(Object.prototype.hasOwnProperty.call(written, 'loopMaxIterations')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(written, 'safeSeedLength')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(written, 'backgroundAutonomy')).toBe(false)
    // The on-disk object is the patch alone (no default keys leaked in).
    expect(Object.keys(written)).toEqual(['minimizeToTray'])
  })

  it('preserves prior on-disk keys across an unrelated patch (no clobber, no default bloat)', async () => {
    const { registerSettingsHandlers } = await import('./settings')
    registerSettingsHandlers()
    const handler = ipcRegistered.get('settings:set')!
    // Two sequential writes: the second must keep the first key AND stay minimal.
    await handler(undefined, { language: 'en' })
    await handler(undefined, { minimizeToTray: true })
    const written = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf-8'))
    expect(written.language).toBe('en')
    expect(written.minimizeToTray).toBe(true)
    // Still only the two user-set keys — defaults did not accrete over the two writes.
    expect(Object.keys(written).sort()).toEqual(['language', 'minimizeToTray'])
  })

  it('caps recursion depth so a hostile deep object cannot OOM', async () => {
    const { registerSettingsHandlers } = await import('./settings')
    registerSettingsHandlers()
    const handler = ipcRegistered.get('settings:set')!
    // Build a 50-deep nested object — well past the depth cap (16).
    let deep: Record<string, unknown> = { leaf: 'value' }
    for (let i = 0; i < 50; i++) deep = { nested: deep }
    // modelConfig is the open-shaped block the schema allows to hold anything.
    const res = await handler(undefined, { modelConfig: deep })
    expect(res.success).toBe(true)
  })

  // 2026-09-03 (settings evaluation D5): the file's shape is checked on the way in.
  it('refuses a key DUIN does not know, naming it, and writes nothing', async () => {
    const { registerSettingsHandlers } = await import('./settings')
    registerSettingsHandlers()
    const handler = ipcRegistered.get('settings:set')!
    const res = await handler(undefined, { minimiseToTray: true, language: 'en' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/minimiseToTray is not a setting DUIN knows/)
    expect(existsSync(join(userDataDir, 'settings.json'))).toBe(false)
  })

  it('refuses a known key whose value is the wrong kind', async () => {
    const { registerSettingsHandlers } = await import('./settings')
    registerSettingsHandlers()
    const handler = ipcRegistered.get('settings:set')!
    const res = await handler(undefined, { fontSize: '16' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/fontSize must be number, got string/)
  })

  it('refuses the home folder as a sandbox write root even after a picker grant', async () => {
    const { registerSettingsHandlers } = await import('./settings')
    registerSettingsHandlers()
    const handler = ipcRegistered.get('settings:set')!
    const { homedir } = await import('os')
    const home = homedir()
    grantTrustedDirectory(home)
    const res = await handler(undefined, { sandboxWritePaths: [home] })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/home folder and system folders cannot be added/)
  })
})
