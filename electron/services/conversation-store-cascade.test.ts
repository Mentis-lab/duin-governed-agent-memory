import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Phase B3 — deleteConversation must cascade to EVERY per-conversation child,
// including the non-FK tables that used to orphan on every delete
// (tool_calls, snip_command_log, snip_events, conversation_rag_attachments).
// And the one-time orphan sweep must clean pre-existing strays without
// over-deleting. Exercised against a real on-disk SQLite DB in a tmpdir,
// with a graceful skip when the better-sqlite3 native binding can't load.

const TEST_USER_DATA = join(tmpdir(), `lamprey-cascade-test-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: { getPath: () => TEST_USER_DATA },
  BrowserWindow: { getAllWindows: () => [] }
}))

import * as convStore from './conversation-store'
import { sweepOrphanedConversationChildren } from './orphan-sweep'
import { __resetDbForTests, getDb } from './database'

function nativeOk(): boolean {
  try {
    // This probe runs at collection time, before beforeEach creates TEST_USER_DATA.
    // Without it the open fails on the missing directory rather than on the binding.
    mkdirSync(TEST_USER_DATA, { recursive: true })
    getDb()
    return true
  } catch {
    return false
  }
}

// ── direct-insert helpers for the non-FK child tables ──
function insertToolCall(convId: string | null, id: string): void {
  getDb()
    .prepare(
      `INSERT INTO tool_calls (id, tool_id, name, conversation_id, args_json, status, started_at)
       VALUES (?, 'tool', 'read_file', ?, '{}', 'done', 0)`
    )
    .run(id, convId)
}
function insertSnipCommand(convId: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO snip_command_log (ts, command, command_head, tokens, matched_filter, conversation_id)
       VALUES (0, 'grep x', 'grep', 3, NULL, ?)`
    )
    .run(convId)
}
function insertSnipEvent(convId: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO snip_events
         (ts, command, filter_name, bytes_before, bytes_after, tokens_before, tokens_after, duration_ms, conversation_id)
       VALUES (0, 'grep x', 'f', 100, 10, 20, 2, 1, ?)`
    )
    .run(convId)
}
function insertRagAttachment(convId: string, docId: string): void {
  getDb()
    .prepare(
      `INSERT INTO conversation_rag_attachments (conversation_id, collection_id, document_id, attached_at)
       VALUES (?, NULL, ?, 0)`
    )
    .run(convId, docId)
}
function count(table: string, convId: string): number {
  return (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE conversation_id = ?`)
      .get(convId) as { n: number }
  ).n
}
function countNull(table: string): number {
  return (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE conversation_id IS NULL`)
      .get() as { n: number }
  ).n
}

beforeEach(() => {
  __resetDbForTests()
  if (existsSync(TEST_USER_DATA)) rmSync(TEST_USER_DATA, { recursive: true, force: true })
  mkdirSync(TEST_USER_DATA, { recursive: true })
})

afterAll(() => {
  __resetDbForTests()
  if (existsSync(TEST_USER_DATA)) rmSync(TEST_USER_DATA, { recursive: true, force: true })
})

describe('B3 — deleteConversation cascade to non-FK children', () => {
  it.skipIf(!nativeOk())('removes tool_calls / snip_* / rag_attachments for the deleted conversation only', () => {
    const a = convStore.createConversation('deepseek-chat')
    const b = convStore.createConversation('deepseek-chat')

    // Children for BOTH conversations.
    insertToolCall(a.id, 'tc-a1')
    insertToolCall(a.id, 'tc-a2')
    insertToolCall(b.id, 'tc-b1')
    insertSnipCommand(a.id)
    insertSnipCommand(b.id)
    insertSnipEvent(a.id)
    insertSnipEvent(b.id)
    insertRagAttachment(a.id, 'doc-a')
    insertRagAttachment(b.id, 'doc-b')

    expect(count('tool_calls', a.id)).toBe(2)
    expect(count('conversation_rag_attachments', a.id)).toBe(1)

    convStore.deleteConversation(a.id)

    // A's children are all gone.
    expect(count('tool_calls', a.id)).toBe(0)
    expect(count('snip_command_log', a.id)).toBe(0)
    expect(count('snip_events', a.id)).toBe(0)
    expect(count('conversation_rag_attachments', a.id)).toBe(0)

    // No over-delete: B's children survive untouched.
    expect(count('tool_calls', b.id)).toBe(1)
    expect(count('snip_command_log', b.id)).toBe(1)
    expect(count('snip_events', b.id)).toBe(1)
    expect(count('conversation_rag_attachments', b.id)).toBe(1)
  })

  it.skipIf(!nativeOk())('leaves NULL-conversation child rows untouched on delete', () => {
    const a = convStore.createConversation('deepseek-chat')
    insertToolCall(a.id, 'tc-a')
    insertToolCall(null, 'tc-null') // ephemeral / headless — no conversation
    insertSnipCommand(null)

    convStore.deleteConversation(a.id)

    expect(count('tool_calls', a.id)).toBe(0)
    expect(countNull('tool_calls')).toBe(1)
    expect(countNull('snip_command_log')).toBe(1)
  })
})

describe('B3 — one-time orphan sweep', () => {
  it.skipIf(!nativeOk())('deletes rows whose parent conversation is gone, keeps live + NULL rows', () => {
    const live = convStore.createConversation('deepseek-chat')

    // Orphans: conversation_id points at a conversation that never existed.
    insertToolCall('ghost-conv', 'tc-ghost1')
    insertToolCall('ghost-conv', 'tc-ghost2')
    insertSnipCommand('ghost-conv')
    insertSnipEvent('ghost-conv')
    insertRagAttachment('ghost-conv', 'doc-ghost')

    // Non-orphans that must survive.
    insertToolCall(live.id, 'tc-live')
    insertToolCall(null, 'tc-null') // NULL parent is legitimate, not an orphan
    insertSnipCommand(null)

    const swept = sweepOrphanedConversationChildren(getDb())

    // Orphans gone.
    expect(count('tool_calls', 'ghost-conv')).toBe(0)
    expect(count('snip_command_log', 'ghost-conv')).toBe(0)
    expect(count('snip_events', 'ghost-conv')).toBe(0)
    expect(count('conversation_rag_attachments', 'ghost-conv')).toBe(0)

    // Live + NULL rows survive.
    expect(count('tool_calls', live.id)).toBe(1)
    expect(countNull('tool_calls')).toBe(1)
    expect(countNull('snip_command_log')).toBe(1)

    // Report reflects what was swept (tool_calls lost 2 ghost rows).
    const toolRow = swept.find((r) => r.table === 'tool_calls')
    expect(toolRow?.deleted).toBe(2)

    // Idempotent: a second sweep finds nothing.
    expect(sweepOrphanedConversationChildren(getDb())).toEqual([])
  })
})
