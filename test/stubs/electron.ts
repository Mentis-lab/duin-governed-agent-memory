// test/stubs/electron.ts — the `electron` module under vitest.
//
// WHY: electron ships as CommonJS. Vitest imports it as ESM, so a module doing
// `import { app, BrowserWindow } from 'electron'` fails to LOAD with
// "SyntaxError: Named export 'BrowserWindow' not found" — the whole suite dies at import time
// before a single test runs. That is what killed electron/services/spine-events-prompt4.test.ts,
// via plugin-loader.ts -> @electron-toolkit/utils -> electron.
//
// This stub is aliased in vitest.config.ts so any transitive `electron` import resolves to a real
// ESM module with named exports. It is DELIBERATELY minimal and inert: it exists so importing a
// module never explodes, not so tests can drive electron. A test that needs specific behaviour
// should still `vi.mock('electron', …)` in its own file — that takes precedence over this alias.
//
// getPath returns a real temp directory rather than throwing: a throwing default would push every
// caller down its degraded path and quietly hide bugs in the normal one. Callers that want to
// exercise the throw (e.g. rag/ingest.test.ts) mock it explicitly.

import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stubUserData = join(tmpdir(), 'duin-vitest-userdata')

export const app = {
  getPath: (name: string): string => (name === 'temp' ? tmpdir() : stubUserData),
  getAppPath: (): string => process.cwd(),
  getName: (): string => 'DUIN',
  getVersion: (): string => '0.0.0-test',
  isPackaged: false,
  whenReady: async (): Promise<void> => undefined,
  on: (): void => undefined,
  once: (): void => undefined,
  quit: (): void => undefined
}

export const BrowserWindow = {
  getAllWindows: (): unknown[] => [],
  getFocusedWindow: (): unknown => null,
  fromWebContents: (): unknown => null
}

export const ipcMain = {
  handle: (): void => undefined,
  on: (): void => undefined,
  removeHandler: (): void => undefined,
  removeAllListeners: (): void => undefined
}

export const ipcRenderer = {
  invoke: async (): Promise<unknown> => undefined,
  on: (): void => undefined,
  send: (): void => undefined,
  removeAllListeners: (): void => undefined
}

export const session = { defaultSession: { webRequest: { onHeadersReceived: (): void => undefined } } }
export const contextBridge = { exposeInMainWorld: (): void => undefined }
export const shell = { openExternal: async (): Promise<void> => undefined }
export const dialog = {
  showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async (): Promise<{ canceled: boolean; filePath?: string }> => ({ canceled: true })
}
export const Menu = { buildFromTemplate: (): unknown => ({}), setApplicationMenu: (): void => undefined }
export const nativeTheme = { shouldUseDarkColors: false, on: (): void => undefined }
export const webUtils = { getPathForFile: (): string => '' }
export const clipboard = { writeText: (): void => undefined, readText: (): string => '' }
export const net = { isOnline: (): boolean => true }

export default {
  app,
  BrowserWindow,
  ipcMain,
  ipcRenderer,
  session,
  contextBridge,
  shell,
  dialog,
  Menu,
  nativeTheme,
  webUtils,
  clipboard,
  net
}
