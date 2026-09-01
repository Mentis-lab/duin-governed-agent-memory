import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Regression coverage for: removeServer() dropped an 'oauth' connector's entry from
// mcp-servers.json but left its access/refresh tokens, DCR client record, and PKCE
// verifier sitting in keys.json forever. Re-adding the same connector id later (e.g.
// re-pointed at a different self-hosted/staging host) would then silently attach the
// OLD server's bearer token to the FIRST request against the NEW one. See
// mcp-manager.ts's removeServer and mcp-oauth.ts's McpOAuthProvider.clear().

const hoisted = vi.hoisted(() => ({
  userData: '',
  // Stand-in for keys.json: the same `provider -> string` contract the real keychain
  // module exposes, so McpOAuthProvider's saveTokens/tokens/clear round-trip through
  // this exactly as they would through the real encrypted store.
  keys: new Map<string, string>()
}))

vi.mock('electron', () => ({
  app: { getPath: () => hoisted.userData },
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

// Not exercised (the test seeds server state directly, bypassing the real connect/
// OAuth handshake) — stubbed only so importing mcp-manager.ts doesn't try to load
// the real SDK transports.
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

vi.mock('./keychain', () => ({
  getKey: (provider: string) => hoisted.keys.get(provider) ?? null,
  setKey: (provider: string, value: string) => {
    hoisted.keys.set(provider, value)
  },
  deleteKey: (provider: string) => {
    hoisted.keys.delete(provider)
  },
  hasKey: (provider: string) => hoisted.keys.has(provider)
}))

import { McpManager, loadConfigs, saveConfigs, type McpServerConfig } from './mcp-manager'

beforeAll(() => {
  hoisted.userData = mkdtempSync(join(tmpdir(), 'duin-mcp-oauth-removal-'))
})

afterAll(() => {
  try {
    rmSync(hoisted.userData, { recursive: true, force: true })
  } catch {
    // best-effort temp cleanup
  }
})

/** Register a connector's state directly, bypassing the real connect/OAuth handshake —
 *  this suite is only about what removeServer() does to the keychore, not the dance
 *  that populates it. */
function seedServer(mgr: McpManager, config: McpServerConfig): void {
  saveConfigs([...loadConfigs().filter((c) => c.id !== config.id), config])
  ;(mgr as unknown as { servers: Map<string, unknown> }).servers.set(config.id, {
    config,
    status: 'disconnected',
    client: null,
    transport: null,
    tools: [],
    restartCount: 0
  })
}

describe('McpManager.removeServer — OAuth credential purge', () => {
  it('deletes the tokens/client/verifier keychain rows for an oauth connector', async () => {
    saveConfigs([]) // start from a clean mcp-servers.json
    hoisted.keys.clear()
    const mgr = new McpManager()
    const id = 'linear'
    seedServer(mgr, {
      id,
      name: 'Linear',
      transport: 'http',
      url: 'https://old-host.example.com/mcp',
      auth: 'oauth',
      enabled: true
    })

    // Simulate a completed prior login: real tokens sitting in the keychain, exactly
    // as McpOAuthProvider.saveTokens/saveClientInformation/saveCodeVerifier left them.
    hoisted.keys.set(`mcp-oauth:${id}:tokens`, '{"access_token":"secret-old-token"}')
    hoisted.keys.set(`mcp-oauth:${id}:client`, '{"client_id":"abc"}')
    hoisted.keys.set(`mcp-oauth:${id}:verifier`, 'pkce-verifier-xyz')

    expect(await mgr.removeServer(id)).toBe(true)

    // Pre-fix: all three rows survived untouched (removeServer never looked at the
    // keychain at all), so re-adding the same id later would silently reuse the OLD
    // server's bearer token against a NEW url.
    expect(hoisted.keys.has(`mcp-oauth:${id}:tokens`)).toBe(false)
    expect(hoisted.keys.has(`mcp-oauth:${id}:client`)).toBe(false)
    expect(hoisted.keys.has(`mcp-oauth:${id}:verifier`)).toBe(false)
    expect(loadConfigs().some((c) => c.id === id)).toBe(false)
  })

  it('leaves the keychain untouched when removing a non-oauth connector', async () => {
    saveConfigs([])
    hoisted.keys.clear()
    // An unrelated oauth row for a DIFFERENT server must survive too — proves the
    // purge is scoped to the removed connector's own id, not a blanket sweep.
    hoisted.keys.set('mcp-oauth:other-server:tokens', '{"access_token":"unrelated"}')

    const mgr = new McpManager()
    const id = 'local-stdio'
    seedServer(mgr, {
      id,
      name: 'Local stdio',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      auth: 'none',
      enabled: true
    })

    const before = new Map(hoisted.keys)
    expect(await mgr.removeServer(id)).toBe(true)
    expect(hoisted.keys).toEqual(before)
  })
})
