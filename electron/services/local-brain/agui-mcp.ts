// agui-mcp — bridge mounted MCP tools into the brain (/agui) agent loop.
//
// The richer "coder" path (electron/ipc/chat.ts) already exposes MCP tools to the
// model via the tool registry; the brain loop historically did not — it offered
// only its hardcoded native tool set, so the whole MCP ecosystem (browser control,
// external APIs, a JS REPL, Feishu, …) was unreachable from the second-brain chat.
// This module converts the manager's live tool inventory into OpenAI
// function-tool schemas the brain loop can offer, and back-maps a namespaced call
// to (serverId, toolName) for dispatch. PURE — the manager I/O stays at the seam.
//
// Naming: every MCP tool is offered as `serverId__toolName` (double-underscore),
// the same convention the coder path uses, so dispatch can split it back apart.
// MCP tools are gated as tier `mcp-external` (see agui-approval) — arbitrary
// external effect earns the same deny-first gate as native host-exec.

export interface McpToolLike {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface McpServerTools {
  serverId: string
  tools: McpToolLike[]
}

export interface OpenAiToolSchema {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** Coerce an MCP inputSchema into a valid JSON-Schema object the provider will
 *  accept as `parameters`. MCP tools SHOULD ship an object schema; when it's
 *  missing or not an object, fall back to an empty-object schema (a no-arg tool)
 *  rather than emit an invalid `parameters` that the provider would reject. */
function normalizeParameters(inputSchema: unknown): Record<string, unknown> {
  if (inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)) {
    const s = inputSchema as Record<string, unknown>
    // A JSON-Schema object node has type:'object' (or at least properties). Pass
    // it through; otherwise wrap so `parameters` is always an object schema.
    if (s.type === 'object' || s.properties) return s
  }
  return { type: 'object', properties: {} }
}

/**
 * Build OpenAI function-tool schemas for every mounted MCP tool. Names are
 * namespaced `serverId__toolName`. Skips servers/tools with an unusable name so
 * one malformed entry can't break the whole tool list. PURE.
 */
export function buildMcpToolSchemas(servers: McpServerTools[] | undefined | null): OpenAiToolSchema[] {
  if (!Array.isArray(servers)) return []
  const out: OpenAiToolSchema[] = []
  for (const s of servers) {
    if (!s || typeof s.serverId !== 'string' || !s.serverId || !Array.isArray(s.tools)) continue
    for (const t of s.tools) {
      if (!t || typeof t.name !== 'string' || !t.name) continue
      out.push({
        type: 'function',
        function: {
          name: `${s.serverId}__${t.name}`,
          description: typeof t.description === 'string' ? t.description : '',
          parameters: normalizeParameters(t.inputSchema)
        }
      })
    }
  }
  return out
}

/** Split a namespaced MCP tool name back into (serverId, toolName). Returns null
 *  for a non-namespaced name. The toolName keeps any further `__` intact. PURE. */
export function splitMcpToolName(name: unknown): { serverId: string; toolName: string } | null {
  if (typeof name !== 'string' || !name.includes('__')) return null
  const [serverId, ...rest] = name.split('__')
  const toolName = rest.join('__')
  if (!serverId || !toolName) return null
  return { serverId, toolName }
}
