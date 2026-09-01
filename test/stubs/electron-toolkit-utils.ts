// test/stubs/electron-toolkit-utils.ts — `@electron-toolkit/utils` under vitest.
//
// The package re-exports electron's CommonJS bindings, so importing it from an ESM test context
// throws "Named export 'BrowserWindow' not found" at LOAD time — killing the whole suite file
// before any test runs. Aliasing `electron` alone does not help: the bad import lives inside this
// dependency, not in our code.
//
// Every call site in this repo imports exactly one symbol, `is`, and uses it only to branch
// dev-vs-packaged (skill-loader, plugin-loader, mcp-defaults, main).
// `is.dev = true` matches how the suite runs — from the repo, not a packaged app.

export const is = {
  dev: true
}

export const electronApp = {
  setAppUserModelId: (): void => undefined
}

export const optimizer = {
  watchWindowShortcuts: (): void => undefined,
  registerFramelessWindowIpc: (): void => undefined
}

export const platform = {
  isWindows: process.platform === 'win32',
  isMacOS: process.platform === 'darwin',
  isLinux: process.platform === 'linux'
}

export default { is, electronApp, optimizer, platform }
