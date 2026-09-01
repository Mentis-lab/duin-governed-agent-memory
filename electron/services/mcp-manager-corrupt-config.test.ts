// Regression guard for the mcp-servers.json corrupt-read amplifier.
//
// saveConfigs() used to be a bare writeFileSync — no temp file, no rename, no fsync. If
// Electron is killed mid-write (crash, OOM kill, Task Manager force-quit, power loss — all
// realistic on an end-user desktop app), the file is left truncated or otherwise invalid JSON.
// loadConfigs()'s only handling for that was a catch block that unconditionally overwrote the
// file with the single bundled 'chrome' default, permanently discarding every custom MCP server
// (URLs, stdio commands/args, headers, OAuth scopes, enabled flags) the user had configured —
// with no backup and no user-facing warning.
//
// This mirrors settings-file-corrupt.test.ts's shape for the exact same hazard class in
// settings.json: 'absent' (nothing to lose) and 'corrupt' (something to lose) must not collapse
// into the same blind-overwrite behaviour.
//
// Runs against a REAL temp directory (no electron, no sqlite) so it genuinely executes rather
// than silently skipping. Unlike mcp-manager.test.ts's fixed nonexistent userData path (which
// works there only because that suite never calls loadConfigs/saveConfigs), this test needs a
// directory it can actually read from and write to.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const userDataDir = mkdtempSync(join(tmpdir(), 'lamprey-mcp-config-'))

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

// mcp-manager statically imports plugin-loader; mock it so its electron / @electron-toolkit
// imports stay out of this test graph (same mock as mcp-manager.test.ts).
vi.mock('./plugin-loader', () => ({
  enabledPluginRoots: () => [],
  subscribeToPluginChanges: () => () => {},
  getPluginsRoot: () => '/tmp/duin-test-plugins'
}))

// Stub the SDK transports/client so importing the manager doesn't try to open a stdio child /
// SSE socket. This suite never exercises connectServer, so the stubs just need to exist.
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {}
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {}
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {}
    async listTools() {
      return { tools: [] }
    }
  }
}))
vi.mock('./keychain', () => ({
  getKey: () => null,
  hasKey: () => false,
  setKey: () => undefined
}))

import { loadConfigs, saveConfigs } from './mcp-manager'

const CONFIG_PATH = join(userDataDir, 'mcp-servers.json')

// A realistic torn-write residue: the writer died partway through, leaving a valid JSON PREFIX
// that still physically contains the user's hand-configured custom server — a remote connector
// with a bearer token, the kind of thing that cannot be reconstructed from memory.
const TORN =
  '[\n  {\n    "id": "chrome",\n    "name": "Chrome (Playwright)",\n    "transport": "stdio",\n' +
  '    "command": "npx",\n    "args": ["-y", "@playwright/mcp"],\n    "auth": "none",\n    "enabled": true\n  },\n' +
  '  {\n    "id": "linear",\n    "name": "Linear",\n    "transport": "http",\n' +
  '    "url": "https://mcp.linear.app/sse",\n    "headers": {"Authorization": "Bearer sk-l'

function sidecars(): string[] {
  return readdirSync(userDataDir).filter((f) => f.includes('.corrupt-'))
}

function clean(): void {
  for (const f of readdirSync(userDataDir)) rmSync(join(userDataDir, f), { force: true, recursive: true })
}

beforeEach(() => {
  clean()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('loadConfigs — a torn/unparseable mcp-servers.json is preserved, not silently destroyed', () => {
  it('quarantines the corrupt file to a side-car before falling back to defaults', () => {
    writeFileSync(CONFIG_PATH, TORN, 'utf-8')

    const result = loadConfigs()

    // The app still boots usable — defaults are returned (seeded DISABLED, release B11)...
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'chrome', enabled: false })

    // ...but the original bytes were NOT destroyed. This assertion fails without the fix:
    // before it, loadConfigs's catch branch unconditionally wrote only the bundled default,
    // discarding the user's 'linear' server (URL, bearer token, everything) with no trace left
    // anywhere on disk.
    const found = sidecars()
    expect(found).toHaveLength(1)
    const preserved = readFileSync(join(userDataDir, found[0]), 'utf-8')
    expect(preserved).toBe(TORN)
    expect(preserved).toContain('linear')
    expect(preserved).toContain('sk-l')

    // And the loss is surfaced loudly, not just a console.error several lines away in a caller.
    expect(console.error).toHaveBeenCalled()
    const logged = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]
    expect(logged).toContain('unparseable')
    expect(logged).toContain(found[0])
  })

  it('does not side-car when the file is merely absent (fresh install, nothing to lose)', () => {
    expect(existsSync(CONFIG_PATH)).toBe(false)

    const result = loadConfigs()

    expect(result[0].id).toBe('chrome')
    expect(sidecars()).toHaveLength(0)
    expect(existsSync(CONFIG_PATH)).toBe(true)
  })

  it('does not side-car a healthy config on a normal load', () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify([
        { id: 'custom', name: 'Custom', transport: 'http', url: 'https://example.com', auth: 'none', enabled: true }
      ]),
      'utf-8'
    )

    const result = loadConfigs()

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('custom')
    expect(sidecars()).toHaveLength(0)
    expect(console.error).not.toHaveBeenCalled()
  })

  it('repeated corrupt loads do not clobber an earlier side-car', () => {
    writeFileSync(CONFIG_PATH, TORN, 'utf-8')
    loadConfigs()
    writeFileSync(CONFIG_PATH, '{"second": tru', 'utf-8')
    loadConfigs()

    const found = sidecars()
    expect(found).toHaveLength(2)
    const bodies = found.map((f) => readFileSync(join(userDataDir, f), 'utf-8')).sort()
    expect(bodies).toEqual([TORN, '{"second": tru'].sort())
  })
})

// A payload that is perfectly valid JSON but the wrong shape (an object instead of an array) is
// a DIFFERENT hazard than the torn-write suite above: JSON.parse never throws, so nothing short
// of an explicit Array.isArray check ever notices. loadConfigs used to `return parsed` verbatim
// in that branch — the `as McpServerConfig[]` cast satisfied the compiler while the runtime
// value was an object. The crash didn't happen here at all: it happened one call away, in
// McpManager.initialize()'s `for (const config of configs)`, which throws "is not iterable" on
// a load that reported no error. Because initialize() is a one-shot (guarded by
// `this.initialized`, set before that loop runs) and its only caller in main.ts just
// console.error-logs a rejection, that crash was never surfaced as a config problem and never
// retried — every MCP connector silently disappeared for the rest of the session.
describe('loadConfigs — a syntactically valid but non-array mcp-servers.json is not returned verbatim', () => {
  it('quarantines a non-array payload and falls back to defaults, same as a torn write', () => {
    // Realistic hand-edit mistake: pasted a single server object without the wrapping `[...]`.
    const NON_ARRAY =
      '{"id": "linear", "name": "Linear", "transport": "http", "url": "https://mcp.linear.app/sse", ' +
      '"auth": "none", "enabled": true}'
    writeFileSync(CONFIG_PATH, NON_ARRAY, 'utf-8')

    const result = loadConfigs()

    // The app still boots usable — a real array of defaults, not the raw object handed back.
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'chrome', enabled: false })

    // The original bytes were preserved for hand-recovery, not silently discarded.
    const found = sidecars()
    expect(found).toHaveLength(1)
    expect(readFileSync(join(userDataDir, found[0]), 'utf-8')).toBe(NON_ARRAY)

    expect(console.error).toHaveBeenCalled()
  })

  it('quarantines a top-level JSON null the same way', () => {
    // JSON.parse("null") succeeds with value `null` — Array.isArray(null) is false, and a bare
    // `for...of null` throws just as it does for an object, so this must not slip through either.
    writeFileSync(CONFIG_PATH, 'null', 'utf-8')

    const result = loadConfigs()

    expect(Array.isArray(result)).toBe(true)
    expect(result[0]).toMatchObject({ id: 'chrome', enabled: false })
    expect(sidecars()).toHaveLength(1)
  })
})

describe('saveConfigs — crash-safe write (atomic-write.ts names the MCP config by name)', () => {
  it('writes through a temp file + rename, leaving no partial artifact behind', () => {
    saveConfigs([
      { id: 'a', name: 'A', transport: 'http', url: 'https://example.com', auth: 'none', enabled: true }
    ])

    expect(readdirSync(userDataDir).filter((f) => f.startsWith('.atomic-'))).toHaveLength(0)
    expect(JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))).toHaveLength(1)
  })
})
