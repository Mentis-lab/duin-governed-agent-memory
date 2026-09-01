import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Regression: connectWithRetry received ONE already-constructed Client + transport
// and reused that SAME pair across all RETRY_DELAYS.length attempts. The real SDK's
// Protocol.connect() sets its internal transport reference synchronously, before the
// handshake even starts, and throws 'Already connected to a transport' if connect()
// is ever called again on that instance without an intervening close(). So the FIRST
// attempt failing for any reason it doesn't itself recover from (a slow `npx -y <pkg>`
// fetch outliving CONNECT_TIMEOUT_MS is the real-world trigger — withTimeout() only
// races client.connect(), it never cancels it, so the real call is still running when
// the retry loop moves on) left every later attempt failing INSTANTLY with that
// misleading error instead of actually retrying — and since the failed attempt's
// client/transport were never assigned to `state` (only the success path does that),
// nothing could ever close them: the spawned child outlived the retry loop entirely.
//
// These fakes reproduce that exact SDK contract (an instance throws on a second
// connect() unless closed first) so the test fails on the pre-fix code — which reuses
// one pair and hits the guard on attempt 2 — and passes once each attempt gets its own
// fresh Client/transport from a factory.
const hoisted = vi.hoisted(() => ({
  userData: '',
  clients: [] as { closed: boolean }[],
  transports: [] as { closed: boolean }[],
  connectCalls: 0
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

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: class {} }))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    closed = false
    onclose?: () => void
    onerror?: (err: Error) => void
    constructor(public readonly opts: { command: string; args?: string[]; env?: Record<string, string> }) {
      hoisted.transports.push(this as never)
    }
    async close() {
      this.closed = true
    }
  }
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class FakeClient {
    closed = false
    private _transport: { close: () => Promise<void> } | null = null
    constructor() {
      hoisted.clients.push(this as never)
    }
    // Faithful to @modelcontextprotocol/sdk's Protocol.connect(): throws if THIS
    // instance already has a transport wired up. A failed connect leaves that
    // reference set — nothing in the SDK clears it for you — so calling connect()
    // again on the same (unclosed) instance always hits this branch.
    async connect(transport: { close: () => Promise<void> }) {
      if (this._transport) {
        throw new Error(
          'Already connected to a transport. Call close() before connecting to a new transport, or use a separate Protocol instance per connection.'
        )
      }
      this._transport = transport
      hoisted.connectCalls++
      // Only the very first connect() attempt across the whole test fails — every
      // later one (necessarily a different, fresh Client if the fix is in place)
      // succeeds. This stands in for the real world's "attempt 0 timed out".
      if (hoisted.connectCalls === 1) {
        throw new Error('simulated: npx fetch exceeded CONNECT_TIMEOUT_MS')
      }
    }
    async listTools() {
      return { tools: [{ name: 'ping', description: 'p', inputSchema: {} }] }
    }
    async close() {
      this.closed = true
      const t = this._transport
      this._transport = null
      await t?.close()
    }
  }
}))

vi.mock('./keychain', () => ({
  getKey: () => null,
  hasKey: () => false,
  setKey: () => undefined
}))

import { McpManager } from './mcp-manager'

beforeAll(() => {
  hoisted.userData = mkdtempSync(join(tmpdir(), 'duin-mcp-retry-test-'))
})

afterAll(() => {
  try {
    rmSync(hoisted.userData, { recursive: true, force: true })
  } catch {
    // best-effort temp cleanup
  }
})

beforeEach(() => {
  hoisted.clients = []
  hoisted.transports = []
  hoisted.connectCalls = 0
})

afterEach(() => {
  hoisted.clients = []
  hoisted.transports = []
})

describe('McpManager.connectWithRetry — retry after a stuck first attempt', () => {
  it('gives each attempt its own Client/transport instead of reusing one across retries', async () => {
    writeFileSync(join(hoisted.userData, 'mcp-servers.json'), '[]')
    const mgr = new McpManager()
    const id = 'flaky-npx-server'

    await mgr.addServerIfMissing({
      id,
      name: 'Flaky',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-slow-package'],
      auth: 'none',
      enabled: true
    })

    // Pre-fix, this never resolves: attempt 0 throws, and attempts 1 and 2 both
    // throw 'Already connected to a transport' instantly (same reused pair), so
    // state.status sticks on 'error' and this times out instead of settling.
    await vi.waitFor(
      () => {
        expect((mgr as unknown as { servers: Map<string, { status: string }> }).servers.get(id)!.status).toBe(
          'connected'
        )
      },
      { timeout: 5000 }
    )

    const state = (mgr as unknown as { servers: Map<string, { status: string; error?: string }> }).servers.get(id)!
    expect(state.status).toBe('connected')
    expect(state.error).toBeUndefined()

    // Two attempts happened (attempt 0 failed, attempt 1 succeeded), each with its
    // OWN Client and transport — not one pair straddling both.
    expect(hoisted.clients).toHaveLength(2)
    expect(hoisted.transports).toHaveLength(2)

    // The failed first attempt's Client/transport were reaped, not orphaned — the
    // other half of the same bug (a leaked `npx` child process).
    expect(hoisted.clients[0].closed).toBe(true)
    expect(hoisted.transports[0].closed).toBe(true)

    // The pair actually wired into state is the surviving (second) one.
    expect(hoisted.clients[1].closed).toBe(false)
  }, 10_000)
})
