// Pairing store — per-(channelId, externalUserId) trust state, persisted to
// pairings.json. This is the connectivity "who may talk to my brain" gate: an
// external user on a channel is DENY-FIRST — unknown/pending until the operator
// explicitly approves them. Deliberately mirrors connections-store.ts's JSON
// persistence so the path is injectable (→ unit-testable off Electron).
//
// The one-time pairing CODE reuses oauth-state's CSRF token generator
// (generateOAuthState → 192-bit base64url). It's single-use: consuming it via
// approveByCode() clears it, so a leaked/replayed code can't re-approve.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { generateOAuthState } from '../oauth-state'
import { messageOf } from '../guarded'
import type { ChannelAuthorization } from './channel-adapter'

export type PairingStatus = 'pending' | 'approved' | 'revoked'

export interface PairingRecord {
  channelId: string
  externalUserId: string
  status: PairingStatus
  /** One-time pairing code; null once consumed (approveByCode) or not pending. */
  code: string | null
  createdAt: number
  updatedAt: number
}

type PairingMap = Record<string, PairingRecord>

let pairings: PairingMap = {}
let storePath: string | null = null

const keyOf = (channelId: string, externalUserId: string): string =>
  `${channelId}:${externalUserId}`

export function setPairingPath(userDataDir: string): void {
  storePath = join(userDataDir, 'pairings.json')
  try {
    if (existsSync(storePath)) {
      const raw = JSON.parse(readFileSync(storePath, 'utf-8')) as { pairings?: PairingMap }
      pairings = raw.pairings && typeof raw.pairings === 'object' ? raw.pairings : {}
    } else {
      pairings = {}
    }
  } catch {
    pairings = {}
  }
}

function persist(): void {
  if (!storePath) return
  try {
    mkdirSync(dirname(storePath), { recursive: true })
    writeFileSync(storePath, JSON.stringify({ pairings }, null, 2), 'utf-8')
  } catch (e) {
    console.debug('[pairing-store] best-effort persist:', messageOf(e))
  }
}

export function getPairing(channelId: string, externalUserId: string): PairingRecord | null {
  return pairings[keyOf(channelId, externalUserId)] ?? null
}

/**
 * Map the raw pairing status → the ChannelAdapter.authorizeUser verdict.
 * DENY-FIRST: an unknown or revoked user is NOT allowed. 'pending' means
 * "pairing requested, awaiting operator approval" — not authorized to run a
 * turn, but distinguishable from a hard 'denied' (revoked) so the adapter can
 * surface the pairing code instead of silently dropping the message.
 */
export function authorizeStatus(channelId: string, externalUserId: string): ChannelAuthorization {
  const rec = getPairing(channelId, externalUserId)
  if (!rec) return 'pending'
  if (rec.status === 'approved') return 'approved'
  if (rec.status === 'revoked') return 'denied'
  return 'pending'
}

/**
 * Begin (or refresh) pairing for an external user. If already approved, returns
 * the approved record untouched (no new code minted). Otherwise creates/updates
 * a PENDING record with a fresh single-use code and returns it. Re-requesting
 * from a revoked state re-opens a pending request (operator can re-approve).
 */
export function requestPairing(channelId: string, externalUserId: string): PairingRecord {
  const key = keyOf(channelId, externalUserId)
  const existing = pairings[key]
  if (existing && existing.status === 'approved') return existing
  const now = Date.now()
  const rec: PairingRecord = {
    channelId,
    externalUserId,
    status: 'pending',
    code: generateOAuthState(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  pairings[key] = rec
  persist()
  return rec
}

/** Approve a specific user directly (operator action from the UI). */
export function approvePairing(channelId: string, externalUserId: string): boolean {
  const key = keyOf(channelId, externalUserId)
  const now = Date.now()
  const existing = pairings[key]
  pairings[key] = {
    channelId,
    externalUserId,
    status: 'approved',
    code: null, // consume any outstanding code on approval
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  persist()
  return true
}

/**
 * Approve whichever PENDING user in `channelId` holds `code`. Single-use: the
 * code is cleared on success, so a second call with the same code finds nothing
 * and returns null. Returns the approved externalUserId, or null if no pending
 * record matches (wrong / already-consumed / expired code).
 */
export function approveByCode(channelId: string, code: string): string | null {
  const trimmed = (code ?? '').trim()
  if (!trimmed) return null
  for (const rec of Object.values(pairings)) {
    if (rec.channelId === channelId && rec.status === 'pending' && rec.code === trimmed) {
      approvePairing(channelId, rec.externalUserId)
      return rec.externalUserId
    }
  }
  return null
}

/** Revoke a user (hard deny). Clears any outstanding code. */
export function revokePairing(channelId: string, externalUserId: string): boolean {
  const key = keyOf(channelId, externalUserId)
  const existing = pairings[key]
  if (!existing) return false
  pairings[key] = { ...existing, status: 'revoked', code: null, updatedAt: Date.now() }
  persist()
  return true
}

/** All pairings, optionally filtered to one channel. Codes are omitted here —
 *  the UI should never render a live pairing code back into a list view. */
export function listPairings(channelId?: string): Omit<PairingRecord, 'code'>[] {
  return Object.values(pairings)
    .filter((r) => !channelId || r.channelId === channelId)
    .map(({ code: _code, ...rest }) => rest)
}
