// brain-mcp-server — a Model Context Protocol server exposing the local DUIN brain (read +
// safe-write) to any MCP client (Claude Desktop, Cursor, …). Evidence Threshold · C2.
//
// Run:  DUIN_BRAIN_URL=http://127.0.0.1:8799 npx tsx electron/services/mcp-brain/brain-mcp-server.ts
// Client config (Claude Desktop mcpServers):
//   { "duin-brain": { "command": "npx", "args": ["tsx",
//       "<repo>/electron/services/mcp-brain/brain-mcp-server.ts"] } }
//
// It forwards allow-listed tool calls to the brain at DUIN_BRAIN_URL (default 127.0.0.1:8799),
// which enforces the B1 loopback control-plane guard on writes. The tool catalog + guards are
// in brain-mcp-tools.ts (pure, unit-tested). stdout is the MCP transport — logs go to stderr.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { BRAIN_TOOLS, buildBrainRequest } from './brain-mcp-tools'
import { wrapEpistemic } from './mcp-epistemic-envelope'

const server = new Server({ name: 'duin-brain', version: '0.1.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: BRAIN_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    const r = buildBrainRequest(name, args, process.env.DUIN_BRAIN_URL)
    const res = await fetch(r.url, {
      method: r.method,
      headers: r.body ? { 'content-type': 'application/json' } : undefined,
      body: r.body
    })
    const text = await res.text()
    // CannotProve honesty contract: a successful-but-EMPTY read is labeled 'cannot-prove' so a
    // downstream agent can't misread DUIN's silence as permission. HTTP errors keep their shape.
    return {
      content: [{ type: 'text', text: res.ok ? wrapEpistemic(text) : `HTTP ${res.status}: ${text}` }],
      isError: !res.ok
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `error: ${(err as Error).message}` }], isError: true }
  }
})

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport())
  process.stderr.write('[duin-brain-mcp] ready\n')
}

main().catch((e) => {
  process.stderr.write(`[duin-brain-mcp] fatal: ${(e as Error)?.message ?? e}\n`)
  process.exit(1)
})
