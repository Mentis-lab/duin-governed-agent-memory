// The seeded MCP rows a FRESH install starts with — release B11.
//
// A fresh install used to write `chrome` = `npx -y @playwright/mcp` with `enabled: true` and
// connect it at boot: a network fetch plus execution of whatever the npm registry served at that
// moment, before the user had touched a setting, with no dialog (the connector dialog covers
// user-added and plugin servers only — ipc/mcp.ts / ipc/plugins.ts). These pins fail on any build
// that drifts back to spawning at boot or to an unpinned package.
//
// Same harness shape as mcp-manager-corrupt-config.test.ts: a real temp userData dir, the SDK
// transports stubbed so importing the manager opens nothing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const userDataDir = mkdtempSync(join(tmpdir(), 'duin-mcp-seed-'))

vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData') return userDataDir
      throw new Error(`unexpected getPath("${which}") in test`)
    }
  },
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
  }
}))
vi.mock('./plugin-loader', () => ({
  enabledPluginRoots: () => [],
  subscribeToPluginChanges: () => () => {},
  getPluginsRoot: () => '/tmp/duin-test-plugins'
}))
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: class {} }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class {} }))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {}
    async listTools() {
      return { tools: [] }
    }
  }
}))
vi.mock('./keychain', () => ({ getKey: () => null, hasKey: () => false, setKey: () => undefined }))

import { loadConfigs, getDefaultConfigs, repairSeededChrome, CHROME_MCP_PACKAGE, type McpServerConfig } from './mcp-manager'

const CONFIG_PATH = join(userDataDir, 'mcp-servers.json')

beforeEach(() => {
  for (const f of readdirSync(userDataDir)) rmSync(join(userDataDir, f), { force: true, recursive: true })
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('fresh-install chrome seed', () => {
  it('is written DISABLED, so nothing spawns at boot until the user turns it on', () => {
    expect(existsSync(CONFIG_PATH)).toBe(false)
    const rows = loadConfigs()
    const chrome = rows.find((r) => r.id === 'chrome')!
    expect(chrome).toBeDefined()
    expect(chrome.enabled).toBe(false)
    // and the row really is on disk (the user can flip it in Settings → Connections)
    const onDisk = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as McpServerConfig[]
    expect(onDisk.find((r) => r.id === 'chrome')?.enabled).toBe(false)
  })

  it('pins @playwright/mcp to an exact version — no registry-latest execution', () => {
    const chrome = getDefaultConfigs().find((r) => r.id === 'chrome')!
    expect(chrome.command).toBe('npx')
    expect(chrome.args).toContain(CHROME_MCP_PACKAGE)
    expect(CHROME_MCP_PACKAGE).toMatch(/^@playwright\/mcp@\d+\.\d+\.\d+$/)
    // The bare, unpinned name must not appear as its own argument.
    expect(chrome.args).not.toContain('@playwright/mcp')
  })
})

describe('repairSeededChrome — a repair never changes `enabled`', () => {
  const bad = (enabled: boolean): McpServerConfig => ({
    id: 'chrome',
    name: 'Chrome (Playwright)',
    transport: 'stdio',
    command: 'npx',
    args: ['@anthropic-ai/mcp-server-playwright'],
    auth: 'none',
    enabled
  })

  it('re-points the package but leaves a disabled row disabled', () => {
    const { configs, changed } = repairSeededChrome([bad(false)])
    expect(changed).toBe(true)
    expect(configs[0].args).toContain(CHROME_MCP_PACKAGE)
    expect(configs[0].enabled).toBe(false)
  })

  it('leaves an enabled row enabled (an install that already opted in keeps it)', () => {
    const { configs } = repairSeededChrome([bad(true)])
    expect(configs[0].enabled).toBe(true)
  })

  it('does not touch a row the user re-pointed themselves', () => {
    const custom: McpServerConfig = { ...bad(true), args: ['-y', 'some-other-mcp'] }
    const { configs, changed } = repairSeededChrome([custom])
    expect(changed).toBe(false)
    expect(configs[0]).toEqual(custom)
  })
})

describe('an existing install keeps its own chrome row', () => {
  it('loadConfigs returns the persisted enabled:true untouched (the owner is not switched off)', () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify([{ ...getDefaultConfigs()[0], enabled: true }]),
      'utf-8'
    )
    const rows = loadConfigs()
    expect(rows.find((r) => r.id === 'chrome')?.enabled).toBe(true)
  })
})
