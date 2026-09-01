import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { mcpManager, type McpServerConfig } from './mcp-manager'
import { probeRequirements, type Requirement } from './capability-requires'

// Bundles a Node REPL MCP server inside the app. This module owns two
// responsibilities:
//
//   1. Path resolution — dev runs out of the project tree, production runs
//      out of `process.resourcesPath`. Mirrors the dev/prod split that
//      skill-loader uses for bundled skills.
//
//   2. Idempotent registration — if the user's mcp-servers.json doesn't
//      already list `node-repl`, append it. We never overwrite an existing
//      entry, so the user can disable or edit the default without us
//      stomping on their changes.

const NODE_REPL_SERVER_ID = 'node-repl'
const FEISHU_SERVER_ID = 'feishu'

/** Resolve a bundled MCP server's server.js (dev tree vs packaged resources). */
function resolveBundledMcpServer(id: string): string | null {
  const candidates: string[] = []
  if (is.dev) {
    candidates.push(join(__dirname, '..', '..', 'resources', 'mcp', id, 'server.js'))
    candidates.push(join(process.cwd(), 'resources', 'mcp', id, 'server.js'))
  } else {
    // app.asar.unpacked FIRST: an ESM server resolves bare imports (e.g.
    // @modelcontextprotocol/sdk) by walking parent node_modules from its OWN
    // file path — NODE_PATH is ignored — and only under app.asar.unpacked is
    // the app's unpacked node_modules an ancestor. From resources/mcp the
    // import can never resolve (estate finding ⑤: node-repl had never
    // connected in a packaged install). resources/mcp stays as the fallback
    // for dependency-free servers and older installs.
    candidates.push(join(process.resourcesPath, 'app.asar.unpacked', 'mcp', id, 'server.js'))
    candidates.push(join(process.resourcesPath, 'mcp', id, 'server.js'))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Resolve the absolute path to the bundled node-repl `server.js`. In dev,
 * the compiled main entry sits at `out/main/index.js`, so the project root
 * is two levels up. In production, electron-builder's `extraResources`
 * step copies the directory to `${resourcesPath}/mcp/node-repl/`.
 *
 * Returns `null` if the file cannot be found, so the caller can decline to
 * register the server rather than seeding a broken config.
 */
export function getNodeReplServerPath(): string | null {
  const candidates: string[] = []
  if (is.dev) {
    // electron-vite emits the main process bundle to `out/main/index.js`.
    // From there the project root is two directories up.
    candidates.push(join(__dirname, '..', '..', 'resources', 'mcp', 'node-repl', 'server.js'))
    // Fallback for unusual local layouts (e.g. running compiled output from
    // a different cwd) — try the cwd-relative resources path too.
    candidates.push(join(process.cwd(), 'resources', 'mcp', 'node-repl', 'server.js'))
  } else {
    // MUST prefer app.asar.unpacked: server.js is ESM and imports
    // @modelcontextprotocol/sdk, which only resolves where the app's unpacked
    // node_modules is a parent of the server file (see resolveBundledMcpServer
    // for the full story — estate finding ⑤). The bare resources/mcp path is
    // kept only so an old install that predates the unpacked copy still finds
    // A file (it will fail to import, exactly as it always did there).
    candidates.push(
      join(process.resourcesPath, 'app.asar.unpacked', 'mcp', 'node-repl', 'server.js')
    )
    candidates.push(join(process.resourcesPath, 'mcp', 'node-repl', 'server.js'))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Build the default MCP server configs that should be present on every
 * install. Returns an empty list if the bundled assets aren't on disk so
 * callers can no-op gracefully.
 *
 * The node-repl server runs via Electron's own binary with the
 * `ELECTRON_RUN_AS_NODE=1` escape hatch — that's the documented way to
 * reuse the bundled Node runtime on end-user machines that don't have a
 * system Node installed.
 */
export function getDefaultMcpServers(): McpServerConfig[] {
  const configs: McpServerConfig[] = []
  const serverPath = getNodeReplServerPath()
  if (serverPath) {
    // SEEDED DISABLED (release M11): node-repl evaluates arbitrary JS in a `vm` context with
    // `fetch` available (resources/mcp/node-repl/server.js), and every mounted MCP tool is
    // offered to the model on every turn. A fresh install must not ship that armed. The row
    // is still registered so the operator can enable it in Settings → Connections — and
    // ensureDefaultMcpServers preserves `enabled` on existing installs, so an install that
    // already has it on (the owner's) keeps it on.
    configs.push({
      id: NODE_REPL_SERVER_ID,
      name: 'Node REPL',
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      auth: 'none',
      enabled: false
    })
  }
  // Feishu / Lark reach: wraps the operator's lark-cli (reuses its auth), so the
  // agent can read chats, messages, calendar + the full OpenAPI.
  //
  // This connector is where the `requires` mechanism came from. It used to call a
  // local `larkCliAvailable()` — ten lines checking three directories for one
  // binary — purely so the server would seed DISABLED rather than broken when
  // lark-cli was absent. The check now DECLARES the dependency instead of hiding
  // it, which buys three things the private helper could not: the connect path
  // refuses to spawn and reports `unavailable` (not `error`) when it goes missing
  // LATER, the UI can say what is missing and how to get it, and the same sentence
  // is available to every other connector without being rewritten.
  //
  // `enabled` still reflects presence at seed time, so a machine without lark-cli
  // does not light up a connector it cannot run — but the requirement is what
  // actually enforces it from here on.
  const feishuPath = resolveBundledMcpServer(FEISHU_SERVER_ID)
  if (feishuPath) {
    const larkCli: Requirement = {
      kind: 'binary',
      name: 'lark-cli',
      hint: 'Install the Lark CLI (npm i -g @larksuiteoapi/lark-cli) and sign in, then reconnect.'
    }
    configs.push({
      id: FEISHU_SERVER_ID,
      name: 'Feishu / Lark',
      transport: 'stdio',
      command: process.execPath,
      args: [feishuPath],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      auth: 'none',
      enabled: probeRequirements([larkCli]).satisfied,
      requires: [larkCli]
    })
  }
  return configs
}

/**
 * Idempotently ensure each default server is registered with the running
 * mcp-manager. Safe to call multiple times; existing entries are left
 * untouched so user edits (disable, custom args, etc.) win.
 *
 * Must be invoked AFTER `mcpManager.initialize()` so the in-memory list and
 * the on-disk config file have been loaded. Returns the ids that were
 * newly added (empty array if everything was already present).
 */
export async function ensureDefaultMcpServers(): Promise<string[]> {
  const defaults = getDefaultMcpServers()
  if (defaults.length === 0) {
    console.warn('[mcp-defaults] No bundled servers found on disk; skipping registration.')
    return []
  }

  // Self-heal: managed fields (`command`, `args`, `env`) are refreshed when
  // stale so a packaged build doesn't keep pointing at a dev path or a
  // process.execPath from a previous Electron version. The user's `enabled`
  // flag is preserved — disabling the default sticks.
  const touched: string[] = []
  for (const config of defaults) {
    try {
      const outcome = await mcpManager.upsertManagedDefault(config)
      if (outcome !== 'unchanged') touched.push(`${config.id}:${outcome}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[mcp-defaults] Failed to register default server '${config.id}':`, message)
    }
  }

  if (touched.length > 0) {
    console.log(`[mcp-defaults] Default MCP servers: ${touched.join(', ')}`)
  }

  return touched
}
