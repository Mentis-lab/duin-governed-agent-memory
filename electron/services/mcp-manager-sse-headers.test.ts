import { describe, it, expect, beforeEach, vi } from 'vitest'

// Regression: McpServerConfig.headers is documented for "http/sse" servers and
// electron/ipc/mcp.ts accepts it identically for both transports, but connectSSE
// built its transport with no options — so a JSON-pasted SSE connector carrying
// `{"headers":{"Authorization":"Bearer sk-…"}}` persisted the header, rendered as
// configured, and then handshook with no Authorization at all. Against a server
// that treats a missing header as "public" this fails OPEN: connect succeeds and
// every tool call runs unauthenticated. connectHttp already applied the field,
// which is what made the gap invisible.

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/lamprey-test-userdata-nonexistent' },
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

// Capture the options connectSSE hands the SDK transport. This is the seam the
// defect lived at: the constructor was called with `undefined` here.
type SseOpts = { requestInit?: RequestInit; eventSourceInit?: unknown } | undefined
const sseCtorCalls: { url: string; opts: SseOpts }[] = []

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class FakeSSE {
    onerror?: (e: Error) => void
    onclose?: () => void
    constructor(url: URL, opts?: SseOpts) {
      sseCtorCalls.push({ url: url.href, opts })
    }
  }
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {}
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class FakeClient {
    async connect(_transport: unknown) {}
    async listTools() {
      return { tools: [{ name: 'ping', description: 'p', inputSchema: {} }] }
    }
  }
}))

// google-access-token present, no expiry entry => no refresh path.
vi.mock('./keychain', () => ({
  getKey: (k: string) => (k === 'google-access-token' ? 'goog-tok' : null),
  hasKey: () => false,
  setKey: () => undefined
}))

import { McpManager, type McpServerConfig } from './mcp-manager'

function headersOf(call: { opts: SseOpts }): Record<string, string> | undefined {
  return call.opts?.requestInit?.headers as Record<string, string> | undefined
}

async function connectSse(config: Partial<McpServerConfig>): Promise<(typeof sseCtorCalls)[number]> {
  const mgr = new McpManager()
  const id = config.id ?? 'remote-sse'
  ;(mgr as any).servers.set(id, {
    config: {
      id,
      name: id,
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
      auth: 'none',
      enabled: true,
      ...config
    },
    status: 'disconnected',
    client: null,
    transport: null,
    tools: [],
    restartCount: 0
  })
  await (mgr as any).connectServer(id)
  const state = (mgr as any).servers.get(id)
  // Guard against a silent pass: if the connect never completed, the ctor
  // assertions below would be checking a call that no real flow produced.
  expect(state.status).toBe('connected')
  return sseCtorCalls[sseCtorCalls.length - 1]
}

beforeEach(() => {
  sseCtorCalls.length = 0
})

describe('mcpManager.connectSSE — configured static headers reach the wire', () => {
  it('forwards config.headers on a plain (auth: none) SSE connector', async () => {
    const call = await connectSse({
      id: 'sse-token-authed',
      auth: 'none',
      headers: { Authorization: 'Bearer sk-test-123', 'X-Tenant': 'acme' }
    })

    expect(headersOf(call)).toEqual({
      Authorization: 'Bearer sk-test-123',
      'X-Tenant': 'acme'
    })
  })

  it('leaves requestInit unset when no headers are configured', async () => {
    const call = await connectSse({ id: 'sse-plain', auth: 'none' })

    expect(call.opts?.requestInit).toBeUndefined()
  })

  it('merges config.headers with the Google bearer on a google-oauth SSE connector', async () => {
    const call = await connectSse({
      id: 'sse-google',
      auth: 'google-oauth',
      headers: { 'X-Tenant': 'acme' }
    })

    const headers = headersOf(call)
    // The bearer still wins on Authorization; the other configured headers survive.
    expect(headers).toEqual({
      'X-Tenant': 'acme',
      Authorization: 'Bearer goog-tok'
    })
  })

  it('lets the google bearer override a configured Authorization header', async () => {
    const call = await connectSse({
      id: 'sse-google-conflict',
      auth: 'google-oauth',
      headers: { Authorization: 'Bearer stale-static' }
    })

    expect(headersOf(call)?.Authorization).toBe('Bearer goog-tok')
  })
})
