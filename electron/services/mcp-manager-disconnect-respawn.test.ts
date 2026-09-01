import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Every transport the manager builds, in construction order. Transport identity
// is how the test tells "reaped" from "respawned": a stdio transport IS a child
// process, so a second one means a second child.
const hoisted = vi.hoisted(() => ({
  userData: '',
  transports: [] as { closed: boolean; onclose?: () => void; opts: { command: string } }[]
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

// Faithful to @modelcontextprotocol/sdk 1.29.0's StdioClientTransport: close()
// ends the child's stdin and awaits the child's 'close' event, and it is that
// event handler which calls onclose(). So onclose fires *while close() is still
// being awaited* — before any code after `await transport.close()` can run. A
// fake whose close() never fires onclose would make this whole class of bug
// untestable, which is roughly how it survived.
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
      await Promise.resolve()
      this.onclose?.()
    }
  }
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class FakeClient {
    async connect(_transport: unknown) {}
    async listTools() {
      return { tools: [{ name: 'js', description: 'eval', inputSchema: {} }] }
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
  hoisted.userData = mkdtempSync(join(tmpdir(), 'duin-mcp-userdata-'))
})

afterAll(() => {
  try {
    rmSync(hoisted.userData, { recursive: true, force: true })
  } catch {
    // best-effort temp cleanup
  }
})

afterEach(() => {
  hoisted.transports = []
})

/** Fresh manager with exactly one connected stdio server, and an empty
 *  mcp-servers.json so the bundled `chrome` default is not seeded on top. */
async function connectedManager(command = 'node-repl'): Promise<{ mgr: McpManager; id: string }> {
  writeFileSync(join(hoisted.userData, 'mcp-servers.json'), '[]')
  const mgr = new McpManager()
  const id = 'node-repl'
  await mgr.addServerIfMissing({
    id,
    name: 'Node REPL',
    transport: 'stdio',
    command,
    args: ['server.js'],
    auth: 'none',
    enabled: true
  })
  await vi.waitFor(() => {
    expect((mgr as never as { servers: Map<string, { status: string }> }).servers.get(id)!.status).toBe('connected')
  })
  return { mgr, id }
}

/** Let any (unwanted) auto-restart finish spawning before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 25))

function stateOf(mgr: McpManager, id: string) {
  return (mgr as never as { servers: Map<string, { status: string; transport: unknown }> }).servers.get(id)
}

// Regression: disconnect() closed the transport and only THEN set
// status = 'disconnected'. The close fires the stdio transport's own onclose,
// whose auto-restart branch is gated on `status === 'connected'` — still true at
// that instant — so tearing a connector down spawned a replacement child.
describe('McpManager — intentional teardown must not trigger the stdio auto-restart', () => {
  it('does not respawn the child when a connector is toggled off', async () => {
    const { mgr, id } = await connectedManager()
    expect(hoisted.transports).toHaveLength(1)

    // Settings -> Connectors -> toggle off. Persists enabled:false, then disconnects.
    await mgr.setServerEnabled(id, false)
    await settle()

    // A second transport here is a second child process for a connector the user
    // just switched off — one that also reports itself back as 'connected'.
    expect(hoisted.transports).toHaveLength(1)
    expect(hoisted.transports[0].closed).toBe(true)
    expect(stateOf(mgr, id)!.status).toBe('disconnected')
    expect(stateOf(mgr, id)!.transport).toBeNull()
    expect(mgr.getAllTools().some((t) => t.serverId === id)).toBe(false)
  })

  it('leaves nothing running after a connector is removed', async () => {
    const { mgr, id } = await connectedManager()

    // removeServer awaits disconnect() and then drops the map entry — so a child
    // spawned during that disconnect is reachable from neither this.servers nor
    // this.pluginServers, and shutdown() cannot close it. It outlives the app.
    expect(await mgr.removeServer(id)).toBe(true)
    await settle()
    await mgr.shutdown()

    expect(hoisted.transports).toHaveLength(1)
    for (const t of hoisted.transports) expect(t.closed).toBe(true)
  })

  it('reconnect swaps to exactly one new child, not two racing ones', async () => {
    const { mgr, id } = await connectedManager()

    await mgr.reconnect(id)
    await settle()

    // Pre-fix: three transports — the original, the auto-restart triggered by
    // closing it, and reconnect's own — with the two connects racing to write
    // state.transport, so whichever lost is left running and unreferenced.
    expect(hoisted.transports).toHaveLength(2)
    expect(hoisted.transports[0].closed).toBe(true)
    expect(hoisted.transports[1].closed).toBe(false)
    expect(stateOf(mgr, id)!.transport).toBe(hoisted.transports[1])
    expect(stateOf(mgr, id)!.status).toBe('connected')
  })

  it('refreshing a managed default swaps to exactly one new child', async () => {
    const { mgr, id } = await connectedManager('stale-electron-path')

    // Boot-time self-heal: process.execPath moved, so the bundled default's
    // command is rewritten and the stale connection is dropped and remade.
    expect(
      await mgr.upsertManagedDefault({
        id,
        name: 'Node REPL',
        transport: 'stdio',
        command: 'fresh-electron-path',
        args: ['server.js'],
        auth: 'none',
        enabled: true
      })
    ).toBe('updated')
    await vi.waitFor(() => {
      expect(stateOf(mgr, id)!.status).toBe('connected')
    })
    await settle()

    expect(hoisted.transports).toHaveLength(2)
    expect(hoisted.transports[0].closed).toBe(true)
    expect(hoisted.transports[1].opts.command).toBe('fresh-electron-path')
    expect(stateOf(mgr, id)!.transport).toBe(hoisted.transports[1])
  })
})
