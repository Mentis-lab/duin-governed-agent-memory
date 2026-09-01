// updater-periodic-check.test.ts — the "Automatically check for updates" toggle promises a
// PERIODIC background check, and for a long time it delivered exactly one, at launch.
//
// initializeUpdater() called autoUpdater.checkForUpdates() once as app.whenReady() resolved and
// nothing ever re-armed it, so a DUIN left running for days — the mode the app is designed for
// (tray icon, minimizeToTray, hourly/daily monitors) — would never learn a release existed while
// the setting insisted it was checking in the background. The single check is genuine, which is
// what hid this: any restart-to-verify looks correct.
//
// These tests drive the real function with a fake clock, so they fail on a build that only checks
// once no matter how the check itself is spelled.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const settings: { autoCheckUpdates?: boolean } = { autoCheckUpdates: true }

vi.mock('electron', () => ({
  // The updater is a no-op unless packaged; the shared stub ships isPackaged: false.
  app: { isPackaged: true },
  BrowserWindow: { getAllWindows: (): unknown[] => [] }
}))

vi.mock('./settings-helper', () => ({
  readSettings: (): Record<string, unknown> => settings
}))

const autoUpdater = {
  autoDownload: true,
  autoInstallOnAppQuit: true,
  on: vi.fn(),
  checkForUpdates: vi.fn(async () => null),
  downloadUpdate: vi.fn(async () => []),
  quitAndInstall: vi.fn()
}

vi.mock('electron-updater', () => ({ autoUpdater }))

import { initializeUpdater, UPDATE_CHECK_INTERVAL_MS } from './updater'

describe('background update check re-arms itself', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    settings.autoCheckUpdates = true
    autoUpdater.checkForUpdates.mockClear()
    autoUpdater.checkForUpdates.mockImplementation(async () => null)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('keeps checking while the app stays open, instead of once at launch', async () => {
    await initializeUpdater({ getWindow: () => null })
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1) // the launch check

    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)

    // Three days of uptime without a quit: the scenario the toggle's copy describes.
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS * 12)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(14)
  })

  it('stops checking when the setting is turned off mid-session', async () => {
    await initializeUpdater({ getWindow: () => null })
    autoUpdater.checkForUpdates.mockClear()

    settings.autoCheckUpdates = false
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS * 3)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()

    // and resumes if it is turned back on, without needing a restart
    settings.autoCheckUpdates = true
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('still re-checks after a launch-time failure — the case that most needs a retry', async () => {
    // Offline at startup: checkForUpdates() rejects (electron-updater emits 'error' and rethrows).
    // If the timer were armed after that await, the app would sit there checking nothing forever.
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED'))
    await initializeUpdater({ getWindow: () => null })
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('a rejected background check does not escape as an unhandled rejection', async () => {
    await initializeUpdater({ getWindow: () => null })
    autoUpdater.checkForUpdates.mockRejectedValue(new Error('feed unreachable'))

    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS)
    // Let the rejection settle; an uncaught one would be reported against this test.
    await vi.advanceTimersByTimeAsync(0)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
  })
})
