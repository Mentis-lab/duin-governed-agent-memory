import { existsSync, mkdirSync, readFileSync, renameSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { atomicWriteDurable } from '../brain/durable-write'
import { messageOf } from '../guarded'

// Notices — the INBOX record for anything DUIN wants a human to see.
//
// Distinct from two neighbours it is easy to confuse:
//   • event-log (the spine) is the AUDIT record: ~130 machine event types, append-only,
//     written by every subsystem. Badging it would surface `model.request.started` and
//     `rag.query.completed` as "notifications", which is why the inbox is not built on it.
//   • delivery-queue is the TRANSPORT record: did the outbound send land, and should it
//     be retried. Its statuses describe the channel, not the human.
//
// A notice is recorded when something worth a person's attention HAPPENED, independent of
// whether it was ever successfully delivered anywhere. That separation is the point: on a
// stock install the home channel is an OS toast that cannot be replied to and no messaging
// channel is configured, so delivery-based state can never answer "what did I miss".

export type NoticeKind = 'watch' | 'approval' | 'loop' | 'automation' | 'digest'
export type NoticeSeverity = 'info' | 'warning' | 'error'

export interface Notice {
  id: string
  kind: NoticeKind
  severity: NoticeSeverity
  title: string
  body: string
  /** Where clicking this should take the user, e.g. `duin://tool/loop`. */
  deepLink: string | null
  createdAt: number
  readAt: number | null
  /** True when the operator still owes a decision. These lead the inbox. */
  needsDecision: boolean
  /** Set once the decision was answered (anywhere — panel, channel reply, timeout). */
  resolvedAt: number | null
  /** Binds a decision notice to the thing being decided, so answering elsewhere clears it. */
  actionId?: string
  /** Repeats inside the coalesce window fold into the existing row rather than stacking. */
  dedupKey?: string
  /** How many times a deduped notice has recurred (1 = seen once). */
  count: number
}

export interface RecordNoticeInput {
  kind: NoticeKind
  severity?: NoticeSeverity
  title: string
  body?: string
  deepLink?: string | null
  needsDecision?: boolean
  actionId?: string
  dedupKey?: string
  now?: number
}

/** Keep the store bounded in an always-on app; the spine remains the full history. */
const MAX_NOTICES = 500
/** A repeat of the same dedupKey inside this window updates the existing row. */
const COALESCE_WINDOW_MS = 30 * 60_000

type NoticeMap = Record<string, Notice>

let notices: NoticeMap = {}
let storePath: string | null = null

// Kept free of any electron import so this module stays unit-testable off Electron,
// like its sibling stores. The owner registers a listener; nothing here knows about
// windows or IPC.
let changeListener: (() => void) | null = null

export function setNoticesChangeListener(fn: (() => void) | null): void {
  changeListener = fn
}

function announce(): void {
  try {
    changeListener?.()
  } catch (e) {
    console.debug('[notices] change listener failed:', messageOf(e))
  }
}

export function setNoticesPath(userDataDir: string): void {
  storePath = join(userDataDir, 'notices.json')
  notices = {}
  try {
    if (existsSync(storePath)) {
      const raw = JSON.parse(readFileSync(storePath, 'utf-8')) as { notices?: NoticeMap }
      notices = raw.notices && typeof raw.notices === 'object' ? raw.notices : {}
    }
  } catch (e) {
    // Same posture as delivery-queue: the next persist() renames a fresh store over this
    // file, so starting silently from {} would erase every unanswered decision with no
    // trace. Move the bytes aside first.
    quarantineCorruptStore(storePath, e)
  }
}

function quarantineCorruptStore(path: string, cause: unknown): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const sidecar = `${path}.${stamp}.corrupt`
  try {
    renameSync(path, sidecar)
    console.error(
      `[notices] UNREADABLE store at ${path} (${messageOf(cause)}) — quarantined to ${sidecar}; ` +
        'in-memory notices reset to empty. Recover unanswered decisions from the quarantined file by hand.'
    )
  } catch (e) {
    console.error(
      `[notices] UNREADABLE store at ${path} (${messageOf(cause)}) and quarantine FAILED ` +
        `(${messageOf(e)}) — notices reset to empty; the corrupt file may be overwritten by the next persist().`
    )
  }
}

function persist(): void {
  if (!storePath) return
  try {
    mkdirSync(dirname(storePath), { recursive: true })
    atomicWriteDurable(storePath, JSON.stringify({ notices }, null, 2))
  } catch (e) {
    console.debug('[notices] best-effort persist:', messageOf(e))
  }
}

/** Drop the oldest READ, non-owed rows once the store exceeds its cap. An unanswered
 *  decision is never evicted by age — it is the one thing the inbox exists to hold. */
function evictOverflow(): void {
  const all = Object.values(notices)
  if (all.length <= MAX_NOTICES) return
  const evictable = all
    .filter((n) => n.readAt !== null && !(n.needsDecision && n.resolvedAt === null))
    .sort((a, b) => a.createdAt - b.createdAt)
  let excess = all.length - MAX_NOTICES
  for (const n of evictable) {
    if (excess <= 0) break
    delete notices[n.id]
    excess--
  }
}

/** Record something worth seeing. Never throws — a producer must not fail because the
 *  inbox could not be written. */
export function recordNotice(input: RecordNoticeInput): Notice | null {
  try {
    const now = input.now ?? Date.now()
    const title = (input.title ?? '').trim()
    if (!title) return null

    if (input.dedupKey) {
      const prior = Object.values(notices)
        .filter((n) => n.dedupKey === input.dedupKey && now - n.createdAt < COALESCE_WINDOW_MS)
        .sort((a, b) => b.createdAt - a.createdAt)[0]
      if (prior) {
        // A recurrence is news again: bump it back to unread rather than leaving the
        // count to change silently under a row the user already dismissed.
        prior.count += 1
        prior.createdAt = now
        prior.readAt = null
        prior.body = input.body ?? prior.body
        // A recurrence that carries a NEW decision must be decidable again:
        // refresh the actionId (approving the old one resolves nothing) and
        // re-open a row that was resolved for the PREVIOUS decision.
        if (input.actionId && input.actionId !== prior.actionId) {
          prior.actionId = input.actionId
          if (input.needsDecision === true) {
            prior.needsDecision = true
            prior.resolvedAt = null
          }
        }
        persist()
        announce()
        return prior
      }
    }

    const notice: Notice = {
      id: randomUUID(),
      kind: input.kind,
      severity: input.severity ?? 'info',
      title,
      body: (input.body ?? '').trim(),
      deepLink: input.deepLink ?? null,
      createdAt: now,
      readAt: null,
      needsDecision: input.needsDecision === true,
      resolvedAt: null,
      ...(input.actionId ? { actionId: input.actionId } : {}),
      ...(input.dedupKey ? { dedupKey: input.dedupKey } : {}),
      count: 1
    }
    notices[notice.id] = notice
    evictOverflow()
    persist()
    announce()
    return notice
  } catch (e) {
    console.debug('[notices] record failed:', messageOf(e))
    return null
  }
}

export interface ListOptions {
  limit?: number
  includeRead?: boolean
}

/** Newest first. Owed decisions always lead, regardless of age. */
export function listNotices(opts: ListOptions = {}): Notice[] {
  const all = Object.values(notices).filter((n) => (opts.includeRead === false ? n.readAt === null : true))
  all.sort((a, b) => {
    const aOwed = a.needsDecision && a.resolvedAt === null
    const bOwed = b.needsDecision && b.resolvedAt === null
    if (aOwed !== bOwed) return aOwed ? -1 : 1
    return b.createdAt - a.createdAt
  })
  return typeof opts.limit === 'number' ? all.slice(0, opts.limit) : all
}

export interface NoticeCounts {
  /** Unread and not yet answered. Drives the pill dot. */
  unread: number
  /** Unanswered decisions. Drives the "N need you" copy. */
  needsDecision: number
}

export function noticeCounts(): NoticeCounts {
  let unread = 0
  let needsDecision = 0
  for (const n of Object.values(notices)) {
    if (n.readAt === null) unread++
    if (n.needsDecision && n.resolvedAt === null) needsDecision++
  }
  return { unread, needsDecision }
}

export function markRead(ids: string[], now = Date.now()): number {
  let changed = 0
  for (const id of ids) {
    const n = notices[id]
    if (n && n.readAt === null) {
      n.readAt = now
      changed++
    }
  }
  if (changed) {
    persist()
    announce()
  }
  return changed
}

export function markAllRead(now = Date.now()): number {
  return markRead(
    Object.values(notices)
      .filter((n) => n.readAt === null)
      .map((n) => n.id),
    now
  )
}

/** Clear an owed decision once it has been answered — including when the answer arrived
 *  somewhere else entirely (a channel reply, or an approval that timed out). Without this
 *  the inbox would keep asking for a decision the system has already made. */
export function resolveByActionId(actionId: string, now = Date.now()): number {
  let changed = 0
  for (const n of Object.values(notices)) {
    if (n.actionId === actionId && n.resolvedAt === null) {
      n.resolvedAt = now
      if (n.readAt === null) n.readAt = now
      changed++
    }
  }
  if (changed) {
    persist()
    announce()
  }
  return changed
}

/** Age out terminal rows. Owed decisions are kept whatever their age. */
export function pruneNotices(maxAgeMs: number, now = Date.now()): number {
  let removed = 0
  for (const n of Object.values(notices)) {
    const owed = n.needsDecision && n.resolvedAt === null
    if (owed) continue
    if (n.readAt !== null && now - n.createdAt > maxAgeMs) {
      delete notices[n.id]
      removed++
    }
  }
  if (removed) persist()
  return removed
}

/** Test seam. */
export function __resetNotices(): void {
  notices = {}
}
