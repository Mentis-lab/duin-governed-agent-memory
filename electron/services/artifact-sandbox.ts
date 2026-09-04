import { BrowserWindow, WebContentsView, app } from 'electron'
import { join } from 'path'
import { writeFileSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'
import { messageOf } from './guarded'
import { parseCanvas } from './canvas/canvas-outline'
import { CANVAS_STYLES, canvasToHtmlFragment, esc as escapeCanvasError } from './canvas/canvas-render'

// In dev, vendor lives under <repo>/resources/vendor relative to the app path.
// In production, electron-builder's extraResources mapping (from: resources/vendor → to: vendor)
// places it directly under process.resourcesPath/vendor.
//
// Resolved LAZILY, on the first artifact that needs it — never at import time. This module is
// reached by local-brain/server.ts (validateArtifact), which brain-native-routes.ts and, through
// it, ipc/settings.ts import (trunk 22e03bd); a module-load `app.getAppPath()` died at import in
// every suite that loads ipc/settings with a partial `electron.app` mock ("app.getAppPath is not
// a function", 7 files on 2026-09-03). Work that belongs to a call, done at load — the same class
// as the boot-path side effects the P0 wiring audit removes.
let vendorDirCache: string | null = null
function vendorDir(): string {
  if (vendorDirCache === null) {
    vendorDirCache = app.isPackaged
      ? join(process.resourcesPath, 'vendor')
      : join(app.getAppPath(), 'resources', 'vendor')
  }
  return vendorDirCache
}

function vendorFileUrl(filename: string): string {
  return `file:///${vendorDir().replace(/\\/g, '/')}/${filename}`
}

const CSP = "default-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; img-src 'self' data:;"

export function buildHtmlDoc(type: string, content: string): string {
  switch (type) {
    case 'html': {
      if (content.includes('<head>')) {
        return content.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${CSP}">`)
      }
      if (content.includes('<html')) {
        return content.replace(/<html([^>]*)>/, `<html$1><head><meta http-equiv="Content-Security-Policy" content="${CSP}"></head>`)
      }
      return `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>body{margin:0;background:#1a1a2e;color:#e8e8e8;font-family:system-ui,sans-serif}</style></head><body>${content}</body></html>`
    }

    case 'svg':
      return `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#1a1a2e}svg{max-width:100%;max-height:100vh}</style></head><body>${content}</body></html>`

    // JSON Canvas blueprint. `content` is the raw .canvas JSON; every string
    // inside it is vault content and is escaped by the renderer (unlike the
    // `svg` case above, whose content is model-authored markup by design).
    // A malformed canvas renders as a readable message — throwing here would
    // break the panel for EVERY artifact type, not just this one.
    case 'canvas': {
      let fragment: string
      try {
        fragment = canvasToHtmlFragment(parseCanvas(content))
      } catch (err) {
        fragment = `<div class="cv-empty">Could not read this canvas: ${escapeCanvasError(messageOf(err))}</div>`
      }
      return `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${CANVAS_STYLES}</style></head><body><div class="cv-scroll">${fragment}</div></body></html>`
    }

    case 'mermaid':
      return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; img-src 'self' data:;">
<style>body{margin:0;padding:16px;background:#1a1a2e;color:#e8e8e8;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 32px)}</style>
</head><body>
<pre class="mermaid">${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
<script src="${vendorFileUrl('mermaid.min.js')}"></script>
<script>mermaid.initialize({startOnLoad:true,theme:'dark'});</script>
</body></html>`

    case 'jsx': {
      const escaped = content.replace(/<\/script>/gi, '<\\/script>')
      return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; img-src 'self' data:;">
<style>body{margin:0;background:#1a1a2e;color:#e8e8e8;font-family:system-ui,sans-serif}#root{padding:16px}</style>
</head><body>
<div id="root"></div>
<script src="${vendorFileUrl('react-shim.js')}"></script>
<script src="${vendorFileUrl('babel.standalone.min.js')}"></script>
<script type="text/babel" data-type="module">
${escaped}

// Auto-render: find the default export or last component
try {
  const root = ReactDOM.createRoot(document.getElementById('root'));
  if (typeof App !== 'undefined') root.render(React.createElement(App));
  else if (typeof default_1 !== 'undefined') root.render(React.createElement(default_1));
} catch(e) { document.getElementById('root').textContent = e.message; }
</script>
</body></html>`
    }

    default:
      return `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>body{margin:0;padding:16px;background:#1a1a2e;color:#e8e8e8;font-family:monospace;white-space:pre-wrap}</style></head><body>${content.replace(/</g, '&lt;')}</body></html>`
  }
}

let view: WebContentsView | null = null
let currentSource = ''
let currentType = ''
// Last bounds the renderer reported. A WebContentsView is created with 0×0
// bounds and only positioned via an async IPC round-trip, so we remember the
// rect and re-apply it once content paints (see render()).
let lastBounds: { x: number; y: number; width: number; height: number } | null = null
// type+content currently loaded into the view. The panel calls render() twice
// on open (from two effects); this lets us skip the redundant second loadFile.
let loadedKey = ''

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows()
  return windows.length > 0 ? windows[0] : null
}

export function render(type: string, content: string): void {
  const win = getMainWindow()
  if (!win) return

  currentSource = content
  currentType = type
  const key = `${type}\n${content}`

  if (!view) {
    view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        allowRunningInsecureContent: false,
        webSecurity: true,
      },
    })
    win.contentView.addChildView(view)
    if (lastBounds) view.setBounds(lastBounds)
    // A freshly created view starts at 0×0 and only gets real bounds after the
    // renderer reports its rect. If that arrives before the first paint the view
    // can get stuck showing a blank frame (the "blank on first open" bug), so
    // re-apply the last known bounds every time content finishes loading.
    view.webContents.on('did-finish-load', () => {
      if (view && lastBounds) view.setBounds(lastBounds)
    })
  } else if (key === loadedKey) {
    // Same artifact already (being) loaded — don't thrash a second loadFile;
    // just make sure it's positioned.
    if (lastBounds) view.setBounds(lastBounds)
    return
  }

  loadedKey = key
  const htmlDoc = buildHtmlDoc(type, content)
  const tempPath = join(app.getPath('temp'), 'lamprey-artifact.html')
  writeFileSync(tempPath, htmlDoc, 'utf-8')

  view.webContents.loadFile(tempPath)
}

export function setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
  lastBounds = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  }
  if (!view) return
  view.setBounds(lastBounds)
}

export function show(): void {
  if (!view) return
  view.setVisible(true)
}

export function hide(): void {
  if (view) {
    view.setVisible(false)
  }
}

export function destroy(): void {
  if (view) {
    const win = getMainWindow()
    if (win) {
      win.contentView.removeChildView(view)
    }
    view.webContents.close()
    view = null
  }
  currentSource = ''
  currentType = ''
  loadedKey = ''
}

export function openInWindow(type: string, content: string): void {
  const htmlDoc = buildHtmlDoc(type, content)
  const tempPath = join(app.getPath('temp'), 'lamprey-artifact-window.html')
  writeFileSync(tempPath, htmlDoc, 'utf-8')

  const artifactWin = new BrowserWindow({
    width: 800,
    height: 600,
    title: `Artifact — ${type}`,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      allowRunningInsecureContent: false,
      webSecurity: true,
    },
  })
  artifactWin.loadFile(tempPath)
}

export function getSource(): string {
  return currentSource
}

export function getType(): string {
  return currentType
}

export function isVisible(): boolean {
  return view !== null
}

/**
 * Headlessly render an artifact and collect any errors it produces, so the chat
 * brain can VALIDATE generated HTML/SVG/JSX/Mermaid before showing it — and feed
 * failures back to the model to fix (the write → render → capture → fix loop).
 *
 * Renders in a hidden, sandboxed BrowserWindow with an injected error collector
 * (window.onerror + unhandledrejection) plus load-failure and render-crash
 * listeners. Never throws; always resolves { ok, errors } and tears the window
 * down.
 */
export async function validateArtifact(
  type: string,
  content: string,
  timeoutMs = 5000
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = []
  let win: BrowserWindow | null = null
  let tempPath: string | null = null
  try {
    const ERR_HOOK =
      '<script>window.__artifactErrors=[];' +
      "window.addEventListener('error',function(e){window.__artifactErrors.push(String((e.error&&e.error.stack)||e.message||'error'))});" +
      "window.addEventListener('unhandledrejection',function(e){window.__artifactErrors.push('unhandledrejection: '+String((e.reason&&e.reason.message)||e.reason))});" +
      '</script>'
    let htmlDoc = buildHtmlDoc(type, content)
    // Inject the collector as early as possible so it catches the artifact's own
    // script errors. buildHtmlDoc always emits a <head>.
    htmlDoc = htmlDoc.includes('<head>')
      ? htmlDoc.replace('<head>', '<head>' + ERR_HOOK)
      : ERR_HOOK + htmlDoc
    tempPath = join(app.getPath('temp'), `duin-artifact-validate-${randomUUID().slice(0, 8)}.html`)
    writeFileSync(tempPath, htmlDoc, 'utf-8')

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        allowRunningInsecureContent: false,
        webSecurity: true
      }
    })
    const wc = win.webContents
    wc.on('did-fail-load', (_e, code, desc, validatedURL) => {
      // -3 = ERR_ABORTED (a superseded navigation) — not a real failure.
      if (code !== -3) errors.push(`load failed (${code}): ${desc}${validatedURL ? ' @ ' + validatedURL : ''}`)
    })
    wc.on('render-process-gone', (_e, details) => {
      errors.push(`render process gone: ${details.reason}`)
    })

    await Promise.race([
      wc.loadFile(tempPath).catch((err) => {
        errors.push(`load threw: ${(err as Error)?.message ?? String(err)}`)
      }),
      new Promise<void>((r) => setTimeout(r, timeoutMs))
    ])
    // Let synchronous + microtask errors surface after the load settles
    // (mermaid/JSX render on DOMContentLoaded).
    await new Promise<void>((r) => setTimeout(r, 400))
    try {
      const collected = (await wc.executeJavaScript('window.__artifactErrors || []')) as unknown
      if (Array.isArray(collected)) for (const e of collected) errors.push(String(e))
    } catch (e) { console.debug('[artifact-sandbox] page may already be gone  rely on the listener-collected errors:', messageOf(e)) }
  } catch (err) {
    errors.push(`validation harness error: ${(err as Error)?.message ?? String(err)}`)
  } finally {
    try {
      win?.destroy()
    } catch (e) { console.debug('[artifact-sandbox] ignore:', messageOf(e)) }
    if (tempPath) {
      try {
        unlinkSync(tempPath)
      } catch (e) { console.debug('[artifact-sandbox] temp file cleanup is best-effort:', messageOf(e)) }
    }
  }
  // Dedup + cap so a runaway artifact can't flood the model's context.
  const unique = [...new Set(errors)].slice(0, 20)
  return { ok: unique.length === 0, errors: unique }
}
