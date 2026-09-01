// updater-notify-only.test.ts — release M11 (A4 F4): the updater NOTIFIES, the operator DOWNLOADS.
//
// `update-available` used to call autoUpdater.downloadUpdate() itself, so an identity-verified
// offer became a ~100-300 MB fetch with nobody asking. Windows builds are unsigned and
// electron-updater skips signature verification for unsigned artifacts, so whoever can publish to
// the feed could stage code onto every install — the Restart click was the only human step.
// These tests drive the real handlers: the offer reaches the renderer, nothing is fetched until
// downloadUpdate() is called, and downloadUpdate() refuses without a verified offer.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
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

const OWN_BUILD = { version: '0.9.0', path: 'DUIN-x64.exe', files: [{ url: 'DUIN-x64.exe' }] }
const FOREIGN_BUILD = { version: '0.27.1', path: 'Lamprey-x64.exe', files: [{ url: 'Lamprey-x64.exe' }] }

const sent: Array<{ channel: string; payload: unknown }> = []
const win = { webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }

async function freshUpdater(): Promise<typeof import('./updater')> {
  vi.resetModules()
  for (const key of Object.keys(handlers)) delete handlers[key]
  autoUpdater.downloadUpdate.mockClear()
  sent.length = 0
  const mod = await import('./updater')
  await mod.initializeUpdater({ getWindow: () => win as never })
  return mod
}

describe('update-available is notify-only', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('autoDownload stays off and a verified offer fetches NOTHING by itself', async () => {
    await freshUpdater()
    expect(autoUpdater.autoDownload).toBe(false)
    handlers['update-available'](OWN_BUILD)
    expect(sent.map((s) => s.channel)).toEqual(['update:available'])
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('downloadUpdate() fetches only after a verified offer in this session', async () => {
    const mod = await freshUpdater()
    // No offer yet → refused, nothing fetched.
    const early = await mod.downloadUpdate()
    expect(early.ok).toBe(false)
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
    // Offer → the operator's click fetches.
    handlers['update-available'](OWN_BUILD)
    const later = await mod.downloadUpdate()
    expect(later.ok).toBe(true)
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('a foreign artifact is refused at the offer AND cannot be downloaded afterwards', async () => {
    const mod = await freshUpdater()
    handlers['update-available'](FOREIGN_BUILD)
    expect(sent).toEqual([])
    const r = await mod.downloadUpdate()
    expect(r.ok).toBe(false)
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('a failed fetch is reported, not swallowed', async () => {
    const mod = await freshUpdater()
    handlers['update-available'](OWN_BUILD)
    autoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await mod.downloadUpdate()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('ERR_INTERNET_DISCONNECTED')
  })
})
