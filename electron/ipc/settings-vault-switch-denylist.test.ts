// CALL-SITE coverage for the confidential-egress denylist cache invalidation wired into
// `settings:set` (electron/ipc/settings.ts).
//
// THE GAP this test closes: confidential-firewall.test.ts already covers setActiveDenylist's pure
// cache-reset behaviour and passes today. What it does NOT cover is whether anything in PRODUCTION
// actually calls setActiveDenylist when the vault changes at runtime — before this fix, nothing did.
// activeDenylist() (confidential-firewall.ts) resolves the vault's
// .duin/_state/confidential-denylist.json ONCE and caches it for the process lifetime — by design,
// so the autonomous background callers that guard external egress (operator-govern, operator-model,
// consolidation-synthesis, transfer-ab, judgment-measure-live — all calling firewallClear()/inspect()
// with no explicit denylist argument) don't each re-read the file. Switching vaults through
// settings:set is a supported runtime flow (this same branch already re-homes the brain DB and moat
// store), but nothing invalidated the denylist cache when the vault itself changed — so reverting the
// one-line `setActiveDenylist(null)` in settings.ts's vault-switch branch leaves
// confidential-firewall.test.ts's own suite fully green. Un-wired == un-fixed, exactly the shape
// settings-graph-history.test.ts's header warns about for the graph-history ledger.
//
// These tests drive the REAL registered `settings:set` ipcMain handler: electron is mocked only for
// ipcMain (to capture the handler), app.getPath (userData -> temp dir) and BrowserWindow/dialog. The
// reindex / notes-watcher / moat machinery the same vault-switch branch also fires is stubbed out —
// none of it is what's under test, and left real it would spin up a live chokidar watcher for no
// reason relevant to this fix. The brain-db-durability half of that branch (dynamic `import(...)`,
// so it is NOT interceptable via vi.mock the way the other, statically-imported collaborators are)
// is left real; it is already exercised safely against real temp vaults by
// brain-db-vault-switch-node.test.ts, so __resetDbForTests() below (the established pattern — see
// loop-store.test.ts / conversation-store-cascade.test.ts) is enough to keep it from leaking a
// locked lamprey.db handle across tests.
//
// POWER CONTROL: deleting `setActiveDenylist(null)` from the settings.ts vault-switch branch fails
// the second assertion in each test below (activeDenylist() keeps returning the stale/empty cache).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let userDataDir = ''

const reindexMock = vi.hoisted(() => vi.fn(async () => 0))
const invalidateBrainGraphCache = vi.hoisted(() => vi.fn())

type Handler = (event: unknown, ...args: any[]) => Promise<any>
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    },
    on: () => {}
  },
  app: { getPath: () => userDataDir, getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '' }
}))

// Irrelevant to the fix under test — stubbed so the vault-switch branch's OTHER side jobs don't
// spin up a live chokidar watcher or touch a real sqlite DB. Each spreads the real module so every
// export the handler references stays present; only the expensive/stateful entry point is replaced.
vi.mock('../services/local-brain/index-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/local-brain/index-store')>()
  return { ...actual, reindex: reindexMock, reindexUntilReady: reindexMock }
})
vi.mock('../services/local-brain/notes-watcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/local-brain/notes-watcher')>()
  return { ...actual, restartNotesWatcher: () => {} }
})
vi.mock('../services/moat-durability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/moat-durability')>()
  return {
    ...actual,
    switchMoatVault: (_userDataDir: string, oldVault: string | null, newVault: string) => ({
      ok: true,
      outcome: 'switched',
      from: oldVault,
      to: newVault,
      flushTarget: oldVault || newVault,
      moatVerified: 0,
      memoryVerified: 0,
      trashVerified: 0
    })
  }
})
vi.mock('../services/local-brain/brain-graph-cache', () => ({
  invalidateBrainGraphCache
}))
vi.mock('../services/brain/brain-db-durability', () => ({
  exportBrainTablesToVault: () => 0,
  reloadBrainTablesFromVault: () => ({
    ok: true,
    outcome: 'reloaded',
    imported: 0,
    priorRows: 0
  })
}))
vi.mock('../services/brain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/brain')>()
  return {
    ...actual,
    refreshNotesExtraction: async () => false,
    buildBrain: async () => ({ entities: 0, edges: 0, status: 'no-model' })
  }
})

import { registerSettingsHandlers } from './settings'
import { activeDenylist, setActiveDenylist } from '../services/governance/confidential-firewall'
import { __resetDbForTests } from '../services/database'
import {
  __resetTrustedDirectoryGrants,
  grantTrustedDirectory
} from '../services/trusted-path-grants'

let vaultA = ''
let vaultB = ''

function seedDenylist(vaultDir: string, terms: string[]): void {
  const stateDir = join(vaultDir, '.duin', '_state')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'confidential-denylist.json'), JSON.stringify(terms), 'utf8')
}

beforeEach(() => {
  handlers.clear()
  reindexMock.mockReset().mockResolvedValue(0)
  invalidateBrainGraphCache.mockReset()
  __resetTrustedDirectoryGrants()
  setActiveDenylist(null) // start cold, like a fresh process — no test leaks its cache into another
  __resetDbForTests() // drop any cached lamprey.db handle from a prior test before reusing app.getPath
  userDataDir = mkdtempSync(join(tmpdir(), 'duin-vswitch-ud-'))
  vaultA = mkdtempSync(join(tmpdir(), 'duin-vswitch-a-'))
  vaultB = mkdtempSync(join(tmpdir(), 'duin-vswitch-b-'))
  seedDenylist(vaultA, ['vault-a-secret'])
  seedDenylist(vaultB, ['vault-b-secret'])
  grantTrustedDirectory(vaultA)
  grantTrustedDirectory(vaultB)
  registerSettingsHandlers()
})

afterEach(() => {
  setActiveDenylist(null)
  // Close the sqlite handle brain-db-durability opened against userDataDir/lamprey.db BEFORE
  // deleting it — on Windows an open handle makes rmSync fail with EPERM (the file is still locked).
  __resetDbForTests()
  for (const d of [userDataDir, vaultA, vaultB]) {
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

describe('settings:set vault switch — confidential-egress denylist cache', () => {
  it('awaits exactly one required index before reporting first-run readiness', async () => {
    reindexMock.mockImplementationOnce(async () => {
      expect(existsSync(join(userDataDir, 'settings.json'))).toBe(false)
      return 7
    })
    const result = await handlers.get('settings:set')!(
      undefined,
      { localBrainNotesDir: vaultA },
      { ensureBrainReady: true }
    )

    expect(result).toEqual({
      success: true,
      data: { indexedCount: 7, indexStatus: 'ready' }
    })
    expect(reindexMock).toHaveBeenCalledTimes(1)
    expect(reindexMock).toHaveBeenCalledWith(vaultA)
    expect(invalidateBrainGraphCache).toHaveBeenCalledTimes(1)
  })

  it('does not publish first-run completion when the required index rejects', async () => {
    reindexMock.mockRejectedValueOnce(new Error('index failed'))
    const result = await handlers.get('settings:set')!(
      undefined,
      { localBrainNotesDir: vaultA },
      { ensureBrainReady: true }
    )

    expect(result).toEqual({ success: false, error: 'index failed' })
    expect(existsSync(join(userDataDir, 'settings.json'))).toBe(false)
  })

  it('keeps the prior vault when the ordinary Brain Settings call shape fails readiness', async () => {
    const setHandler = handlers.get('settings:set')!
    await setHandler(
      undefined,
      { localBrainNotesDir: vaultA },
      { ensureBrainReady: true }
    )
    reindexMock.mockRejectedValueOnce(new Error('vault B index failed'))

    const result = await setHandler(undefined, { localBrainNotesDir: vaultB })

    expect(result).toEqual({ success: false, error: 'vault B index failed' })
    expect(
      JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).localBrainNotesDir
    ).toBe(vaultA)
  })

  it('rejects ungranted scaffold and import roots from the renderer', async () => {
    const scaffold = await handlers.get('brain:scaffold-harness')!(undefined, {
      srcDir: userDataDir,
      outDir: userDataDir
    })
    const imported = await handlers.get('brain:import')!(undefined, {
      adapterId: 'codex',
      sourceDir: userDataDir,
      mode: 'copy'
    })

    expect(scaffold).toMatchObject({ success: false })
    expect(scaffold.error).toMatch(/native folder picker|active vault/i)
    expect(imported).toMatchObject({ success: false })
    expect(imported.error).toMatch(/detected by DUIN/i)
  })

  it('re-resolves the denylist from the NEW vault after a runtime vault switch', async () => {
    const setHandler = handlers.get('settings:set')!
    expect(setHandler).toBeTruthy()

    // Point at Vault A and warm the cache — exactly what any of the autonomous background callers
    // (operator-govern, operator-model, consolidation-synthesis, transfer-ab, judgment-measure-live)
    // do the first time they call firewallClear()/inspect() with no explicit denylist argument.
    await setHandler(undefined, { localBrainNotesDir: vaultA })
    expect(activeDenylist()).toEqual(['vault-a-secret'])

    // Operator switches vaults at runtime — a supported, tested flow (this same branch also
    // re-homes the brain DB and moat store on a vault change).
    await setHandler(undefined, { localBrainNotesDir: vaultB })

    // Must now enforce Vault B's terms, not the stale Vault A list — else Vault B's real
    // confidential content is never blocked from an external model call.
    expect(activeDenylist()).toEqual(['vault-b-secret'])
  })

  it('also invalidates on the very first vault pick, not just a later switch', async () => {
    // The milder variant named in the finding: a background job calls activeDenylist() before any
    // vault is configured (dir resolves to null) and permanently caches []. The very first
    // settings:set that adopts a vault must still blow that empty cache away.
    expect(activeDenylist()).toEqual([])

    const setHandler = handlers.get('settings:set')!
    await setHandler(undefined, { localBrainNotesDir: vaultA })

    expect(activeDenylist()).toEqual(['vault-a-secret'])
  })
})
