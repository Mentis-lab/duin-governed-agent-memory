import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { readSettings } from './settings-helper'

let tray: Tray | null = null
let getWindowRef: (() => BrowserWindow | null) | null = null

function resolveIconPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'icon.png')
  return join(app.getAppPath(), 'resources', 'icon.png')
}

function buildIcon() {
  const img = nativeImage.createFromPath(resolveIconPath())
  if (img.isEmpty()) return img
  return img.resize({ width: 16, height: 16 })
}

function activeWindow(): BrowserWindow | null {
  const win = getWindowRef ? getWindowRef() : BrowserWindow.getAllWindows()[0] ?? null
  // A DESTROYED BrowserWindow is still a truthy object, and every method on it throws
  // 'Object has been destroyed'. The tray is always alive (initializeTray is unconditional) and
  // outlives the window it points at, so "absent" and "dead" must collapse to the same answer
  // here — the callers below all branch on truthiness alone.
  return win && !win.isDestroyed() ? win : null
}

function toggleWindow(): void {
  const win = activeWindow()
  if (!win) return
  if (win.isVisible() && !win.isMinimized()) {
    win.hide()
  } else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

/** Structural subset of BrowserWindow that `revealWindow` drives. */
type RevealableWindow = Pick<BrowserWindow, 'isMinimized' | 'restore' | 'show' | 'focus'>

/**
 * Bring `win` back to the foreground from ANY concealed state — minimized OR hidden.
 *
 * WHY this is exported rather than inlined per call site: a hidden window reports
 * `isMinimized() === false`, and `focus()` only "focuses on the window" — it does not un-hide one
 * (only `show()` does). So the natural-looking `if (isMinimized()) restore(); focus()` pair is a
 * silent no-op on exactly the state THIS module creates: `handleWindowClose` hides the window when
 * `minimizeToTray` is on. That is what made the second-instance bug invisible — the code handled
 * the minimized half convincingly and did nothing at all for the hidden half. Every "un-conceal the
 * window" path must go through here so the hidden case cannot be forgotten again.
 */
export function revealWindow(win: RevealableWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function showWindow(): void {
  const win = activeWindow()
  if (!win) return
  revealWindow(win)
}

function startNewConversation(): void {
  showWindow()
  const win = activeWindow()
  win?.webContents.send('tray:newConversation')
}

function rebuildMenu(): void {
  if (!tray) return
  const settings = readSettings()
  const minimizeToTray = settings.minimizeToTray === true
  const win = activeWindow()
  const visible = !!win && win.isVisible() && !win.isMinimized()
  const menu = Menu.buildFromTemplate([
    {
      label: visible ? 'Hide DUIN' : 'Show DUIN',
      click: () => toggleWindow()
    },
    {
      label: 'New Conversation',
      accelerator: process.platform === 'darwin' ? 'Cmd+N' : 'Ctrl+N',
      click: () => startNewConversation()
    },
    { type: 'separator' },
    {
      label: minimizeToTray ? 'Quit DUIN' : 'Quit',
      click: () => {
        markQuitRequested()
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
}

export function initializeTray(opts: { getWindow: () => BrowserWindow | null }): void {
  if (tray) return
  getWindowRef = opts.getWindow
  try {
    tray = new Tray(buildIcon())
    tray.setToolTip('DUIN')
    tray.on('click', () => toggleWindow())
    tray.on('right-click', () => {
      rebuildMenu()
      tray?.popUpContextMenu()
    })
    rebuildMenu()
  } catch (err) {
    console.error('[tray] failed to create tray:', (err as Error).message)
    tray = null
  }
}

export function refreshTrayMenu(): void {
  rebuildMenu()
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

/** Is a quit already under way?
 *
 *  This used to be an ad-hoc `(app as any).isQuittingFromTray`, set in exactly ONE place:
 *  the tray menu's own Quit item. Every other quit path — macOS Cmd+Q, the app menu's
 *  Quit, and autoUpdater.quitAndInstall() — left it false, so with "minimize to tray" on,
 *  handleWindowClose intercepted the close and HID the window instead. The app never quit.
 *
 *  It broke the update flow especially badly: quitAndInstall() closes windows first, this
 *  interceptor hid them instead of closing them, and the trailing app.quit() then re-hit
 *  the same still-open (hidden) window. "Restart to install" silently did nothing.
 *
 *  Named for what it means rather than where it came from, and set from `before-quit` in
 *  main.ts, which EVERY quit path fires — so a new quit path cannot forget it.
 */
let quitRequested = false

/** Record that the app is quitting, so a pending window close is not intercepted. */
export function markQuitRequested(): void {
  quitRequested = true
}

/** Test seam: reset the flag between cases. */
export function __resetQuitRequested(): void {
  quitRequested = false
}

/**
 * When a BrowserWindow's close event fires, decide between hiding-to-tray and quitting based on
 * the persisted `minimizeToTray` setting. Returns `true` if the close was intercepted (window
 * hidden), `false` if the window should proceed to close.
 */
export function handleWindowClose(win: BrowserWindow, e: Electron.Event): boolean {
  const settings = readSettings()
  const minimizeToTray = settings.minimizeToTray === true
  if (minimizeToTray && tray && !quitRequested) {
    e.preventDefault()
    win.hide()
    rebuildMenu()
    return true
  }
  return false
}
