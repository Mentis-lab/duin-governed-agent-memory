import { createOAuthSession, type OAuthSession } from './oauth-state'
import { decideMcpCallback, type McpCallbackDecision } from './mcp-oauth-callback'

// Per-server registry for in-flight generic-MCP OAuth flows. Split out of mcp-oauth.ts (which
// transitively imports electron and so can't be unit tested) for the same reason
// mcp-oauth-callback.ts was: the boundary this fix is about deserves a test that can actually run.
//
// BUG THIS REPLACES: the flow used to live behind two bare module-level `let` singletons in
// mcp-oauth.ts (`pending` / `activeSession`) shared by every McpOAuthProvider instance regardless
// of which MCP server it belonged to. mcp-manager.ts's initialize() fires connectServer() for
// every enabled server WITHOUT awaiting each one (see its `for` loop), so two OAuth-authed
// servers connecting at app launch genuinely race: server B's state()/waitForCode() calls
// reassigned both singletons out from under server A's still-pending flow. Worse, A's own
// 5-minute timeout handler did `if (pending) { pending = null; reject(...) }` — true regardless
// of WHOSE flow `pending` currently held — so A's timer firing late could silently null out B's
// live registration and reject A's promise, after which B's correctly state-verified callback
// would find `pending === null` and be silently dropped even though the browser told the user
// authorization was complete. Keying every entry by serverId (the one thing each
// McpOAuthProvider instance always has, and never shares with a sibling) removes the collision:
// two flows for two servers now own two independent slots.

interface PendingCode {
  resolve: (code: string) => void
  reject: (e: Error) => void
}

const sessionsByServer = new Map<string, OAuthSession>()
const pendingByServer = new Map<string, PendingCode>()

/** `state()`: mint a fresh single-use session for this server, filed under its own key. */
export function beginOAuthSession(serverId: string): OAuthSession {
  const session = createOAuthSession()
  sessionsByServer.set(serverId, session)
  return session
}

/**
 * `waitForCode()`: register the resolve/reject pair for this server's in-flight callback.
 * Returns a `clear()` that the caller's timeout path must invoke instead of touching any shared
 * state directly. `clear()` is identity-checked against whatever is currently filed under
 * `serverId`, so a stale timeout firing after this entry was already settled (a real callback
 * arrived) or superseded (a newer flow started for the same server) is a safe no-op rather than
 * reaching in and deleting someone else's live registration — the exact bug this module fixes.
 */
export function registerPending(
  serverId: string,
  resolve: (code: string) => void,
  reject: (e: Error) => void
): () => void {
  const entry: PendingCode = { resolve, reject }
  pendingByServer.set(serverId, entry)
  return () => {
    if (pendingByServer.get(serverId) === entry) pendingByServer.delete(serverId)
  }
}

/**
 * Route one loopback callback request to whichever in-flight server's session verifies its
 * `state`, then settle (and clear) THAT server's pending promise only. The wire callback carries
 * just `code`/`state` — no serverId — so `state` is the sole correlator; that is the whole reason
 * OAuth has a state param. `OAuthSession.verify` is single-use and a failed match has no side
 * effect (it only flips to consumed on success), so probing every candidate session in turn is
 * safe and leaves every non-matching flow untouched.
 */
export function routeOAuthCallback(url: URL): McpCallbackDecision {
  for (const [serverId, session] of sessionsByServer) {
    const decision = decideMcpCallback(url, session)
    if (decision.kind === 'drop') continue
    sessionsByServer.delete(serverId)
    const pending = pendingByServer.get(serverId)
    if (pending) {
      pendingByServer.delete(serverId)
      if (decision.kind === 'resolve') pending.resolve(decision.code)
      else pending.reject(new Error(decision.reason))
    }
    return decision
  }
  return { kind: 'drop' }
}
