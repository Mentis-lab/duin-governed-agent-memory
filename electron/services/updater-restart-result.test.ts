// updater-restart-result.test.ts — the Restart button's refusal used to die inside the main process.
//
// quitAndInstall() was `Promise<void>`. When this session had not verified a completed download it
// logged `[updater] REFUSED quitAndInstall: …` and RETURNED, and its only caller —
// ipcMain.handle('update:restart') in main.ts — answered `{ success: true }` unconditionally. So
// the refusal was not merely unhandled downstream, it was UNREPRESENTABLE: no thrown error, no
// return value, nothing for the IPC envelope to carry.
//
// The window is not exotic. `update-available` sends the renderer its "restart to install" banner
// and only THEN calls downloadUpdate() on a ~100-300 MB artifact (updater.ts's own comment), so
// Restart is on screen, enabled, and guaranteed to refuse for the whole download. What made it
// invisible is that a refusal and an imminent restart look identical from the renderer: nothing
// changes on screen either way.
//
// These tests drive the real handlers, so they fail on any build where a refusal cannot be
// reported — however the refusal itself is spelled.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  // The updater is a no-op unless packaged; the shared stub ships isPackaged: false.
  app: { isPackaged: true },
  BrowserWindow: { getAllWindows: (): unknown[] => [] }
}))

vi.mock('./settings-helper', () => ({
  readSettings: (): Record<string, unknown> => ({ autoCheckUpdates: true })
}))

type Handler = (info: unknown) => void
const handlers: Record<string, Handler> = {}

const autoUpdater = {
  autoDownload: true,
  autoInstallOnAppQuit: true,
  on: vi.fn((event: string, cb: Handler) => {
    handlers[event] = cb
  }),
  checkForUpdates: vi.fn(async () => null),
  downloadUpdate: vi.fn(async () => []),
  quitAndInstall: vi.fn()
}

vi.mock('electron-updater', () => ({ autoUpdater }))

/** A manifest that passes the DUIN-* identity guard. */
const OWN_BUILD = { version: '0.9.0', path: 'DUIN-x64.exe', files: [{ url: 'DUIN-x64.exe' }] }
/** The foreign artifact that actually reached an operator's banner in July 2026. */
const FOREIGN_BUILD = {
  version: '0.27.1',
  path: 'Lamprey-x64.exe',
  files: [{ url: 'Lamprey-x64.exe' }]
}

/** `verifiedDownloadReady` is module-level and one-way, so each test needs its own module
 *  instance — otherwise a passing install in one test arms every later one. */
async function freshUpdater(): Promise<typeof import('./updater')> {
  vi.resetModules()
  for (const key of Object.keys(handlers)) delete handlers[key]
  autoUpdater.quitAndInstall.mockClear()
  const mod = await import('./updater')
  await mod.initializeUpdater({ getWindow: () => null })
  return mod
}

describe('quitAndInstall reports its refusal instead of swallowing it', () => {
  beforeEach(() => {
    // The periodic check arms a 6h interval; fake timers keep it from outliving the test.
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('refuses AND says so while the banner is up but the download is still in flight', async () => {
    const { quitAndInstall } = await freshUpdater()

    // This is the exact on-screen state: update-available has fired (banner + Restart button
    // visible) and the download it kicked off has not finished.
    handlers['update-available']?.(OWN_BUILD)

    const result = await quitAndInstall()

    expect(result.ok).toBe(false)
    // A refusal with no reason degrades to invoke()'s generic "request failed" in the renderer,
    // which tells the operator nothing about waiting for the download.
    expect(result.error ?? '').not.toBe('')
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('installs and reports ok once the download is verified', async () => {
    const { quitAndInstall } = await freshUpdater()

    handlers['update-available']?.(OWN_BUILD)
    handlers['update-downloaded']?.(OWN_BUILD)

    await expect(quitAndInstall()).resolves.toEqual({ ok: true })
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('still refuses a downloaded FOREIGN artifact — reporting the refusal did not relax the guard', async () => {
    const { quitAndInstall } = await freshUpdater()

    // v0.27.1 is upstream Lamprey's version line, not DUIN's. Installing it over DUIN is
    // unrecoverable from inside the app.
    handlers['update-downloaded']?.(FOREIGN_BUILD)

    const result = await quitAndInstall()

    expect(result.ok).toBe(false)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('a repeated click keeps refusing rather than going through on the second try', async () => {
    const { quitAndInstall } = await freshUpdater()
    handlers['update-available']?.(OWN_BUILD)

    expect((await quitAndInstall()).ok).toBe(false)
    expect((await quitAndInstall()).ok).toBe(false)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })
})
