import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// The tray owns the only code path in the app that CONCEALS the main window without closing it
// (handleWindowClose -> win.hide() when `minimizeToTray` is on), so it also owns un-concealing it.
//
// The bug this file pins: a hidden window reports isMinimized() === false, and Electron's focus()
// only "focuses on the window" — it never shows a hidden one. main.ts's single-instance
// 'second-instance' handler used `if (isMinimized()) restore(); focus()`, which reads like it
// handles concealment but is a total no-op on the hide-to-tray state: relaunching the DUIN
// shortcut while the window was hidden produced no window, no taskbar button and no error.
//
// electron is stubbed globally (vitest.config.ts alias) but that stub has no Tray/nativeImage,
// which tray.ts imports at module scope — mock the module here so the import resolves.
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: (): string => process.cwd(), quit: (): void => undefined },
  BrowserWindow: { getAllWindows: (): unknown[] => [] },
  Tray: class {
    setToolTip(): void {}
    setContextMenu(): void {}
    on(): void {}
    destroy(): void {}
    popUpContextMenu(): void {}
  },
  Menu: { buildFromTemplate: (): unknown => ({}) },
  nativeImage: { createFromPath: (): unknown => ({ isEmpty: () => true }) }
}))

let minimizeToTray = true
vi.mock('./settings-helper', () => ({ readSettings: () => ({ minimizeToTray }) }))

const {
  revealWindow,
  initializeTray,
  refreshTrayMenu,
  destroyTray,
  handleWindowClose,
  markQuitRequested,
  __resetQuitRequested
} = await import('./tray')

function fakeWindow(minimized: boolean): {
  calls: string[]
  win: Parameters<typeof revealWindow>[0]
} {
  const calls: string[] = []
  return {
    calls,
    win: {
      isMinimized: vi.fn(() => minimized),
      restore: vi.fn(() => void calls.push('restore')),
      show: vi.fn(() => void calls.push('show')),
      focus: vi.fn(() => void calls.push('focus'))
    } as unknown as Parameters<typeof revealWindow>[0]
  }
}

describe('revealWindow', () => {
  it('SHOWS a window that is hidden but not minimized (the hide-to-tray state)', () => {
    const { calls, win } = fakeWindow(false)
    revealWindow(win)
    // The regression guard: focusing alone leaves a hidden window invisible.
    expect(calls).toContain('show')
    expect(calls).toEqual(['show', 'focus'])
  })

  it('restores before showing when the window is minimized', () => {
    const { calls, win } = fakeWindow(true)
    revealWindow(win)
    expect(calls).toEqual(['restore', 'show', 'focus'])
  })
})

describe('single-instance relaunch wiring', () => {
  it("main.ts's second-instance handler reveals the window instead of only focusing it", () => {
    const main = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8')
    const handler = main.match(/app\.on\('second-instance'[\s\S]*?\n {2}\}\)/)
    expect(handler).not.toBeNull()
    // Load-bearing check: the shared reveal must be on the real relaunch path, not merely exported.
    expect(handler![0]).toContain('revealWindow(mainWindow)')
    expect(handler![0]).not.toMatch(/mainWindow\.focus\(\)/)
  })
})

// The tray is created once at startup (main.ts calls initializeTray unconditionally) and lives for
// the whole process, but the window it points at can be DESTROYED and never replaced: with the
// shipped default minimizeToTray:false a close really destroys the window, and on darwin
// `window-all-closed` deliberately does not quit. A destroyed BrowserWindow is still a truthy
// object and throws 'Object has been destroyed' on every method, so `if (!win) return` waves it
// through. The throw was then swallowed by main.ts's top-level uncaughtException handler — the tray
// icon just stopped working, with nothing logged and no way back except force-quitting.
describe('tray against a destroyed window', () => {
  it('treats a destroyed window as absent instead of calling methods on it', () => {
    const boom = (): never => {
      throw new Error('Object has been destroyed')
    }
    const live = {
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      isMinimized: vi.fn(() => false)
    }
    const dead = {
      isDestroyed: vi.fn(() => true),
      isVisible: vi.fn(boom),
      isMinimized: vi.fn(boom)
    }

    // Build the tray while the window is alive — that is the real startup order, and it matters:
    // initializeTray swallows its own errors, so a tray built against an already-dead window would
    // mask the defect rather than expose it.
    let current: unknown = live
    initializeTray({ getWindow: () => current } as unknown as Parameters<typeof initializeTray>[0])
    expect(live.isVisible).toHaveBeenCalled()

    // Now the window is destroyed. refreshTrayMenu is on the production path — main.ts wires it to
    // the window's show/hide/minimize/restore events and the tray's own click handler.
    current = dead
    expect(() => refreshTrayMenu()).not.toThrow()
    expect(dead.isVisible).not.toHaveBeenCalled()

    destroyTray()
  })
})

// The macOS half of the same bug. 'second-instance' (Windows/Linux relaunch) and 'activate' (Dock
// click) are the two "the user asked for the app back" entry points, and only the first one was
// fixed. `if (getAllWindows().length === 0) createWindow()` is the stock Electron sample and it is
// correct for the shipped minimizeToTray:false — but when the setting is on, handleWindowClose
// HIDES the window rather than destroying it, so the window count is still 1, the branch never
// fires, and this handler had no show()/focus() fallback whatsoever: the Dock click was a no-op.
describe('macOS dock-activate wiring', () => {
  it("main.ts's activate handler reveals an existing hidden window, not just the zero-windows case", () => {
    const main = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8')
    // Anchored on the handler's actual signature: a comment elsewhere in main.ts mentions
    // `app.on('activate')` in prose and a looser pattern matches that instead.
    const handler = main.match(/app\.on\('activate', \(\) => \{[\s\S]*?\n {2}\}\)/)
    expect(handler).not.toBeNull()
    // Load-bearing: the shared reveal must be on the Dock path, not merely exported.
    expect(handler![0]).toContain('revealWindow(mainWindow)')
    // focus() alone cannot un-hide a window — that is precisely how this class of bug hides.
    expect(handler![0]).not.toMatch(/mainWindow\.focus\(\)/)
  })
})

// main.ts cannot be imported under vitest (it boots the whole app at module scope), so its wiring
// is asserted from source — the same technique the second-instance test above uses.
describe('main-window lifecycle wiring', () => {
  it('createWindow clears the mainWindow ref when Electron destroys the window', () => {
    const main = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8')
    const createWindow = main.match(/function createWindow\(\)[\s\S]*?\n\}/)
    expect(createWindow).not.toBeNull()
    // 'close' is not enough: it can be intercepted (hide-to-tray) and it also fires for closes that
    // DO destroy the window, after which `mainWindow` would stay truthy forever. Every consumer
    // branches on bare truthiness, so the ref itself has to become null.
    expect(createWindow![0]).toMatch(/\.on\('closed',[\s\S]*?mainWindow = null/)
  })
})

// ── backlog findings 38 + 39 ────────────────────────────────────────────────

describe('handleWindowClose — a quit from ANY path must not be intercepted', () => {
  // Destructuring a getter would snapshot it BEFORE the call, so keep the state object
  // and read it afterwards.
  const closeEvent = (): { state: { prevented: boolean }; e: Electron.Event } => {
    const state = { prevented: false }
    const e = { preventDefault: () => void (state.prevented = true) } as unknown as Electron.Event
    return { state, e }
  }
  const win = () => ({ hide: vi.fn() }) as unknown as Parameters<typeof handleWindowClose>[0]

  beforeEach(() => {
    __resetQuitRequested()
    minimizeToTray = true
    initializeTray({ onOpen: () => {}, onNewConversation: () => {} } as never)
  })
  afterEach(() => destroyTray())

  it('hides to tray on an ordinary window close', () => {
    const { state, e } = closeEvent()
    expect(handleWindowClose(win(), e)).toBe(true)
    expect(state.prevented).toBe(true)
  })

  it('lets the close proceed once a quit has been requested', () => {
    // The whole defect: this flag was set ONLY by the tray menu's own Quit item, so
    // Cmd+Q, the app-menu Quit and autoUpdater.quitAndInstall() all had their window
    // close intercepted and hidden — the app simply never quit.
    markQuitRequested()
    const { state, e } = closeEvent()
    expect(handleWindowClose(win(), e)).toBe(false)
    expect(state.prevented).toBe(false)
  })

  it('does not intercept at all when minimize-to-tray is off', () => {
    minimizeToTray = false
    const { state, e } = closeEvent()
    expect(handleWindowClose(win(), e)).toBe(false)
    expect(state.prevented).toBe(false)
  })
})
