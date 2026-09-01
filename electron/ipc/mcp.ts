import { ipcMain, shell, dialog, BrowserWindow } from 'electron'
import { createServer } from 'http'
import { mcpManager } from '../services/mcp-manager'
import type { McpServerConfig } from '../services/mcp-manager'
import * as keychain from '../services/keychain'
import { createOAuthSession, validateOAuthCallback } from '../services/oauth-state'
import { messageOf } from '../services/guarded'

function sanitizeAddServerInput(raw: unknown): McpServerConfig | string {
  if (!raw || typeof raw !== 'object') return 'Connector config must be an object'
  const obj = raw as Record<string, unknown>
  const id = typeof obj.id === 'string' ? obj.id.trim() : ''
  if (!id) return 'Connector id is required (kebab-case)'
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return 'Connector id must be kebab-case (a-z, 0-9, -)'
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : id
  const transport =
    obj.transport === 'stdio' || obj.transport === 'sse' || obj.transport === 'http'
      ? obj.transport
      : null
  if (!transport) {
    return 'Say how to reach this server: "stdio" to run it on this computer, or "http" (or "sse") for a remote URL'
  }
  const auth =
    obj.auth === 'google-oauth' ? 'google-oauth' : obj.auth === 'oauth' ? 'oauth' : 'none'
  const enabled = obj.enabled === false ? false : true
  const cfg: McpServerConfig = { id, name, transport, auth, enabled }
  if (typeof obj.scope === 'string' && obj.scope.trim()) cfg.scope = obj.scope.trim()
  if (transport === 'sse' || transport === 'http') {
    if (typeof obj.url !== 'string' || !obj.url.trim())
      return `${transport} transport requires a url`
    cfg.url = obj.url.trim()
    // Optional static auth headers (e.g. Authorization: Bearer <token>).
    if (obj.headers && typeof obj.headers === 'object' && !Array.isArray(obj.headers)) {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(obj.headers as Record<string, unknown>)) {
        if (typeof v === 'string') headers[k] = v
      }
      if (Object.keys(headers).length) cfg.headers = headers
    }
  } else {
    if (typeof obj.command !== 'string' || !obj.command.trim())
      return 'A server that runs on this computer needs a "command" to start it (for example "npx")'
    cfg.command = obj.command.trim()
    if (Array.isArray(obj.args)) {
      cfg.args = obj.args.filter((a): a is string => typeof a === 'string')
    }
    if (obj.env && typeof obj.env === 'object' && !Array.isArray(obj.env)) {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
        if (typeof v === 'string') env[k] = v
      }
      cfg.env = env
    }
  }
  return cfg
}

/**
 * SECURITY BOUNDARY for stdio connectors — the same one hooks.ts draws around
 * hook authoring, for a strictly GREATER capability. A stdio connector is not
 * data: `enabled` defaults true (see sanitizeAddServerInput), so adding one
 * immediately reaches `new StdioClientTransport({ command, args, env })` in
 * mcp-manager.connectStdio and spawns a renderer-supplied executable with no
 * sandbox — and saveConfigs persists it, so it re-spawns on every later launch.
 *
 * Why this was invisible: sanitizeAddServerInput *looks* like the security
 * check. It is not — it validates SHAPE only (id is kebab-case, command is a
 * non-empty string) and passes command/args/env through verbatim. A reviewer
 * reading the handler sees a sanitizer called on untrusted input and stops.
 *
 * The dialog is native and main-process, so an injected script or a malicious
 * connector manifest the user pastes can call window.api.mcp.addServer but
 * cannot click it. Returns true only on explicit approval.
 *
 * Exported because `mcp:addServer` is not the only door to connectStdio: a
 * plugin's connectors.json reaches the same spawn (see the gate in
 * ipc/plugins.ts). One dialog, so the two ingresses cannot drift apart.
 */
export async function approveStdioConnector(cfg: McpServerConfig): Promise<boolean> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  const argLines = cfg.args?.length ? `\nArguments:\n${cfg.args.map((a) => `  ${a}`).join('\n')}` : ''
  // Show env KEYS only: values routinely carry API tokens and this dialog is
  // screen-shareable. The keys alone are what the user needs to judge reach.
  const envKeys = Object.keys(cfg.env ?? {})
  const envLine = envKeys.length ? `\nEnvironment: ${envKeys.join(', ')}` : ''
  const detail =
    `Connector: ${cfg.name} (${cfg.id})\n` +
    `\nThis program will run on your computer with your full user privileges, ` +
    `now and every time DUIN starts:\n\n` +
    `Command: ${cfg.command}` +
    argLines +
    envLine +
    `\n\nOnly continue if you trust the source of this connector.`
  const dialogOpts = {
    type: 'warning' as const,
    buttons: ['Cancel', 'Add connector'],
    defaultId: 0, // Enter → Cancel: safe default for a code-execution prompt
    cancelId: 0,
    noLink: true,
    title: 'Approve connector',
    message: 'Allow this connector to run a program on your computer?',
    detail
  }
  const r = win
    ? await dialog.showMessageBox(win, dialogOpts)
    : await dialog.showMessageBox(dialogOpts)
  return r.response === 1
}

const REDIRECT_PORT = 9876
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`
// NOTE (stage 5 — hands/act): calendar scope widened from `calendar.readonly` to the
// full `calendar` (read+WRITE) so DUIN can create/update/delete Calendar events. The
// full scope subsumes read, so ingest is unaffected. EXISTING USERS MUST RE-CONSENT
// (reconnect Google in Settings) for the new write scope to take effect — until then
// calendar write calls return HTTP 403 insufficientPermissions.
const SCOPES = 'https://mail.google.com/ https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar'

export function registerMcpHandlers(): void {
  ipcMain.handle('mcp:list', async () => {
    try {
      const servers = mcpManager.getServers()
      return { success: true, data: servers }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('mcp:getStatus', async (_event, id: string) => {
    try {
      const servers = mcpManager.getServers()
      const server = servers.find((s) => s.id === id)
      if (!server) return { success: false, error: `Server '${id}' not found` }
      return { success: true, data: { status: server.status, error: server.error } }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('mcp:reconnect', async (_event, id: string) => {
    try {
      await mcpManager.reconnect(id)
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  // MR — MCP Resources surface. list/read/templates delegate to the manager's
  // bounded + validated resource methods (capabilities probe, byte/item limits,
  // URI validation). Read-only, network-bound.
  ipcMain.handle('mcp:listResources', async (_event, id: string, cursor?: string) => {
    try {
      return { success: true, data: await mcpManager.listResources(id, cursor) }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('mcp:listResourceTemplates', async (_event, id: string, cursor?: string) => {
    try {
      return { success: true, data: await mcpManager.listResourceTemplates(id, cursor) }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('mcp:readResource', async (_event, id: string, uri: string) => {
    try {
      const contents = await mcpManager.readResource(id, uri)
      // Provenance guard: a server must not answer a read for one URI with
      // content stamped from a different URI.
      if (contents.some((content) => content.uri !== uri)) {
        return { success: false, error: `MCP server '${id}' returned mismatched resource content` }
      }
      return { success: true, data: contents }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  // Open a resource URI in the OS browser. http(s) ONLY, credentials STRIPPED
  // (a userinfo-bearing URL never reaches the browser with its secret), and a
  // native hostname-consent dialog the renderer cannot click through.
  ipcMain.handle('mcp:openResource', async (_event, id: string, uri: string) => {
    try {
      const url = new URL(uri)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return { success: false, error: 'Only HTTP(S) MCP resource links can open externally' }
      }
      // Strip any embedded credentials before the URL leaves the app.
      url.username = ''
      url.password = ''
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      const options = {
        type: 'question' as const,
        buttons: ['Cancel', 'Open'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Open MCP resource?',
        message: `Open ${url.hostname} outside DUIN?`,
        detail: `Connector: ${id}\n${url.toString()}`
      }
      const { response } = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options)
      if (response !== 1) return { success: false, error: 'Open cancelled by user.' }
      await shell.openExternal(url.toString())
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  // Customize C6: add a fresh connector. Sanitizes user-supplied config
  // (catalog click OR JSON paste from the renderer), then delegates to
  // mcpManager.addServerIfMissing so the id-collision check + persistence
  // path stays in one place.
  ipcMain.handle('mcp:addServer', async (_event, raw: unknown) => {
    try {
      const parsed = sanitizeAddServerInput(raw)
      if (typeof parsed === 'string') {
        return { success: false, error: parsed }
      }
      // SECURITY: a stdio connector spawns an executable the renderer chose.
      // Gate BEFORE addServerIfMissing — that call both persists the entry and
      // starts connecting, so approving afterwards would be too late. sse/http
      // connectors spawn nothing and stay ungated.
      if (parsed.transport === 'stdio') {
        const ok = await approveStdioConnector(parsed)
        if (!ok) return { success: false, error: 'Connector add cancelled' }
      }
      // Claim the id FIRST. The keychain write below is keyed on parsed.id, and
      // addServerIfMissing refuses an id that already exists — so writing first meant an
      // add that was about to be REFUSED had already overwritten the existing
      // connector's stored client credentials, breaking a working connector while
      // reporting a harmless "already exists". Ordering is the whole fix: nothing may
      // touch credentials for a connector this call did not create.
      const added = await mcpManager.addServerIfMissing(parsed)
      if (!added) {
        return { success: false, error: `Connector "${parsed.id}" already exists` }
      }

      // Pre-registered OAuth credentials go to the keychain under the key
      // McpOAuthProvider.clientInformation() reads, never into mcp-servers.json —
      // that file is plaintext and gets opened by hand.
      //
      // This used to run BEFORE the add, so the connect it triggers would already see
      // the credentials and skip dynamic registration. addServerIfMissing is awaited and
      // the connect it starts is not, so writing immediately after still lands before
      // any token exchange needs them; and a connector whose add was refused no longer
      // gets its predecessor's credentials clobbered.
      const raw_ = raw as Record<string, unknown>
      const clientId = typeof raw_.oauthClientId === 'string' ? raw_.oauthClientId.trim() : ''
      if (clientId) {
        const clientSecret =
          typeof raw_.oauthClientSecret === 'string' ? raw_.oauthClientSecret.trim() : ''
        keychain.setKey(
          `mcp-oauth:${parsed.id}:client`,
          JSON.stringify({ client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) })
        )
      }
      return { success: true, data: parsed }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('mcp:removeServer', async (_event, id: unknown) => {
    try {
      if (typeof id !== 'string' || !id) return { success: false, error: 'A connector id is required' }
      const removed = await mcpManager.removeServer(id)
      if (!removed) {
        return {
          success: false,
          error: `Couldn't remove "${id}" — it may belong to a plugin. Disable the plugin instead.`
        }
      }
      return { success: true, data: { id } }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('mcp:setEnabled', async (_event, id: unknown, enabled: unknown) => {
    try {
      if (typeof id !== 'string' || !id) return { success: false, error: 'A connector id is required' }
      if (typeof enabled !== 'boolean') return { success: false, error: 'enabled must be true or false' }
      const ok = await mcpManager.setServerEnabled(id, enabled)
      if (!ok) {
        return {
          success: false,
          error: `Couldn't change "${id}" — it may belong to a plugin. Disable the plugin instead.`
        }
      }
      return { success: true, data: { id, enabled } }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  // The config file is the escape hatch for anything the UI can't express (extra env,
  // a transport we don't offer). It was never mentioned anywhere, so nobody could find it.
  ipcMain.handle('mcp:openConfigFolder', async () => {
    try {
      shell.showItemInFolder(mcpManager.configPath())
      return { success: true, data: { path: mcpManager.configPath() } }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  // Part B — DUIN-local Google connector. A first-class connect grant that is
  // INDEPENDENT of any google-oauth MCP server row (boot purge deletes the
  // placeholder catalog server, so gating the UI on such a row left Google
  // permanently unreachable). This is a READ-ONLY keychain probe: token
  // presence via hasKey (no decrypt of the access token itself) plus the
  // non-sensitive expiry timestamp so the UI can render connected/expired.
  ipcMain.handle('mcp:googleAuthStatus', async () => {
    try {
      const connected = keychain.hasKey('google-access-token')
      let expiresAt: number | null = null
      let expired = false
      if (connected) {
        const expiryStr = keychain.getKey('google-token-expiry')
        const parsed = expiryStr ? parseInt(expiryStr, 10) : NaN
        if (Number.isFinite(parsed)) {
          expiresAt = parsed
          expired = Date.now() > parsed
        }
      }
      return { success: true, data: { connected, expired, expiresAt } }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('mcp:setupGoogleOAuth', async () => {
    try {
      const clientId = keychain.getKey('google-client-id')
      const clientSecret = keychain.getKey('google-client-secret')

      if (!clientId || !clientSecret) {
        return { success: false, error: 'Google client credentials not configured. Save client_id and client_secret first.' }
      }

      // SEC-9: per-flow CSRF token. Generated here, embedded in the auth
      // URL, verified in the callback handler. Single-use: a stale or
      // replayed state is rejected, even when the random value matches.
      const session = createOAuthSession()

      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      authUrl.searchParams.set('client_id', clientId)
      authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('scope', SCOPES)
      authUrl.searchParams.set('access_type', 'offline')
      authUrl.searchParams.set('prompt', 'consent')
      authUrl.searchParams.set('state', session.state)

      const code = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          server.close()
          reject(new Error('OAuth timeout — no callback received within 2 minutes'))
        }, 120_000)

        const server = createServer((req, res) => {
          const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`)
          // SEC-9: full decision tree (denied / missing-code / state-
          // mismatch / success) lives in `validateOAuthCallback` so it can
          // be tested without booting the http server. State verification
          // is single-use; a successful match consumes the session.
          const outcome = validateOAuthCallback(url, session)

          if (outcome.kind === 'denied') {
            res.writeHead(outcome.httpStatus, { 'Content-Type': 'text/html' })
            res.end('<html><body><h2>Authorization denied.</h2><p>You can close this tab.</p></body></html>')
            clearTimeout(timeout)
            server.close()
            reject(new Error(`OAuth denied: ${outcome.reason}`))
            return
          }

          if (outcome.kind === 'state-mismatch') {
            res.writeHead(outcome.httpStatus, { 'Content-Type': 'text/html' })
            res.end('<html><body><h2>OAuth state mismatch.</h2><p>Close this tab and start the flow again from DUIN.</p></body></html>')
            clearTimeout(timeout)
            server.close()
            reject(new Error(outcome.reason))
            return
          }

          if (outcome.kind === 'missing-code') {
            res.writeHead(outcome.httpStatus, { 'Content-Type': 'text/plain' })
            res.end(outcome.reason)
            return
          }

          // outcome.kind === 'success'
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><h2>DUIN connected!</h2><p>You can close this tab and return to the app.</p></body></html>')
          clearTimeout(timeout)
          server.close()
          resolve(outcome.code)
        })

        server.listen(REDIRECT_PORT, '127.0.0.1', () => {
          shell.openExternal(authUrl.toString())
        })

        server.on('error', (err) => {
          clearTimeout(timeout)
          reject(new Error(`Failed to start OAuth server: ${messageOf(err)}`, { cause: err }))
        })
      })

      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: REDIRECT_URI,
          grant_type: 'authorization_code'
        })
      })

      if (!tokenResponse.ok) {
        const errorBody = await tokenResponse.text()
        return { success: false, error: `Token exchange failed (${tokenResponse.status}): ${errorBody}` }
      }

      const tokenData = (await tokenResponse.json()) as {
        access_token: string
        refresh_token?: string
        expires_in: number
      }

      keychain.setKey('google-access-token', tokenData.access_token)
      if (tokenData.refresh_token) {
        keychain.setKey('google-refresh-token', tokenData.refresh_token)
      }
      keychain.setKey('google-token-expiry', String(Date.now() + tokenData.expires_in * 1000))

      console.log('[oauth] Tokens stored. Connecting Google MCP servers...')

      // Reconnect whatever google-oauth servers the user actually has (was
      // hardcoded to the now-removed placeholder gmail/drive defaults).
      const googleServers = mcpManager
        .getServers()
        .filter((s) => s.auth === 'google-oauth')
        .map((s) => s.id)
      const connectResults: string[] = []
      for (const id of googleServers) {
        try {
          await mcpManager.reconnect(id)
          connectResults.push(`${id}: connected`)
        } catch (err) {
          connectResults.push(`${id}: ${messageOf(err)}`)
        }
      }

      console.log('[oauth] Connection results:', connectResults.join(', '))
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  // mcp:approveToolCall is registered in chat.ts (handles confirmation flow)
}
