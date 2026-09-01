// saveMessage's SQLITE_BUSY retry must be replay-safe — EXECUTING coverage over `node:sqlite`.
//
// THE DEFECT. The retried closure ran three statements with no transaction around them: the
// message INSERT, then touchConversation, then the FTS sync. touchConversation is unguarded and
// runs AFTER the INSERT has already committed in autocommit mode, so a transient SQLITE_BUSY there
// sent withWriteRetry back through the whole closure — and the second INSERT hit the messages
// primary key. That is not a busy error, so it was rethrown: the caller saw a hard constraint
// failure, the row was already durably written, conversations.updated_at was stale, and the FTS
// entry was missing. Precisely the renderer-vs-database divergence the PS3 retry was added to
// prevent.
//
// WHY node:sqlite. better-sqlite3 is built for Electron's ABI and throws under the node-env
// vitest, so a suite gated on nativeOk() reports PASS while executing nothing. The real
// withWriteRetry is kept (importOriginal); only getDb and transactional are injected, so what is
// under test is saveMessage's own composition of the two.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
  CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT, updated_at INTEGER);
  CREATE TABLE projects (id TEXT PRIMARY KEY, updated_at INTEGER);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, model TEXT,
    tool_call_id TEXT, tool_calls TEXT, draft TEXT, reasoning TEXT, documents TEXT,
    stage TEXT, content_raw TEXT, proof_status TEXT, content_parts TEXT, created_at INTEGER
  );
  CREATE TABLE sessions_fts (source TEXT, conversation_id TEXT, message_id TEXT, title TEXT, body TEXT);
`

let db: DatabaseSync
/** Throw SQLITE_BUSY once on the next conversations UPDATE — the post-INSERT step. */
let failNextTouch = false
let depth = 0

const shim = {
  prepare(sql: string) {
    const stmt = db.prepare(sql)
    const isTouch = /UPDATE conversations SET updated_at/i.test(sql)
    return {
      run: (...args: unknown[]) => {
        if (isTouch && failNextTouch) {
          failNextTouch = false
          const err = new Error('SQLITE_BUSY: database is locked') as Error & { code?: string }
          err.code = 'SQLITE_BUSY'
          throw err
        }
        return stmt.run(...(args as never[]))
      },
      get: (...args: unknown[]) => stmt.get(...(args as never[])),
      all: (...args: unknown[]) => stmt.all(...(args as never[]))
    }
  }
}

/** Mirrors the production `transactional`, including its SAVEPOINT nesting. */
const realTx = <T,>(fn: () => T): T => {
  const nested = depth > 0
  const sp = `_tx${depth}`
  db.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN')
  depth++
  try {
    const out = fn()
    db.exec(nested ? `RELEASE ${sp}` : 'COMMIT')
    return out
  } catch (e) {
    db.exec(nested ? `ROLLBACK TO ${sp}` : 'ROLLBACK')
    throw e
  } finally {
    depth--
  }
}

vi.mock('./database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./database')>()
  return { ...actual, getDb: () => shim, transactional: realTx }
})

const { saveMessage } = await import('./conversation-store')

const rows = (sql: string, ...a: unknown[]): unknown[] => db.prepare(sql).all(...(a as never[]))
const count = (table: string): number =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint }).n)

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  db.prepare('INSERT INTO conversations (id, project_id, updated_at) VALUES (?,?,?)').run('c1', null, 1)
  failNextTouch = false
  depth = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const save = (id: string): unknown =>
  saveMessage({ id, conversationId: 'c1', role: 'user', content: 'a message worth searching for' })

describe('saveMessage survives a SQLITE_BUSY raised after the INSERT', () => {
  it('writes exactly one row instead of throwing a primary-key violation', () => {
    failNextTouch = true

    expect(() => save('m1')).not.toThrow()
    expect(count('messages')).toBe(1)
  })

  it('does not lose the FTS entry to the retry', () => {
    failNextTouch = true
    save('m2')

    const fts = rows('SELECT message_id FROM sessions_fts WHERE message_id = ?', 'm2')
    expect(fts).toHaveLength(1)
  })

  it('still advances the conversation timestamp after the retry', () => {
    failNextTouch = true
    save('m3')

    const conv = db.prepare('SELECT updated_at FROM conversations WHERE id = ?').get('c1') as {
      updated_at: number
    }
    expect(conv.updated_at).toBeGreaterThan(1)
  })

  it('leaves the happy path untouched', () => {
    save('m4')

    expect(count('messages')).toBe(1)
    expect(rows('SELECT message_id FROM sessions_fts WHERE message_id = ?', 'm4')).toHaveLength(1)
  })
})
