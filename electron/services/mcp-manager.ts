import { app, BrowserWindow } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { McpOAuthProvider } from './mcp-oauth'
import { readFileSync, existsSync, renameSync } from 'fs'
import { join, dirname, basename } from 'path'
import { atomicWriteFileSync } from './atomic-write'
// Static import (no circular dep). Replaces a lazy `require('./plugin-loader')`
// that broke under the single-file main bundle ("Cannot find module").
import { enabledPluginRoots, subscribeToPluginChanges } from './plugin-loader'
import { randomUUID } from 'crypto'
import * as keychain from './keychain'
import { refreshGoogleToken as refreshGoogleTokenShared } from './google-auth'
import { trace } from './debug-trace'
import { friendly, messageOf } from './guarded'
import {
  coerceRequirements,
  describeMissing,
  effectiveRequirements,
  probeRequirements,
  type Requirement,
  type RequirementResult
} from './capability-requires'

// T2 — Per-call MCP timeout. The SDK has built-in `RequestOptions.timeout`
// support (it throws McpError with code RequestTimeout on expiry). We pass
// it on every callTool so a hung remote server (Ahrefs slow query, browser
// MCP waiting on a dead tab, stalled stdio child) can never block the chat
// turn indefinitely. The threshold is read from settings.json each call so
// the user can tune it without a restart.
export class MCPTimeoutError extends Error {
  constructor(public readonly serverId: string, public readonly toolName: string, public readonly timeoutMs: number) {
    super(
      `MCP tool '${serverId}__${toolName}' did not respond within ${Math.round(timeoutMs / 1000)}s — the server is likely stalled or the operation is too slow.`
    )
    this.name = 'MCPTimeoutError'
  }
}

// MR — MCP Resources. A server that does not advertise `resources` in its
// capabilities cannot serve list/read; surfacing a distinct error lets the UI
// hide the Resources affordance rather than spamming failed requests.
export class McpResourceCapabilityError extends Error {
  constructor(public readonly serverId: string) {
    super(`MCP server '${serverId}' does not advertise resource support`)
    this.name = 'McpResourceCapabilityError'
  }
}

// MR — a resource response (URI, page, or content blob) breached a hard byte /
// item limit. Bounds are enforced before anything reaches the model or UI so a
// hostile or buggy server cannot flood the context window or renderer.
export class McpResourceBoundsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpResourceBoundsError'
  }
}

const DEFAULT_MCP_CALL_TIMEOUT_MS = 120_000
const MIN_MCP_CALL_TIMEOUT_MS = 5_000

let mcpCallTimeoutOverrideMs: number | null = null
export function __setMcpCallTimeoutForTesting(ms: number | null): void {
  mcpCallTimeoutOverrideMs = ms
}

function readMcpCallTimeoutMs(): number {
  if (mcpCallTimeoutOverrideMs !== null) return mcpCallTimeoutOverrideMs
  try {
    const path = join(app.getPath('userData'), 'settings.json')
    if (!existsSync(path)) return DEFAULT_MCP_CALL_TIMEOUT_MS
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { mcpCallTimeoutMs?: unknown }
    const ms = raw.mcpCallTimeoutMs
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_MCP_CALL_TIMEOUT_MS
    if (ms <= 0) return 0 // 0 disables the per-call cap (SDK default still applies)
    return Math.max(MIN_MCP_CALL_TIMEOUT_MS, ms)
  } catch {
    return DEFAULT_MCP_CALL_TIMEOUT_MS
  }
}

export interface McpToolAnnotations {
  title?: string
  /** The tool does not modify its environment (safe to auto-run). */
  readOnlyHint?: boolean
  /** The tool may perform destructive updates (only meaningful when not read-only). */
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: unknown
  /** MCP spec tool annotations — hints used to risk-classify + gate the tool. */
  annotations?: McpToolAnnotations
}

// MR — MCP Resources surface. Concrete resources, URI templates, and the
// content blobs a read returns, plus the server's advertised capability shape.
export interface McpResource {
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  size?: number
  annotations?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

export interface McpResourceTemplate {
  uriTemplate: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  annotations?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

export type McpResourceContent =
  | { uri: string; mimeType?: string; text: string; _meta?: Record<string, unknown> }
  | { uri: string; mimeType?: string; blob: string; _meta?: Record<string, unknown> }

export interface McpResourcePage<T> {
  items: T[]
  nextCursor?: string
}

export interface McpResourceCapabilities {
  supported: boolean
  subscribe: boolean
  listChanged: boolean
}

// Hard ceilings applied to every resource response. Frozen so a stray
// assignment cannot loosen a limit at runtime.
export const MCP_RESOURCE_LIMITS = Object.freeze({
  maxUriBytes: 8_192,
  maxCursorBytes: 4_096,
  maxPageItems: 500,
  maxPageBytes: 512 * 1024,
  maxContentItems: 32,
  maxContentBytes: 4 * 1024 * 1024
})

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function validateResourceUri(uri: string): string {
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new TypeError('MCP resource URI must be a non-empty string')
  }
  if (Buffer.byteLength(uri, 'utf8') > MCP_RESOURCE_LIMITS.maxUriBytes) {
    throw new McpResourceBoundsError('MCP resource URI exceeds the 8192-byte limit')
  }
  if (uri.trim() !== uri || hasControlCharacters(uri)) {
    throw new TypeError('MCP resource URI contains whitespace or control characters')
  }
  try {
    // eslint-disable-next-line no-new
    new URL(uri)
  } catch {
    throw new TypeError(`Invalid MCP resource URI: ${uri}`)
  }
  return uri
}

function validateCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined
  if (!cursor || Buffer.byteLength(cursor, 'utf8') > MCP_RESOURCE_LIMITS.maxCursorBytes) {
    throw new McpResourceBoundsError('MCP cursor must be 1 to 4096 bytes')
  }
  if (hasControlCharacters(cursor)) {
    throw new TypeError('MCP cursor contains control characters')
  }
  return cursor
}

function assertBoundedPage(kind: string, items: unknown[]): void {
  if (items.length > MCP_RESOURCE_LIMITS.maxPageItems) {
    throw new McpResourceBoundsError(
      `MCP ${kind} page returned ${items.length} items; limit is ${MCP_RESOURCE_LIMITS.maxPageItems}`
    )
  }
  const bytes = Buffer.byteLength(JSON.stringify(items), 'utf8')
  if (bytes > MCP_RESOURCE_LIMITS.maxPageBytes) {
    throw new McpResourceBoundsError(
      `MCP ${kind} page returned ${bytes} bytes; limit is ${MCP_RESOURCE_LIMITS.maxPageBytes}`
    )
  }
}

export interface McpServerConfig {
  id: string
  name: string
  // 'http' = Streamable HTTP, the current spec transport that supersedes SSE.
  transport: 'sse' | 'stdio' | 'http'
  url?: string
  /** Optional static request headers (e.g. { Authorization: 'Bearer …' }) for
   *  http/sse token-authed remote servers. */
  headers?: Record<string, string>
  command?: string
  args?: string[]
  // Optional extra env vars merged on top of `process.env` when launching a
  // stdio server. Used by the bundled Node REPL default server to set
  // ELECTRON_RUN_AS_NODE=1; ignored for SSE transports.
  env?: Record<string, string>
  // 'oauth' = generic OAuth 2.1 (MCP authorization spec) for remote http/sse
  // servers that require their own login (Linear/Notion/etc.), via mcp-oauth.ts.
  auth: 'google-oauth' | 'oauth' | 'none'
  /** OAuth scope string for auth: 'oauth' servers (optional). */
  scope?: string
  enabled: boolean
  /** Customize C11: when registered transiently by the plugin runtime,
   *  the owning plugin id. Plugin-owned servers are NEVER persisted to
   *  mcp-servers.json; they're rebuilt from the plugin's connectors.json
   *  every boot + on every plugin enable/disable. */
  pluginId?: string
  /** What this connector needs on the machine before it can run — a binary on
   *  PATH, a file, an env var. Probed BEFORE spawn; see the 'unavailable'
   *  status. Omitted means no requirements, which is the common case. */
  requires?: Requirement[]
}

// 'unavailable' is NOT an error. An error means the server was reachable and the
// connection failed; unavailable means it was never installable on this machine —
// the runtime it needs is absent. Collapsing the two is what made "you do not have
// Node" arrive dressed as a connection fault, after the full retry ladder, wearing
// whatever the child wrote to stderr. Only one of the two is the operator's to fix,
// and only one is worth retrying.
type ServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'unavailable'

/** What `getServers()` hands the renderer: the config, live status, and the probed
 *  requirement failures so the UI can say what is missing without re-probing. */
export type McpServerListing = McpServerConfig & {
  status: ServerStatus
  error?: string
  missing?: RequirementResult[]
}

interface ServerState {
  config: McpServerConfig
  status: ServerStatus
  error?: string
  client: Client | null
  transport: SSEClientTransport | StreamableHTTPClientTransport | StdioClientTransport | null
  tools: McpTool[]
  restartCount: number
  /** Last lines the child wrote to stderr, kept so a failed connect can say why. */
  stderrTail?: string[]
  /** Set once per transport instance: `onerror` and `onclose` both fire for a single
   *  crash, and each used to schedule its own restart — burning two of MAX_RESTARTS
   *  and racing two connects for the same server. Cleared back to false in
   *  connectWithRetry's success branch, the point where a new transport instance
   *  takes over — without that reset this flag disables auto-restart permanently
   *  after the FIRST crash+recovery instead of once per crash. */
  restartScheduled?: boolean
}

const MAX_RESTARTS = 3
const RETRY_DELAYS = [1000, 3000, 9000]
const STDERR_TAIL_LINES = 50
/** A server can spawn fine and then never finish the MCP handshake. Without a bound,
 *  the row sits on `connecting` forever. */
const CONNECT_TIMEOUT_MS = 30_000

function getConfigPath(): string {
  return join(app.getPath('userData'), 'mcp-servers.json')
}

/**
 * Move an unparseable mcp-servers.json aside to a timestamped side-car, preserving the bytes
 * for hand-recovery, instead of letting loadConfigs's catch branch destroy them by overwriting
 * with bare defaults. Mirrors settings-file.ts's quarantineCorruptSettings — same hazard (a
 * torn write from Electron dying mid-write looks byte-for-byte identical to "never
 * configured"), same shape of fix — kept local here since this file is the only reader/writer
 * of mcp-servers.json (no fan-out across call sites the way settings.json had).
 * Returns the side-car path, or null if it could not be moved (e.g. permissions), in which case
 * the caller must fall back to logging the loss rather than silently eating it.
 */
function quarantineCorruptMcpConfig(path: string): string | null {
  const dir = dirname(path)
  const stem = basename(path).replace(/\.json$/i, '')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (let attempt = 0; attempt < 50; attempt++) {
    const suffix = attempt === 0 ? '' : `-${attempt}`
    const sidecar = join(dir, `${stem}.corrupt-${stamp}${suffix}.json`)
    if (existsSync(sidecar)) continue
    try {
      renameSync(path, sidecar)
      return sidecar
    } catch {
      return null
    }
  }
  return null
}

/** Reject after `ms` if `promise` has not settled. The timer is cleared either way so
 *  a slow-but-successful connect does not leave the event loop pinned. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    })
  ]).finally(() => clearTimeout(timer)) as Promise<T>
}

// Historical placeholder Google MCP endpoints that earlier builds seeded but
// that DO NOT EXIST (Google hosts no MCP server there) — they 404 on every boot.
// Stripped from new + existing configs. Gmail/Drive REACH should come from a real
// MCP server (added via the catalog); ingest stays on the native SourceAdapters.
const PLACEHOLDER_URL_RE = /googleapis\.com\/mcp\/sse/i

// The Playwright MCP package ships as `@playwright/mcp`; `@anthropic-ai/mcp-server-playwright`
// has never existed. Earlier builds seeded that name AND omitted `-y`, so npx asked a
// non-TTY child to confirm an install of a package it could not find — meaning the first
// connector every new user saw was permanently red, for two independent reasons.
//
// PINNED (release B11): `npx -y @playwright/mcp` with no version resolves and executes
// whatever the registry serves at spawn time — third-party code chosen at boot, not at
// build. The seed names an exact version so what runs is what was reviewed; bump it here
// deliberately. Exported so the seed test can pin the pin.
export const CHROME_MCP_PACKAGE = '@playwright/mcp@0.0.79'
const CHROME_DEFAULT_ARGS = ['-y', CHROME_MCP_PACKAGE, '--browser', 'chromium']
const BAD_CHROME_PACKAGE = '@anthropic-ai/mcp-server-playwright'

/** The seeded connector rows a fresh install starts with. SEEDED DISABLED (release B11): a
 *  fresh install used to spawn `npx` — a network fetch + execution of an npm package — at
 *  every boot with no dialog, before the user had touched a single setting. The row stays so
 *  the user can turn it on in Settings → Connections (the existing per-server enable path,
 *  which is the consent step); nothing spawns until they do. Exported for the seed test. */
export function getDefaultConfigs(): McpServerConfig[] {
  return [
    {
      id: 'chrome',
      name: 'Chrome (Playwright)',
      transport: 'stdio',
      command: 'npx',
      args: [...CHROME_DEFAULT_ARGS],
      auth: 'none',
      enabled: false
    }
  ]
}

/** Repair the seeded chrome entry on installs that already wrote the bad one. Only
 *  touches a config still pointing at the package that does not exist, so a user who
 *  deliberately re-pointed it keeps their edit. Managed fields only: `enabled` is the
 *  user's and is carried over untouched, so a repair can never switch a connector on
 *  (nor off). Exported for the seed test. */
export function repairSeededChrome(configs: McpServerConfig[]): { configs: McpServerConfig[]; changed: boolean } {
  let changed = false
  const out = configs.map((c) => {
    if (c?.id !== 'chrome' || !c.args?.includes(BAD_CHROME_PACKAGE)) return c
    changed = true
    return { ...c, args: [...CHROME_DEFAULT_ARGS] }
  })
  return { configs: out, changed }
}

export function loadConfigs(): McpServerConfig[] {
  const configPath = getConfigPath()
  if (!existsSync(configPath)) {
    const defaults = getDefaultConfigs()
    atomicWriteFileSync(configPath, JSON.stringify(defaults, null, 2))
    return defaults
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as McpServerConfig[]
    // A structurally valid JSON value that is not an array (an object, string, number, null —
    // e.g. a hand-edit that dropped the wrapping `[...]`, or a future format written by a
    // newer build) used to be `return`ed here verbatim: the `as McpServerConfig[]` cast above
    // makes TypeScript believe it, so nothing downstream in THIS function ever complained.
    // The crash surfaced one call away instead — McpManager.initialize()'s
    // `for (const config of configs)` threw "is not iterable" on a load that had completed
    // with no error, past the catch block below that exists precisely to recover a bad
    // mcp-servers.json. And because initialize() sets `this.initialized = true` before that
    // loop runs, the thrown rejection (only `.catch()`-logged at the main.ts call site) never
    // gets a natural retry — every MCP connector silently disappears for the rest of the
    // session. Throw into the same catch so a non-array parse gets the identical
    // quarantine-then-fall-back-to-defaults recovery a torn write already gets, instead of an
    // uncaught crash one layer up.
    if (!Array.isArray(parsed)) throw new Error(`mcp-servers.json parsed to ${typeof parsed}, not an array`)
    // Migration: drop the placeholder Google endpoints that 404 on boot.
    const filtered = parsed.filter((s) => !(s?.url && PLACEHOLDER_URL_RE.test(s.url)))
    const { configs: cleaned, changed } = repairSeededChrome(filtered)
    if (changed || cleaned.length !== parsed.length) {
      atomicWriteFileSync(configPath, JSON.stringify(cleaned, null, 2))
    }
    return cleaned
  } catch {
    // The file exists but JSON.parse (or readFileSync) failed — almost always a torn write:
    // saveConfigs used to be a bare writeFileSync with no fsync/rename, so Electron dying
    // mid-write (crash, OOM kill, force-quit, power loss) leaves a truncated/invalid-JSON file
    // that is byte-for-byte indistinguishable from "never configured". Blindly overwriting here
    // with the single bundled default would silently discard every custom server the user
    // configured — URLs, stdio commands/args, headers, OAuth scopes — with nothing left to
    // recover and no warning beyond a console.error several lines away in the caller. Preserve
    // the bad bytes first (best-effort — a failed rename is itself logged rather than silently
    // swallowed), THEN fall back to defaults so the app still boots usable.
    const sidecar = quarantineCorruptMcpConfig(configPath)
    if (sidecar) {
      console.error(
        `[mcp] ${configPath} was present but unparseable (likely a torn write). ` +
          `Preserved the previous bytes at ${sidecar} before writing fresh defaults. ` +
          `Recover any custom servers (URLs, commands, headers, scopes) from that file.`
      )
    } else {
      console.error(
        `[mcp] ${configPath} was present but unparseable and could not be preserved ` +
          `(the side-car rename failed). Falling back to defaults — any custom servers ` +
          `previously configured there are lost.`
      )
    }
    const defaults = getDefaultConfigs()
    atomicWriteFileSync(configPath, JSON.stringify(defaults, null, 2))
    return defaults
  }
}

export function saveConfigs(configs: McpServerConfig[]): void {
  atomicWriteFileSync(getConfigPath(), JSON.stringify(configs, null, 2))
}

/** Key-wise equality for a string record, not JSON.stringify: key order follows
 *  the order keys appear in connectors.json, so a reordered but otherwise
 *  identical `env`/`headers` is not a change worth restarting a child for. */
function sameStringRecord(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  const recA = a ?? {}
  const recB = b ?? {}
  const keysA = Object.keys(recA)
  if (keysA.length !== Object.keys(recB).length) return false
  return keysA.every((k) => recA[k] === recB[k])
}

/** Do two plugin-owned connector configs describe the same server?
 *  Covers exactly the fields `refreshPluginConnectors` derives from a plugin's
 *  connectors.json — `id`/`pluginId`/`enabled` are fixed by construction there,
 *  so a difference in any of these is a real edit the running server has not
 *  picked up. `scope`/`headers` must be compared here too now that the derivation
 *  above copies them: leaving them out would silently recreate the exact bug this
 *  comment used to describe (a corrected connectors.json parsed but discarded on
 *  the "already known id" path) one field lower. See sameStringRecord for why
 *  `env`/`headers` compare key-wise instead of by JSON.stringify. */
function samePluginConnectorConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  if (
    a.name !== b.name ||
    a.transport !== b.transport ||
    a.auth !== b.auth ||
    a.url !== b.url ||
    a.command !== b.command ||
    a.scope !== b.scope
  ) {
    return false
  }
  const argsA = a.args ?? []
  const argsB = b.args ?? []
  if (argsA.length !== argsB.length || argsA.some((v, i) => v !== argsB[i])) return false
  if (!sameRequirements(a.requires, b.requires)) return false
  return sameStringRecord(a.env, b.env) && sameStringRecord(a.headers, b.headers)
}

/** Requirements are part of the derived config, so they belong in the equality check
 *  for the same reason `scope`/`headers` do: an operator who fixes a wrong `requires`
 *  in connectors.json must see the running server pick it up, not have the edit
 *  parsed and discarded on the "already known id" path. Order-sensitive on purpose —
 *  the list is short and hand-written, and a reorder is not worth a deep compare. */
function sameRequirements(a: Requirement[] | undefined, b: Requirement[] | undefined): boolean {
  const listA = a ?? []
  const listB = b ?? []
  if (listA.length !== listB.length) return false
  return listA.every((r, i) => {
    const other = listB[i]
    if (r.kind !== other.kind) return false
    if (r.hint !== other.hint) return false
    return r.kind === 'file'
      ? r.path === (other as { path: string }).path
      : r.name === (other as { name: string }).name
  })
}

/**
 * The environment a child process spawned by DUIN may inherit: system vars it needs to run,
 * nothing that carries a credential. ONE list, two spawners — MCP stdio servers here and the
 * external executor (services/executor/) — so the allowlist cannot drift between them.
 *
 * Almost every catalog entry is `npx -y <pkg>`, which has to reach the npm registry. Behind a
 * corporate proxy or TLS interception, dropping the proxy/CA vars makes every connector fail
 * with no indication that the network is the reason.
 */
export const SAFE_CHILD_ENV_KEYS: readonly string[] = [
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'windir', 'TEMP', 'TMP',
  'TMPDIR', 'LANG', 'LC_ALL', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'HOMEDRIVE', 'HOMEPATH',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'NPM_CONFIG_REGISTRY', 'npm_config_registry'
]

export class McpManager {
  private servers = new Map<string, ServerState>()
  private statusCallbacks: ((serverId: string, status: ServerStatus, error?: string) => void)[] = []
  private initialized = false
  // Customize C11: plugin-owned servers live in a separate Map keyed by
  // namespaced id (`<pluginId>:<connectorId>`). They're NEVER persisted
  // to mcp-servers.json — rebuilt from plugin connectors.json on every
  // plugin enable/disable.
  private pluginServers = new Map<string, ServerState>()
  private unsubscribePluginChanges: (() => void) | null = null

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    const configs = loadConfigs()
    for (const config of configs) {
      this.servers.set(config.id, {
        config,
        status: 'disconnected',
        client: null,
        transport: null,
        tools: [],
        restartCount: 0
      })
    }

    for (const [id, state] of this.servers) {
      if (state.config.enabled) {
        this.connectServer(id).catch((err) => {
          console.error(`[mcp] Failed to connect ${id}:`, messageOf(err))
        })
      }
    }

    // Customize C11: subscribe to plugin enable/disable broadcasts so the
    // plugin-owned server set stays in sync. The lazy require avoids a
    // hard module-load order between plugin-loader and mcp-manager.
    try {
      this.unsubscribePluginChanges = subscribeToPluginChanges(() =>
        this.refreshPluginConnectors()
      )
      this.refreshPluginConnectors()
    } catch (err) {
      console.error('[mcp] plugin subscription failed:', (err as Error).message)
    }
  }

  /** Customize C11: rebuild the plugin-owned server set from the current
   *  enabled plugins. Disconnects + drops any plugin server that's no
   *  longer enabled; adds any new ones. Persisted servers are untouched. */
  private refreshPluginConnectors(): void {
    let enabledRoots: { pluginId: string; rootPath: string }[]
    try {
      enabledRoots = enabledPluginRoots()
    } catch {
      enabledRoots = []
    }

    const desired = new Map<string, McpServerConfig>()
    for (const { pluginId, rootPath } of enabledRoots) {
      const fp = join(rootPath, 'connectors.json')
      if (!existsSync(fp)) continue
      try {
        const parsed = JSON.parse(readFileSync(fp, 'utf-8'))
        if (!Array.isArray(parsed)) continue
        for (const raw of parsed) {
          if (!raw || typeof raw !== 'object') continue
          const obj = raw as Record<string, unknown>
          const innerId = typeof obj.id === 'string' ? obj.id : ''
          if (!innerId) continue
          const namespacedId = `${pluginId}:${innerId}`
          const transport =
            obj.transport === 'stdio' || obj.transport === 'sse' || obj.transport === 'http'
              ? obj.transport
              : null
          if (!transport) continue
          // McpServerConfig.auth also carries generic 'oauth' (mcp-oauth.ts) — connectSSE
          // and connectHttp both branch on `auth === 'oauth'` to build a McpOAuthProvider
          // from `scope`. Mapping only 'google-oauth' here silently downgraded a plugin's
          // oauth connector to unauthenticated 'none', the same shape of gap as the 'http'
          // transport being rejected above: this loop parses connectors.json into
          // McpServerConfig but had never been updated to that interface's full unions.
          const auth: McpServerConfig['auth'] =
            obj.auth === 'google-oauth' ? 'google-oauth' : obj.auth === 'oauth' ? 'oauth' : 'none'
          const cfg: McpServerConfig = {
            id: namespacedId,
            name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : namespacedId,
            transport,
            auth,
            enabled: true,
            pluginId
          }
          if ((transport === 'sse' || transport === 'http') && typeof obj.url === 'string') {
            cfg.url = obj.url
            // headers is documented as applying to both remote transports (see the
            // connectSSE non-oauth branch and connectHttp) — dropping it here meant a
            // token-authed plugin connector parsed but never carried its header. scope
            // only matters once auth is 'oauth', but costs nothing to carry regardless.
            if (obj.headers && typeof obj.headers === 'object' && !Array.isArray(obj.headers)) {
              const headers: Record<string, string> = {}
              for (const [k, v] of Object.entries(obj.headers as Record<string, unknown>)) {
                if (typeof v === 'string') headers[k] = v
              }
              cfg.headers = headers
            }
            if (auth === 'oauth' && typeof obj.scope === 'string') cfg.scope = obj.scope
          }
          if (transport === 'stdio' && typeof obj.command === 'string') {
            cfg.command = obj.command
            if (Array.isArray(obj.args)) {
              cfg.args = obj.args.filter((a: unknown): a is string => typeof a === 'string')
            }
            if (obj.env && typeof obj.env === 'object' && !Array.isArray(obj.env)) {
              const env: Record<string, string> = {}
              for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
                if (typeof v === 'string') env[k] = v
              }
              cfg.env = env
            }
          }
          // Applies to every transport: a remote connector can require an env token
          // just as a stdio one can require a binary. Coerced from untrusted JSON —
          // a malformed entry is dropped, never fatal to the connector.
          const requires = coerceRequirements(obj.requires)
          if (requires) cfg.requires = requires
          desired.set(namespacedId, cfg)
        }
      } catch (err) {
        console.error('[mcp] failed to read plugin connectors at', fp, err)
      }
    }

    // Disconnect + drop entries no longer present.
    for (const [id, state] of this.pluginServers) {
      if (!desired.has(id)) {
        void this.cleanupServer(state)
        this.pluginServers.delete(id)
      }
    }

    // Add new entries; re-apply changed ones; preserve untouched connections.
    for (const [id, cfg] of desired) {
      const existing = this.pluginServers.get(id)
      if (existing) {
        // `cfg` was just re-read from connectors.json, and that file is
        // user-editable and watched (plugin-loader's chokidar watcher fires
        // broadcastChange -> this function on every write). Skipping every
        // already-known id meant an in-place edit — fixing a broken command,
        // adding a required env var, repointing a URL — was parsed here and
        // then dropped on the floor, with no error and no log line to say so:
        // the stale child kept running until the plugin was toggled off/on or
        // the app restarted. What made it invisible is that the id is the only
        // thing the loop looked at, and an edit deliberately keeps the id.
        // Diff the live config against the fresh one (the same managed-field
        // comparison upsertManagedDefault does for bundled defaults) and
        // restart only on a real difference, so an unrelated edit elsewhere in
        // the plugins root does not churn every healthy connector.
        if (!samePluginConnectorConfig(existing.config, cfg)) {
          console.log(`[mcp] plugin connector ${id} changed on disk — reconnecting`)
          existing.config = cfg
          // A prior failure must not be counted against MAX_RESTARTS now that
          // the config it failed with is gone.
          existing.restartCount = 0
          // Mark disconnected BEFORE closing: closing a stdio transport fires
          // its own `onclose`, whose auto-restart branch runs only while the
          // status is still 'connected'. Leaving it would spawn a second child
          // racing the reconnect below.
          existing.status = 'disconnected'
          void this.cleanupServer(existing).then(() =>
            this.connectPluginServer(id).catch((err) => {
              console.error(
                `[mcp] Failed to reconnect plugin server ${id} after a connectors.json change:`,
                messageOf(err)
              )
            })
          )
        }
        continue
      }
      const state: ServerState = {
        config: cfg,
        status: 'disconnected',
        client: null,
        transport: null,
        tools: [],
        restartCount: 0
      }
      this.pluginServers.set(id, state)
      // Attempt to connect; surface failures via the status callback.
      this.connectPluginServer(id).catch((err) => {
        console.error(`[mcp] Failed to connect plugin server ${id}:`, messageOf(err))
      })
    }
  }

  private async connectPluginServer(id: string): Promise<void> {
    const state = this.pluginServers.get(id)
    if (!state) return
    // Reuse the same connect path as persistent servers by temporarily
    // adopting the state into the main Map for the connect call, then
    // popping it back out. Connect mutates state in place — that's fine.
    this.servers.set(id, state)
    try {
      await this.connectServer(id)
    } finally {
      // Whether connect succeeded or not, the state lives in
      // pluginServers as the canonical home. Remove from the main Map
      // so list operations don't double-count. Match by identity: a
      // disable+re-enable during the await parks a DIFFERENT state under
      // this id, and that newcomer is not ours to evict.
      if (this.servers.get(id) === state) this.servers.delete(id)

      // Disabling the plugin (or just this connector) while the connect was
      // still in flight already ran refreshPluginConnectors' drop loop over
      // this state: its cleanupServer() call was a no-op because state.transport
      // stays null for the whole connect attempt — it is assigned only in
      // connectWithRetry's success branch — and pluginServers.delete(id) then
      // dropped the map's only reference. Popping ourselves out of this.servers
      // above would leave the just-connected client (and, for stdio, the child
      // process it spawned) reachable from NEITHER map, so getServers,
      // getAllTools and shutdown would all skip it and nothing would ever close
      // it again. What hid this is that the drop path *looks* like it
      // disconnects — it does call cleanupServer, just a beat too early to have
      // anything to close. Re-check ownership now that the await has resolved
      // and close whatever we ended up opening.
      if (this.pluginServers.get(id) !== state) {
        // Mark disconnected BEFORE closing: a stdio transport's own onclose
        // auto-restart branch fires only while the status is still 'connected',
        // and would respawn the very child we are here to reap.
        state.status = 'disconnected'
        await this.cleanupServer(state)
      }
    }
  }

  getServers(): McpServerListing[] {
    const result: McpServerListing[] = []
    // Requirements are re-probed on read, not cached onto the state, so a connector
    // whose missing binary was installed a minute ago stops reporting it without a
    // reconnect. The probe itself has a 30s TTL, so this stays cheap under polling.
    const listing = (state: ServerState): McpServerListing => {
      const effective = effectiveRequirements(
        state.config.requires,
        state.config.transport,
        state.config.command
      )
      const missing = probeRequirements(effective, { env: state.config.env }).missing
      return {
        ...state.config,
        status: state.status,
        error: state.error,
        // The EFFECTIVE set, not the declared one: a row whose only requirement is
        // its own command should still show what it needs. `requires` on the
        // persisted config is left alone — this is derived for display, never
        // written back to mcp-servers.json.
        requires: effective,
        missing: missing.length > 0 ? missing : undefined
      }
    }
    for (const state of this.servers.values()) {
      result.push(listing(state))
    }
    // Customize C11: append plugin-owned servers. They carry pluginId so
    // the renderer can render a "from plugin: X" badge and lock the
    // remove affordance.
    for (const state of this.pluginServers.values()) {
      result.push(listing(state))
    }
    return result
  }

  /**
   * Append a server config if no entry with the same id already exists,
   * persist the updated list, register the in-memory state, and (if
   * enabled) start connecting. No-op when an id collision is found, so
   * user edits in mcp-servers.json take precedence over the default. Returns
   * true when the server was newly added.
   */
  async addServerIfMissing(config: McpServerConfig): Promise<boolean> {
    if (this.servers.has(config.id)) return false

    // Persist alongside the user's existing configs so the entry survives
    // restarts and shows up in the settings UI like any other server.
    const existing = loadConfigs()
    if (!existing.some((c) => c.id === config.id)) {
      saveConfigs([...existing, config])
    }

    this.servers.set(config.id, {
      config,
      status: 'disconnected',
      client: null,
      transport: null,
      tools: [],
      restartCount: 0
    })

    if (config.enabled) {
      this.connectServer(config.id).catch((err) => {
        console.error(`[mcp] Failed to connect default server ${config.id}:`, messageOf(err))
      })
    }

    return true
  }

  /** Where the hand-editable connector config lives, for the UI to reveal. */
  configPath(): string {
    return getConfigPath()
  }

  /** Drop a connector for good: disconnect, forget it in memory, take it out of
   *  `mcp-servers.json` so it does not respawn on the next launch, and purge any
   *  OAuth credentials it left in the keychain. Plugin-owned entries are rebuilt
   *  from their plugin every boot and are refused here — the way to remove one is
   *  to disable its plugin. */
  async removeServer(id: string): Promise<boolean> {
    if (this.pluginServers.has(id)) return false
    const state = this.servers.get(id)
    if (!state) return false
    await this.disconnect(id)
    this.servers.delete(id)
    saveConfigs(loadConfigs().filter((c) => c.id !== id))
    // SEC: an 'oauth' connector's access/refresh tokens, DCR client record, and PKCE
    // verifier live in keys.json under a per-id namespace (mcp-oauth.ts's `k(id, field)`)
    // that is entirely separate from mcp-servers.json. Without this, removal only
    // forgot the connector's config — the keychain rows survived untouched, so
    // re-adding the SAME id later (e.g. re-pointed at a different self-hosted/staging
    // host) would silently hand the old server's bearer token to the first request
    // against the new one. McpOAuthProvider.clear() already owned exactly this
    // vocabulary (tokens/client/verifier); it just had no caller anywhere in the app.
    if (state.config.auth === 'oauth') {
      new McpOAuthProvider(id).clear()
    }
    return true
  }

  /** Turn a connector on or off and make it stick. Several catalog entries ship
   *  `enabled: false` on purpose, so without this they could be added but never used. */
  async setServerEnabled(id: string, enabled: boolean): Promise<boolean> {
    if (this.pluginServers.has(id)) return false
    const state = this.servers.get(id)
    if (!state) return false

    state.config = { ...state.config, enabled }
    saveConfigs(loadConfigs().map((c) => (c.id === id ? { ...c, enabled } : c)))

    if (enabled) {
      // A prior failure would otherwise still be counted against MAX_RESTARTS.
      state.restartCount = 0
      this.connectServer(id).catch((err) => {
        console.error(`[mcp] failed to connect ${id} after enable:`, messageOf(err))
      })
    } else {
      await this.disconnect(id)
    }
    return true
  }

  /**
   * Self-healing variant for bundled default servers. Owns specific fields
   * (`command`, `args`, `env`) and refreshes them when stale — e.g. when
   * `process.execPath` differs because the user upgraded Electron, or when
   * the bundled server.js moved between dev and packaged paths. Preserves
   * the user's `enabled` flag and `name` so toggling the default off keeps
   * sticking across restarts.
   *
   * Returns 'added' when no entry existed, 'updated' when managed fields
   * changed, 'unchanged' when the existing entry already matched.
   */
  async upsertManagedDefault(
    desired: McpServerConfig
  ): Promise<'added' | 'updated' | 'unchanged'> {
    if (!this.servers.has(desired.id)) {
      await this.addServerIfMissing(desired)
      return 'added'
    }

    const existing = this.servers.get(desired.id)!.config
    const sameCommand = existing.command === desired.command
    const sameArgs = JSON.stringify(existing.args ?? []) === JSON.stringify(desired.args ?? [])
    const sameEnv = JSON.stringify(existing.env ?? {}) === JSON.stringify(desired.env ?? {})
    // `requires` is a managed field by exactly the same logic as command/args/env: it
    // is derived from the shipped code, not from anything the user edited. Leaving it
    // out meant an EXISTING install never gained a newly-declared requirement —
    // measured 2026-08-26, where the Feishu default kept `requires: undefined` after
    // a deploy that declared its lark-cli dependency, so the declaration was inert on
    // the only machine running it.
    const sameRequires = sameRequirements(existing.requires, desired.requires)
    if (sameCommand && sameArgs && sameEnv && sameRequires) return 'unchanged'

    // Build the refreshed config: managed fields from desired, user fields
    // from existing.
    const refreshed: McpServerConfig = {
      ...existing,
      command: desired.command,
      args: desired.args,
      env: desired.env,
      requires: desired.requires
    }

    const configs = loadConfigs().map((c) => (c.id === desired.id ? refreshed : c))
    saveConfigs(configs)
    const state = this.servers.get(desired.id)!
    state.config = refreshed
    state.restartCount = 0

    if (refreshed.enabled) {
      // Drop any in-flight stale connection so the next read uses the new
      // command/args. Status before close, for the reason spelled out in
      // disconnect(): otherwise the old transport's onclose auto-restarts a
      // child that then races the reconnect below, and one of the two is left
      // running with nothing referencing it.
      state.status = 'disconnected'
      void this.cleanupServer(state).then(() => {
        this.connectServer(desired.id).catch((err) => {
          console.error(`[mcp] Reconnect after default refresh failed for ${desired.id}:`, messageOf(err))
        })
      })
    }

    return 'updated'
  }

  async connect(id: string): Promise<void> {
    return this.connectServer(id)
  }

  async disconnect(id: string): Promise<void> {
    const state = this.servers.get(id)
    if (!state) return

    // Mark disconnected BEFORE closing — the same ordering rule the plugin path
    // already documents (refreshPluginConnectors / connectPluginServer). A stdio
    // transport's own onclose (and onerror) auto-restart branch fires only while
    // the status is still 'connected', and closing is exactly what makes it fire:
    // the SDK's StdioClientTransport.close() ends the child's stdin and awaits the
    // child's 'close' event, whose handler calls onclose — so onclose runs INSIDE
    // the await below and respawns the very child we are here to reap.
    // What hid this: the two statements read as order-independent bookkeeping, and
    // the respawn is asynchronous, so the only symptom is the connector row going
    // green again a moment after the user switched it off (with mcp-servers.json
    // saying enabled:false and getAllTools still offering its tools). Via
    // removeServer() it is worse — the replacement child is spawned, then
    // servers.delete(id) drops the only reference to it, so shutdown() cannot
    // close it and the process tree survives until the app is force-killed.
    state.status = 'disconnected'
    await this.cleanupServer(state)
    state.error = undefined
    this.emitStatus(id, 'disconnected')
  }

  async reconnect(id: string): Promise<void> {
    const state = this.servers.get(id)
    if (!state) return

    // Status before close, for the reason spelled out in disconnect(). Here the
    // stale auto-restart does not just resurrect a reaped child: its connectServer
    // races the explicit one below, and whichever handshake lands second overwrites
    // state.transport — orphaning the other client and its child process.
    state.status = 'disconnected'
    await this.cleanupServer(state)
    state.restartCount = 0
    await this.connectServer(id)
  }

  listTools(id: string): McpTool[] {
    return this.servers.get(id)?.tools ?? []
  }

  getAllTools(): { serverId: string; tools: McpTool[] }[] {
    const result: { serverId: string; tools: McpTool[] }[] = []
    // Include BOTH regular and plugin-owned servers — plugin tools were invisible
    // to the model (getAllTools skipped pluginServers), so plugin connectors
    // appeared installed but couldn't be called.
    for (const map of [this.servers, this.pluginServers]) {
      for (const [id, state] of map) {
        if (state.status === 'connected' && state.tools.length > 0) {
          result.push({ serverId: id, tools: state.tools })
        }
      }
    }
    return result
  }

  /** Resolve a server by id from EITHER the persisted or plugin-owned map. */
  private findServer(id: string): ServerState | undefined {
    return this.servers.get(id) ?? this.pluginServers.get(id)
  }

  // MR — probe the server's advertised resource capabilities. `supported`
  // gates whether list/read are even attempted; subscribe/listChanged are
  // surfaced for callers that want change notifications (not wired here).
  getResourceCapabilities(serverId: string): McpResourceCapabilities {
    const state = this.findServer(serverId)
    const resources = state?.client?.getServerCapabilities()?.resources
    return {
      supported: resources !== undefined,
      subscribe: resources?.subscribe === true,
      listChanged: resources?.listChanged === true
    }
  }

  async listResources(
    serverId: string,
    cursor?: string,
    signal?: AbortSignal
  ): Promise<McpResourcePage<McpResource>> {
    const result = await this.runResourceRequest(serverId, 'resources/list', signal, (client, options) =>
      client.listResources(cursor === undefined ? undefined : { cursor: validateCursor(cursor) }, options)
    )
    assertBoundedPage('resource', result.resources)
    for (const resource of result.resources) validateResourceUri(resource.uri)
    return { items: result.resources as McpResource[], nextCursor: result.nextCursor }
  }

  async listResourceTemplates(
    serverId: string,
    cursor?: string,
    signal?: AbortSignal
  ): Promise<McpResourcePage<McpResourceTemplate>> {
    const result = await this.runResourceRequest(
      serverId,
      'resources/templates/list',
      signal,
      (client, options) =>
        client.listResourceTemplates(
          cursor === undefined ? undefined : { cursor: validateCursor(cursor) },
          options
        )
    )
    assertBoundedPage('resource template', result.resourceTemplates)
    return {
      items: result.resourceTemplates as McpResourceTemplate[],
      nextCursor: result.nextCursor
    }
  }

  async readResource(
    serverId: string,
    uri: string,
    signal?: AbortSignal
  ): Promise<McpResourceContent[]> {
    const validatedUri = validateResourceUri(uri)
    const result = await this.runResourceRequest(serverId, 'resources/read', signal, (client, options) =>
      client.readResource({ uri: validatedUri }, options)
    )
    if (result.contents.length > MCP_RESOURCE_LIMITS.maxContentItems) {
      throw new McpResourceBoundsError(
        `MCP resource returned ${result.contents.length} content items; limit is ${MCP_RESOURCE_LIMITS.maxContentItems}`
      )
    }
    for (const content of result.contents) validateResourceUri(content.uri)
    const bytes = Buffer.byteLength(JSON.stringify(result.contents), 'utf8')
    if (bytes > MCP_RESOURCE_LIMITS.maxContentBytes) {
      throw new McpResourceBoundsError(
        `MCP resource returned ${bytes} bytes; limit is ${MCP_RESOURCE_LIMITS.maxContentBytes}`
      )
    }
    return result.contents as McpResourceContent[]
  }

  // Shared choke point for every resource RPC: requires a connected client,
  // requires the server to advertise `resources`, applies the same per-call
  // timeout + cancellation as callTool, and maps RequestTimeout to the
  // friendly MCPTimeoutError.
  private async runResourceRequest<T>(
    serverId: string,
    operation: string,
    signal: AbortSignal | undefined,
    request: (
      client: Client,
      options:
        | { timeout?: number; resetTimeoutOnProgress?: boolean; signal?: AbortSignal }
        | undefined
    ) => Promise<T>
  ): Promise<T> {
    const state = this.findServer(serverId)
    if (!state || !state.client || state.status !== 'connected') {
      throw new Error(`MCP server '${serverId}' is not connected`)
    }
    if (!state.client.getServerCapabilities()?.resources) {
      throw new McpResourceCapabilityError(serverId)
    }
    const timeoutMs = readMcpCallTimeoutMs()
    const options =
      timeoutMs > 0
        ? { timeout: timeoutMs, resetTimeoutOnProgress: true as const, ...(signal ? { signal } : {}) }
        : signal
          ? { signal }
          : undefined
    try {
      return await request(state.client, options)
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        throw new MCPTimeoutError(serverId, operation, timeoutMs > 0 ? timeoutMs : 60_000)
      }
      throw error
    }
  }

  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const state = this.servers.get(serverId) ?? this.pluginServers.get(serverId)
    if (!state || !state.client || state.status !== 'connected') {
      throw new Error(`MCP server '${serverId}' is not connected`)
    }

    const timeoutMs = readMcpCallTimeoutMs()
    const traceId = randomUUID().slice(0, 8)
    const startedAt = Date.now()
    trace('mcp.callTool.enter', {
      traceId,
      serverId,
      toolName,
      timeoutMs,
      argsKeys: Object.keys(args ?? {}),
      argsPreview: JSON.stringify(args ?? {}).slice(0, 200)
    })
    let result
    try {
      // 3rd arg `options.timeout`: SDK throws McpError(RequestTimeout) on
      // expiry. 0 disables our per-call cap and falls back to the SDK's
      // built-in default. resetTimeoutOnProgress=true lets a long-running
      // tool keep the connection alive as long as it sends progress notes.
      result = await state.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        timeoutMs > 0
          ? { timeout: timeoutMs, resetTimeoutOnProgress: true }
          : undefined
      )
      trace('mcp.callTool.complete', {
        traceId,
        serverId,
        toolName,
        durationMs: Date.now() - startedAt,
        isError: result?.isError ?? false
      })
    } catch (err) {
      const isTimeout = err instanceof McpError && err.code === ErrorCode.RequestTimeout
      trace('mcp.callTool.error', {
        traceId,
        serverId,
        toolName,
        durationMs: Date.now() - startedAt,
        isTimeout,
        errName: (err as { name?: string })?.name,
        errCode: err instanceof McpError ? err.code : undefined,
        errMessage: String(messageOf(err) ?? err).slice(0, 200)
      })
      if (isTimeout) {
        throw new MCPTimeoutError(serverId, toolName, timeoutMs > 0 ? timeoutMs : 60_000)
      }
      throw err
    }

    if (result.isError) {
      const errorText = Array.isArray(result.content)
        ? result.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n')
        : String(result.content)
      throw new Error(errorText || 'Tool call failed')
    }

    if (Array.isArray(result.content)) {
      const texts = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
      if (texts.length > 0) {
        return texts.length === 1 ? texts[0] : texts.join('\n')
      }
      // No text blocks survived the filter. A tool whose result is entirely
      // image/audio/resource content (e.g. a screenshot tool) used to fall
      // through to ''.join('\n') === '' here — a successful call silently
      // handed the caller an empty string, indistinguishable from "the tool
      // legitimately returned nothing" and with no error to explain it.
      // Serialize the surviving blocks instead so they still reach the
      // caller; only a truly empty content array collapses to ''.
      return result.content.length > 0 ? JSON.stringify(result.content) : ''
    }

    return result.content
  }

  onStatusChange(cb: (serverId: string, status: ServerStatus, error?: string) => void): void {
    this.statusCallbacks.push(cb)
  }

  async shutdown(): Promise<void> {
    for (const [, state] of this.servers) {
      await this.cleanupServer(state)
    }
    this.servers.clear()
    // Plugin-owned stdio servers live in a separate map; clean them up too, or
    // every plugin-spawned child process (npx trees, etc.) orphans on app quit
    // and accumulates across launch/quit cycles.
    for (const [, state] of this.pluginServers) {
      await this.cleanupServer(state)
    }
    this.pluginServers.clear()
  }

  private async connectServer(id: string): Promise<void> {
    // Resolve from BOTH maps. Plugin-owned servers live only in pluginServers
    // once connectPluginServer's finally pops them back out of this.servers —
    // but the stdio restart handlers (transport.onclose/onerror) recover a
    // crashed server by calling connectServer(state.config.id). Without the
    // pluginServers fallback that call silently no-op'd, so a plugin stdio
    // server that crashed mid-session never restarted (its tools vanished until
    // a plugin toggle or app relaunch), while a persistent stdio server in the
    // same spot restarted up to MAX_RESTARTS. Mirrors callTool's lookup.
    const state = this.servers.get(id) ?? this.pluginServers.get(id)
    if (!state) return

    // PREFLIGHT. Runs before `connecting` is even announced, because a connector
    // whose runtime is absent is not connecting — it has nothing to connect to. The
    // retry ladder below costs three attempts plus backoff and cannot fix a missing
    // binary, so spending it here would only delay the same answer while making it
    // less legible. Requirements are re-probed per connect (30s cache) so installing
    // the missing tool and hitting Reconnect works without a restart.
    // DECLARED requirements only. A requirement someone WROTE is an opt-in: the
    // author asserted this connector cannot work without it, and taking them at
    // their word is safe. The requirement DERIVED from the command line (see
    // effectiveRequirements, used for display in getServers) is a guess, and a wrong
    // guess here takes a working connector dark — a far worse outcome than the
    // confusing error message it was meant to improve. That is not hypothetical: the
    // first version of the probe resolved binaries against the main-process PATH
    // only, which is wrong for any connector that sets its own PATH in its env
    // block, and it would have refused to spawn a server that works. So the derived
    // requirement INFORMS the row and never gates the spawn.
    //
    // `env` is the connector's OWN block, which is where a catalog entry's token
    // lives (mcp-servers.json), not the main-process environment — see ProbeOptions.
    const report = probeRequirements(state.config.requires, { env: state.config.env })
    if (!report.satisfied) {
      const detail = describeMissing(report)
      state.status = 'unavailable'
      state.error = detail
      this.emitStatus(id, 'unavailable', detail)
      console.warn(`[mcp] ${id} is unavailable on this machine: ${detail}`)
      return
    }

    state.status = 'connecting'
    state.error = undefined
    this.emitStatus(id, 'connecting')

    try {
      if (state.config.transport === 'sse') {
        await this.connectSSE(state)
      } else if (state.config.transport === 'http') {
        await this.connectHttp(state)
      } else {
        await this.connectStdio(state)
      }
    } catch (err) {
      state.status = 'error'
      state.error = messageOf(err)
      this.emitStatus(id, 'error', messageOf(err))
      console.error(`[mcp] Connection error for ${id}:`, messageOf(err))
    }
  }

  private async connectSSE(state: ServerState): Promise<void> {
    if (state.config.auth === 'oauth') {
      const oauthProvider = new McpOAuthProvider(state.config.id, state.config.scope)
      const url = new URL(state.config.url!)
      // A factory, not a single instance: connectWithRetry calls this fresh on every
      // attempt. See the comment there for why reusing one Client/transport pair
      // across retries throws 'Already connected to a transport' and orphans
      // whatever the failed attempt started.
      const createConnection = (): { client: Client; transport: SSEClientTransport } => {
        const transport = new SSEClientTransport(url, { authProvider: oauthProvider })
        const client = new Client({ name: 'duin', version: '1.0.0' })
        transport.onerror = (err) => {
          console.error(`[mcp] SSE error for ${state.config.id}:`, messageOf(err))
          state.status = 'error'
          state.error = messageOf(err)
          this.emitStatus(state.config.id, 'error', messageOf(err))
        }
        transport.onclose = () => {
          if (state.status === 'connected') {
            state.status = 'disconnected'
            this.emitStatus(state.config.id, 'disconnected')
          }
        }
        return { client, transport }
      }
      await this.connectWithRetry(state, createConnection, oauthProvider)
      return
    }
    if (state.config.auth === 'google-oauth') {
      const accessToken = keychain.getKey('google-access-token')
      if (!accessToken) {
        state.status = 'disconnected'
        state.error = 'Google OAuth not configured'
        this.emitStatus(state.config.id, 'disconnected', state.error)
        return
      }

      const expiryStr = keychain.getKey('google-token-expiry')
      const FIVE_MINUTES = 5 * 60 * 1000
      if (expiryStr && Date.now() + FIVE_MINUTES > parseInt(expiryStr, 10)) {
        const refreshed = await this.refreshGoogleToken()
        if (!refreshed) {
          state.status = 'error'
          state.error = 'Token refresh failed'
          this.emitStatus(state.config.id, 'error', state.error)
          return
        }
      }

      const token = keychain.getKey('google-access-token')!
      const url = new URL(state.config.url!)
      // Same merge connectHttp does: configured static headers are the base, the
      // Google bearer overrides Authorization. This branch used to send ONLY the
      // bearer, silently dropping every other configured header.
      const headers: Record<string, string> = {
        ...(state.config.headers ?? {}),
        Authorization: `Bearer ${token}`
      }
      const createConnection = (): { client: Client; transport: SSEClientTransport } => {
        const transport = new SSEClientTransport(url, {
          eventSourceInit: {
            fetch: (input: string | URL | Request, init?: RequestInit) => {
              // `init.headers` already carries the merged set (the SDK builds it from
              // requestInit via _commonHeaders before calling this fetch), so copying
              // it forward is what preserves the non-Authorization headers here.
              const headers = new Headers(init?.headers)
              headers.set('Authorization', `Bearer ${token}`)
              return fetch(input, { ...init, headers })
            }
          },
          requestInit: { headers }
        })

        const client = new Client({ name: 'duin', version: '1.0.0' })

        transport.onerror = (err) => {
          console.error(`[mcp] SSE error for ${state.config.id}:`, messageOf(err))
          state.status = 'error'
          state.error = messageOf(err)
          this.emitStatus(state.config.id, 'error', messageOf(err))
        }

        transport.onclose = () => {
          if (state.status === 'connected') {
            state.status = 'disconnected'
            this.emitStatus(state.config.id, 'disconnected')
          }
        }

        return { client, transport }
      }

      await this.connectWithRetry(state, createConnection)
    } else {
      const url = new URL(state.config.url!)
      // McpServerConfig.headers is documented as applying to "http/sse" servers and
      // electron/ipc/mcp.ts accepts it for both, but this branch constructed the
      // transport with NO options at all — so a token-authed SSE connector saved its
      // Authorization header to mcp-servers.json, showed as configured in the UI, and
      // then handshook anonymously. The bug hid behind the sibling: connectHttp does
      // apply the same field, so "headers work" was true for the transport people
      // tested. The SDK routes requestInit.headers through _commonHeaders() into BOTH
      // the SSE GET stream and the POST message channel, so this one option covers the
      // whole conversation. Mirrors connectHttp deliberately — keep the two in step.
      const headers: Record<string, string> = { ...(state.config.headers ?? {}) }
      const createConnection = (): { client: Client; transport: SSEClientTransport } => {
        const transport = new SSEClientTransport(url, {
          requestInit: Object.keys(headers).length ? { headers } : undefined
        })
        const client = new Client({ name: 'duin', version: '1.0.0' })

        transport.onerror = (err) => {
          console.error(`[mcp] SSE error for ${state.config.id}:`, messageOf(err))
          state.status = 'error'
          state.error = messageOf(err)
          this.emitStatus(state.config.id, 'error', messageOf(err))
        }

        return { client, transport }
      }

      await this.connectWithRetry(state, createConnection)
    }
  }

  private async connectHttp(state: ServerState): Promise<void> {
    const url = new URL(state.config.url!)
    // oauthProvider (unlike client/transport) must stay ONE instance for the whole
    // connectWithRetry call — it carries the in-flight PKCE/consent state across
    // retries — so it's built once here, outside the per-attempt factory below.
    const oauthProvider =
      state.config.auth === 'oauth' ? new McpOAuthProvider(state.config.id, state.config.scope) : undefined
    // A factory, not a single instance: connectWithRetry calls this fresh on every
    // attempt. See the comment there for why reusing one Client/transport pair
    // across retries throws 'Already connected to a transport' and orphans
    // whatever the failed attempt started.
    const createConnection = (): { client: Client; transport: StreamableHTTPClientTransport } => {
      let transport: StreamableHTTPClientTransport
      if (oauthProvider) {
        transport = new StreamableHTTPClientTransport(url, { authProvider: oauthProvider })
      } else {
        const headers: Record<string, string> = { ...(state.config.headers ?? {}) }
        if (state.config.auth === 'google-oauth') {
          const token = keychain.getKey('google-access-token')
          if (token) headers['Authorization'] = `Bearer ${token}`
        }
        transport = new StreamableHTTPClientTransport(url, {
          requestInit: Object.keys(headers).length ? { headers } : undefined
        })
      }
      const client = new Client({ name: 'duin', version: '1.0.0' })

      transport.onerror = (err) => {
        console.error(`[mcp] HTTP error for ${state.config.id}:`, messageOf(err))
        state.status = 'error'
        state.error = messageOf(err)
        this.emitStatus(state.config.id, 'error', messageOf(err))
      }
      transport.onclose = () => {
        if (state.status === 'connected') {
          state.status = 'disconnected'
          this.emitStatus(state.config.id, 'disconnected')
        }
      }

      return { client, transport }
    }

    await this.connectWithRetry(state, createConnection, oauthProvider)
  }

  private async connectStdio(state: ServerState): Promise<void> {
    // SECURITY: never spread the full process.env into a spawned MCP server — the
    // main-process env carries provider API keys and OAuth tokens. Pass only the
    // system vars a child process needs to run, plus the server's own configured env.
    const safeBase: Record<string, string> = {}
    for (const k of SAFE_CHILD_ENV_KEYS) {
      const v = process.env[k]
      if (typeof v === 'string') safeBase[k] = v
    }
    const mergedEnv = { ...safeBase, ...(state.config.env ?? {}) }

    // A factory, not a single instance: connectWithRetry calls this fresh on every
    // attempt. See the comment there for why reusing one Client/transport pair
    // across retries throws 'Already connected to a transport' and orphans the
    // spawned child — for stdio specifically, that orphan is a live `npx` process.
    const createConnection = (): { client: Client; transport: StdioClientTransport } => {
      const transport = new StdioClientTransport({
        command: state.config.command!,
        args: state.config.args,
        env: mergedEnv,
        stderr: 'pipe'
      })

      // `stderr: 'pipe'` hands us a PassThrough that NOTHING was reading. Two costs: the
      // child's only diagnostic channel was discarded (npx writes "package not found",
      // 404s, EACCES and proxy failures there, so every connect failure arrived with no
      // cause), and an unread pipe fills its ~64KB buffer and blocks the child mid-write.
      // Draining it fixes the stall and gives the failure message something to say.
      // Reset per attempt so a retry's tail reflects THIS child, not a stale one.
      state.stderrTail = []
      transport.stderr?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString('utf-8').split(/\r?\n/).filter((l) => l.trim())
        const tail = state.stderrTail ?? (state.stderrTail = [])
        tail.push(...lines)
        if (tail.length > STDERR_TAIL_LINES) tail.splice(0, tail.length - STDERR_TAIL_LINES)
      })

      const client = new Client({ name: 'duin', version: '1.0.0' })

      transport.onerror = (err) => {
        console.error(`[mcp] stdio error for ${state.config.id}:`, messageOf(err))
        if (state.status === 'connected') {
          state.status = 'error'
          state.error = messageOf(err)
          this.emitStatus(state.config.id, 'error', messageOf(err))

          if (!state.restartScheduled && state.restartCount < MAX_RESTARTS) {
            state.restartScheduled = true
            state.restartCount++
            console.log(`[mcp] Restarting ${state.config.id} (attempt ${state.restartCount}/${MAX_RESTARTS})`)
            this.cleanupServer(state).then(() => this.connectServer(state.config.id))
          }
        }
      }

      transport.onclose = () => {
        if (state.status === 'connected') {
          state.status = 'disconnected'
          this.emitStatus(state.config.id, 'disconnected')

          if (!state.restartScheduled && state.restartCount < MAX_RESTARTS) {
            state.restartScheduled = true
            console.log(`[mcp] Restarting ${state.config.id} after close (attempt ${state.restartCount}/${MAX_RESTARTS})`)
            state.restartCount++
            this.connectServer(state.config.id).catch(() => {})
          }
        }
      }

      return { client, transport }
    }

    await this.connectWithRetry(state, createConnection)
  }

  private async connectWithRetry(
    state: ServerState,
    // A factory rather than a ready-made pair: the SDK's Protocol.connect() sets
    // its internal transport reference BEFORE the handshake even starts, and
    // throws 'Already connected to a transport' if connect() is called again on
    // the same Client — so a Client that failed (including one still stuck mid
    // handshake when OUR withTimeout below gives up on it) can never be reused
    // for a retry. StdioClientTransport/SSEClientTransport/StreamableHTTPClient-
    // Transport all likewise refuse a second start() on the same instance (SSE
    // and HTTP don't even reset that guard on close()). Calling this once per
    // attempt is what makes "retry" mean a real new attempt instead of the same
    // stale pair throwing instantly.
    createConnection: () => {
      client: Client
      transport: SSEClientTransport | StreamableHTTPClientTransport | StdioClientTransport
    },
    oauthProvider?: McpOAuthProvider
  ): Promise<void> {
    let lastError: Error | null = null
    let authExchanged = false

    for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
      const { client, transport } = createConnection()
      try {
        // Both calls are bounded: a child that spawns but never speaks MCP would
        // otherwise leave the row on `connecting` with no error and no end.
        await withTimeout(
          client.connect(transport),
          CONNECT_TIMEOUT_MS,
          `${state.config.id} did not respond within ${CONNECT_TIMEOUT_MS / 1000}s`
        )

        const toolsResult = await withTimeout(
          client.listTools(),
          CONNECT_TIMEOUT_MS,
          `${state.config.id} connected but never listed its tools`
        )
        state.tools = toolsResult.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: (t as { annotations?: McpToolAnnotations }).annotations
        }))

        state.client = client
        state.transport = transport
        state.status = 'connected'
        state.error = undefined
        state.restartCount = 0
        // This transport instance (`transport`, just wired into `state` above) now
        // owns the crash handlers armed below on connectStdio's `onerror`/`onclose`.
        // restartScheduled is documented as scoped to one transport instance, but
        // was only ever set true there and never cleared anywhere — so once a
        // stdio server crashed and auto-restarted once, EVERY later crash of the
        // new (successfully connected) transport instance was silently ignored:
        // the `!state.restartScheduled` guard stayed false forever even though
        // restartCount was well under MAX_RESTARTS. Reset it here, the one point
        // shared by every transport (stdio/sse/http) and every reconnect path
        // (auto-restart, manual reconnect, enable toggle), so the guard's
        // lifetime actually matches its documented scope.
        state.restartScheduled = false
        this.emitStatus(state.config.id, 'connected')

        console.log(`[mcp] Connected to ${state.config.id} — ${state.tools.length} tools available`)
        return
      } catch (err) {
        lastError = err as Error
        // Reap whatever this attempt started before the next one spawns another.
        // Without this a timed-out attempt's child process (or open socket) was
        // simply abandoned — it was never assigned to state.transport (that only
        // happens on the success path above), so cleanupServer/shutdown had
        // nothing to close, and it leaked for the life of the app.
        await client.close().catch(() => {})
        // Generic OAuth: the transport opened the browser for consent and threw
        // Unauthorized. Capture the loopback callback code, exchange it for
        // tokens, then retry the connect ONCE (don't re-open the browser).
        const isUnauthorized =
          err instanceof UnauthorizedError || /unauthor/i.test(String(friendly(err, '')))
        if (oauthProvider && !authExchanged && isUnauthorized) {
          authExchanged = true
          try {
            console.log(`[mcp] ${state.config.id}: awaiting OAuth consent…`)
            const code = await oauthProvider.waitForCode()
            await (transport as unknown as { finishAuth(code: string): Promise<void> }).finishAuth(code)
            continue // retry connect immediately, now with tokens
          } catch (e) {
            lastError = e as Error
          }
        }
        console.warn(`[mcp] Connection attempt ${attempt + 1} for ${state.config.id} failed:`, messageOf(err))
        if (attempt < RETRY_DELAYS.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt]))
        }
      }
    }

    // Attach what the child actually said. Without this the user sees only
    // "spawn npx ENOENT" or a bare timeout, while the real cause — a 404 on the
    // package, a proxy refusal, a missing token — sat unread in its stderr.
    const err = lastError || new Error('Connection failed after retries')
    const tail = (state.stderrTail ?? []).slice(-6)
    if (tail.length) {
      err.message = `${err.message}\n${tail.join('\n')}`
    }
    throw err
  }

  private async refreshGoogleToken(): Promise<boolean> {
    // Delegates to the shared google-auth helper so the MCP path and the ingest
    // adapters refresh through one code path (audit C8).
    return refreshGoogleTokenShared()
  }

  private async cleanupServer(state: ServerState): Promise<void> {
    try {
      if (state.transport) {
        await state.transport.close()
      }
    } catch {
      // ignore cleanup errors
    }
    state.client = null
    state.transport = null
    state.tools = []
  }

  private emitStatus(serverId: string, status: ServerStatus, error?: string): void {
    for (const cb of this.statusCallbacks) {
      try {
        cb(serverId, status, error)
      } catch {
        // ignore callback errors
      }
    }

    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (mainWindow) {
      mainWindow.webContents.send('mcp:statusChanged', { serverId, status, error })
    }
  }
}

export const mcpManager = new McpManager()
