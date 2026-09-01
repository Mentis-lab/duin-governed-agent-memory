// node-repl seeded DISABLED — release M11 (A4 F3 / A6 F2).
//
// The bundled Node REPL server evaluates arbitrary JS in a `vm` context with `fetch` available
// (resources/mcp/node-repl/server.js), and every mounted MCP tool is offered to the model on
// every turn. A fresh install must register the row (so the operator can enable it in Settings →
// Connections) but must not ship it armed. ensureDefaultMcpServers preserves the user's `enabled`
// on existing installs, so an install that already turned it on keeps it on — that half is pinned
// here through the manager seam it calls.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-mcp-defaults-seed-test' }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.mock('./capability-requires', () => ({
  probeRequirements: () => ({ satisfied: false, missing: [] })
}))

const upserts: Array<{ id: string; enabled: boolean }> = []
vi.mock('./mcp-manager', () => ({
  mcpManager: {
    upsertManagedDefault: async (cfg: { id: string; enabled: boolean }) => {
      upserts.push({ id: cfg.id, enabled: cfg.enabled })
      return 'added'
    }
  }
}))

import { getDefaultMcpServers, ensureDefaultMcpServers } from './mcp-defaults'

beforeEach(() => {
  upserts.length = 0
})

describe('getDefaultMcpServers — node-repl', () => {
  it('registers the bundled node-repl row DISABLED', () => {
    const rows = getDefaultMcpServers()
    const repl = rows.find((r) => r.id === 'node-repl')
    // The dev-tree server.js is resolved from the repo (mcp-defaults.test.ts pins that it ships).
    expect(repl, 'node-repl row must still be registered so the operator can enable it').toBeDefined()
    expect(repl!.enabled).toBe(false)
    expect(repl!.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('never seeds any bundled server enabled on a fresh install', () => {
    // Feishu is probe-gated (lark-cli absent here → disabled); node-repl is disabled by policy.
    for (const r of getDefaultMcpServers()) {
      expect(r.enabled, `${r.id} must not be seeded enabled`).toBe(false)
    }
  })

  it('hands the disabled row to the manager (whose upsert preserves an existing enabled flag)', async () => {
    await ensureDefaultMcpServers()
    const repl = upserts.find((u) => u.id === 'node-repl')
    expect(repl).toEqual({ id: 'node-repl', enabled: false })
  })
})
