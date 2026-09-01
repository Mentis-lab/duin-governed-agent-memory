// Pending interactions — the AWAITING-REPLY primitive that makes connectivity
// TWO-WAY. A proactive send that expects an answer (an approval prompt, a nudge
// the user can reply to) registers a pending interaction here BEFORE it goes out.
// When an inbound message later arrives on the same (channelId, userId), the
// channel runtime consults resolveByReply() FIRST: if an open interaction matches,
// the reply is routed to it instead of starting a fresh de-privileged brain turn.
//
// SECURITY (the part that matters):
//   • An interaction is scoped to the exact (channelId, userId) it was created for.
//     resolveByReply(channelId, userId, …) only ever matches interactions for THAT
//     pair, so one user can never resolve another user's pending interaction.
//   • resolveByReply is a ROUTING + bookkeeping primitive ONLY. Marking an
//     interaction 'resolved' and returning it does NOT execute anything. For an
//     'approval' interaction, the caller that acts on the returned record is
//     responsible for the STRONGER operator-designation + single-use + replay
//     checks before it lets the reply authorize a gated action. This module
//     provides single-use (an interaction resolves at most once) and expiry
//     (an open interaction past expiresAt can never resolve) as the substrate
//     those guards build on — it does not itself grant any privilege.
//
// Persistence mirrors pairing-store.ts (injectable path → unit-testable off
// Electron). When no path is set the store is an empty in-memory map, so
// resolveByReply simply returns null and the runtime falls through to a fresh turn.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { messageOf } from '../guarded'

export type InteractionKind = 'approval' | 'nudge'
export type InteractionStatus = 'open' | 'resolved' | 'expired'

export interface PendingInteraction {
  id: string
  channelId: string
  userId: string
  kind: InteractionKind
  /** The prompt text that was sent out asking for this reply (for audit/UI). */
  prompt: string
  /** Opaque caller payload (e.g. the gated action to run once approved). */
  payload: Record<string, unknown>
  createdAt: number
  expiresAt: number
  status: InteractionStatus
  /** Set once, when the interaction transitions out of 'open'. */
  resolvedAt: number | null
  /** The inbound reply text that resolved it (null if expired unresolved). */
  replyText: string | null
}

/** Default time-to-live for a pending interaction: 15 minutes. */
const DEFAULT_TTL_MS = 15 * 60_000

type InteractionMap = Record<string, PendingInteraction>

let interactions: InteractionMap = {}
let storePath: string | null = null

export function setPendingInteractionsPath(userDataDir: string): void {
  storePath = join(userDataDir, 'pending-interactions.json')
  try {
    if (existsSync(storePath)) {
      const raw = JSON.parse(readFileSync(storePath, 'utf-8')) as { interactions?: InteractionMap }
      interactions = raw.interactions && typeof raw.interactions === 'object' ? raw.interactions : {}
    } else {
      interactions = {}
    }
  } catch {
    interactions = {}
  }
}

function persist(): void {
  if (!storePath) return
  try {
    mkdirSync(dirname(storePath), { recursive: true })
    writeFileSync(storePath, JSON.stringify({ interactions }, null, 2), 'utf-8')
  } catch (e) {
    console.debug('[pending-interactions] best-effort persist:', messageOf(e))
  }
}

export interface CreateInteractionInput {
  channelId: string
  userId: string
  kind: InteractionKind
  prompt: string
  payload?: Record<string, unknown>
  /** Override the default TTL. */
  ttlMs?: number
  now?: number
}

/** Register a new open interaction awaiting a reply. */
export function createInteraction(input: CreateInteractionInput): PendingInteraction {
  const now = input.now ?? Date.now()
  const ttl = input.ttlMs && input.ttlMs > 0 ? input.ttlMs : DEFAULT_TTL_MS
  const rec: PendingInteraction = {
    id: randomUUID(),
    channelId: input.channelId,
    userId: input.userId,
    kind: input.kind,
    prompt: input.prompt,
    payload: input.payload ?? {},
    createdAt: now,
    expiresAt: now + ttl,
    status: 'open',
    resolvedAt: null,
    replyText: null
  }
  interactions[rec.id] = rec
  persist()
  return rec
}

/**
 * Mark any open interaction whose expiresAt has passed as 'expired'. Returns the
 * expired records. Called at the top of resolveByReply and on the tick sweep so a
 * stale prompt can never be resolved by a late reply. Persists if anything changed.
 */
export function sweepExpired(now: number = Date.now()): PendingInteraction[] {
  const expired: PendingInteraction[] = []
  for (const rec of Object.values(interactions)) {
    if (rec.status === 'open' && rec.expiresAt <= now) {
      rec.status = 'expired'
      rec.resolvedAt = now
      expired.push(rec)
    }
  }
  if (expired.length) persist()
  return expired
}

/**
 * Route an inbound reply from (channelId, userId) to the OLDEST open interaction
 * for that exact pair. Expiry is swept first, so a reply can only match a still-
 * valid interaction. On a match the interaction is marked 'resolved' (single-use:
 * a second reply finds nothing) and returned; otherwise null. Returning null tells
 * the runtime "no pending interaction — run a fresh turn".
 *
 * `opts.kinds` optionally restricts the match to specific interaction kinds. The
 * channel runtime uses this to keep the GENERIC reply path (`['nudge']`) from ever
 * consuming an operator-gated 'approval' interaction — those are resolved only via
 * the operator-authenticated path in approval-roundtrip.ts. Omitting `kinds`
 * preserves the original any-kind behavior.
 */
export function resolveByReply(
  channelId: string,
  userId: string,
  text: string,
  now: number = Date.now(),
  opts?: { kinds?: InteractionKind[] }
): PendingInteraction | null {
  sweepExpired(now)
  const kinds = opts?.kinds
  const open = Object.values(interactions)
    .filter(
      (r) =>
        r.status === 'open' &&
        r.channelId === channelId &&
        r.userId === userId &&
        (!kinds || kinds.includes(r.kind))
    )
    .sort((a, b) => a.createdAt - b.createdAt)
  const oldest = open[0]
  if (!oldest) return null
  oldest.status = 'resolved'
  oldest.resolvedAt = now
  oldest.replyText = text
  persist()
  return oldest
}

/**
 * Resolve one SPECIFIC open interaction by id — the primitive the operator-gated
 * approval path uses so a reply can only ever close the EXACT pending action it was
 * routed to (never a different or broader one). Single-use + expiry-checked:
 *   • past expiry (or already swept) → null (a late reply can't approve).
 *   • already resolved/expired       → null (replay-safe; a second call finds nothing).
 *   • `expectKind` mismatch          → null (a nudge id can't be closed as an approval).
 * On success the record is marked 'resolved', stamped with the reply, and returned.
 */
export function resolveById(
  id: string,
  text: string,
  now: number = Date.now(),
  opts?: { expectKind?: InteractionKind }
): PendingInteraction | null {
  const rec = interactions[id]
  if (!rec) return null
  if (rec.status !== 'open') return null
  if (rec.expiresAt <= now) {
    // Lapsed — expire it in place so nothing can resolve it later, then refuse.
    rec.status = 'expired'
    rec.resolvedAt = now
    persist()
    return null
  }
  if (opts?.expectKind && rec.kind !== opts.expectKind) return null
  rec.status = 'resolved'
  rec.resolvedAt = now
  rec.replyText = text
  persist()
  return rec
}

/**
 * List OPEN, unexpired interactions matching an optional (channelId, userId, kind)
 * filter, OLDEST first (FIFO). Read-only — does not mutate or sweep. The approval
 * resolver uses this to locate the pending 'approval' for a channel before applying
 * the operator gate.
 */
export function listOpen(
  filter: { channelId?: string; userId?: string; kind?: InteractionKind } = {},
  now: number = Date.now()
): PendingInteraction[] {
  return Object.values(interactions)
    .filter(
      (r) =>
        r.status === 'open' &&
        r.expiresAt > now &&
        (!filter.channelId || r.channelId === filter.channelId) &&
        (!filter.userId || r.userId === filter.userId) &&
        (!filter.kind || r.kind === filter.kind)
    )
    .sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Cancel an OPEN interaction by marking it 'expired'. Used when the outbound push
 * that would have solicited a reply never reached the operator (dispatch failed):
 * we must NOT leave an approvable window open for an action the operator never saw.
 * Returns true if an open interaction was cancelled.
 */
export function cancelInteraction(id: string, now: number = Date.now()): boolean {
  const rec = interactions[id]
  if (!rec || rec.status !== 'open') return false
  rec.status = 'expired'
  rec.resolvedAt = now
  persist()
  return true
}

/**
 * Drop terminal ('resolved' / 'expired') interactions whose resolvedAt is older than
 * `olderThanMs`, to bound the persisted store in an always-on app. NEVER removes an
 * 'open' interaction (a still-answerable window), and never one without a resolvedAt
 * stamp. Returns the number pruned. Called from the automations tick. Persists once
 * if anything changed.
 */
export function pruneInteractions(olderThanMs: number, now: number = Date.now()): number {
  let pruned = 0
  for (const [id, rec] of Object.entries(interactions)) {
    if (
      (rec.status === 'resolved' || rec.status === 'expired') &&
      rec.resolvedAt !== null &&
      now - rec.resolvedAt > olderThanMs
    ) {
      delete interactions[id]
      pruned++
    }
  }
  if (pruned) persist()
  return pruned
}

export function getInteraction(id: string): PendingInteraction | null {
  return interactions[id] ?? null
}

/** All interactions, optionally filtered by status. Newest first. */
export function listInteractions(status?: InteractionStatus): PendingInteraction[] {
  return Object.values(interactions)
    .filter((r) => !status || r.status === status)
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** True if the given user has any open (unexpired) interaction awaiting a reply. */
export function hasOpenInteraction(
  channelId: string,
  userId: string,
  now: number = Date.now()
): boolean {
  return Object.values(interactions).some(
    (r) => r.status === 'open' && r.channelId === channelId && r.userId === userId && r.expiresAt > now
  )
}
