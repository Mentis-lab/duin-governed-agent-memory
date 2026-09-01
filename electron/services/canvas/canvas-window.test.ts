// canvas-window.test.ts — pins the fix for "detached note/canvas windows carry the full app preload
// with zero navigation or new-window guard".
//
// openDetachedWindow constructs a real electron.BrowserWindow and calls loadURL/loadFile against it,
// which needs a running app to do anything meaningful — driving that through a mock deep enough to
// prove the guard actually fires would need far more scaffolding than signal (see
// electron/services/browser-manager.ts and artifact-sandbox.ts's own tests, which stop at pure logic
// for the same reason). So this is a structural/adoption check, the same technique
// settings-call-sites.test.ts uses to pin that a choke point stays wired at its call site: it reads
// the real source and asserts the guard pair from window-guard.ts is actually registered here, using
// the predicates it exports — not just imported and left unused.
//
// The DECISION LOGIC these calls depend on is separately, fully unit-tested in window-guard.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const src = readFileSync(
  resolve(process.cwd(), 'electron/services/canvas/canvas-window.ts'),
  'utf-8'
)

describe('canvas-window.ts — openDetachedWindow wires the shared navigation guard', () => {
  it('imports both guard predicates from the shared pure module', () => {
    expect(src).toMatch(
      /import\s*\{[^}]*isExternalOpenTarget[^}]*\}\s*from\s*['"]\.\.\/window-guard['"]/
    )
    expect(src).toMatch(
      /import\s*\{[^}]*isAllowedNavigationTarget[^}]*\}\s*from\s*['"]\.\.\/window-guard['"]/
    )
  })

  it('registers a real setWindowOpenHandler that consults isExternalOpenTarget', () => {
    const openHandlerAt = src.indexOf('setWindowOpenHandler(')
    const navigateListenerAt = src.indexOf("on('will-navigate'")
    expect(openHandlerAt, 'setWindowOpenHandler is not registered on win.webContents').toBeGreaterThan(
      -1
    )
    expect(navigateListenerAt, 'will-navigate is not registered on win.webContents').toBeGreaterThan(-1)
    // The open-handler wiring must reference the predicate BEFORE the separate will-navigate
    // listener — proves it's inside that handler's own body, not an unrelated stray mention.
    expect(openHandlerAt).toBeLessThan(navigateListenerAt)
    expect(src.slice(openHandlerAt, navigateListenerAt)).toContain('isExternalOpenTarget')
  })

  it('registers a real will-navigate listener that consults isAllowedNavigationTarget', () => {
    const navigateListenerAt = src.indexOf("on('will-navigate'")
    expect(navigateListenerAt).toBeGreaterThan(-1)
    expect(src.slice(navigateListenerAt)).toContain('isAllowedNavigationTarget')
  })

  it('applies the same predicate to server redirects', () => {
    const redirectAt = src.indexOf("on('will-redirect'")
    expect(redirectAt).toBeGreaterThan(-1)
    expect(src.slice(redirectAt)).toContain('isAllowedNavigationTarget')
  })

  it("no longer opts this window out of the sandbox (matches mainWindow's full-preload profile)", () => {
    expect(src).not.toMatch(/sandbox:\s*false/)
    expect(src).toMatch(/sandbox:\s*true/)
  })
})
