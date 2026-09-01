import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// A STRUCTURAL test, and deliberately so. The vitest environment is node-only
// (vitest.config.ts: `environment: 'node'`, and there is no jsdom or
// @testing-library in devDependencies), so the entry module and the JSX
// placements cannot be render-tested in this repo. What CAN be pinned is that the
// wiring is present at all — which is exactly what was missing: createRoot had no
// options, and there was no boundary anywhere in src/.
//
// If a jsdom environment is ever added, replace this with a real mount test.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

describe('renderer error wiring', () => {
  const main = read('main.tsx')
  const app = read('App.tsx')

  it('createRoot is given onUncaughtError — it was called with NO options', () => {
    expect(main).toMatch(/onUncaughtError/)
    expect(main).toMatch(/onCaughtError/)
  })

  it('the renderer entry installs the global handlers', () => {
    expect(main).toMatch(/installGlobalErrorHandlers\(\s*window/)
  })

  it('an ErrorBoundary wraps the shell', () => {
    expect(main).toMatch(/<ErrorBoundary label="the application shell">/)
  })

  it('each right-panel branch has its OWN boundary, so one throw does not take the shell', () => {
    // A single root boundary would still blank the whole window, just prettily.
    expect(app).toMatch(/<ErrorBoundary label="this tool panel">/)
    expect(app).toMatch(/<ErrorBoundary label="the artifact panel">/)
    expect(app).toMatch(/<ErrorBoundary label="the workspace panel">/)
  })

  it('the fallback reaches window:reload — an IPC with zero renderer callers before this', () => {
    const boundary = read('components/ErrorBoundary.tsx')
    const globals = read('lib/global-errors.ts')
    expect(boundary).toMatch(/reloadWindow/)
    expect(globals).toMatch(/window:reload/) // the handler this finally calls
    expect(globals).toMatch(/api\?\.window\?\.reload/)
  })

  // The last link of that chain, and the one that was inert: the main-process handler reloaded the
  // module-global `mainWindow`, so a crash inside a DETACHED Canvas/Node window (same bundle, same
  // preload, same shell boundary above) reloaded the main window instead — and answered
  // {success:true}, so reloadWindow's location.reload() fallback (throw-only) never ran either.
  // Anchored on the handler body, not the whole file, because main.ts touches `mainWindow`
  // everywhere; main.ts cannot be imported under vitest (it boots the app at module scope), the
  // same reason tray.test.ts asserts its wiring from source.
  it('the main-process handler reloads the window that ASKED, not the module-global mainWindow', () => {
    const handler = read('../electron/main.ts').match(
      /ipcMain\.handle\('window:reload',[\s\S]*?\n {2}\}\)/
    )
    expect(handler).not.toBeNull()
    expect(handler![0]).toMatch(/\.reload\(\)/)
    expect(handler![0]).toMatch(/event\.sender/)
    expect(handler![0]).not.toMatch(/mainWindow/)
  })
})
