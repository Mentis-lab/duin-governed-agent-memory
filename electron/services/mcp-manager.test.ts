import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock electron's app so the module loads under vitest's node environment.
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/lamprey-test-userdata-nonexistent'
  },
  // connectServer emits status changes, which reach into BrowserWindow.getAllWindows().
  // Provide the static so that path is a harmless no-op under the node test env.
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
  }
}))

// mcp-manager now statically imports plugin-loader (was a lazy require); mock it
// so its electron / @electron-toolkit imports stay out of this test graph.
vi.mock('./plugin-loader', () => ({
  enabledPluginRoots: () => [],
  subscribeToPluginChanges: () => () => {},
  getPluginsRoot: () => '/tmp/duin-test-plugins'
}))

// Stub the SDK transports so importing the manager doesn't try to open a
// stdio child / SSE socket.
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {}
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {}
}))

// We need the real ErrorCode + McpError for the manager's instanceof check to
// match what the mocked Client throws.
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class FakeClient {
    public capturedTimeout: number | undefined
    // Minimal connect handshake so connectServer's stdio path completes on the
    // first attempt (no RETRY_DELAYS sleeps). listTools returns one tool so a
    // successful reconnect is observable via state.tools.
    async connect(_transport: unknown) {}
    async listTools() {
      return { tools: [{ name: 'ping', description: 'p', inputSchema: {} }] }
    }
    async callTool(_params: unknown, _schema: unknown, opts?: { timeout?: number }) {
      // Record what the manager passed so the test can assert on it.
      FakeClient.lastTimeoutMs = opts?.timeout
      if (FakeClient.behaviour === 'timeout') {
        throw new McpError(ErrorCode.RequestTimeout, 'request timeout')
      }
      if (FakeClient.behaviour === 'generic-error') {
        throw new Error('boom')
      }
      if (FakeClient.behaviour === 'image-only') {
        return {
          isError: false,
          content: [{ type: 'image', data: 'ZmFrZS1wbmctYnl0ZXM=', mimeType: 'image/png' }]
        }
      }
      return { isError: false, content: [{ type: 'text', text: 'ok' }] }
    }
    static lastTimeoutMs: number | undefined
    static behaviour: 'ok' | 'timeout' | 'generic-error' | 'image-only' = 'ok'
  }
}))

// keychain is incidental; stub to be safe.
vi.mock('./keychain', () => ({
  getKey: () => null,
  hasKey: () => false,
  setKey: () => undefined
}))

import { McpManager, MCPTimeoutError, __setMcpCallTimeoutForTesting } from './mcp-manager'
import { Client as FakeClientCtor } from '@modelcontextprotocol/sdk/client/index.js'

function seedConnectedServer(mgr: McpManager, serverId: string): void {
  // Reach into the manager's internal state map. The test bypasses the real
  // connect/handshake flow entirely — we only care that callTool wires the
  // timeout and translates RequestTimeout into MCPTimeoutError.
  const fakeClient = new (FakeClientCtor as any)()
  ;(mgr as any).servers.set(serverId, {
    config: { id: serverId, name: serverId, transport: 'stdio', auth: 'none', enabled: true },
    status: 'connected',
    client: fakeClient,
    transport: null,
    tools: [],
    restartCount: 0
  })
}

beforeEach(() => {
  ;(FakeClientCtor as any).lastTimeoutMs = undefined
  ;(FakeClientCtor as any).behaviour = 'ok'
})

describe('mcpManager.callTool — per-call timeout (T2)', () => {
  it('passes the configured timeout to client.callTool', async () => {
    __setMcpCallTimeoutForTesting(45_000)
    const mgr = new McpManager()
    seedConnectedServer(mgr, 'srv1')

    const result = await mgr.callTool('srv1', 'do_thing', { x: 1 })

    expect(result).toBe('ok')
    expect((FakeClientCtor as any).lastTimeoutMs).toBe(45_000)

    __setMcpCallTimeoutForTesting(null)
  })

  it('falls back to SDK default when configured timeout is 0', async () => {
    __setMcpCallTimeoutForTesting(0)
    const mgr = new McpManager()
    seedConnectedServer(mgr, 'srv2')

    await mgr.callTool('srv2', 'do_thing', {})

    expect((FakeClientCtor as any).lastTimeoutMs).toBeUndefined()

    __setMcpCallTimeoutForTesting(null)
  })

  it('translates RequestTimeout McpError into a typed MCPTimeoutError', async () => {
    __setMcpCallTimeoutForTesting(30_000)
    ;(FakeClientCtor as any).behaviour = 'timeout'
    const mgr = new McpManager()
    seedConnectedServer(mgr, 'srv3')

    await expect(mgr.callTool('srv3', 'slow_query', { q: 'x' })).rejects.toMatchObject({
      name: 'MCPTimeoutError',
      serverId: 'srv3',
      toolName: 'slow_query',
      timeoutMs: 30_000
    })

    __setMcpCallTimeoutForTesting(null)
  })

  it('lets non-timeout errors pass through unchanged', async () => {
    __setMcpCallTimeoutForTesting(30_000)
    ;(FakeClientCtor as any).behaviour = 'generic-error'
    const mgr = new McpManager()
    seedConnectedServer(mgr, 'srv4')

    await expect(mgr.callTool('srv4', 'broken_tool', {})).rejects.toThrow('boom')

    __setMcpCallTimeoutForTesting(null)
  })

  it('serializes non-text content blocks instead of discarding them as an empty string', async () => {
    // Regression: a tool result made entirely of image/audio/resource blocks
    // passed the `type === 'text'` filter with zero survivors, so callTool
    // returned '' — a "successful" empty string indistinguishable from a
    // tool that truly returned nothing, with no error to explain the gap.
    ;(FakeClientCtor as any).behaviour = 'image-only'
    const mgr = new McpManager()
    seedConnectedServer(mgr, 'srv5')

    const result = await mgr.callTool('srv5', 'screenshot', {})

    expect(result).not.toBe('')
    expect(typeof result).toBe('string')
    const parsed = JSON.parse(result as string)
    expect(parsed).toEqual([{ type: 'image', data: 'ZmFrZS1wbmctYnl0ZXM=', mimeType: 'image/png' }])
  })

  it('MCPTimeoutError exposes server, tool, and threshold for logging', () => {
    const e = new MCPTimeoutError('srv', 'tool', 90_000)
    expect(e.name).toBe('MCPTimeoutError')
    expect(e.serverId).toBe('srv')
    expect(e.toolName).toBe('tool')
    expect(e.timeoutMs).toBe(90_000)
    expect(e.message).toMatch(/90s/)
  })
})

describe('mcpManager.connectServer — plugin stdio restart recovery', () => {
  // Regression: a plugin-owned stdio server lives only in pluginServers after
  // connectPluginServer's finally pops it out of this.servers. Its transport
  // restart handlers (onclose/onerror) recover a crash by calling
  // connectServer(state.config.id). Before the fix, connectServer looked up
  // ONLY this.servers, so that call silently no-op'd and the crashed plugin
  // server never came back — while a persistent stdio server restarted fine.
  it('reconnects a plugin server that lives only in pluginServers', async () => {
    const mgr = new McpManager()
    const pluginId = 'plugin-stdio-1'

    // Simulate the post-crash state the onclose handler leaves behind: the
    // server has already been marked disconnected and exists solely in the
    // plugin map (its canonical home once connectPluginServer returns).
    ;(mgr as any).pluginServers.set(pluginId, {
      config: {
        id: pluginId,
        name: pluginId,
        transport: 'stdio',
        command: 'noop',
        args: [],
        auth: 'none',
        enabled: true,
        pluginId: 'somePlugin'
      },
      status: 'disconnected',
      client: null,
      transport: null,
      tools: [],
      restartCount: 1
    })

    // This is exactly the call the transport.onclose restart handler makes.
    await (mgr as any).connectServer(pluginId)

    const state = (mgr as any).pluginServers.get(pluginId)
    expect(state.status).toBe('connected')
    expect(state.tools.length).toBeGreaterThan(0)
  })
})

describe('mcpManager stdio restart — restartScheduled scoped per transport instance', () => {
  // Regression: restartScheduled is documented ("Set once per transport instance")
  // to guard only against onerror+onclose double-firing for the SAME crash. Both
  // handlers only ever set it to true; nothing reset it back to false when a new
  // transport instance took over on reconnect. So a stdio server that crashed once
  // and auto-recovered would silently stop auto-recovering forever after — the
  // second crash's handler sees `restartScheduled` still `true` from the first
  // crash and skips the whole restart block, even though restartCount (1) is well
  // under MAX_RESTARTS (3). Only a manual reconnect (or app relaunch) could revive
  // it. This test drives two real crash+recover cycles through connectStdio's
  // actual onerror handler and fails before the fix because the second recovery
  // never happens.
  it('recovers from a second crash after the first auto-restart already succeeded', async () => {
    const mgr = new McpManager()
    const id = 'stdio-flaky'
    const state: any = {
      config: { id, name: id, transport: 'stdio', command: 'noop', args: [], auth: 'none', enabled: true },
      status: 'disconnected',
      client: null,
      transport: null,
      tools: [],
      restartCount: 0
    }
    ;(mgr as any).servers.set(id, state)

    await (mgr as any).connectServer(id)
    expect(state.status).toBe('connected')
    const transport1 = state.transport
    expect(transport1).toBeTruthy()

    // Crash #1. The handler arms restartScheduled/restartCount synchronously,
    // then reconnects asynchronously via cleanupServer().then(connectServer).
    transport1.onerror(new Error('child crashed'))
    expect(state.restartCount).toBe(1)

    await vi.waitFor(() => {
      expect(state.status).toBe('connected')
      expect(state.transport).not.toBe(transport1)
    })
    const transport2 = state.transport

    // Crash #2, on the transport instance that took over after the first
    // recovery. Per the field's own doc, restartScheduled should be scoped to
    // THIS instance — if it was never reset, this call is silently swallowed
    // and state.status sticks on 'error' forever.
    transport2.onerror(new Error('child crashed again'))

    await vi.waitFor(() => {
      expect(state.status).toBe('connected')
      expect(state.transport).not.toBe(transport2)
    })
    // restartCount resets to 0 on every successful connect regardless of this fix
    // (it counts consecutive failures, not lifetime crashes) — assert it stayed
    // healthy, and that restartScheduled was cleared for the new transport too,
    // rather than re-asserting the recovery already proven by the waitFor above.
    expect(state.restartCount).toBe(0)
    expect(state.restartScheduled).toBe(false)
    expect(state.error).toBeUndefined()
  })
})
