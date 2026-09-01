// Shared Google OAuth token freshness (audit C8 — DUIN_AUDIT_REMEDIATION.md).
//
// Google access tokens expire ~1h after issue. Previously ONLY the MCP-connect path
// refreshed them (mcp-manager); the ingest adapters (Gmail/Calendar) read
// `google-access-token` directly and never refreshed, so ingest silently died ~1h
// after the user connected Google — the 30-min sync loop kept running against a dead
// token. This helper is the single freshness gate both paths call.

import * as keychain from './keychain'
import { messageOf } from './guarded'

// Refresh a minute before the real expiry so an in-flight request never races it.
const EXPIRY_BUFFER_MS = 60_000

/**
 * Return a valid Google access token, refreshing it first if it's missing / expired /
 * within the buffer of expiry. Returns null when there's no usable token and no way to
 * refresh (caller should then treat Google as not configured).
 */
export async function ensureFreshGoogleToken(): Promise<string | null> {
  const token = keychain.getKey('google-access-token')
  const expiryRaw = keychain.getKey('google-token-expiry')
  const expiry = expiryRaw ? Number(expiryRaw) : 0
  if (token && expiry && Number.isFinite(expiry) && Date.now() < expiry - EXPIRY_BUFFER_MS) {
    return token
  }
  const ok = await refreshGoogleToken()
  return ok ? keychain.getKey('google-access-token') : token ?? null
}

let inFlightRefresh: Promise<boolean> | null = null

/**
 * Exchange the stored refresh token for a new access token + expiry. Returns false when OAuth
 * credentials are missing or the exchange fails. M4 single-flight: concurrent callers (Gmail +
 * Calendar ingest share this helper) await ONE exchange — two parallel refreshes can make Google
 * invalidate the first token when the second lands, handing a caller an instantly-dead token.
 */
export async function refreshGoogleToken(): Promise<boolean> {
  if (inFlightRefresh) return inFlightRefresh
  inFlightRefresh = doRefreshGoogleToken().finally(() => {
    inFlightRefresh = null
  })
  return inFlightRefresh
}

async function doRefreshGoogleToken(): Promise<boolean> {
  const refreshToken = keychain.getKey('google-refresh-token')
  const clientId = keychain.getKey('google-client-id')
  const clientSecret = keychain.getKey('google-client-secret')
  if (!refreshToken || !clientId || !clientSecret) return false
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      })
    })
    if (!response.ok) {
      console.error('[google-auth] token refresh failed:', response.status)
      return false
    }
    const data = (await response.json()) as { access_token: string; expires_in: number }
    keychain.setKey('google-access-token', data.access_token)
    keychain.setKey('google-token-expiry', String(Date.now() + data.expires_in * 1000))
    return true
  } catch (err) {
    console.error('[google-auth] token refresh error:', messageOf(err))
    return false
  }
}
