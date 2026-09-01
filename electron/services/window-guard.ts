// window-guard.ts — pure navigation-security decisions shared by every BrowserWindow that loads the
// app's full preload (electron/preload.ts's contextBridge window.api: chat, files, hooks, shell).
//
// WHY THIS IS ITS OWN MODULE, AND WHY THE GAP THIS CLOSES WAS INVISIBLE:
// main.ts's createWindow() wires this exact guard pair (setWindowOpenHandler + will-navigate) inline,
// directly on mainWindow.webContents, with a SECURITY comment explaining why: Electron re-executes a
// window's preload against whatever it navigates to, so a full-preload window that ever reaches a
// remote origin hands that origin the same window.api surface the packaged app trusts. Because the
// guard lived inline in one constructor, there was nowhere to grep "does every full-preload window
// get this?" — it read as mainWindow-specific setup, not a reusable contract. When
// electron/services/canvas/canvas-window.ts later opened a SECOND window with the identical preload
// (for detached note/canvas views), nothing prompted it to repeat the guard, and the window still
// opened, still rendered, still worked — the omission only becomes exploitable via a narrow path (an
// ordinary http(s) link inside vault-note/connector-ingested content that the renderer's read view
// lets fall through to a real top-level navigation instead of intercepting).
//
// Extracted here, pure (no `electron` import), so the DECISION LOGIC — the part that actually defines
// the security boundary — can be unit-tested directly without mocking BrowserWindow/webContents.
// electron/services/browser-manager.ts and artifact-sandbox.ts's own tests follow the same split:
// test the pure predicate; mock `electron` only enough to let an importing module load at all.

/**
 * True if `url` may be handed to the OS opener (`shell.openExternal`) from a window-open request
 * (`webContents.setWindowOpenHandler`). Only plain http/https — file://, javascript:, data:, and
 * chrome-extension:/view-source:-style schemes must never reach the OS opener from renderer content.
 */
export function isExternalOpenTarget(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false // malformed URL — never hand it anywhere
  }
}

/**
 * True if top-level navigation to `url` may proceed IN THIS WINDOW (a `webContents` `will-navigate`
 * event). Anything else must call `event.preventDefault()` — see the module doc for why. Allows only
 * the packaged file:// app and the Vite dev server; every remote origin is denied (including https),
 * because allowing one would let it inherit this window's preload.
 */
export function isAllowedNavigationTarget(url: string, trustedRendererUrl: string): boolean {
  try {
    const candidate = new URL(url)
    const trusted = new URL(trustedRendererUrl)
    if (trusted.protocol === 'file:') {
      return (
        candidate.protocol === 'file:' &&
        candidate.host === trusted.host &&
        candidate.pathname === trusted.pathname
      )
    }
    // Non-file trusted target (the dev server): exact-origin match only. Opaque origins
    // (the string 'null' — file:, data:, or an unparseable trusted value) must never
    // satisfy this branch: 'null' === 'null' would let ANY file:/data: candidate through
    // whenever the trusted URL itself degrades, so fail closed instead of comparing.
    if (trusted.origin === 'null' || candidate.origin === 'null') return false
    return candidate.origin === trusted.origin
  } catch {
    return false // malformed URL — deny, don't guess
  }
}
