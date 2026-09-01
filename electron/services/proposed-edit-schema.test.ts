import { describe, it, expect } from 'vitest'
import { PROPOSED_EDIT_SCHEMA_SQL } from './proposed-edit-schema'

// Validates the proposed_edit_proposals DDL against real SQLite via node:sqlite
// (DatabaseSync) — no Electron better-sqlite3 ABI, so it runs under vitest. The
// migration (v43) execs the exact same constant, so this is the production DDL.

interface DB {
  exec(sql: string): void
  prepare(sql: string): {
    run(...a: unknown[]): void
    all(...a: unknown[]): unknown[]
    get(...a: unknown[]): unknown
  }
  close(): void
}
let DatabaseSync: (new (path: string) => DB) | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  DatabaseSync = (require('node:sqlite') as { DatabaseSync: new (path: string) => DB }).DatabaseSync
} catch {
  DatabaseSync = null
}

const CONVERSATIONS = `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    model TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`

function seeded(): DB {
  const db = new DatabaseSync!(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(CONVERSATIONS)
  db.exec(PROPOSED_EDIT_SCHEMA_SQL)
  db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?)').run('c1', 't', 'm', 1, 1)
  return db
}

function insert(db: DB, id: string, conv: string, status: string): void {
  db.prepare(
    `INSERT INTO proposed_edit_proposals
       (id, conversation_id, title, patch, rationale, anchor_json, status, result, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, conv, 'Edit note', 'PATCH', null, '[]', status, null, 1, 1)
}

describe.skipIf(!DatabaseSync)('proposed_edit_proposals DDL (real node:sqlite)', () => {
  it('accepts a valid pending row', () => {
    const db = seeded()
    insert(db, 'p1', 'c1', 'pending')
    const row = db.prepare('SELECT status FROM proposed_edit_proposals WHERE id = ?').get('p1') as {
      status: string
    }
    expect(row.status).toBe('pending')
    db.close()
  })

  it('REJECTS an out-of-domain status (CHECK is really there)', () => {
    const db = seeded()
    expect(() => insert(db, 'p2', 'c1', 'bogus')).toThrow()
    db.close()
  })

  it('cascades delete when the owning conversation is removed', () => {
    const db = seeded()
    insert(db, 'p3', 'c1', 'accepted')
    db.prepare('DELETE FROM conversations WHERE id = ?').run('c1')
    const rows = db.prepare('SELECT id FROM proposed_edit_proposals').all()
    expect(rows.length).toBe(0)
    db.close()
  })

  it('rejects a row whose conversation_id has no parent (FK enforced)', () => {
    const db = seeded()
    expect(() => insert(db, 'p4', 'ghost', 'pending')).toThrow()
    db.close()
  })

  it('exposes the conversation index for card listing', () => {
    const db = seeded()
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
      .get('idx_proposed_edit_proposals_conversation')
    expect(idx).toBeTruthy()
    db.close()
  })
})
