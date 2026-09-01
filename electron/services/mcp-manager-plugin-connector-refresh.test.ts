import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Mutable across the test: `enabledPluginRoots` is what refreshPluginConnectors
// walks, so the mock has to be re-pointable at a per-test temp plugin root.
const hoisted = vi.hoisted(() => ({
  roots: [] as { pluginId: string; rootPath: string }[],
  // Every transport the manager builds, so a test can assert on one the manager
  // itself has stopped tracking.
  transports: [] as { closed: boolean }[],
  // When set, the fake client's connect() parks on this until the test releases
  // it — the only way to hold a connect "in flight" long enough to disable the
  // plugin underneath it.
  connectGate: null as Promise<void> | null
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/lamprey-test-userdata-nonexistent' },
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
  }
}))

vi.mock('./plugin-loader', () => ({
  enabledPluginRoots: () => hoisted.roots,
  subscribeToPluginChanges: () => () => {},
  getPluginsRoot: () => '/tmp/duin-test-plugins'
}))

// Each `new StdioClientTransport(...)` is a distinct object, so transport
// identity is how the test tells "reconnected" from "left alone".
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: class {} }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {}
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    closed = false
    constructor(public readonly opts: { command: string; args?: string[]; env?: Record<string, string> }) {
      hoisted.transports.push(this)
    }
    async close() {
      this.closed = true
    }
  }
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class FakeClient {
    async connect(_transport: unknown) {
      if (hoisted.connectGate) await hoisted.connectGate
    }
    async listTools() {
      return { tools: [{ name: 'ping', description: 'p', inputSchema: {} }] }
    }
  }
}))

vi.mock('./keychain', () => ({
  getKey: () => null,
  hasKey: () => false,
  setKey: () => undefined
}))

import { McpManager } from './mcp-manager'

const tmpRoots: string[] = []

function seedPluginRoot(pluginId: string, connectors: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), 'duin-mcp-plugin-'))
  tmpRoots.push(root)
  const pluginDir = join(root, pluginId)
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'connectors.json'), JSON.stringify(connectors, null, 2))
  hoisted.roots = [{ pluginId, rootPath: pluginDir }]
  return pluginDir
}

function writeConnectors(pluginDir: string, connectors: unknown[]): void {
  writeFileSync(join(pluginDir, 'connectors.json'), JSON.stringify(connectors, null, 2))
}

afterEach(() => {
  hoisted.roots = []
  hoisted.transports = []
  hoisted.connectGate = null
  for (const root of tmpRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // best-effort temp cleanup
    }
  }
})

describe('McpManager.refreshPluginConnectors — in-place connectors.json edits', () => {
  // Regression: the "add new entries" loop skipped every id already present in
  // pluginServers, so a freshly parsed config for an ALREADY-ENABLED plugin was
  // thrown away. A user (or the plugin itself — plugin dirs are documented as
  // hand-editable) fixing a broken command / adding a required env var /
  // repointing a URL keeps the connector id, so the watcher-driven refresh
  // re-read the file, built the corrected config, and dropped it silently. The
  // stale child kept running until the plugin was toggled off/on or the app
  // restarted, with nothing logged to say the edit had been ignored.
  it('re-applies and reconnects when an enabled plugin edits a connector in place', async () => {
    const pluginDir = seedPluginRoot('myplugin', [
      { id: 'conn', name: 'Conn', transport: 'stdio', command: 'broken-cmd', args: ['--old'] }
    ])
    const mgr = new McpManager()
    const id = 'myplugin:conn'

    ;(mgr as any).refreshPluginConnectors()
    await vi.waitFor(() => {
      expect((mgr as any).pluginServers.get(id)?.status).toBe('connected')
    })
    const firstTransport = (mgr as any).pluginServers.get(id).transport
    expect(firstTransport.opts.command).toBe('broken-cmd')

    // The user repairs the connector without changing its id — exactly what
    // plugin-loader's chokidar 'change' event forwards to this function.
    writeConnectors(pluginDir, [
      {
        id: 'conn',
        name: 'Conn',
        transport: 'stdio',
        command: 'fixed-cmd',
        args: ['--new'],
        env: { API_KEY: 'k' }
      }
    ])
    ;(mgr as any).refreshPluginConnectors()

    await vi.waitFor(() => {
      const state = (mgr as any).pluginServers.get(id)
      expect(state.status).toBe('connected')
      expect(state.transport).not.toBe(firstTransport)
    })

    const state = (mgr as any).pluginServers.get(id)
    expect(state.config.command).toBe('fixed-cmd')
    expect(state.config.args).toEqual(['--new'])
    expect(state.config.env).toEqual({ API_KEY: 'k' })
    // The live child must be launched from the corrected config, not just the
    // bookkeeping copy of it.
    expect(state.transport.opts.command).toBe('fixed-cmd')
    expect(state.transport.opts.args).toEqual(['--new'])
    expect(state.transport.opts.env.API_KEY).toBe('k')
  })

  it('leaves an unchanged connector connected (no restart churn on unrelated edits)', async () => {
    const pluginDir = seedPluginRoot('myplugin', [
      { id: 'conn', name: 'Conn', transport: 'stdio', command: 'same-cmd', args: ['--a'], env: { A: '1', B: '2' } }
    ])
    const mgr = new McpManager()
    const id = 'myplugin:conn'

    ;(mgr as any).refreshPluginConnectors()
    await vi.waitFor(() => {
      expect((mgr as any).pluginServers.get(id)?.status).toBe('connected')
    })
    const firstTransport = (mgr as any).pluginServers.get(id).transport

    // Same connector, reformatted and with env keys reordered — semantically
    // identical, so the running child must be left alone.
    writeConnectors(pluginDir, [
      { id: 'conn', name: 'Conn', transport: 'stdio', command: 'same-cmd', args: ['--a'], env: { B: '2', A: '1' } }
    ])
    ;(mgr as any).refreshPluginConnectors()

    // Give any (unwanted) async reconnect a chance to land before asserting.
    await new Promise((r) => setTimeout(r, 20))
    const state = (mgr as any).pluginServers.get(id)
    expect(state.status).toBe('connected')
    expect(state.transport).toBe(firstTransport)
  })
})

describe('McpManager.connectPluginServer — plugin disabled mid-connect', () => {
  // Regression: connectPluginServer aliases the plugin's ServerState into
  // this.servers for the duration of the connect and unconditionally removes it
  // again in its `finally`. If the plugin is toggled off during that window
  // (Customize Plugins -> setPluginEnabled -> broadcastChange ->
  // refreshPluginConnectors), the drop loop deletes the id from pluginServers and
  // calls cleanupServer — which closes nothing, because state.transport is still
  // null until connectWithRetry succeeds. The connect then finishes, writes a live
  // client + transport (a spawned child, for stdio) onto that state, and the
  // `finally` removes the last remaining reference. getServers/getAllTools/shutdown
  // only ever walk the two maps, so the connection could never be closed again.
  it('closes a connection that completes after its plugin was disabled', async () => {
    seedPluginRoot('slowplugin', [
      { id: 'conn', name: 'Conn', transport: 'stdio', command: 'slow-cmd' }
    ])
    const mgr = new McpManager()
    const id = 'slowplugin:conn'

    let release!: () => void
    hoisted.connectGate = new Promise<void>((r) => {
      release = r
    })

    ;(mgr as any).refreshPluginConnectors()
    // Hold a reference the manager is about to lose — that is the only way to
    // observe a leaked state at all.
    const leaked = (mgr as any).pluginServers.get(id)
    expect(leaked.status).toBe('connecting')
    expect(leaked.transport).toBeNull()
    expect(hoisted.transports).toHaveLength(1)

    // Plugin disabled while the handshake is still open.
    hoisted.roots = []
    ;(mgr as any).refreshPluginConnectors()
    expect((mgr as any).pluginServers.has(id)).toBe(false)

    release()
    await vi.waitFor(() => {
      expect(hoisted.transports[0].closed).toBe(true)
    })
    expect(leaked.client).toBeNull()
    expect(leaked.transport).toBeNull()
    expect((mgr as any).servers.has(id)).toBe(false)
  })

  it('keeps a still-wanted connector connected when an unrelated refresh runs mid-connect', async () => {
    seedPluginRoot('slowplugin', [
      { id: 'conn', name: 'Conn', transport: 'stdio', command: 'slow-cmd' }
    ])
    const mgr = new McpManager()
    const id = 'slowplugin:conn'

    let release!: () => void
    hoisted.connectGate = new Promise<void>((r) => {
      release = r
    })

    ;(mgr as any).refreshPluginConnectors()
    // Same connectors.json, re-read mid-connect (chokidar fires on any write in
    // the plugins root): the connector is still desired, so the connection that
    // lands afterwards must survive.
    ;(mgr as any).refreshPluginConnectors()

    release()
    await vi.waitFor(() => {
      expect((mgr as any).pluginServers.get(id)?.status).toBe('connected')
    })
    expect(hoisted.transports[0].closed).toBe(false)
    expect((mgr as any).pluginServers.get(id).transport).toBe(hoisted.transports[0])
  })
})

describe('McpManager.refreshPluginConnectors — full McpServerConfig contract', () => {
  // Regression: the transport/auth checks here only ever recognized the values
  // the first plugin connector shipped with (transport 'stdio' | 'sse', auth
  // 'google-oauth' | 'none') and were never widened to match McpServerConfig,
  // which documents a third transport ('http', Streamable HTTP) and a third auth
  // ('oauth', generic MCP OAuth 2.1). A plugin author writing connectors.json in
  // the documented shape — the exact shape DUIN's own Add-connector "Custom" tab
  // produces for a Streamable HTTP server — got no error and no log line:
  // `transport` came back null, the `continue` guard skipped the entry, and the
  // connector just never appeared.
  it('derives an http-transport connector, including its headers, and connects it', async () => {
    seedPluginRoot('httpplugin', [
      {
        id: 'conn',
        name: 'Conn',
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { 'X-Api-Key': 'secret' }
      }
    ])
    const mgr = new McpManager()
    const id = 'httpplugin:conn'

    ;(mgr as any).refreshPluginConnectors()

    const state = (mgr as any).pluginServers.get(id)
    expect(state).toBeDefined()
    expect(state.config.transport).toBe('http')
    expect(state.config.url).toBe('https://example.com/mcp')
    expect(state.config.headers).toEqual({ 'X-Api-Key': 'secret' })

    // Also prove the derived config is one connectServer's http branch actually
    // accepts end to end, not just a shape that happens to satisfy the assertions
    // above.
    await vi.waitFor(() => {
      expect((mgr as any).pluginServers.get(id)?.status).toBe('connected')
    })
  })

  // Companion to the http case above: auth 'oauth' (generic MCP OAuth 2.1, as
  // opposed to the DUIN-specific 'google-oauth') and its `scope` were dropped the
  // same way — silently downgraded to `auth: 'none'`, which connectSSE/connectHttp
  // then hand to the server with no Authorization at all.
  it('derives a generic oauth-auth connector with its scope, for sse transport, and connects it', async () => {
    seedPluginRoot('oauthplugin', [
      {
        id: 'conn',
        name: 'Conn',
        transport: 'sse',
        url: 'https://example.com/sse',
        auth: 'oauth',
        scope: 'profile email'
      }
    ])
    const mgr = new McpManager()
    const id = 'oauthplugin:conn'

    ;(mgr as any).refreshPluginConnectors()

    const state = (mgr as any).pluginServers.get(id)
    expect(state).toBeDefined()
    expect(state.config.auth).toBe('oauth')
    expect(state.config.scope).toBe('profile email')

    await vi.waitFor(() => {
      expect((mgr as any).pluginServers.get(id)?.status).toBe('connected')
    })
  })

  // samePluginConnectorConfig must track every field the derivation above now
  // copies — otherwise a user editing a header in place (e.g. rotating an
  // expired token) would be parsed correctly but silently kept running under the
  // OLD config, the exact failure the first describe block in this file exists
  // to catch for command/args/env.
  it('reconnects on an in-place edit that changes only a connector header', async () => {
    const pluginDir = seedPluginRoot('httpplugin2', [
      {
        id: 'conn',
        name: 'Conn',
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { 'X-Api-Key': 'old' }
      }
    ])
    const mgr = new McpManager()
    const id = 'httpplugin2:conn'

    ;(mgr as any).refreshPluginConnectors()
    await vi.waitFor(() => {
      expect((mgr as any).pluginServers.get(id)?.status).toBe('connected')
    })

    writeConnectors(pluginDir, [
      {
        id: 'conn',
        name: 'Conn',
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { 'X-Api-Key': 'new' }
      }
    ])
    ;(mgr as any).refreshPluginConnectors()

    // The edit is picked up synchronously (refreshPluginConnectors swaps
    // `existing.config` before kicking off the async reconnect), so this does
    // not need a vi.waitFor: if samePluginConnectorConfig wrongly still called
    // this "unchanged", the config here would still read 'old'.
    expect((mgr as any).pluginServers.get(id).config.headers).toEqual({ 'X-Api-Key': 'new' })

    await vi.waitFor(() => {
      expect((mgr as any).pluginServers.get(id)?.status).toBe('connected')
    })
  })
})
