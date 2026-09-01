import { createServer, type Server } from 'http'
import { shell } from 'electron'
import * as keychain from './keychain'
import { beginOAuthSession, registerPending, routeOAuthCallback } from './mcp-oauth-registry'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientMetadata,
  OAuthClientInformation,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'

// Generic OAuth 2.1 for remote MCP servers (the MCP authorization spec) — the
// gap that blocked connecting hosted servers (Linear/Notion/etc.) that require
// their own OAuth. The SDK drives discovery + dynamic client registration + PKCE
// + token exchange; this provider supplies (1) a persistent per-server token/
// client store (encrypted keychain), (2) a loopback callback to capture the auth
// code, and (3) opening the system browser for consent.
//
// Distinct loopback port from the Google-OAuth handler (9876) to avoid clashes.

const CALLBACK_PORT = 9877
const CALLBACK_PATH = '/oauth/callback'
export const MCP_OAUTH_REDIRECT_URL = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`

// The CSRF state for each server's in-flight flow, and the promise callback awaiting its code,
// live in mcp-oauth-registry.ts keyed by serverId — NOT here as bare module-level singletons.
// Multiple OAuth-authed MCP servers can (and at app launch, do — see mcp-manager.ts's
// unawaited connectServer loop) have flows in flight at once; a single shared slot let one
// server's timeout or new attempt silently clobber another's pending consent. See that module's
// header comment for the full history.
let callbackServer: Server | null = null

function ensureCallbackServer(): void {
  if (callbackServer) return
  callbackServer = createServer((req, res) => {
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${CALLBACK_PORT}`)
    if (u.pathname !== CALLBACK_PATH) {
      res.writeHead(404)
      res.end()
      return
    }
    // SEC: verify the OAuth `state` before honouring anything on this callback.
    // The loopback server stays up for the whole ~5-minute consent window on a
    // fixed localhost port, so any page the user has open can fire a
    // cross-origin GET at it with an attacker-chosen ?code. The old handler
    // resolved `pending` with whatever code arrived and finishAuth then
    // persisted the attacker's tokens under the user's server id — this flow,
    // unlike its two siblings, sent no state and verified none. `state()` now
    // puts a 192-bit token on the auth URL; a callback whose state doesn't
    // echo it back is dropped (left inert) so a forgery can neither inject a
    // code nor DoS the legitimate callback that follows. routeOAuthCallback
    // also picks out WHICH server this callback belongs to (by matching state
    // against every in-flight session) and resolves only that server's pending
    // promise, so one server's callback can never settle another's.
    const decision = routeOAuthCallback(u)
    const ok = decision.kind === 'resolve'
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(
      `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0f1115;color:#e8e8e8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>DUIN — authorization ${
        ok ? 'complete ✓' : 'failed'
      }</h2><p>You can close this window and return to DUIN.</p></div></body>`
    )
  })
  callbackServer.on('error', (e) => console.error('[mcp-oauth] callback server error:', e.message))
  callbackServer.listen(CALLBACK_PORT, '127.0.0.1')
}

function k(serverId: string, field: string): string {
  return `mcp-oauth:${serverId}:${field}`
}

export class McpOAuthProvider implements OAuthClientProvider {
  private verifierMem?: string
  constructor(
    private readonly serverId: string,
    private readonly scope?: string
  ) {}

  get redirectUrl(): string {
    return MCP_OAUTH_REDIRECT_URL
  }

  get clientMetadata(): OAuthClientMetadata {
    // Public (no client secret) + PKCE — the recommended posture for a native app.
    return {
      client_name: 'DUIN',
      redirect_uris: [MCP_OAUTH_REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.scope ? { scope: this.scope } : {})
    }
  }

  clientInformation(): OAuthClientInformation | undefined {
    const raw = keychain.getKey(k(this.serverId, 'client'))
    return raw ? (JSON.parse(raw) as OAuthClientInformation) : undefined
  }

  saveClientInformation(info: OAuthClientInformation): void {
    keychain.setKey(k(this.serverId, 'client'), JSON.stringify(info))
  }

  tokens(): OAuthTokens | undefined {
    const raw = keychain.getKey(k(this.serverId, 'tokens'))
    return raw ? (JSON.parse(raw) as OAuthTokens) : undefined
  }

  saveTokens(tokens: OAuthTokens): void {
    keychain.setKey(k(this.serverId, 'tokens'), JSON.stringify(tokens))
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifierMem = codeVerifier
    keychain.setKey(k(this.serverId, 'verifier'), codeVerifier)
  }

  codeVerifier(): string {
    return this.verifierMem ?? keychain.getKey(k(this.serverId, 'verifier')) ?? ''
  }

  /**
   * SDK hook: the value returned here is set as the `state` query param on the
   * authorization URL (client/auth.js calls `provider.state()` in `auth()`).
   * Without this hook the SDK sends no state and the loopback callback has
   * nothing to verify — the CSRF hole this fixes. We mint a single-use session
   * and file it in the registry under this.serverId (NOT a shared module
   * slot — see mcp-oauth-registry.ts) so `ensureCallbackServer`'s handler can
   * verify the echoed-back state against the right server's session even
   * while another server's OAuth flow is in flight at the same time.
   */
  state(): string {
    return beginOAuthSession(this.serverId).state
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    ensureCallbackServer()
    await shell.openExternal(authorizationUrl.toString())
  }

  /** Await the auth code delivered to the loopback callback (5 min cap). */
  waitForCode(timeoutMs = 300_000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        clear()
        reject(new Error('OAuth authorization timed out (no callback within 5 minutes)'))
      }, timeoutMs)
      // registerPending files this under this.serverId and hands back a `clear` that only
      // removes THIS registration (identity-checked), so a late timeout can't null out a
      // different server's still-live pending callback the way the old shared slot did.
      const clear = registerPending(
        this.serverId,
        (code) => {
          clearTimeout(timer)
          resolve(code)
        },
        (e) => {
          clearTimeout(timer)
          reject(e)
        }
      )
    })
  }

  /**
   * Forget stored tokens/client for this server (re-auth from scratch).
   *
   * Deletes the keychain rows outright — `setKey(k, '')` (the previous body) only
   * overwrites the VALUE; the row (and `hasKey`) survives. That distinction went
   * unnoticed because this method had no caller anywhere in the app: removeServer()
   * in mcp-manager.ts dropped the connector from mcp-servers.json but never touched
   * its keychain namespace, so the real token ciphertext (not even blanked) sat
   * there untouched. Re-adding the same connector id later — e.g. re-pointed at a
   * different self-hosted/staging host — would then hand that OLD server's bearer
   * token to the FIRST request against the NEW one. See removeServer's call site.
   */
  clear(): void {
    keychain.deleteKey(k(this.serverId, 'tokens'))
    keychain.deleteKey(k(this.serverId, 'client'))
    keychain.deleteKey(k(this.serverId, 'verifier'))
  }
}
