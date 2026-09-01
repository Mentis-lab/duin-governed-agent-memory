import { describe, it, expect } from 'vitest'
import { LOOP_BACKLOG_REBUILD_V25 } from './db-migrations'

// Validates the v25 loop_backlog rebuild (CHECK-drop) against real SQLite via
// node:sqlite (DatabaseSync) — no Electron better-sqlite3 ABI, so it runs under vitest
// where db-migrations.test.ts (better-sqlite3) is skipped. Migrations are irreversible,
// so the rebuild must be proven: rows preserved + the new held-output status accepted.

interface DB {
  exec(sql: string): void
  prepare(sql: string): { run(...a: unknown[]): void; all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown }
  close(): void
}
let DatabaseSync: (new (path: string) => DB) | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  DatabaseSync = (require('node:sqlite') as { DatabaseSync: new (path: string) => DB }).DatabaseSync
} catch {
  DatabaseSync = null
}

const OLD_SCHEMA = `
  CREATE TABLE loop_backlog (
    id TEXT PRIMARY KEY,
    loop_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    task TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','in_progress','done','skipped','error')),
    result TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
  );
  CREATE INDEX idx_loop_backlog_next ON loop_backlog(loop_id, status, position ASC);
`

describe.skipIf(!DatabaseSync)('v25 loop_backlog rebuild (real node:sqlite)', () => {
  function seeded(): DB {
    const db = new DatabaseSync!(':memory:')
    db.exec(OLD_SCHEMA)
    db.prepare('INSERT INTO loop_backlog VALUES (?,?,?,?,?,?,?,?,?)').run('a', 'L', 0, 'task A', 'done', 'r', 1, 2, 3)
    db.prepare('INSERT INTO loop_backlog VALUES (?,?,?,?,?,?,?,?,?)').run('b', 'L', 1, 'task B', 'pending', null, 4, null, null)
    return db
  }

  it('the OLD schema REJECTS awaiting-ratification (proves the CHECK was really there)', () => {
    const db = seeded()
    expect(() =>
      db.prepare('INSERT INTO loop_backlog VALUES (?,?,?,?,?,?,?,?,?)').run('c', 'L', 2, 't', 'awaiting-ratification', null, 5, null, null)
    ).toThrow()
    db.close()
  })

  it('after the rebuild: rows preserved AND awaiting-ratification is accepted', () => {
    const db = seeded()
    db.exec(LOOP_BACKLOG_REBUILD_V25)

    // Every row survived, values intact.
    const rows = db.prepare('SELECT id, status, task FROM loop_backlog ORDER BY position').all() as {
      id: string
      status: string
      task: string
    }[]
    expect(rows).toEqual([
      { id: 'a', status: 'done', task: 'task A' },
      { id: 'b', status: 'pending', task: 'task B' }
    ])

    // The new held-output status now inserts without a CHECK violation.
    db.prepare('INSERT INTO loop_backlog VALUES (?,?,?,?,?,?,?,?,?)').run('c', 'L', 2, 'held', 'awaiting-ratification', null, 6, 7, null)
    const held = db.prepare("SELECT COUNT(*) AS n FROM loop_backlog WHERE status = 'awaiting-ratification'").get() as { n: number }
    expect(held.n).toBe(1)

    // The next-item index was recreated (query planner uses it — presence check via sqlite_master).
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_loop_backlog_next'").get()
    expect(idx).toBeTruthy()
    db.close()
  })
})
