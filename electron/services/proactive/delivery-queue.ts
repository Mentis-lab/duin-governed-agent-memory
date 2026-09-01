// Delivery queue — the RELIABILITY substrate for proactive (outbound) sends.
//
// channelDispatch (channel-dispatch.ts) performs exactly ONE delivery attempt and
// never retries. That is the right primitive for an interactive tool call, but a
// PROACTIVE send (a nudge, an approval prompt, a watch/notify signal) originates
// with no human watching the result — if that single attempt fails, the message
// is silently lost. This module wraps channelDispatch with a PERSISTED dead-letter
// queue so a proactive send survives a transient channel outage:
//
//   enqueue(ref, text, meta) → attempt now.
//     ok    → record status 'delivered', return the receipt.
//     fail  → persist to deliveries.json (status 'pending') with a backoff-scheduled
//             nextAttemptAt; the automations 60s tick calls redeliverDue() to retry.
//   redeliverDue(now) → attempt every pending record whose nextAttemptAt has passed.
//     ok    → 'delivered'. fail → bump attempts + reschedule with exponential backoff,
//     or, once maxAttempts is exhausted, park it as a 'dead' letter (never silently
//     dropped — it stays in the store with its last error for inspection).
//
// Persistence mirrors pairing-store.ts / connections-store.ts (injectable path →
// unit-testable off Electron). This module carries NO exec authority — it only
// forwards text through the existing dispatch seam.

import { existsSync, readFileSync, renameSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { channelDispatch, type ChannelRef } from '../channel-dispatch'
import { atomicWriteDurable } from '../brain/durable-write'
import { messageOf } from '../guarded'

export type DeliveryStatus = 'pending' | 'delivered' | 'dead'

export interface DeliveryRecord {
  id: string
  ref: ChannelRef
  text: string
  /** Caller-supplied context (e.g. source: 'nudge', interactionId). Opaque here. */
  meta: Record<string, unknown>
  status: DeliveryStatus
  /** Attempts made SO FAR (the initial enqueue attempt counts as 1). */
  attempts: number
  maxAttempts: number
  createdAt: number
  /** Epoch ms at/after which the next redelivery is eligible. */
  nextAttemptAt: number
  lastAttemptAt: number | null
  lastError: string | null
  deliveredAt: number | null
  /** Carried so a retry lands on the same surface the first attempt would have. */
  deepLink?: string | null
  /** Carried so a retry says the same thing the first attempt would have. */
  title?: string
}

/** A compact receipt returned to the caller of enqueue(). */
export interface DeliveryReceipt {
  id: string
  ok: boolean
  status: DeliveryStatus
  error?: string
}

/** Default retry budget: initial attempt + 5 redeliveries. */
const DEFAULT_MAX_ATTEMPTS = 6
/** Backoff base — first redelivery ~1 min out, doubling, capped. */
const BACKOFF_BASE_MS = 60_000
const BACKOFF_CAP_MS = 30 * 60_000

type QueueMap = Record<string, DeliveryRecord>

let queue: QueueMap = {}
let storePath: string | null = null

// Overlap guard for redeliverDue(). The automations 60s tick fires it
// fire-and-forget (automations-runner.ts tick(): `void redeliverDue().catch(...)`).
// A record's status/attempts are only mutated AFTER `await attempt(...)`, so while a
// pass is parked on a hung dispatch (channelDispatch → restSend has no timeout; an
// undici request to a half-open socket can hang for minutes) the in-flight record is
// STILL 'pending' with nextAttemptAt in the past. The next tick would re-select and
// re-send that same record — double-firing the nudge and burning the retry budget at
// double rate. Serialise passes: while one is in flight, later ticks no-op. What made
// this invisible is that the mutation-after-await races only across two overlapping
// calls, so a single-call test can never surface it.
let redelivering = false

/** The delivery attempt seam — channelDispatch by default; overridable in tests
 *  that would rather not vi.mock the whole module. */
type Dispatcher = (
  ref: ChannelRef,
  text: string,
  opts?: { deepLink?: string | null; title?: string }
) => Promise<{ ok: boolean; error?: string }>
let dispatcher: Dispatcher = channelDispatch

/** Test seam: substitute the dispatch function. Pass no arg to restore default. */
export function __setDispatcher(fn?: Dispatcher): void {
  dispatcher = fn ?? channelDispatch
}

export function setDeliveryQueuePath(userDataDir: string): void {
  storePath = join(userDataDir, 'deliveries.json')
  queue = {}
  try {
    if (existsSync(storePath)) {
      const raw = JSON.parse(readFileSync(storePath, 'utf-8')) as { queue?: QueueMap }
      queue = raw.queue && typeof raw.queue === 'object' ? raw.queue : {}
    }
  } catch (e) {
    // The file exists but is unreadable/unparseable — a torn write from a crash/power-loss
    // mid persist() (which runs on every enqueue and after every redeliver batch), or disk
    // corruption. Resetting to {} is the only safe in-memory state, but the NEXT enqueue's
    // persist() atomically renames a fresh store OVER this file, so silently starting from {}
    // would erase every pending nudge/approval/watch notice AND its dead letters — violating
    // this module's stated "never silently dropped" contract with no trace. So QUARANTINE the
    // bytes first: move them aside to a timestamped .corrupt sidecar and log loudly, so the
    // undelivered records are recoverable by hand rather than lost. Never delete; never
    // overwrite in place. (queue is already reset to {} above.)
    quarantineCorruptStore(storePath, e)
  }
}

/** Move an unparseable store aside to `<name>.<ISO-stamp>.corrupt` so the imminent persist()
 *  cannot overwrite it. Mirrors capability-ledger.ts's quarantine. Best-effort: if the rename
 *  fails we still log, and we deliberately do NOT fall back to deleting — a file we failed to
 *  preserve stays where it is. */
function quarantineCorruptStore(path: string, cause: unknown): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const sidecar = `${path}.${stamp}.corrupt`
  try {
    renameSync(path, sidecar)
    console.error(
      `[delivery-queue] UNREADABLE store at ${path} (${messageOf(cause)}) — quarantined to ${sidecar}; ` +
        'in-memory queue reset to empty. Undelivered pending/dead letters in the quarantined file are ' +
        'NOT re-hydrated automatically — recover them by hand.'
    )
  } catch (e) {
    console.error(
      `[delivery-queue] UNREADABLE store at ${path} (${messageOf(cause)}) and quarantine FAILED ` +
        `(${messageOf(e)}) — queue reset to empty; the corrupt file may be overwritten by the next persist().`
    )
  }
}

function persist(): void {
  if (!storePath) return
  try {
    mkdirSync(dirname(storePath), { recursive: true })
    // Crash-safe: tmp → fsync → rename → fsync(dir), same as the sibling stores (capability-ledger.ts,
    // action-ledger.ts). A bare writeFileSync opens with 'w' and truncates IN PLACE, so a crash mid-write
    // leaves a torn deliveries.json the next boot fails to parse — dropping every pending/dead proactive send.
    atomicWriteDurable(storePath, JSON.stringify({ queue }, null, 2))
  } catch (e) {
    console.debug('[delivery-queue] best-effort persist:', messageOf(e))
  }
}

/** Backoff delay before the Nth attempt's retry (attempts already made = n). */
export function backoffMs(attempts: number): number {
  const exp = BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempts - 1))
  return Math.min(exp, BACKOFF_CAP_MS)
}

/** One delivery attempt via the dispatch seam. Never throws (dispatch doesn't). */
async function attempt(
  ref: ChannelRef,
  text: string,
  deepLink?: string | null,
  title?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    return await dispatcher(ref, text, { deepLink: deepLink ?? null, ...(title ? { title } : {}) })
  } catch (e) {
    // Defensive: channelDispatch is documented never-throws, but a test seam or a
    // future dispatcher might. Treat a throw as a failed attempt, never a crash.
    return { ok: false, error: messageOf(e) }
  }
}

export interface EnqueueOptions {
  /** Where clicking the delivered notification should land. Persisted with the record so
   *  a retry days later still lands somewhere, not just the first attempt. */
  deepLink?: string | null
  /** Notification title, persisted for the same reason. */
  title?: string
  meta?: Record<string, unknown>
  maxAttempts?: number
  now?: number
}

/**
 * Enqueue a proactive send. Attempts delivery IMMEDIATELY (attempt #1). On success
 * the record is stored 'delivered'; on failure it is stored 'pending' with a
 * backoff-scheduled nextAttemptAt so redeliverDue() will retry it on the tick.
 * Always returns a receipt — a proactive send is never fire-and-forget-lost.
 */
export async function enqueue(
  ref: ChannelRef,
  text: string,
  opts: EnqueueOptions = {}
): Promise<DeliveryReceipt> {
  const now = opts.now ?? Date.now()
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const rec: DeliveryRecord = {
    id: randomUUID(),
    ref: { kind: ref.kind, target: ref.target, ...(ref.voice ? { voice: true } : {}) },
    text,
    meta: opts.meta ?? {},
    status: 'pending',
    attempts: 0,
    maxAttempts,
    createdAt: now,
    nextAttemptAt: now,
    lastAttemptAt: null,
    lastError: null,
    deliveredAt: null,
    ...(opts.deepLink ? { deepLink: opts.deepLink } : {}),
    ...(opts.title ? { title: opts.title } : {})
  }

  const r = await attempt(ref, text, rec.deepLink, rec.title)
  rec.attempts = 1
  rec.lastAttemptAt = now
  if (r.ok) {
    rec.status = 'delivered'
    rec.deliveredAt = now
    rec.lastError = null
  } else {
    rec.lastError = r.error ?? 'delivery failed'
    if (rec.attempts >= rec.maxAttempts) {
      rec.status = 'dead'
    } else {
      rec.status = 'pending'
      rec.nextAttemptAt = now + backoffMs(rec.attempts)
    }
  }
  // Persist the record so even an immediately-successful send leaves a receipt
  // trail, and a pending/dead one is durable across restarts.
  queue[rec.id] = rec
  persist()
  return { id: rec.id, ok: r.ok, status: rec.status, error: r.ok ? undefined : rec.lastError ?? undefined }
}

export interface RedeliverSummary {
  attempted: number
  delivered: number
  dead: number
  stillPending: number
}

/**
 * Retry every 'pending' record whose nextAttemptAt has passed. Called from the
 * automations 60s tick. Bounded: a record that exhausts maxAttempts becomes a
 * 'dead' letter (retained, not dropped). Persists once at the end.
 */
export async function redeliverDue(now: number = Date.now()): Promise<RedeliverSummary> {
  const summary: RedeliverSummary = { attempted: 0, delivered: 0, dead: 0, stillPending: 0 }
  // A prior pass is still awaiting a dispatch; its in-flight record has not yet had
  // its status claimed, so re-entering here would re-send it. No-op instead.
  if (redelivering) return summary
  redelivering = true
  try {
    const due = Object.values(queue).filter(
      (r) => r.status === 'pending' && r.nextAttemptAt <= now
    )
    for (const rec of due) {
      summary.attempted++
      const r = await attempt(rec.ref, rec.text, rec.deepLink, rec.title)
      rec.attempts++
      rec.lastAttemptAt = now
      if (r.ok) {
        rec.status = 'delivered'
        rec.deliveredAt = now
        rec.lastError = null
        summary.delivered++
      } else {
        rec.lastError = r.error ?? 'delivery failed'
        if (rec.attempts >= rec.maxAttempts) {
          rec.status = 'dead'
          summary.dead++
        } else {
          rec.nextAttemptAt = now + backoffMs(rec.attempts)
          summary.stillPending++
        }
      }
    }
    if (due.length) persist()
    return summary
  } finally {
    redelivering = false
  }
}

export function getDelivery(id: string): DeliveryRecord | null {
  return queue[id] ?? null
}

/** All delivery records, optionally filtered by status. Newest first. */
export function listDeliveries(status?: DeliveryStatus): DeliveryRecord[] {
  return Object.values(queue)
    .filter((r) => !status || r.status === status)
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** Drop delivered records older than `olderThanMs` to bound the store. Returns
 *  the number pruned. Never prunes 'pending' or 'dead' letters. */
export function pruneDelivered(olderThanMs: number, now: number = Date.now()): number {
  let pruned = 0
  for (const [id, rec] of Object.entries(queue)) {
    if (rec.status === 'delivered' && rec.deliveredAt !== null && now - rec.deliveredAt > olderThanMs) {
      delete queue[id]
      pruned++
    }
  }
  if (pruned) persist()
  return pruned
}
