import { randomUUID } from 'crypto'
import type { Database } from 'better-sqlite3'
import { getDb, withWriteRetry } from './database'
import { friendly, messageOf } from './guarded'

// Append-only event log. The cross-system audit/timeline complement to the
// structured domain tables (tool_calls, permission_policies, automations,
// projects). This service is the only sanctioned writer: it owns JSON
// serialization, payload size caps, timestamping, and metadata-only redaction.
//
// What the log records vs. does NOT record:
//   - metadata, IDs, statuses, counts, durations, model/provider names, bounded
//     previews, redacted paths/args. Yes.
//   - secrets, full API keys, OAuth tokens, raw model responses, full file
//     contents, anything beyond the payload cap. No — those either belong on
//     `messages` (model content) or in the keychain (credentials), never here.
//
// See PLANNING/Lamprey_Data_Spine_Plan_and_Prompt_Timeline.md for the spine
// roadmap and how producers will be wired in Prompts 2–4.

// ──────────────────── event types ────────────────────

export const EVENT_TYPES = [
  // Tool call lifecycle (Prompt 2). Mirror tool_calls but in timeline form.
  'tool.call.started',
  'tool.call.approved',
  'tool.call.denied',
  'tool.call.completed',
  'tool.call.failed',

  // Agent pipeline (Prompt 3): planner/coder/reviewer stages.
  'agent.stage.started',
  'agent.stage.completed',
  'agent.stage.failed',

  // Model requests (Prompt 3): per-provider per-model calls.
  'model.request.started',
  'model.request.completed',
  'model.request.failed',

  // Chat (Prompt 3).
  'chat.cancelled',
  'chat.error',

  // Track 2 / E1 — session chapter marker. Emitted by the chapters store
  // every time a row is inserted via the `mark_chapter` tool or the
  // `session:markChapter` IPC. Plan §2 invariant 10.
  'chat.chapter.marked',

  // Track 2 / E5 — auto context compression. Emitted by the compressor
  // when a conversation's projected tokens trip the threshold and the
  // oldest messages get folded into a summary. Payload carries the
  // compressed count, original/summary token counts, and reduction %.
  'chat.compressed',

  // Workspace + worktree (Prompt 4).
  'workspace.changed',
  'worktree.created',
  'worktree.removed',

  // Automations (Prompt 4).
  'automation.started',
  'automation.completed',
  'automation.failed',

  // Track 3 / G2: self-paced loop wake-up lifecycle.
  'loop.wakeup.scheduled',
  'loop.wakeup.fired',

  // Loop Phase LP-3: recurring loop iteration lifecycle.
  'loop.iteration',
  'loop.iteration.error',
  // Headless agentic loop runs (the autonomy executor — real artifacts).
  'loop.agentic.completed',
  'loop.agentic.failed',

  // Security / policy (Prompt 2 + ongoing).
  'security.decision',
  'permission.policy.created',
  'permission.policy.updated',
  'permission.policy.deleted',

  // Settings (Prompt 4): key-change metadata only, never raw values.
  'settings.updated',

  // Projects (Prompt 4): created/archived/pinned/deleted are discrete user
  // actions with single-flag semantics. Rename + touch are noisy
  // bookkeeping and intentionally stay off the event spine.
  'project.created',
  'project.archived',
  'project.pinned',
  'project.deleted',

  // RAG collections (R1 of the LAMPREY_RAG_PLAN). Discrete user actions on
  // the collection table. Document / chunk / ingest / query / retrieval /
  // rerank / model-download event types land in later R-prompts alongside
  // their producers.
  'rag.collection.created',
  'rag.collection.updated',
  'rag.collection.deleted',

  // RAG embedder download lifecycle (R2). Emitted by the embeddings service
  // on first activation of a model id — the underlying transformers.js
  // pipeline fetches weights from HF once and caches them in
  // userData/models/transformers/. Per-byte progress isn't surfaced by
  // transformers.js; v1 emits started + completed only.
  'rag.model.download.started',
  'rag.model.download.completed',
  'rag.model.download.failed',

  // RAG ingest pipeline (R5). One pair per file inside an ingest job.
  // correlationId on the event row is the jobId so the timeline can
  // reconstruct a multi-file ingest by one id.
  'rag.ingest.started',
  'rag.ingest.completed',
  'rag.ingest.failed',

  // RAG retrieval (R7-R9). One event per top-level query — sub-queries
  // emitted by multi-query rewrite (R9) are rolled into the parent's
  // payload, not emitted separately.
  'rag.query.completed',
  'rag.query.failed',
  'rag.rerank.completed',
  'rag.rerank.failed',
  'persistence.checkpoint',
  'persistence.integrity',
  'persistence.backup',
  'persistence.backup_rejected',
  'persistence.recovery',
  'conversation.forked',
  'conversation.seed.attached',
  'conversation.seed.truncated',
  'proof.receipt.created',
  'proof.receipt.failed',
  'proof.gate.passed',
  'proof.gate.failed',
  'proof.gate.waived',
  'failure_ledger.recorded',
  'failure_ledger.repeated',
  // Unexpected failure caught by guarded() — the anti-swallow telemetry that
  // makes silent degradation (dead vector stack, ledger-CHECK) loud + queryable.
  'guarded.failure',
  // Feedback channel (DUIN autonomic nervous system, organ #1). One row per
  // user verdict on a proactive surface (act/snooze/dismiss/not-relevant).
  // The typed seed in the payload is what feeds the starved P5 (correction)
  // and P6 (forecast-resolution) loops; the per-detectorClass tally is the
  // loudness gate + earned-autonomy governor's primary sensor.
  'feedback.observation.recorded',

  // Schema-graft "surprise" instrument. One row each time reality contradicts a
  // prediction the brain staged — a turn-beat track miss or a resolved forecast
  // miss. First-class, queryable audit of every mispredict (predicted vs actual
  // in the payload). Deliberately NOT `*.failed`: the calibration gap-axis
  // already derives systematic weakness from these same miss-rates, so this row
  // is audit/timeline only and must NOT auto-feed the recurring-failure axis.
  'prediction.mispredicted',

  // Task & thread control — recoverable lifecycle mutation (rename / pin / unpin /
  // archive / close / restore) and permanent task-tree deletion. Emitted by the
  // task-lifecycle service; audit/timeline only.
  'task.metadata.updated',
  'task.deleted',

  // Schema-graft "carry": a self-authored forward note-to-self, recorded when the brain
  // promotes a belief, resurfaced at the next turn-open so a follow-up ("recheck this")
  // survives context compaction. Reuses the event spine — no new ledger. Recording is
  // always-on (cheap audit); the turn-open resurface is gated (DUIN_FORWARD_NOTES).
  'note.forward.recorded',

  // Operator-fact lifecycle (Remember loop). Added 2026-07-30: of 34,807 rows in
  // `events`, NOT ONE matched memory / fact / capture / promotion / correction —
  // so every question about whether the Remember loop was turning had to be
  // answered by diffing file timestamps by hand. A loop that cannot report on
  // itself is a loop nobody notices has stopped (constitution property 7).
  'operator.fact.recorded',
  'operator.fact.promoted',
  'operator.fact.confirmed',
  'operator.fact.reverted',
  'operator.fact.vetoed',
  'operator.promotion.held',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export type EventSeverity = 'info' | 'warning' | 'error'

/**
 * Provenance label on the JSON payload column. `metadata` (default) means the
 * row only carries structural metadata — safe to read freely. `preview` means
 * the row includes a bounded preview of user-or-model content; UI surfaces
 * should label these accordingly. `redacted` means the writer dropped fields it
 * could not safely persist.
 */
export type EventRedaction = 'metadata' | 'preview' | 'redacted'

/**
 * Who acted. `user` = direct human action; `system` = housekeeping/timer;
 * `agent` = orchestrator (single-mode or pipeline); `model` = provider/LLM;
 * `tool` = tool invocation outcome (used for tool-completion events where the
 * tool itself, not the model that called it, is the relevant actor).
 */
export type EventActorKind = 'user' | 'system' | 'agent' | 'model' | 'tool'

// ──────────────────── records ────────────────────

export interface EventRecord {
  id: string
  type: EventType
  createdAt: number
  severity: EventSeverity
  conversationId?: string
  projectId?: string
  workspacePath?: string
  automationId?: string
  toolCallId?: string
  parentEventId?: string
  correlationId?: string
  actorKind: EventActorKind
  actorId?: string
  entityKind?: string
  entityId?: string
  payload: Record<string, unknown>
  redaction: EventRedaction
}

export interface RecordEventInput {
  type: EventType
  severity?: EventSeverity
  conversationId?: string
  projectId?: string
  workspacePath?: string
  automationId?: string
  toolCallId?: string
  parentEventId?: string
  correlationId?: string
  actorKind: EventActorKind
  actorId?: string
  entityKind?: string
  entityId?: string
  payload?: Record<string, unknown>
  redaction?: EventRedaction
}

export interface EventFilter {
  type?: EventType | EventType[]
  conversationId?: string
  projectId?: string
  workspacePath?: string
  automationId?: string
  toolCallId?: string
  correlationId?: string
  severity?: EventSeverity | EventSeverity[]
  /** Inclusive lower bound (epoch ms). */
  sinceMs?: number
  /** Inclusive upper bound (epoch ms). */
  untilMs?: number
  /** Max rows. Clamped to MAX_LIST_LIMIT. Default 200. */
  limit?: number
  /** Order: 'desc' (default, recent first) or 'asc' (timeline order). */
  order?: 'asc' | 'desc'
}

// ──────────────────── caps + redaction ────────────────────

/**
 * Maximum serialized payload size. Anything larger is wrapped into a
 * `{ truncated: true, originalBytes }` envelope and stored as `redacted`. This
 * is intentionally well below SQLite's row limit — the event log is for
 * timeline metadata, not bulk content storage.
 */
export const PAYLOAD_BYTE_CAP = 16 * 1024

/**
 * Maximum rows a single listEvents call will return. Callers asking for more
 * are silently clamped — the event log is a timeline aid, not a bulk export.
 */
export const MAX_LIST_LIMIT = 1000

/**
 * Retention window for the append-only events table. Rows older than this are
 * eligible for pruning UNLESS another row still references them (see
 * `failure_ledger.event_id`). The events table is a timeline aid, not a
 * permanent archive: at the observed ~570 rows/day, 30 days ≈ 17k rows — small
 * and useful — while a runaway automation once wrote 108k rows in a burst that
 * had to be pruned by hand. `pruneEvents` (wired into the daily backup tick)
 * makes that bound automatic. MAX_LIST_LIMIT is only a READ cap and never
 * deleted anything.
 */
export const EVENT_RETENTION_DAYS = 30

/**
 * Absolute upper bound on retained events. Even inside the retention window a
 * runaway burst must not let the table grow without limit, so when the row
 * count exceeds this after age-pruning, the OLDEST rows past the cap are
 * dropped (still preserving referenced rows).
 */
export const EVENT_MAX_ROWS = 100_000

const SECRET_KEY_PATTERNS: RegExp[] = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /authorization/i,
  /bearer/i,
  /private[_-]?key/i,
  /client[_-]?secret/i,
  /refresh[_-]?token/i,
  /access[_-]?token/i,
  /openai[_-]?key/i,
  /anthropic[_-]?key/i,
  /credential/i,
  /cookie/i,
  /session[_-]?id/i
]

function looksSensitive(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key))
}

/**
 * Walk a JSON-serializable payload and drop values under keys that look like
 * credentials. We replace the value with the literal string '[redacted]' so
 * timeline consumers still see the field's *presence* (useful for "the request
 * carried an auth header" without leaking the header itself). Returns the
 * cleaned payload plus whether any redaction occurred.
 *
 * Cycle-safe: tracks objects we've already seen so a self-referential payload
 * cannot send the walker into an infinite loop.
 */
export function redactPayload(value: unknown): {
  value: unknown
  redacted: boolean
} {
  const seen = new WeakSet<object>()
  let anyRedacted = false

  function walk(v: unknown): unknown {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v as object)) {
      anyRedacted = true
      return '[cycle]'
    }
    seen.add(v as object)
    if (Array.isArray(v)) {
      return v.map((item) => walk(item))
    }
    const out: Record<string, unknown> = {}
    for (const [k, raw] of Object.entries(v)) {
      if (looksSensitive(k)) {
        anyRedacted = true
        out[k] = '[redacted]'
      } else {
        out[k] = walk(raw)
      }
    }
    return out
  }

  return { value: walk(value), redacted: anyRedacted }
}

/**
 * Per-field preview cap. Producers (tool registry, agent pipeline, retrieval)
 * call boundedJsonPreview to inline a short, redacted view of a specific value
 * — args, result text, model response — into an event payload. The full
 * payload cap still applies, but using this helper means a single large field
 * can't push the *whole* payload into a truncation envelope, which would lose
 * the surrounding metadata (toolId, durationMs, etc.) that makes the event
 * useful in the timeline.
 */
export const FIELD_PREVIEW_CHAR_CAP = 2048

/**
 * Build a bounded, redacted JSON preview of a value. Suitable for stuffing
 * into a payload field whose primary job is "give the user a hint of what
 * this call carried" without leaking secrets or duplicating large blobs into
 * the event log. Returns null when the input is undefined so callers can
 * conditionally omit the field.
 */
export function boundedJsonPreview(
  value: unknown,
  maxChars: number = FIELD_PREVIEW_CHAR_CAP
): string | null {
  if (value === undefined) return null
  if (typeof value === 'string') {
    if (value.length <= maxChars) return value
    return value.slice(0, Math.max(0, maxChars - 16)) + '… (truncated)'
  }
  const { value: cleaned } = redactPayload(value)
  let json: string
  try {
    json = JSON.stringify(cleaned)
  } catch (err) {
    json = JSON.stringify({
      _serializationError: String((err as Error)?.message ?? err)
    })
  }
  if (json.length <= maxChars) return json
  return json.slice(0, Math.max(0, maxChars - 16)) + '… (truncated)'
}

interface SerializeResult {
  json: string
  redaction: EventRedaction
}

/**
 * Serialize a payload to JSON with redaction + size cap. The result is what
 * actually lands in the `payload_json` column. Pure: callers in tests can
 * exercise size-cap behavior without writing to the database.
 */
export function serializePayload(
  payload: Record<string, unknown> | undefined,
  declared: EventRedaction = 'metadata'
): SerializeResult {
  const base = payload ?? {}
  const { value: cleaned, redacted } = redactPayload(base)
  let json: string
  try {
    json = JSON.stringify(cleaned)
  } catch (err) {
    json = JSON.stringify({
      _serializationError: String((err as Error)?.message ?? err)
    })
    return { json, redaction: 'redacted' }
  }
  let resolved: EventRedaction = declared
  if (redacted && resolved !== 'redacted') resolved = 'redacted'

  if (json.length > PAYLOAD_BYTE_CAP) {
    const envelope = {
      truncated: true,
      originalBytes: json.length,
      cap: PAYLOAD_BYTE_CAP
    }
    return { json: JSON.stringify(envelope), redaction: 'redacted' }
  }
  return { json, redaction: resolved }
}

// ──────────────────── DB row mapping ────────────────────

interface EventRow {
  id: string
  type: string
  created_at: number
  severity: string
  conversation_id: string | null
  project_id: string | null
  workspace_path: string | null
  automation_id: string | null
  tool_call_id: string | null
  parent_event_id: string | null
  correlation_id: string | null
  actor_kind: string
  actor_id: string | null
  entity_kind: string | null
  entity_id: string | null
  payload_json: string
  redaction: string
}

function rowToEvent(row: EventRow): EventRecord {
  let payload: Record<string, unknown>
  try {
    const parsed = JSON.parse(row.payload_json)
    payload =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { value: parsed }
  } catch {
    payload = { _parseError: true }
  }
  return {
    id: row.id,
    type: row.type as EventType,
    createdAt: row.created_at,
    severity: row.severity as EventSeverity,
    conversationId: row.conversation_id ?? undefined,
    projectId: row.project_id ?? undefined,
    workspacePath: row.workspace_path ?? undefined,
    automationId: row.automation_id ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    parentEventId: row.parent_event_id ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    actorKind: row.actor_kind as EventActorKind,
    actorId: row.actor_id ?? undefined,
    entityKind: row.entity_kind ?? undefined,
    entityId: row.entity_id ?? undefined,
    payload,
    redaction: row.redaction as EventRedaction
  }
}

// ──────────────────── memory fallback ────────────────────

// Activates when getDb() throws (headless tests without an Electron app). The
// pattern mirrors permission-policies-store: same public API, the swap happens
// inside the service so callers never have to know which path they hit.
//
// SCOPE — exactly ONE condition, the one the line above names: there is no
// database in this process at all. That is a TOTAL failure — no persistence
// exists to lose — so serving process-local arrays beats throwing.
//
// It is deliberately NOT reachable from a failure *inside* a SQL statement.
// That is a PARTIAL failure: the database is open and every recorded event is
// still on disk. Latching there used to point the whole audit spine at a
// volatile array AND make listEvents() serve that same array, so the Activity
// Timeline rendered the user's on-disk history as EMPTY — indistinguishable
// from "my audit log was wiped" — for the rest of the process, while
// security.decision / proof.gate.waived / tool-approval events were written to
// memory and lost at quit. One statement was enough to trip it: "Continue
// read-only" on the integrity banner reopens the DB with `readonly: true`, and
// getDb()'s own startup runIntegrityCheck() records a `persistence.integrity`
// event whose INSERT then raises SQLITE_READONLY. The daily prune tick tripped
// it the same way on a transient SQLITE_BUSY.
//
// What made it invisible: the latch is quiet, permanent and process-wide. The
// single console.warn scrolls past; recordEvent still returns a populated
// EventRecord so every caller reads it as success; every later call takes the
// fast `useFallback` path without touching the DB again, so nothing retries and
// nothing re-checks whether the database recovered. Even leaving read-only mode
// does not clear it — only the test-only __resetEventLog does.
//
// Transient failures are now retried by `withWriteRetry` (the same PS3 guard
// conversation-store, brain-db and entity-graph-store use) and anything that
// survives the retries stays local to the statement that caused it. This
// mirrors the identical fix already made in rag/store.ts and
// permission-policies-store.ts.
const memoryFallback: EventRecord[] = []
let useFallback = false

function activateFallback(reason: string): void {
  if (!useFallback) {
    useFallback = true
    console.warn(
      `[event-log] persistence unavailable, falling back to memory: ${reason}`
    )
  }
}

/**
 * Acquire the DB handle for one event-log call.
 *
 * Returns `null` only when the caller must use the memory buffer — the fallback
 * is already latched, or `getDb()` itself threw (no database in this process).
 * A handle means the DB is present: the caller runs its statements inside
 * {@link runDb} and a statement-level failure never downgrades persistence.
 */
function acquireDb(op: string): Database | null {
  if (useFallback) return null
  try {
    return getDb()
  } catch (err) {
    activateFallback(`${op}: ${friendly(err, 'unknown')}`)
    return null
  }
}

/**
 * Run one statement group against a live DB, retrying a transient SQLITE_BUSY.
 * Anything still failing after the retries is rethrown to this call's own
 * caller: the events are on disk, and a reader must learn that its query failed
 * rather than be handed an empty list that reads as "there are no events".
 */
function runDb<T>(op: string, fn: () => T): T {
  try {
    return withWriteRetry(fn, { label: `event-log.${op}` })
  } catch (err) {
    console.error(
      `[event-log] ${op} failed against the database: ${friendly(
        err,
        'unknown'
      )} — surfacing to the caller (persistence is NOT being downgraded to memory)`
    )
    throw err
  }
}

export function isUsingMemoryFallback(): boolean {
  return useFallback
}

// ──────────────────── writer ────────────────────

/**
 * Record a single event. Returns the persisted EventRecord with id +
 * createdAt populated. Never throws on payload size — oversize payloads are
 * truncated to an envelope and marked `redaction: 'redacted'`.
 */
export function recordEvent(input: RecordEventInput): EventRecord {
  if (!EVENT_TYPES.includes(input.type)) {
    throw new Error(`recordEvent: unknown event type "${input.type}"`)
  }
  if (!input.actorKind) {
    throw new Error('recordEvent: actorKind is required')
  }

  const id = randomUUID()
  const createdAt = Date.now()
  const severity: EventSeverity = input.severity ?? 'info'
  const { json, redaction } = serializePayload(input.payload, input.redaction)

  const record: EventRecord = {
    id,
    type: input.type,
    createdAt,
    severity,
    conversationId: input.conversationId,
    projectId: input.projectId,
    workspacePath: input.workspacePath,
    automationId: input.automationId,
    toolCallId: input.toolCallId,
    parentEventId: input.parentEventId,
    correlationId: input.correlationId,
    actorKind: input.actorKind,
    actorId: input.actorId,
    entityKind: input.entityKind,
    entityId: input.entityId,
    payload: safeParsePayload(json),
    redaction
  }

  const db = acquireDb('recordEvent')
  if (db) {
    try {
      runDb('recordEvent', () =>
        db
          .prepare(
            `INSERT INTO events
           (id, type, created_at, severity,
            conversation_id, project_id, workspace_path,
            automation_id, tool_call_id, parent_event_id, correlation_id,
            actor_kind, actor_id, entity_kind, entity_id,
            payload_json, redaction)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            id,
            input.type,
            createdAt,
            severity,
            input.conversationId ?? null,
            input.projectId ?? null,
            input.workspacePath ?? null,
            input.automationId ?? null,
            input.toolCallId ?? null,
            input.parentEventId ?? null,
            input.correlationId ?? null,
            input.actorKind,
            input.actorId ?? null,
            input.entityKind ?? null,
            input.entityId ?? null,
            json,
            redaction
          )
      )
    } catch {
      // BEST-EFFORT WRITER: recordEvent is fire-and-forget for every producer
      // (most call it from inside their own catch blocks), so a write that
      // survives the retries drops THIS event only — runDb has already logged
      // why. What it must NOT do is latch the fallback: the on-disk history is
      // intact, later writes may well succeed, and a permanent swap would blank
      // the timeline reads too (see the fallback docblock above).
    }
    return record
  }
  memoryFallback.push(record)
  return record
}

function safeParsePayload(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { value: parsed }
  } catch {
    return {}
  }
}

// ──────────────────── retention / prune ────────────────────

export interface PruneEventsOptions {
  /** Delete events older than this many days. Default EVENT_RETENTION_DAYS. */
  retentionDays?: number
  /** Hard row-count ceiling; oldest rows past it are dropped. Default EVENT_MAX_ROWS. */
  maxRows?: number
  /** Injectable clock (ms) for deterministic tests. Default Date.now(). */
  now?: number
}

export interface PruneEventsResult {
  deletedByAge: number
  deletedByCap: number
  deleted: number
}

/**
 * Check a table exists so the referenced-event preservation clause only runs when
 * `failure_ledger` is present (it always is in the live app; some unit-test DBs
 * bootstrap only the events table).
 */
function tableExists(db: ReturnType<typeof getDb>, name: string): boolean {
  try {
    return !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name)
  } catch {
    return false
  }
}

/**
 * Retention policy for the unbounded `events` table. Deletes rows older than
 * `retentionDays`, then — if still over `maxRows` — drops the oldest rows past
 * the cap. SAFE by construction:
 *   - SCOPED: only ever deletes from `events`; touches nothing else.
 *   - REFERENCE-PRESERVING: `failure_ledger.event_id` is a soft cross-table
 *     reference (no SQL FK), so a live ledger row must keep its originating
 *     event. Both deletes exclude any event whose id appears in
 *     `failure_ledger.event_id`, so a ledger reference is never orphaned. (When
 *     `failure_ledger` doesn't exist there is nothing to preserve.)
 *   - TRANSACTIONAL: age + cap run in one transaction, so a mid-prune failure
 *     rolls back and leaves the table exactly as it was.
 *   - FAILURE-ISOLATED: any error is swallowed (logged by `runDb`) and reported
 *     as zero deletions — pruning is housekeeping and must never take down its
 *     caller (the daily backup tick). Isolated means isolated: a failed prune
 *     also must not switch the log over to the memory fallback.
 *
 * Note on `parent_event_id`: that is an intra-table advisory link for timeline
 * threading, not a live dependency, and age-pruning removes a coherent old
 * window together — a surviving recent child pointing at a pruned old parent is
 * acceptable (and already tolerated by readers). Only the load-bearing
 * cross-table `failure_ledger` reference is preserved.
 */
export function pruneEvents(opts?: PruneEventsOptions): PruneEventsResult {
  const retentionDays =
    typeof opts?.retentionDays === 'number' && opts.retentionDays > 0
      ? opts.retentionDays
      : EVENT_RETENTION_DAYS
  const maxRows =
    typeof opts?.maxRows === 'number' && opts.maxRows > 0
      ? Math.floor(opts.maxRows)
      : EVENT_MAX_ROWS
  const now = typeof opts?.now === 'number' ? opts.now : Date.now()
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000

  const db = acquireDb('pruneEvents')
  if (db) {
    try {
      const hasLedger = tableExists(db, 'failure_ledger')
      // NOT EXISTS is null-safe: ledger rows with a NULL event_id never match, so
      // they don't accidentally shield anything. Omitted entirely when the table
      // is absent (nothing to preserve).
      const preserveClause = hasLedger
        ? `AND NOT EXISTS (SELECT 1 FROM failure_ledger fl WHERE fl.event_id = events.id)`
        : ''

      const run = db.transaction((): { byAge: number; byCap: number } => {
        // 1) Age prune — old rows nothing depends on.
        const byAge = db
          .prepare(`DELETE FROM events WHERE created_at < ? ${preserveClause}`)
          .run(cutoff).changes

        // 2) Cap prune — if still over the ceiling, drop the OLDEST rows beyond it
        //    (still preserving referenced rows). DELETE...ORDER BY/LIMIT isn't
        //    compiled into better-sqlite3's SQLite, so we select the victim ids in
        //    a subquery (ORDER BY + LIMIT are legal there).
        let byCap = 0
        const total = (db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number }).c
        if (total > maxRows) {
          byCap = db
            .prepare(
              `DELETE FROM events WHERE id IN (
                 SELECT id FROM events
                 WHERE 1 ${preserveClause}
                 ORDER BY created_at ASC
                 LIMIT ?
               )`
            )
            .run(total - maxRows).changes
        }
        return { byAge, byCap }
      })

      return runDb('pruneEvents', () => {
        const { byAge, byCap } = run()
        return { deletedByAge: byAge, deletedByCap: byCap, deleted: byAge + byCap }
      })
    } catch {
      // Housekeeping, so the failure stops here and reports zero deletions
      // (runDb logged it). Deliberately NOT the memory branch below: the events
      // are still on disk, and pruning the volatile buffer instead — after
      // latching the whole log onto it — was how a transient SQLITE_BUSY on the
      // daily backup tick used to blank the timeline for the rest of the run.
      return { deletedByAge: 0, deletedByCap: 0, deleted: 0 }
    }
  }

  // Memory fallback: apply the same policy to the in-memory buffer. No
  // failure_ledger there, so there is nothing to preserve by reference.
  const before = memoryFallback.length
  for (let i = memoryFallback.length - 1; i >= 0; i--) {
    if (memoryFallback[i].createdAt < cutoff) memoryFallback.splice(i, 1)
  }
  const deletedByAge = before - memoryFallback.length
  let deletedByCap = 0
  if (memoryFallback.length > maxRows) {
    // Sort oldest→newest, drop the oldest overflow.
    memoryFallback.sort((a, b) => a.createdAt - b.createdAt)
    deletedByCap = memoryFallback.length - maxRows
    memoryFallback.splice(0, deletedByCap)
  }
  return { deletedByAge, deletedByCap, deleted: deletedByAge + deletedByCap }
}

// ──────────────────── helpers ────────────────────

type SeverityHelperInput = Omit<RecordEventInput, 'severity'>

export function recordInfo(input: SeverityHelperInput): EventRecord {
  return recordEvent({ ...input, severity: 'info' })
}

export function recordWarning(input: SeverityHelperInput): EventRecord {
  return recordEvent({ ...input, severity: 'warning' })
}

export function recordError(input: SeverityHelperInput): EventRecord {
  return recordEvent({ ...input, severity: 'error' })
}

// ──────────────────── readers ────────────────────

export function getEvent(id: string): EventRecord | null {
  const db = acquireDb('getEvent')
  if (db) {
    return runDb('getEvent', () => {
      const row = db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as
        | EventRow
        | undefined
      return row ? rowToEvent(row) : null
    })
  }
  return memoryFallback.find((e) => e.id === id) ?? null
}

interface BuiltQuery {
  sql: string
  params: Array<string | number>
}

function buildListQuery(filter: EventFilter): BuiltQuery {
  const where: string[] = []
  const params: Array<string | number> = []

  if (filter.type) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type]
    if (types.length > 0) {
      where.push(`type IN (${types.map(() => '?').join(', ')})`)
      params.push(...types)
    }
  }
  if (filter.severity) {
    const sevs = Array.isArray(filter.severity) ? filter.severity : [filter.severity]
    if (sevs.length > 0) {
      where.push(`severity IN (${sevs.map(() => '?').join(', ')})`)
      params.push(...sevs)
    }
  }
  if (filter.conversationId) {
    where.push('conversation_id = ?')
    params.push(filter.conversationId)
  }
  if (filter.projectId) {
    where.push('project_id = ?')
    params.push(filter.projectId)
  }
  if (filter.workspacePath) {
    where.push('workspace_path = ?')
    params.push(filter.workspacePath)
  }
  if (filter.automationId) {
    where.push('automation_id = ?')
    params.push(filter.automationId)
  }
  if (filter.toolCallId) {
    where.push('tool_call_id = ?')
    params.push(filter.toolCallId)
  }
  if (filter.correlationId) {
    where.push('correlation_id = ?')
    params.push(filter.correlationId)
  }
  if (typeof filter.sinceMs === 'number') {
    where.push('created_at >= ?')
    params.push(filter.sinceMs)
  }
  if (typeof filter.untilMs === 'number') {
    where.push('created_at <= ?')
    params.push(filter.untilMs)
  }

  const order = filter.order === 'asc' ? 'ASC' : 'DESC'
  const limit = clampLimit(filter.limit)
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const sql =
    `SELECT * FROM events ${whereClause} ORDER BY created_at ${order} LIMIT ?`.trim()
  params.push(limit)
  return { sql, params }
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return 200
  }
  return Math.min(Math.floor(limit), MAX_LIST_LIMIT)
}

function eventMatchesFilter(e: EventRecord, filter: EventFilter): boolean {
  if (filter.type) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type]
    if (types.length > 0 && !types.includes(e.type)) return false
  }
  if (filter.severity) {
    const sevs = Array.isArray(filter.severity) ? filter.severity : [filter.severity]
    if (sevs.length > 0 && !sevs.includes(e.severity)) return false
  }
  if (filter.conversationId && e.conversationId !== filter.conversationId) return false
  if (filter.projectId && e.projectId !== filter.projectId) return false
  if (filter.workspacePath && e.workspacePath !== filter.workspacePath) return false
  if (filter.automationId && e.automationId !== filter.automationId) return false
  if (filter.toolCallId && e.toolCallId !== filter.toolCallId) return false
  if (filter.correlationId && e.correlationId !== filter.correlationId) return false
  if (typeof filter.sinceMs === 'number' && e.createdAt < filter.sinceMs) return false
  if (typeof filter.untilMs === 'number' && e.createdAt > filter.untilMs) return false
  return true
}

export function listEvents(filter: EventFilter = {}): EventRecord[] {
  const db = acquireDb('listEvents')
  if (db) {
    return runDb('listEvents', () => {
      const { sql, params } = buildListQuery(filter)
      const rows = db.prepare(sql).all(...params) as EventRow[]
      return rows.map(rowToEvent)
    })
  }
  const order = filter.order === 'asc' ? 'asc' : 'desc'
  const limit = clampLimit(filter.limit)
  const matched = memoryFallback.filter((e) => eventMatchesFilter(e, filter))
  matched.sort((a, b) =>
    order === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt
  )
  return matched.slice(0, limit)
}

/**
 * Aggregate counts of every `*.failed` event by (type, entity). Bypasses
 * MAX_LIST_LIMIT (a GROUP BY, not a row scan) so the capability-gap detector
 * sees ALL-TIME systematic failures, not just the last 1000 events. Memory
 * fallback aggregates the in-memory buffer.
 */
/** All-time `*.failed` counts per (type, entity), WITH the timestamp of the most recent one.
 *
 *  `lastAt` matters as much as the count: the ledger sync re-asserts these rows on every pass,
 *  and without a real event time it had nothing to stamp but `now` — which made a failure that
 *  last happened weeks ago look like it just did. See recordFailure's lastSeenAt handling. */
export function listFailedEventCounts(): {
  type: string
  entityId: string | null
  n: number
  lastAt: number
}[] {
  const db = acquireDb('listFailedEventCounts')
  if (db) {
    return runDb('listFailedEventCounts', () => {
      return db
        .prepare(
          "SELECT type, entity_id AS entityId, COUNT(*) AS n, MAX(created_at) AS lastAt FROM events WHERE type LIKE '%.failed' GROUP BY type, entity_id"
        )
        .all() as { type: string; entityId: string | null; n: number; lastAt: number }[]
    })
  }
  const agg = new Map<string, { type: string; entityId: string | null; n: number; lastAt: number }>()
  for (const e of memoryFallback) {
    if (!e.type.endsWith('.failed')) continue
    const entityId = e.entityId ?? null
    const key = `${e.type}::${entityId}`
    const g = agg.get(key) ?? { type: e.type, entityId, n: 0, lastAt: 0 }
    g.n++
    g.lastAt = Math.max(g.lastAt, e.createdAt ?? 0)
    agg.set(key, g)
  }
  return [...agg.values()]
}

/** What one standing permission policy has actually DONE since it was granted. */
export interface PolicyUsage {
  policyId: string
  /** Calls this policy decided on its own, with no human in the loop. */
  n: number
  /** Of those, the ones it DENIED — a policy that is quietly blocking work
   *  looks identical to an unused one if you only count approvals. */
  denied: number
  lastAt: number
}

/**
 * All-time per-policy usage, for the Permissions surface.
 *
 * WHY `actor_kind = 'system'` AND NOT a plain payload match. `emitApprovalEvent` stamps
 * `payload.policyId` at exactly one call site — the branch in `permissions-store.requestApproval`
 * where a persisted policy resolved the call and the modal never opened. The other two sites
 * (full-access short-circuit, human answered a modal) leave it undefined. So the policyId
 * *already* means "no human decided this", and the actor filter is belt-and-braces against a
 * future third site stamping it on a human decision — which would silently inflate the count
 * a user reads as "times this grant acted for me".
 *
 * A GROUP BY, so it is not subject to MAX_LIST_LIMIT: a grant that fired 40,000 times must not
 * report the last 1,000. `json_extract` is JSON1, compiled into better-sqlite3 by default.
 */
export function listPolicyUsage(): PolicyUsage[] {
  const db = acquireDb('listPolicyUsage')
  if (db) {
    return runDb('listPolicyUsage', () => {
      return db
        .prepare(
          `SELECT json_extract(payload_json, '$.policyId') AS policyId,
                  COUNT(*) AS n,
                  SUM(CASE WHEN type = 'tool.call.denied' THEN 1 ELSE 0 END) AS denied,
                  MAX(created_at) AS lastAt
             FROM events
            WHERE type IN ('tool.call.approved', 'tool.call.denied')
              AND actor_kind = 'system'
              AND json_extract(payload_json, '$.policyId') IS NOT NULL
            GROUP BY policyId`
        )
        .all() as PolicyUsage[]
    })
  }
  const agg = new Map<string, PolicyUsage>()
  for (const e of memoryFallback) {
    if (e.type !== 'tool.call.approved' && e.type !== 'tool.call.denied') continue
    if (e.actorKind !== 'system') continue
    const policyId = e.payload?.policyId
    if (typeof policyId !== 'string' || policyId === '') continue
    const g = agg.get(policyId) ?? { policyId, n: 0, denied: 0, lastAt: 0 }
    g.n++
    if (e.type === 'tool.call.denied') g.denied++
    g.lastAt = Math.max(g.lastAt, e.createdAt ?? 0)
    agg.set(policyId, g)
  }
  return [...agg.values()]
}

export interface TimelineFilter {
  conversationId?: string
  projectId?: string
  workspacePath?: string
  correlationId?: string
  automationId?: string
  /** Max rows. Clamped to MAX_LIST_LIMIT. Default 500. */
  limit?: number
  /** Which END of the timeline `limit` takes.
   *
   *  Default 'oldest' preserves the historical behaviour. 'newest' exists because a
   *  caller that wants "the last N events" was silently getting the FIRST N: the limit
   *  is applied by SQL before the caller ever sees a row, so no amount of slicing
   *  afterwards can recover events that were never selected. */
  window?: 'oldest' | 'newest'
}

/**
 * Convenience reader: returns events for a single scope in ascending time
 * order (oldest → newest) so consumers can render a top-to-bottom timeline.
 * Exactly one of conversationId / projectId / workspacePath / correlationId /
 * automationId must be set; passing none throws so callers can't accidentally
 * pull the entire log under the timeline banner.
 */
export function listTimeline(filter: TimelineFilter): EventRecord[] {
  const scopes = [
    filter.conversationId,
    filter.projectId,
    filter.workspacePath,
    filter.correlationId,
    filter.automationId
  ].filter((v) => typeof v === 'string' && v.length > 0)
  if (scopes.length === 0) {
    throw new Error(
      'listTimeline: at least one of conversationId, projectId, workspacePath, correlationId, automationId is required'
    )
  }
  return listEvents({
    conversationId: filter.conversationId,
    projectId: filter.projectId,
    workspacePath: filter.workspacePath,
    correlationId: filter.correlationId,
    automationId: filter.automationId,
    order: filter.window === 'newest' ? 'desc' : 'asc',
    limit: filter.limit ?? 500
  })
}

// ──────────────────── test-only hooks ────────────────────

/** Test-only: drop the in-memory fallback so tests start clean. */
export function __resetEventLog(): void {
  memoryFallback.length = 0
  useFallback = false
}

/** Test-only: force the memory fallback path. */
export function __forceMemoryFallback(): void {
  useFallback = true
}
