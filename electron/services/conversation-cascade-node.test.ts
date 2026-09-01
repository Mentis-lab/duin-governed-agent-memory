// B3 cascade + orphan-sweep — EXECUTING coverage against Node's built-in
// `node:sqlite` (DatabaseSync), so the SQL runs for real without the Electron
// better-sqlite3 ABI. The sibling conversation-store-cascade.test.ts drives the
// same logic through the real getDb(), but is skipIf(!nativeOk()) and never
// runs under the node-env vitest — this file closes that gap by injecting a
// node:sqlite handle through the seams (orphan-sweep already takes `db`;
// deleteConversation takes DeleteConversationDeps).

import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { Database } from 'better-sqlite3'
import { sweepOrphanedConversationChildren } from './orphan-sweep'
import { deleteConversation, type DeleteConversationDeps } from './conversation-store'

// Minimal schema — only the columns the cascade + sweep touch.
const SCHEMA = `
  CREATE TABLE conversations (id TEXT PRIMARY KEY);
  CREATE TABLE tool_calls (id TEXT PRIMARY KEY, conversation_id TEXT);
  CREATE TABLE snip_command_log (rowid INTEGER PRIMARY KEY, conversation_id TEXT);
  CREATE TABLE snip_events (rowid INTEGER PRIMARY KEY, conversation_id TEXT);
  CREATE TABLE conversation_rag_attachments (conversation_id TEXT, document_id TEXT);
`

let db: DatabaseSync
// The seams type `db` as better-sqlite3's Database; node:sqlite is a structural
// superset of the tiny prepare().run()/get() subset they use.
const asDb = () => db as unknown as Database

const CHILD_TABLES = ['tool_calls', 'snip_command_log', 'snip_events', 'conversation_rag_attachments'] as const

function insertChild(table: string, convId: string | null): void {
  if (table === 'tool_calls') {
    db.prepare('INSERT INTO tool_calls (id, conversation_id) VALUES (?, ?)').run(`t-${Math.round(performance.now() * 1000)}-${convId ?? 'null'}`, convId)
  } else if (table === 'conversation_rag_attachments') {
    db.prepare('INSERT INTO conversation_rag_attachments (conversation_id, document_id) VALUES (?, ?)').run(convId, 'doc')
  } else {
    db.prepare(`INSERT INTO ${table} (conversation_id) VALUES (?)`).run(convId)
  }
}
function countWhere(table: string, sql: string, ...params: unknown[]): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${sql}`).get(...(params as [])) as { n: number | bigint }
  return Number(row.n)
}

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
})

describe('orphan-sweep — sweepOrphanedConversationChildren (node:sqlite)', () => {
  beforeEach(() => {
    db.prepare('INSERT INTO conversations (id) VALUES (?)').run('live')
    // For each child table: one live-parent row, one dead-parent row, one NULL row.
    for (const t of CHILD_TABLES) {
      insertChild(t, 'live')
      insertChild(t, 'dead')
      insertChild(t, null)
    }
  })

  it('deletes ONLY rows whose parent is gone; keeps live-parent and NULL rows', () => {
    const rows = sweepOrphanedConversationChildren(asDb())
    // Every child table lost exactly its one dead-parent row.
    expect(rows.map((r) => r.table).sort()).toEqual([...CHILD_TABLES].sort())
    for (const r of rows) expect(Number(r.deleted)).toBe(1)
    for (const t of CHILD_TABLES) {
      expect(countWhere(t, "conversation_id = 'live'")).toBe(1) // live kept
      expect(countWhere(t, "conversation_id = 'dead'")).toBe(0) // orphan gone
      expect(countWhere(t, 'conversation_id IS NULL')).toBe(1) // NULL kept
    }
  })

  it('NEVER deletes NULL-conversation rows (the IS NOT NULL guard)', () => {
    // Remove the only live conversation so no dead/live distinction remains —
    // every non-NULL row is now an orphan, but NULL rows must still survive.
    db.prepare("DELETE FROM conversations WHERE id = 'live'").run()
    sweepOrphanedConversationChildren(asDb())
    for (const t of CHILD_TABLES) {
      expect(countWhere(t, 'conversation_id IS NULL')).toBe(1)
      expect(countWhere(t, 'conversation_id IS NOT NULL')).toBe(0)
    }
  })

  it('is idempotent: a second run deletes nothing', () => {
    sweepOrphanedConversationChildren(asDb())
    const second = sweepOrphanedConversationChildren(asDb())
    expect(second).toEqual([])
  })

  it('skips a missing child table instead of throwing', () => {
    db.exec('DROP TABLE tool_calls')
    const rows = sweepOrphanedConversationChildren(asDb())
    // The remaining three tables still get swept; no throw.
    expect(rows.map((r) => r.table)).not.toContain('tool_calls')
    expect(rows.length).toBe(3)
  })
})

describe('deleteConversation — transactional all-or-nothing cascade (node:sqlite)', () => {
  // A real BEGIN/COMMIT/ROLLBACK wrapper over the node:sqlite handle, standing in
  // for database.ts:transactional (better-sqlite3's db.transaction()).
  const tx = <T,>(fn: () => T): T => {
    db.exec('BEGIN')
    try {
      const r = fn()
      db.exec('COMMIT')
      return r
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  const baseDeps = (over: Partial<DeleteConversationDeps>): DeleteConversationDeps => ({
    db: asDb(),
    transactional: tx,
    clearConversationState: () => {},
    ftsDeleteAllForConversation: () => {},
    detachAllRagAttachments: () => {},
    ...over
  })

  beforeEach(() => {
    db.prepare('INSERT INTO conversations (id) VALUES (?)').run('c1')
    insertChild('tool_calls', 'c1')
    insertChild('snip_command_log', 'c1')
    insertChild('snip_events', 'c1')
    insertChild('conversation_rag_attachments', 'c1')
  })

  it('rolls the WHOLE delete back when a later cascade step throws', () => {
    const deps = baseDeps({
      detachAllRagAttachments: () => {
        throw new Error('rag detach blew up mid-cascade')
      }
    })
    expect(() => deleteConversation('c1', deps)).toThrow(/mid-cascade/)
    // Nothing was deleted — the conversation row and every child survive.
    expect(countWhere('conversations', "id = 'c1'")).toBe(1)
    expect(countWhere('tool_calls', "conversation_id = 'c1'")).toBe(1)
    expect(countWhere('snip_command_log', "conversation_id = 'c1'")).toBe(1)
    expect(countWhere('snip_events', "conversation_id = 'c1'")).toBe(1)
    expect(countWhere('conversation_rag_attachments', "conversation_id = 'c1'")).toBe(1)
  })

  it('commits the full cascade on the happy path', () => {
    const deps = baseDeps({
      detachAllRagAttachments: (id) =>
        void db.prepare('DELETE FROM conversation_rag_attachments WHERE conversation_id = ?').run(id)
    })
    deleteConversation('c1', deps)
    expect(countWhere('conversations', "id = 'c1'")).toBe(0)
    expect(countWhere('tool_calls', "conversation_id = 'c1'")).toBe(0)
    expect(countWhere('snip_command_log', "conversation_id = 'c1'")).toBe(0)
    expect(countWhere('snip_events', "conversation_id = 'c1'")).toBe(0)
    expect(countWhere('conversation_rag_attachments', "conversation_id = 'c1'")).toBe(0)
  })
})
