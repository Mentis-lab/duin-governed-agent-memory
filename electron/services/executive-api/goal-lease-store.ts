import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

// Executive API — goal leases (P1 membrane for fleet WRITES).
//
// N agents sharing ONE goal-state need write coordination; the operator does
// not. So leases live HERE, at the executive seam — the only path fleet
// principals can write through — and never in plan-goal-store: a user/system
// actor (the operator's UI, DUIN's own loops) always wins and is never
// lease-blocked. Leases coordinate the fleet, they do not fence the owner.
//
// Design (2026-08-14 prior-art research, folded into artifact 32f42d4b):
//  - Claim = lease with TTL, SQS-visibility-timeout style. A claim by the
//    current holder is a RENEWAL (idempotent); a claim on an expired lease is
//    a TAKEOVER (allowed, counted in leaseTransitions as a churn signal).
//  - Fencing epoch: every successful claim/takeover bumps a monotonic
//    per-goal epoch. Every write must present the epoch it claimed under;
//    a resurrected stale holder (its lease expired, someone else claimed)
//    presents an old epoch and is REJECTED even if it wakes inside the new
//    holder's window. Expiry-only leases without fencing admit stale writes
//    (Kleppmann's Redlock lesson) — the epoch is the part that makes this
//    safe, not the TTL.
//  - Renew-on-activity: LLM sessions cannot heartbeat on a timer, so every
//    successful write validation extends the lease. Idle = expiry.
//  - Durable across restarts (goals are durable, so their write-locks must
//    be): userData JSON, atomic replace, corrupt file fails CLOSED for
//    holders (no lease = nothing validates) but open for claims.
//
// Attribution rides here too (createdBy / lastWriter): the core Goal shape
// stays untouched; the "Connected agents" pane reads attribution from this
// ledger next to the goal id.

export interface GoalLease {
  goalId: string
  /** Principal id of the current holder; null after release/expiry-sweep. */
  holder: string | null
  holderName: string | null
  /** Monotonic fencing token; bumps on every claim/takeover, never resets. */
  epoch: number
  expiresAt: number | null
  /** TTL the current holder claimed under — renew-on-activity extends by THIS,
   *  not the default, so a 4h claim is never silently shrunk to 15m by its own
   *  writes. Absent on pre-fix records → default. */
  ttlMs?: number
  /** Times the lease changed hands (takeover after expiry or fresh claim
   *  after release). High churn = a goal the fleet is thrashing on. */
  leaseTransitions: number
  createdBy: string | null
  lastWriter: string | null
  lastWriteAt: number | null
}

export const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000
const MAX_LEASE_TTL_MS = 4 * 60 * 60 * 1000

interface StoreShape {
  version: 1
  leases: Record<string, GoalLease>
}

let pathOverride: string | null = null
let cache: StoreShape | null = null

function storePath(): string {
  if (pathOverride) return pathOverride
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as typeof import('electron')
  return join(app.getPath('userData'), 'executive-goal-leases.json')
}

function load(): StoreShape {
  if (cache) return cache
  const p = storePath()
  if (!existsSync(p)) {
    cache = { version: 1, leases: {} }
    return cache
  }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as StoreShape
    cache = { version: 1, leases: raw.leases && typeof raw.leases === 'object' ? raw.leases : {} }
  } catch {
    // Corrupt ledger: start empty. Holders lose their leases (fail closed for
    // writes); goals themselves are unharmed and re-claimable.
    cache = { version: 1, leases: {} }
  }
  return cache
}

function persist(): void {
  const p = storePath()
  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${p}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(load(), null, 2), 'utf-8')
  renameSync(tmp, p)
}

function leaseOf(goalId: string): GoalLease {
  const store = load()
  let lease = store.leases[goalId]
  if (!lease) {
    lease = {
      goalId,
      holder: null,
      holderName: null,
      epoch: 0,
      expiresAt: null,
      leaseTransitions: 0,
      createdBy: null,
      lastWriter: null,
      lastWriteAt: null
    }
    store.leases[goalId] = lease
  }
  return lease
}

function isLive(lease: GoalLease, now: number): boolean {
  return lease.holder !== null && lease.expiresAt !== null && lease.expiresAt > now
}

export function recordGoalCreation(goalId: string, principalId: string): void {
  const lease = leaseOf(goalId)
  lease.createdBy = principalId
  persist()
}

export type ClaimResult =
  | { ok: true; epoch: number; expiresAt: number; renewed: boolean; tookOver: boolean }
  | { ok: false; reason: 'held'; holder: string; holderName: string | null; expiresAt: number }

/** Claim (or renew, for the current holder) the write lease on a goal. */
export function claimGoalLease(
  goalId: string,
  principalId: string,
  principalName: string,
  ttlMs = DEFAULT_LEASE_TTL_MS,
  now = Date.now()
): ClaimResult {
  const ttl = Math.max(60_000, Math.min(Math.floor(ttlMs), MAX_LEASE_TTL_MS))
  const lease = leaseOf(goalId)
  if (isLive(lease, now) && lease.holder !== principalId) {
    return {
      ok: false,
      reason: 'held',
      holder: lease.holder as string,
      holderName: lease.holderName,
      expiresAt: lease.expiresAt as number
    }
  }
  const renewed = lease.holder === principalId && isLive(lease, now)
  const tookOver = !renewed && lease.holder !== null && lease.holder !== principalId
  if (!renewed) {
    // Fresh claim or takeover: the epoch bumps so any write fenced to the
    // previous holder's epoch is dead on arrival, even if that holder wakes.
    lease.epoch += 1
    lease.leaseTransitions += lease.holder === null && lease.epoch === 1 ? 0 : 1
    lease.holder = principalId
    lease.holderName = principalName
  }
  lease.ttlMs = ttl
  lease.expiresAt = now + ttl
  persist()
  return { ok: true, epoch: lease.epoch, expiresAt: lease.expiresAt, renewed, tookOver }
}

export type WriteAuthResult =
  | { ok: true }
  | {
      ok: false
      reason: 'no-lease' | 'not-holder' | 'stale-epoch' | 'expired'
      holder?: string | null
      currentEpoch?: number
    }

/**
 * Fence check for a fleet write. On success the lease renews (renew-on-
 * activity) and attribution is stamped. Every failure names its cause so the
 * agent can self-correct ("re-claim with duin_goal_claim").
 */
export function authorizeGoalWrite(
  goalId: string,
  principalId: string,
  epoch: number,
  now = Date.now()
): WriteAuthResult {
  const store = load()
  const lease = store.leases[goalId]
  if (!lease || lease.holder === null) return { ok: false, reason: 'no-lease' }
  if (lease.holder !== principalId) {
    return { ok: false, reason: 'not-holder', holder: lease.holder, currentEpoch: lease.epoch }
  }
  if (lease.epoch !== epoch) {
    // The goal changed hands since this caller claimed (its lease expired and
    // someone took over, then it came back). Its authority is gone.
    return { ok: false, reason: 'stale-epoch', currentEpoch: lease.epoch }
  }
  if (lease.expiresAt === null || lease.expiresAt <= now) {
    return { ok: false, reason: 'expired' }
  }
  // Renew by the TTL this holder CLAIMED under, and never shrink: a write
  // must extend authority, not truncate a 4h grant to the 15m default.
  const granted = Math.max(
    60_000,
    Math.min(Math.floor(lease.ttlMs ?? DEFAULT_LEASE_TTL_MS), MAX_LEASE_TTL_MS)
  )
  lease.expiresAt = Math.max(lease.expiresAt, now + granted)
  lease.lastWriter = principalId
  lease.lastWriteAt = now
  persist()
  return { ok: true }
}

export function releaseGoalLease(
  goalId: string,
  principalId: string,
  epoch: number,
  now = Date.now()
): { ok: boolean } {
  const store = load()
  const lease = store.leases[goalId]
  if (!lease || lease.holder !== principalId || lease.epoch !== epoch) return { ok: false }
  lease.holder = null
  lease.holderName = null
  lease.expiresAt = null
  void now
  persist()
  return { ok: true }
}

/** Read-side enrichment for duin_goals: who holds what, epoch, churn. */
export function getGoalLease(goalId: string, now = Date.now()): GoalLease & { live: boolean } {
  const lease = leaseOf(goalId)
  return { ...lease, live: isLive(lease, now) }
}

export function dropLeaseRecord(goalId: string): void {
  const store = load()
  if (store.leases[goalId]) {
    delete store.leases[goalId]
    persist()
  }
}

export const __goalLeaseTest = {
  setPath(p: string | null): void {
    pathOverride = p
    cache = null
  },
  reset(): void {
    cache = null
  }
}
