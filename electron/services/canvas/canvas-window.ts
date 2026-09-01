import { BrowserWindow, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { isAllowedNavigationTarget, isExternalOpenTarget } from '../window-guard'

// DETACHED SURFACE WINDOWS — a surface in its own window, for inspection and
// editing at full size.
//
// This deliberately does NOT reuse artifact-sandbox's openInWindow. That path
// builds a static HTML document and shows it in a SANDBOXED window with no
// preload — right for a read-only preview, useless for anything editable, which
// needs the renderer bundle and IPC. So this opens the real renderer with a
// `?view=<kind>&key=<key>` marker that main.tsx routes on.
//
// Windows are addressed BY KEY, never by content: a surface open in two places
// must be one thing, not two copies that drift.

/** Surfaces that can be detached. Adding one here + a branch in main.tsx is the
 *  whole contract — no per-surface window plumbing. */
export type DetachedView = 'canvas' | 'node'

const TITLES: Record<DetachedView, string> = {
  canvas: 'Canvas',
  node: 'DUIN'
}

const openWindows = new Map<string, BrowserWindow>()

export function openDetachedWindow(
  view: DetachedView,
  key: string
): { ok: boolean; error?: string } {
  const k = (key ?? '').trim()
  if (!k) return { ok: false, error: 'key required' }
  if (view === 'canvas' && !k.toLowerCase().endsWith('.canvas')) {
    return { ok: false, error: 'Not a canvas path' }
  }

  // Focus rather than duplicate — two windows on one key would race each other's
  // saves, and the last writer would silently win.
  const mapKey = `${view}:${k}`
  const existing = openWindows.get(mapKey)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return { ok: true }
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: `${TITLES[view]} — ${k}`,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })

  const packagedRendererPath = join(__dirname, '../renderer/index.html')
  const trustedRendererUrl =
    is.dev && process.env['ELECTRON_RENDERER_URL']
      ? process.env['ELECTRON_RENDERER_URL']
      : pathToFileURL(packagedRendererPath).href

  // SECURITY: this window carries the SAME full app preload as mainWindow (window.api's chat/
  // files/hooks/shell contextBridge surface), so it needs the identical guard pair main.ts's
  // createWindow() wires on mainWindow.webContents — without it, an ordinary http(s) link rendered
  // inside vault-note content (BrainExplorerPanel's read view only intercepts internal wikilinks;
  // any other href falls through to a bare, unguarded anchor) navigates this window in place, and
  // Electron re-executes the preload against whatever loads, handing a remote page the same
  // window.api surface the packaged app trusts. See window-guard.ts for why the decision logic
  // lives in its own pure, independently-tested module rather than being re-typed by hand here.
  win.webContents.setWindowOpenHandler((details) => {
    if (isExternalOpenTarget(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    // F1: pin navigation to the EXACT trusted renderer document (same target loadFile/loadURL use
    // below) — sibling files, other localhost ports, and every remote origin are denied.
    if (!isAllowedNavigationTarget(url, trustedRendererUrl)) event.preventDefault()
  })
  win.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedNavigationTarget(url, trustedRendererUrl)) event.preventDefault()
  })

  const query = `?view=${encodeURIComponent(view)}&key=${encodeURIComponent(k)}`
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}${query}`)
  } else {
    // loadFile takes the query separately — appending it to the path would be
    // treated as part of the filename and 404.
    win.loadFile(packagedRendererPath, { search: query })
  }

  openWindows.set(mapKey, win)
  win.on('closed', () => openWindows.delete(mapKey))
  return { ok: true }
}

/** Back-compat shim for the canvas call site. */
export function openCanvasWindow(rel: string): { ok: boolean; error?: string } {
  return openDetachedWindow('canvas', rel)
}
