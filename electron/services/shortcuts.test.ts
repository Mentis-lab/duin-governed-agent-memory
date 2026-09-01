import { describe, it, expect, vi, beforeAll } from 'vitest'

// The global hotkeys are registered ONCE at startup (main.ts calls registerGlobalShortcuts
// unconditionally) and stay live for the whole process — but the window they act on can be
// destroyed and never replaced: with the shipped default minimizeToTray:false a close really
// destroys the window, and on darwin `window-all-closed` deliberately does not quit.
//
// A destroyed BrowserWindow is still a truthy object, and every method on it throws
// 'Object has been destroyed'. So `if (!win) return` waved it straight through and the handler died
// on its first call. What made it invisible: main.ts's top-level uncaughtException handler swallowed
// the throw (its own report targets the same destroyed webContents), so Cmd+Shift+L simply did
// nothing — no window, no error, nothing logged.
//
// electron is stubbed globally (vitest.config.ts alias) but that stub has no globalShortcut, which
// shortcuts.ts imports at module scope — mock the module here and capture the registered handlers,
// which are otherwise unreachable (toggleWindow/copyLastAssistant are not exported).
const hoisted = vi.hoisted(() => ({ registered: new Map<string, () => void>() }))

vi.mock('electron', () => ({
  app: { on: (): void => undefined },
  BrowserWindow: { getAllWindows: (): unknown[] => [] },
  globalShortcut: {
    register: (accelerator: string, callback: () => void): boolean => {
      hoisted.registered.set(accelerator, callback)
      return true
    },
    unregisterAll: (): void => undefined
  }
}))

const { registerGlobalShortcuts } = await import('./shortcuts')

const boom = (): never => {
  throw new Error('Object has been destroyed')
}

const dead = {
  isDestroyed: vi.fn(() => true),
  isVisible: vi.fn(boom),
  isMinimized: vi.fn(boom),
  isFocused: vi.fn(boom),
  restore: vi.fn(boom),
  show: vi.fn(boom),
  focus: vi.fn(boom),
  hide: vi.fn(boom),
  webContents: { send: vi.fn(boom) }
}

describe('global shortcuts against a destroyed window', () => {
  beforeAll(() => {
    registerGlobalShortcuts({ getWindow: () => dead } as unknown as Parameters<
      typeof registerGlobalShortcuts
    >[0])
  })

  it('the toggle hotkey treats a destroyed window as absent instead of throwing', () => {
    const toggle = hoisted.registered.get('CommandOrControl+Shift+L')
    expect(toggle).toBeTypeOf('function')
    expect(() => toggle!()).not.toThrow()
    // The guard has to short-circuit BEFORE any method call — reaching isVisible() is the bug.
    expect(dead.isVisible).not.toHaveBeenCalled()
  })

  it('the copy-last hotkey does not push IPC into a destroyed webContents', () => {
    const copy = hoisted.registered.get('CommandOrControl+Shift+C')
    expect(copy).toBeTypeOf('function')
    expect(() => copy!()).not.toThrow()
    expect(dead.webContents.send).not.toHaveBeenCalled()
  })
})
