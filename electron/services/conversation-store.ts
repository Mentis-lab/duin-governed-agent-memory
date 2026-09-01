import { randomUUID } from 'crypto'
import { getDb, withWriteRetry, transactional } from './database'
import { touchProject } from './projects-store'
import { clearConversationState } from './plan-goal-store'
import { sanitizePseudoTags } from './sanitize-pseudo-tags'
import { listAttachments as ragListAttachments, removeAttachment as ragRemoveAttachment } from './rag/store'
import type { Database } from 'better-sqlite3'
import type { VisionContentPart } from '../shared/chat-send-contract'

export interface ConversationRow {
  id: string
  title: string | null
  model: string
  created_at: number
  updated_at: number
  kind?: string
  worktree_path?: string | null
  project_id?: string | null
  archived?: number
  pinned_at?: number | null
  forked_from_id?: string | null
  forked_from_message_id?: string | null
  seed_blob?: string | null
  seed_source_kind?: SeedSourceKind | null
  /** v28 — task lifecycle. NULL = open; a timestamp = the task was `close`d
   *  (recoverable via `restore`). Distinct from `archived`. */
  closed_at?: number | null
}

export interface MessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  model: string | null
  tool_call_id: string | null
  tool_calls: string | null
  draft: string | null
  reasoning: string | null
  created_at: number
  /** Track 2 / E5 — when this message was folded into a summary by the
   *  context compressor, this is the id of the summary message. NULL
   *  for messages that have never been compressed (the default for
   *  every row in a fresh conversation). */
  compressed_into: string | null
  /** JSON-encoded array of StoredDocument. NULL for turns with no
   *  create_document calls. */
  documents: string | null
  /** Reasoning Audit Phase R1 — multi-agent pipeline stage discriminator.
   *  NULL = legacy or single-agent. 'planner' | 'reviewer' | 'composer'
   *  set by the pipeline / composer save sites. Coder rows stay NULL
   *  (the implicit default) so legacy rows don't need backfill. */
  stage: string | null
  /** Robustness Hotfix HX4 (v0.8.4) — verbatim pre-sanitization copy of
   *  the assistant row's body. NULL on pre-hotfix legacy rows + non-
   *  assistant rows. UI continues to read `content` (sanitized); this
   *  column exists for the audit / export surface (RT-Viewer extension). */
  content_raw: string | null
  /** Vision attachments as a JSON array of OpenAI content parts
   *  (`{type:'image_url',image_url:{url:'data:…'}}`). NULL for every text-only
   *  turn, which is every row written before 2026-07-28.
   *
   *  `content` remains the TEXT PROJECTION of the turn and stays authoritative
   *  for display, export, sanitization and FTS — deliberately, so no existing
   *  reader has to learn about parts, and so base64 never enters the search
   *  index. Only the API serializer recombines the two. */
  content_parts: string | null
  /** WC-4 — Persisted proof gate trust state.
   *
   *  NULL = not applicable (read-only turn, legacy row, no mutating tool
   *  call observed). `'trusted'` = the M5 gate evaluated and found a
   *  passing receipt after the last mutation. `'untrusted'` = mutations
   *  observed but no fresh passing receipt. `'blocked'` = a strict-mode
   *  block (reserved; WC-5 surfaces this in the UI banner). `'waived'` =
   *  user explicitly waived via the contract waiver flow (M6).
   *
   *  Replaces the WC-pre era of parsing `proofGateNotice` text out of the
   *  message body to know whether a turn is trusted. */
  proof_status: string | null
}

/** Allowed values for `MessageRow.stage`. Kept as a string union so
 *  callers can pass `undefined` to mean "not a multi-agent row".
 *  Coder rows intentionally stay NULL — see database.ts R1 migration.
 *  CR-2 (Cogency Restore Phase) — added 'system' for harness-synthesised
 *  rows (abort-safe rollback message naming modified paths when the
 *  multi-agent pipeline bails after Coder mutations). */
export type MessageStage = 'planner' | 'reviewer' | 'composer' | 'system'

/** WC-4 — Allowed values for `MessageRow.proof_status`. NULL on the row
 *  means "not applicable" (use the absence rather than a sentinel string). */
export type ProofStatus = 'trusted' | 'untrusted' | 'blocked' | 'waived'
export type SeedSourceKind = 'none' | 'message' | 'block' | 'transcript-range' | 'custom'

export interface ConversationSeedBlob {
  sourceConversationId?: string
  sourceMessageId?: string
  source?: string
  kind: SeedSourceKind
  contentPreview?: string
  attachedDocumentId?: string
  seedBytes?: number
}

export interface StoredToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface StoredDocument {
  id: string
  name: string
  mimeType: string
  content: string
  sizeBytes: number
  createdAt: number
}

export function createConversation(
  model: string,
  opts?: {
    kind?: 'local' | 'cloud' | 'worktree'
    worktreePath?: string | null
    projectId?: string | null
    forkedFromId?: string | null
    forkedFromMessageId?: string | null
    seedBlob?: ConversationSeedBlob | string | null
    seedSourceKind?: SeedSourceKind
  }
) {
  const db = getDb()
  const id = randomUUID()
  const now = Date.now()
  const kind = opts?.kind ?? 'local'
  const worktreePath = opts?.worktreePath ?? null
  const projectId = opts?.projectId ?? null
  const seedSourceKind = opts?.seedSourceKind ?? 'none'
  const seedBlob =
    typeof opts?.seedBlob === 'string'
      ? opts.seedBlob
      : opts?.seedBlob
        ? JSON.stringify(opts.seedBlob)
        : null
  db.prepare(
    `INSERT INTO conversations
       (id, title, model, created_at, updated_at, kind, worktree_path, project_id,
        forked_from_id, forked_from_message_id, seed_blob, seed_source_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    null,
    model,
    now,
    now,
    kind,
    worktreePath,
    projectId,
    opts?.forkedFromId ?? null,
    opts?.forkedFromMessageId ?? null,
    seedBlob,
    seedSourceKind
  )
  if (projectId) touchProject(projectId)
  return {
    id,
    title: null,
    model,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    kind,
    worktreePath,
    projectId,
    forkedFromId: opts?.forkedFromId ?? null,
    forkedFromMessageId: opts?.forkedFromMessageId ?? null,
    seedBlob: seedBlob ?? undefined,
    seedSourceKind
  }
}

function rowToConversation(row: ConversationRow, count: number) {
  let seedBlob: ConversationSeedBlob | string | null = null
  if (row.seed_blob) {
    try {
      seedBlob = JSON.parse(row.seed_blob) as ConversationSeedBlob
    } catch {
      seedBlob = row.seed_blob
    }
  }
  return {
    id: row.id,
    title: row.title || 'New conversation',
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: count,
    kind: (row.kind as 'local' | 'cloud' | 'worktree' | undefined) ?? 'local',
    worktreePath: row.worktree_path ?? null,
    projectId: row.project_id ?? null,
    archived: row.archived === 1,
    pinnedAt: row.pinned_at ?? null,
    forkedFromId: row.forked_from_id ?? null,
    forkedFromMessageId: row.forked_from_message_id ?? null,
    closedAt: row.closed_at ?? null,
    seedBlob,
    seedSourceKind: row.seed_source_kind ?? 'none'
  }
}

export function findMessage(conversationId: string, messageId: string) {
  const rows = getMessages(conversationId)
  return rows.find((m) => m.id === messageId) ?? null
}

export function listConversationLineage(conversationId: string, limit = 10) {
  const lineage: ReturnType<typeof getConversation>[] = []
  let current = getConversation(conversationId)
  let guard = 0
  while (current?.forkedFromId && guard < limit) {
    const parent = getConversation(current.forkedFromId)
    if (!parent) break
    lineage.push(parent)
    current = parent
    guard += 1
  }
  return lineage
}

export function getConversation(id: string) {
  const db = getDb()
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
    | ConversationRow
    | undefined
  if (!row) return null
  const count = db.prepare(
    'SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?'
  ).get(id) as { cnt: number }
  return rowToConversation(row, count.cnt)
}

export function listConversations() {
  const db = getDb()
  // One LEFT JOIN + GROUP BY instead of a COUNT(*) query per conversation (the
  // old N+1, re-preparing the SQL each row). Same output; index-served via
  // idx_messages_conversation. COUNT(m.id) is 0 for conversations with no messages.
  const rows = db
    .prepare(
      `SELECT c.*, COUNT(m.id) AS cnt
         FROM conversations c
         LEFT JOIN messages m ON m.conversation_id = c.id
        GROUP BY c.id
        ORDER BY c.updated_at DESC`
    )
    .all() as (ConversationRow & { cnt: number })[]
  return rows.map((row) => rowToConversation(row, row.cnt))
}

// E3 — Sessions sidebar uses three buckets: Recent (not archived,
// not pinned), Pinned (pinned_at IS NOT NULL), Archived (archived = 1).
// The optional `query` arg restricts by FTS hit, and `limit`/`offset`
// support infinite-scroll pagination.
export type SessionsTab = 'recent' | 'pinned' | 'archived'

export interface ListSessionsOptions {
  tab?: SessionsTab
  query?: string
  limit?: number
  offset?: number
}

export function listSessions(opts: ListSessionsOptions = {}) {
  const db = getDb()
  const tab: SessionsTab = opts.tab ?? 'recent'
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)

  let ids: string[] | null = null
  if (opts.query && opts.query.trim()) {
    // FTS scan returns the candidate conversation ids; we then join
    // back to the canonical row for the bucket filter so we don't
    // double-implement archive/pin logic in the FTS query.
    try {
      const matches = db
        .prepare(
          `SELECT DISTINCT conversation_id
             FROM sessions_fts
            WHERE sessions_fts MATCH ?
            ORDER BY rank
            LIMIT ?`
        )
        // Escaped, like its sibling searchSessions. Passing the raw user query to
        // FTS5 MATCH meant a hyphenated term, an ISO date, or anything with a colon
        // parsed as FTS syntax and threw — and the catch below silently degrades to a
        // titles-only LIKE scan, so the sidebar and Brain Explorer quietly stopped
        // searching message BODIES for exactly the queries most likely to be typed.
        .all(escapeFtsQuery(opts.query.trim()), 500) as { conversation_id: string }[]
      ids = matches.map((m) => m.conversation_id)
    } catch (err) {
      // Malformed FTS query — fall back to a LIKE scan on titles only.
      console.warn('[conversation-store] FTS query failed:', (err as Error).message)
      const like = `%${opts.query.trim().replace(/[\\%_]/g, '')}%`
      const matches = db
        .prepare(
          `SELECT id FROM conversations
            WHERE title LIKE ?
            ORDER BY updated_at DESC
            LIMIT 500`
        )
        .all(like) as { id: string }[]
      ids = matches.map((m) => m.id)
    }
    if (ids.length === 0) return []
  }

  let where: string
  let order = 'updated_at DESC'
  if (tab === 'recent') {
    where = 'archived = 0 AND pinned_at IS NULL'
  } else if (tab === 'pinned') {
    where = 'pinned_at IS NOT NULL'
    order = 'pinned_at DESC'
  } else {
    where = 'archived = 1'
  }

  let sql = `SELECT * FROM conversations WHERE ${where}`
  const params: any[] = []
  if (ids) {
    const placeholders = ids.map(() => '?').join(',')
    sql += ` AND id IN (${placeholders})`
    params.push(...ids)
  }
  sql += ` ORDER BY ${order} LIMIT ? OFFSET ?`
  params.push(limit, offset)

  const rows = db.prepare(sql).all(...params) as ConversationRow[]
  return rows.map((row) => {
    const count = db
      .prepare('SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?')
      .get(row.id) as { cnt: number }
    return rowToConversation(row, count.cnt)
  })
}

export function setConversationArchived(id: string, archived: boolean): void {
  const db = getDb()
  db.prepare('UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ?').run(
    archived ? 1 : 0,
    Date.now(),
    id
  )
}

export function setConversationPinned(id: string, pinned: boolean): void {
  const db = getDb()
  db.prepare('UPDATE conversations SET pinned_at = ?, updated_at = ? WHERE id = ?').run(
    pinned ? Date.now() : null,
    Date.now(),
    id
  )
}

// v28 — task lifecycle `close` / `restore`. Sets (or clears) closed_at. A closed
// conversation surfaces as a terminal-but-recoverable node in the task graph;
// `restore` clears it (the lifecycle service also un-archives on restore).
export function setConversationClosed(id: string, closed: boolean): void {
  const db = getDb()
  db.prepare('UPDATE conversations SET closed_at = ?, updated_at = ? WHERE id = ?').run(
    closed ? Date.now() : null,
    Date.now(),
    id
  )
}

// Cross-session FTS — returns a flat list of hits keyed by source so
// the renderer can render "matched in title" vs "matched in message"
// distinctly. Snippets are taken from the FTS5 snippet() helper.
export interface SessionSearchHit {
  conversationId: string
  source: 'conversation' | 'message'
  messageId: string | null
  snippet: string
  rank: number
}

// FTS5 reads -, :, ^ and friends as syntax, so a bare `duin-brain` or an ISO date parses as a
// column filter and raises "no such column". The catch below then turns that into an empty
// result set, which reads to the user as "no matches" rather than "your query was rejected".
// Quote every bare term into a string literal; leave already-quoted phrases, trailing-* prefix
// searches, and FTS5's (uppercase-only) boolean operators alone so callers that build a real
// FTS5 expression — agui-grounding's OR-of-tokens — keep working.
function escapeFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      if (tok === 'AND' || tok === 'OR' || tok === 'NOT') return tok
      if (tok.length > 1 && tok.startsWith('"') && tok.endsWith('"')) return tok
      const star = tok.endsWith('*') ? '*' : ''
      const bare = star ? tok.slice(0, -1) : tok
      if (!bare) return `"${tok.replace(/"/g, '""')}"`
      return `"${bare.replace(/"/g, '""')}"${star}`
    })
    .join(' ')
}

export function searchSessions(query: string, limit = 50): SessionSearchHit[] {
  const q = escapeFtsQuery(query.trim())
  if (!q) return []
  const db = getDb()
  try {
    const rows = db
      .prepare(
        `SELECT source, conversation_id, message_id,
                snippet(sessions_fts, 4, '<<', '>>', '…', 24) AS snippet,
                rank
           FROM sessions_fts
          WHERE sessions_fts MATCH ?
          ORDER BY rank
          LIMIT ?`
      )
      .all(q, limit) as any[]
    return rows.map((r) => ({
      conversationId: r.conversation_id,
      source: r.source,
      messageId: r.message_id ?? null,
      snippet: r.snippet ?? '',
      rank: r.rank
    }))
  } catch (err) {
    console.warn('[conversation-store] FTS search failed:', (err as Error).message)
    return []
  }
}

// ────────────── FTS sync helpers ──────────────

function ftsDeleteConversation(id: string): void {
  const db = getDb()
  try {
    db.prepare(
      "DELETE FROM sessions_fts WHERE source = 'conversation' AND conversation_id = ?"
    ).run(id)
  } catch (err) {
    console.warn('[conversation-store] FTS delete-conv failed:', (err as Error).message)
  }
}

function ftsDeleteAllForConversation(id: string): void {
  const db = getDb()
  try {
    db.prepare('DELETE FROM sessions_fts WHERE conversation_id = ?').run(id)
  } catch (err) {
    console.warn('[conversation-store] FTS delete-all failed:', (err as Error).message)
  }
}

function ftsDeleteMessagesForConversation(conversationId: string): void {
  const db = getDb()
  try {
    db.prepare(
      "DELETE FROM sessions_fts WHERE source = 'message' AND conversation_id = ?"
    ).run(conversationId)
  } catch (err) {
    console.warn(
      '[conversation-store] FTS delete-messages-for-conv failed:',
      (err as Error).message
    )
  }
}

// Bulk clear a conversation's messages + the matching FTS rows. Used by
// the compact path which collapses a long conversation into a single
// summary message; reusing this helper keeps the FTS index from
// re-surfacing the discarded content.
export function clearConversationMessages(conversationId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId)
  ftsDeleteMessagesForConversation(conversationId)
}

/** ATOMIC compact: replace a conversation's messages with a single summary row, all-or-nothing.
 *
 *  /compact used to call clearConversationMessages() and THEN saveMessage(), outside any transaction.
 *  The DELETE committed immediately, so if the insert then failed — constraint violation, disk full, a
 *  db-encryption error — the conversation was left PERMANENTLY EMPTY with nothing written back, and the
 *  user saw only a generic "compact failed" toast. Destroying the old state before the new state is
 *  durable is the classic ordering bug; doing both inside one transaction makes a failure a no-op.
 *
 *  Returns the number of messages replaced. Throws on failure, with the conversation untouched. */
export interface CompactConversationDeps {
  db: Pick<Database, 'prepare'>
  transactional: <T>(fn: () => T) => T
}

/** Mirrors defaultDeleteConversationDeps — the all-or-nothing property is the whole point of this
 *  function, and the real getDb() path cannot execute under the node-env vitest (better-sqlite3 ABI), so
 *  the seam exists to let the transaction be tested for real against node:sqlite. Without it the only
 *  available "test" is one that skips silently and proves nothing. */
export interface CompactConversationOptions {
  /** Delete ONLY these message ids instead of the whole conversation.
   *
   *  The caller summarises a SNAPSHOT of the messages, and summarising is a model
   *  call that takes real time. Deleting the conversation wholesale at the end of it
   *  destroys anything that arrived in between — messages the summary never saw and
   *  the caller never archived. Passing the snapshot's ids makes the delete cover
   *  exactly what the summary stands in for, and nothing else.
   *
   *  Omitted ⇒ previous behaviour (replace the entire conversation). */
  replaceIds?: string[]
}

export function compactConversation(
  conversationId: string,
  summary: { id: string; content: string; createdAt?: number },
  deps?: CompactConversationDeps,
  opts?: CompactConversationOptions
): number {
  const d: CompactConversationDeps = deps ?? { db: getDb(), transactional }
  const db = d.db
  const ids = opts?.replaceIds
  const scoped = Array.isArray(ids) && ids.length > 0
  const replaced = withWriteRetry(() =>
    d.transactional(() => {
      let n: number
      if (scoped) {
        const holes = ids.map(() => '?').join(', ')
        const row = db
          .prepare(
            `SELECT COUNT(*) as c FROM messages WHERE conversation_id = ? AND id IN (${holes})`
          )
          .get(conversationId, ...ids) as { c: number }
        n = row?.c ?? 0
        db.prepare(
          `DELETE FROM messages WHERE conversation_id = ? AND id IN (${holes})`
        ).run(conversationId, ...ids)
      } else {
        const row = db
          .prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?')
          .get(conversationId) as { c: number }
        n = row?.c ?? 0
        db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId)
      }
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, created_at)
         VALUES (?, ?, 'system', ?, ?)`
      ).run(summary.id, conversationId, summary.content, summary.createdAt ?? Date.now())
      return n
    })
  )
  // FTS is a rebuildable index, so it is reconciled AFTER the durable write and its failure must never
  // roll back a committed compact — a stale search row is recoverable, a lost conversation is not.
  // Skipped when deps are injected (unit tests run a minimal schema with no FTS tables).
  if (!deps) {
    try {
      if (scoped) {
        // Only the replaced rows leave the index. Wiping the conversation's whole FTS
        // here would un-index the messages this compact deliberately kept.
        for (const mid of ids as string[]) ftsDeleteMessage(mid)
      } else {
        ftsDeleteMessagesForConversation(conversationId)
      }
      ftsInsertMessage(summary.id, conversationId, summary.content)
    } catch (e) {
      console.warn('[conversation-store] compact: FTS reconcile failed (index only):', (e as Error)?.message)
    }
  }
  return replaced
}

function ftsDeleteMessage(messageId: string): void {
  const db = getDb()
  try {
    db.prepare(
      "DELETE FROM sessions_fts WHERE source = 'message' AND message_id = ?"
    ).run(messageId)
  } catch (err) {
    console.warn('[conversation-store] FTS delete-message failed:', (err as Error).message)
  }
}

function ftsUpsertConversation(id: string, title: string | null): void {
  if (!title) return
  const db = getDb()
  try {
    ftsDeleteConversation(id)
    db.prepare(
      `INSERT INTO sessions_fts (source, conversation_id, message_id, title, body)
       VALUES ('conversation', ?, NULL, ?, '')`
    ).run(id, title)
  } catch (err) {
    console.warn('[conversation-store] FTS upsert-conv failed:', (err as Error).message)
  }
}

function ftsInsertMessage(messageId: string, conversationId: string, body: string): void {
  if (!body || !body.trim()) return
  const db = getDb()
  try {
    db.prepare(
      `INSERT INTO sessions_fts (source, conversation_id, message_id, title, body)
       VALUES ('message', ?, ?, '', ?)`
    ).run(conversationId, messageId, body)
  } catch (err) {
    console.warn('[conversation-store] FTS insert-message failed:', (err as Error).message)
  }
}

/**
 * One-shot index repair. Empties `sessions_fts` and re-fills it from
 * the conversation + message tables. Called on first boot after the E3
 * migration runs so any pre-existing conversations are searchable
 * immediately. Subsequent boots see a non-empty index and skip.
 */
export function backfillSessionsFts(force = false): { rebuilt: boolean; rows: number } {
  const db = getDb()
  let existing: number
  try {
    existing = (db.prepare('SELECT COUNT(*) AS cnt FROM sessions_fts').get() as { cnt: number }).cnt
  } catch (err) {
    // If the FTS vtable isn't there yet (binding unavailable), bail.
    console.warn('[conversation-store] FTS backfill skipped:', (err as Error).message)
    return { rebuilt: false, rows: 0 }
  }
  if (existing > 0 && !force) return { rebuilt: false, rows: existing }
  try {
    db.exec('DELETE FROM sessions_fts')
    // Single quotes are load-bearing: better-sqlite3 builds SQLite with SQLITE_DQS=0,
    // so `""` parses as an empty IDENTIFIER and this prepare threw `no such column: ""`
    // — after DELETE had already emptied the index, and into a catch that swallowed it
    // as {rebuilt:false, rows:0}. Every pre-upgrade conversation stayed unsearchable.
    const convs = db
      .prepare("SELECT id, title FROM conversations WHERE title IS NOT NULL AND title <> ''")
      .all() as { id: string; title: string }[]
    for (const c of convs) ftsUpsertConversation(c.id, c.title)
    const msgs = db
      .prepare(
        "SELECT id, conversation_id, content FROM messages WHERE role IN ('user','assistant') AND content IS NOT NULL"
      )
      .all() as { id: string; conversation_id: string; content: string }[]
    for (const m of msgs) ftsInsertMessage(m.id, m.conversation_id, m.content)
    const rows = (db.prepare('SELECT COUNT(*) AS cnt FROM sessions_fts').get() as { cnt: number }).cnt
    return { rebuilt: true, rows }
  } catch (err) {
    console.error('[conversation-store] FTS backfill failed:', (err as Error).message)
    return { rebuilt: false, rows: 0 }
  }
}

// Suppress unused-import flag — `ftsDeleteMessage` is exposed for
// future per-message-edit support (T2:E5 compression will need it).
void ftsDeleteMessage

/** Detach every RAG attachment on a conversation by REUSING rag/store's own
 *  per-attachment remove path (rather than duplicating the DELETE + its
 *  COALESCE-uniqueness shape here). rag/store shares the same cached DB
 *  connection (getDb), so these removes participate in the caller's
 *  transaction when one is open; the memory-fallback bookkeeping stays inside
 *  rag/store. (No import cycle: rag/store imports only crypto + database.) */
function detachAllRagAttachments(conversationId: string): void {
  for (const att of ragListAttachments(conversationId)) {
    ragRemoveAttachment({
      conversationId,
      collectionId: att.collectionId,
      documentId: att.documentId
    })
  }
}

/** Injectable seam for {@link deleteConversation} so the all-or-nothing cascade
 *  can be unit-tested against a node:sqlite DB without the Electron
 *  better-sqlite3 ABI. Production binds the real getDb()/transactional + module
 *  helpers via {@link defaultDeleteConversationDeps}. */
export interface DeleteConversationDeps {
  db: Pick<Database, 'prepare'>
  transactional: <T>(fn: () => T) => T
  clearConversationState: (id: string) => void
  ftsDeleteAllForConversation: (id: string) => void
  detachAllRagAttachments: (id: string) => void
}

function defaultDeleteConversationDeps(): DeleteConversationDeps {
  return {
    db: getDb(),
    transactional,
    clearConversationState,
    ftsDeleteAllForConversation,
    detachAllRagAttachments
  }
}

export function deleteConversation(
  id: string,
  deps: DeleteConversationDeps = defaultDeleteConversationDeps()
) {
  // Phase B3 — make the delete transactional (all-or-nothing) and cascade to
  // EVERY per-conversation child, including the non-FK tables that used to
  // orphan permanently on each delete. All statements are scoped by
  // conversation_id — NEVER a global wipe. A throw anywhere rolls the whole
  // delete back rather than leaving a half-deleted conversation.
  deps.transactional(() => {
    // FK'd children (messages, stage_metrics, PRs) cascade off this row.
    deps.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
    // plan_steps / goals have no FK to conversations (the '__global__' bucket and
    // ephemeral runs need rows without a conversation row), so clear them here.
    deps.clearConversationState(id)
    deps.ftsDeleteAllForConversation(id)
    // Non-FK children carrying a conversation_id column — no cascade fires, so
    // delete them explicitly (scoped by id). Before B3 these leaked forever:
    // tool_calls had no delete path anywhere; snip_command_log / snip_events
    // only had a global wipe; rag attachments were only detached one-at-a-time
    // from the RAG UI.
    deps.db.prepare('DELETE FROM tool_calls WHERE conversation_id = ?').run(id)
    deps.db.prepare('DELETE FROM snip_command_log WHERE conversation_id = ?').run(id)
    deps.db.prepare('DELETE FROM snip_events WHERE conversation_id = ?').run(id)
    deps.detachAllRagAttachments(id)
  })
}

export function updateConversationTitle(id: string, title: string) {
  const db = getDb()
  db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(
    title,
    Date.now(),
    id
  )
  ftsUpsertConversation(id, title)
}

export function updateConversationModel(id: string, model: string) {
  const db = getDb()
  db.prepare('UPDATE conversations SET model = ?, updated_at = ? WHERE id = ?').run(
    model,
    Date.now(),
    id
  )
}

export function setConversationProject(id: string, projectId: string | null) {
  const db = getDb()
  db.prepare('UPDATE conversations SET project_id = ?, updated_at = ? WHERE id = ?').run(
    projectId,
    Date.now(),
    id
  )
  if (projectId) touchProject(projectId)
}

// Track 2 / C3 — plan mode gate. The flag lives on the conversation row so
// it survives restarts; the dispatcher reads it before approving any
// mutating tool call. `isPlanModeActive` returns false for missing rows so
// stale conversation ids in flight cannot trip the gate.
export function isPlanModeActive(id: string): boolean {
  const db = getDb()
  const row = db
    .prepare('SELECT plan_mode_active FROM conversations WHERE id = ?')
    .get(id) as { plan_mode_active?: number } | undefined
  return !!(row && row.plan_mode_active === 1)
}

export function setPlanModeActive(id: string, active: boolean): boolean {
  const db = getDb()
  const result = db
    .prepare(
      'UPDATE conversations SET plan_mode_active = ?, updated_at = ? WHERE id = ?'
    )
    .run(active ? 1 : 0, Date.now(), id)
  return result.changes > 0
}

export function touchConversation(id: string) {
  const db = getDb()
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  // Bubble activity up to the parent project so it sorts to the top.
  const row = db
    .prepare('SELECT project_id FROM conversations WHERE id = ?')
    .get(id) as { project_id?: string | null } | undefined
  if (row?.project_id) touchProject(row.project_id)
}

/** Pull a leading <think>…</think> block out of an assistant content string
 *  and route it into the dedicated reasoning column. Models without a native
 *  reasoning_content streaming channel (everything except DeepSeek's V4-Flash
 *  thinking mode + the reasoner) emit reasoning inline because the contract
 *  forces them to lead every turn with <think>. Without this extraction, the
 *  reasoning would survive in `content` but never light up the Reasoning
 *  panel — which keys off the dedicated column. We extract at save time so
 *  the persistence shape is consistent regardless of which channel produced
 *  the reasoning. If `reasoning` is already populated (native channel did
 *  its job), leave `content` untouched. */
export function splitInlineReasoning(
  content: string,
  reasoning: string | undefined
): { content: string; reasoning: string | undefined } {
  if (reasoning && reasoning.length > 0) return { content, reasoning }
  const closed = content.match(/^\s*<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/)
  if (closed) {
    return { content: closed[2], reasoning: closed[1].trim() }
  }
  return { content, reasoning }
}

/** Composer-aware variant: tries to pull inline `<think>…</think>` from
 *  `content` first; when that comes up empty AND a `draft` is supplied,
 *  re-runs the split against the draft and hoists any inline reasoning out.
 *  This lets the Reasoning panel survive Final Response Composer passes,
 *  which replace the original body in `content` with a clean rewrite and
 *  stash the original (which carries the inline block) in `draft`.
 *
 *  When neither place has a `<think>` block and `reasoning` was already
 *  supplied by the provider's native channel, the supplied value is
 *  passed through untouched. */
export function splitInlineReasoningWithDraft(
  content: string,
  reasoning: string | undefined,
  draft: string | undefined
): { content: string; reasoning: string | undefined } {
  const fromContent = splitInlineReasoning(content, reasoning)
  if (fromContent.reasoning && fromContent.reasoning.length > 0) {
    return fromContent
  }
  if (typeof draft !== 'string' || draft.length === 0) {
    return fromContent
  }
  const fromDraft = splitInlineReasoning(draft, undefined)
  if (fromDraft.reasoning && fromDraft.reasoning.length > 0) {
    return { content: fromContent.content, reasoning: fromDraft.reasoning }
  }
  return fromContent
}

export function saveMessage(msg: {
  id: string
  conversationId: string
  role: string
  content: string
  model?: string
  toolCallId?: string
  toolCalls?: StoredToolCall[]
  draft?: string
  reasoning?: string
  documents?: StoredDocument[]
  /** Reasoning Audit Phase R1 — multi-agent pipeline stage discriminator.
   *  Pass 'planner' / 'reviewer' / 'composer' from agent-pipeline.ts +
   *  chat.ts composer path. Omit (NULL) for single-agent + Coder rows. */
  stage?: MessageStage
  /** WC-4 — Persisted proof gate trust status. Omit (NULL) for read-only
   *  turns or non-assistant rows. Chat dispatch writes this after the M5
   *  gate evaluates. UI and composer consume from the column, not from
   *  message body text. */
  proofStatus?: ProofStatus
  /** Vision attachments for this turn as OpenAI content parts. `content` must
   *  still carry the turn's TEXT — these are the parts with no text form, so
   *  sanitization, FTS and every display surface keep working off `content`
   *  alone and never see base64. Omit (NULL) for text-only turns. */
  contentParts?: VisionContentPart[]
}) {
  const db = getDb()
  const now = Date.now()
  // Only assistant turns can carry reasoning — user/system/tool rows are
  // always pass-through so the <think> heuristic doesn't accidentally
  // mangle user input that happens to start with a literal <think>.
  //
  // Composer fallback: when the Final Response Composer rewrites the body,
  // chat.ts puts the ORIGINAL (which carries the inline `<think>…</think>`)
  // into `draft` and the composed clean text into `content`. The first
  // splitInlineReasoning call sees no inline block in `content` and returns
  // reasoning=undefined; the draft path below recovers the inline block so
  // the Reasoning panel survives composer passes. Without this, every
  // tool-using turn from inline-emitting models (Gemma, Qwen, V4 Pro
  // without thinking mode) loses its chain-of-thought the moment the
  // composer runs.
  const split =
    msg.role === 'assistant'
      ? splitInlineReasoningWithDraft(msg.content, msg.reasoning, msg.draft)
      : { content: msg.content, reasoning: msg.reasoning }
  // Robustness Hotfix HX4 (v0.8.4) — pseudo-XML sanitisation. Assistant
  // rows occasionally emit `<bash>find …</bash>` (or `<tool>`, `<run>`,
  // `<shell>`, etc.) as final prose instead of invoking a real tool. The
  // chat bubble would render the pseudo-XML as literal text and the user
  // has to re-prompt. We persist the sanitised text in `content` (what
  // every UI surface reads) and the verbatim original in `content_raw`
  // for the audit trail. Non-assistant rows pass through unchanged.
  //
  // FC-7 — when the assistant message has native tool calls (toolCalls
  // populated by the provider), skip sanitisation. The model used the API
  // correctly; pseudo-XML in prose alongside real tool_calls is never a
  // ghosted invocation. Fallback models (no tool_calls, supportsTools:
  // false) still run through the sanitizer.
  const hasNativeToolCalls = !!(msg.toolCalls && msg.toolCalls.length > 0)
  const sanitizedContent =
    msg.role === 'assistant' && !hasNativeToolCalls
      ? sanitizePseudoTags(split.content)
      : split.content
  const contentRaw =
    msg.role === 'assistant' && sanitizedContent !== split.content ? split.content : null
  const toolCallsJson = msg.toolCalls && msg.toolCalls.length > 0 ? JSON.stringify(msg.toolCalls) : null
  const documentsJson = msg.documents && msg.documents.length > 0 ? JSON.stringify(msg.documents) : null
  // Vision parts ride their own column. Note what does NOT happen to them: they
  // are not sanitized, not split for reasoning, and above all not fed to FTS —
  // a base64 image in the search index would bloat the DB for zero search value.
  const contentPartsJson =
    msg.contentParts && msg.contentParts.length > 0 ? JSON.stringify(msg.contentParts) : null
  // PS3 — wrap the message INSERT + touchConversation + FTS sync in
  // withWriteRetry so a transient SQLITE_BUSY (post-busy_timeout, rare
  // multi-process edge case) doesn't drop a chat message silently.
  // This is the single highest-frequency writer in the app; a dropped
  // row leaves the renderer's optimistic-updated bubble without DB
  // backing on the next reload.
  // The retried unit must be atomic. touchConversation runs unguarded AFTER the INSERT has
  // already committed in autocommit mode, so a SQLITE_BUSY there replayed the whole closure and
  // the second INSERT hit the primary key — turning a transient busy into a hard constraint throw
  // with the row half-written and its FTS entry missing. Wrapping in a transaction means a retry
  // starts from a rolled-back slate; better-sqlite3 nests via SAVEPOINT, so an outer transaction
  // stays safe.
  withWriteRetry(
    () =>
      transactional(() => {
        db.prepare(
          'INSERT INTO messages (id, conversation_id, role, content, model, tool_call_id, tool_calls, draft, reasoning, documents, stage, content_raw, proof_status, content_parts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
          msg.id,
          msg.conversationId,
          msg.role,
          sanitizedContent,
          msg.model || null,
          msg.toolCallId || null,
          toolCallsJson,
          msg.draft || null,
          split.reasoning || null,
          documentsJson,
          msg.stage || null,
          contentRaw,
          msg.proofStatus || null,
          contentPartsJson,
          now
        )
        touchConversation(msg.conversationId)
        // E3: keep the cross-session FTS index in sync. User/assistant
        // bodies are the ones worth searching; system/tool messages are
        // usually plumbing and would inflate the index with noise. We index
        // the sanitised content so search matches what the user sees in the
        // bubble, not the pseudo-XML.
        if (msg.role === 'user' || msg.role === 'assistant') {
          ftsInsertMessage(msg.id, msg.conversationId, sanitizedContent)
        }
      }),
    { label: 'conversation-store.saveMessage' }
  )
  return {
    id: msg.id,
    conversationId: msg.conversationId,
    role: msg.role,
    content: sanitizedContent,
    contentRaw: contentRaw ?? undefined,
    timestamp: now,
    model: msg.model,
    toolCallId: msg.toolCallId,
    toolCalls: msg.toolCalls,
    draft: msg.draft,
    reasoning: split.reasoning,
    documents: msg.documents,
    stage: msg.stage,
    proofStatus: msg.proofStatus
  }
}

/**
 * WC-5 — Flip a message's persisted proof_status. Used by the waiver
 * flow after the user explicitly waives a proof gate via the
 * `contracts:waive` IPC. Returns the new status on success, or null if
 * the message row does not exist.
 */
export function setMessageProofStatus(
  messageId: string,
  status: ProofStatus | null
): ProofStatus | null {
  const db = getDb()
  const result = db
    .prepare('UPDATE messages SET proof_status = ? WHERE id = ?')
    .run(status ?? null, messageId)
  if (result.changes === 0) return null
  return status
}

export function getMessages(conversationId: string) {
  const db = getDb()
  const rows = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
  ).all(conversationId) as MessageRow[]
  return rows.map((row) => {
    let toolCalls: StoredToolCall[] | undefined
    if (row.tool_calls) {
      try {
        const parsed = JSON.parse(row.tool_calls)
        if (Array.isArray(parsed)) toolCalls = parsed as StoredToolCall[]
      } catch {
        // Corrupt JSON — drop. The orphan-tool filter in chat.ts will
        // handle the consequence (drop tool replies that have no parent).
      }
    }
    let documents: StoredDocument[] | undefined
    if (row.documents) {
      try {
        const parsed = JSON.parse(row.documents)
        if (Array.isArray(parsed)) documents = parsed as StoredDocument[]
      } catch {
        // Same corrupt-JSON policy as toolCalls — drop and continue.
      }
    }
    let contentParts: VisionContentPart[] | undefined
    if (row.content_parts) {
      try {
        const parsed = JSON.parse(row.content_parts)
        if (Array.isArray(parsed) && parsed.length) contentParts = parsed as VisionContentPart[]
      } catch {
        // Same corrupt-JSON policy — drop the images, keep the turn. `content`
        // still holds the text, so a corrupt part list degrades to a text turn
        // rather than losing the message.
      }
    }
    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role as 'user' | 'assistant' | 'system' | 'tool',
      content: row.content,
      timestamp: row.created_at,
      model: row.model || undefined,
      toolCallId: row.tool_call_id || undefined,
      // Track 2 / E5 — passed through to the renderer so the chat view
      // can show a CompressedRegionPill where originals were folded.
      compressedInto: row.compressed_into ?? undefined,
      toolCalls,
      reasoning: row.reasoning ?? undefined,
      documents,
      // Reasoning Audit Phase R1 — multi-agent pipeline stage discriminator.
      // NULL on legacy rows + Coder rows reaches the renderer as `undefined`,
      // which MessageBubble (R7) treats as "no chip, no toggle".
      stage: (row.stage ?? undefined) as MessageStage | undefined,
      // Robustness Hotfix HX4 (v0.8.4) — verbatim pre-sanitisation copy of
      // the assistant body. NULL on legacy + non-assistant + already-clean
      // assistant rows. Renderer ignores it; audit / export surfaces opt in.
      contentRaw: row.content_raw ?? undefined,
      // WC-4 — persisted proof gate trust status. NULL → undefined so the
      // renderer treats it as "not applicable" and renders no banner state.
      proofStatus: (row.proof_status ?? undefined) as ProofStatus | undefined,
      // Vision attachments. NULL on every text turn → undefined, so callers
      // that never learned about images behave exactly as before.
      contentParts
    }
  })
}
