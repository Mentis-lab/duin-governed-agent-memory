import type { OAuthSession } from './oauth-state'

// Pure decision logic for the generic-MCP OAuth loopback callback, split out
// of mcp-oauth.ts (which transitively imports electron and so can't be unit
// tested). The callback server there is a long-lived localhost listener that
// stays up for the whole ~5-minute consent window, so the state check is the
// only thing standing between the user's token store and any web page that
// fires a cross-origin GET at the loopback port with an attacker-chosen code.

export type McpCallbackDecision =
  | { kind: 'resolve'; code: string }
  | { kind: 'reject'; reason: string }
  | { kind: 'drop' }

/**
 * Decide what a single loopback callback request should do to the pending
 * auth promise.
 *
 * State is verified FIRST, before either `code` or `error` is honoured, and a
 * failed state check yields `drop` (not `reject`). That ordering is the whole
 * point:
 *   - a forged `?code=…` with no/wrong state can't inject a code, AND
 *   - a forged `?error=…` (or any stray request to the loopback port) can't
 *     settle — and therefore can't DoS — the real callback that follows,
 *     because `drop` leaves the pending promise untouched.
 * The sibling browser flows (mcp.ts / github-service.ts) can afford to reject
 * on mismatch because each uses a per-flow server it closes immediately; this
 * one reuses a persistent server, so a mismatch must be inert, not fatal.
 *
 * `session.verify` is single-use, so this must be called exactly once per
 * request. A missing session (callback with no auth in flight) also drops.
 */
export function decideMcpCallback(
  url: URL,
  session: OAuthSession | null
): McpCallbackDecision {
  if (!session) return { kind: 'drop' }
  if (!session.verify(url.searchParams.get('state'))) return { kind: 'drop' }
  const error = url.searchParams.get('error')
  if (error) return { kind: 'reject', reason: error }
  const code = url.searchParams.get('code')
  if (!code) return { kind: 'reject', reason: 'authorization response missing code' }
  return { kind: 'resolve', code }
}
