import { describe, it, expect, vi } from 'vitest'
import BetterSqlite3, { type Database } from 'better-sqlite3'

vi.mock('./rag/vec-loader', () => ({
  isVecAvailable: () => false,
  loadSqliteVec: () => {
    /* no-op for tests */
  }
}))

import { initLegacySchema } from './schema-init'
import {
  runMigrations,
  LATEST_VERSION,
  MIGRATIONS,
  MIGRATION_LEDGER_DDL,
  MIGRATION_LEDGER_TABLE
} from './db-migrations'

// The P0 of 2026-07-30, pinned.
//
// `schema-init` created `idx_memory_index_source` on a column that only its own
// CREATE TABLE supplies — and on an EXISTING database that CREATE TABLE is a
// no-op, so the index statement threw `no such column: source`. It threw BEFORE
// `runMigrations` could add the column, and `getDb()` had already published its
// handle, so every later call short-circuited and skipped both init steps
// permanently. The ledger froze at 44 with `LATEST_VERSION` 45, and no migration
// could ever land again on any existing install.
//
// It was silent in the worst way: the app worked, `integrity_check` passed on a
// table missing a column, and nothing compared `user_version` to the registry
// head. That missing comparison is why it ran undetected for a day, so it is now
// an assertion in `getDb()` and the second test below.
//
// These run the REAL production pair (initLegacySchema then runMigrations) over a
// database shaped like a pre-v45 install, which is the scenario no existing test
// covered — the migration suite builds bare baselines, and the schema-init suite
// only ever starts from a fresh database. The bug lived exactly in the gap
// between those two fixtures.

const HAS_NATIVE_SQLITE: boolean = (() => {
  try {
    const probe = new BetterSqlite3(':memory:')
    probe.close()
    return true
  } catch {
    return false
  }
})()

/** A `memory_index` as it exists on every install that predates v45: no `source`. */
const PRE_V45_MEMORY_INDEX = `
  CREATE TABLE memory_index (
    name TEXT PRIMARY KEY,
    project_slug TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('user','feedback','project','reference')),
    description TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    source_conversation_id TEXT,
    file_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`

function columnsOf(db: Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((r) => r.name)
}

function userVersion(db: Database): number {
  return (db.pragma('user_version') as Array<{ user_version: number }>)[0].user_version
}

function indexExists(db: Database, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?")
      .get(name) !== undefined
  )
}

describe.runIf(HAS_NATIVE_SQLITE)('schema bootstrap on a pre-v45 database', () => {
  function preV45Db(): Database {
    const db = new BetterSqlite3(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(PRE_V45_MEMORY_INDEX)
    // Stamp it where the live install actually sat, so the chain has real work to
    // do rather than running from zero.
    db.pragma('user_version = 44')
    // Seed the ledger as a HEALTHY v44 install would carry it. Without this the
    // runner finds no ledger, seeds one, and correctly decides the entries below
    // the registry's numbering gaps cannot be proven to have run — dragging the
    // whole gap-repair path (and the entire 67-table schema it needs) into a test
    // that is about one column. That path has its own coverage in
    // db-migration-gap.test.ts; here it is noise.
    db.exec(MIGRATION_LEDGER_DDL)
    const insert = db.prepare(
      `INSERT OR IGNORE INTO ${MIGRATION_LEDGER_TABLE} (version, applied_at) VALUES (?, ?)`
    )
    for (const m of MIGRATIONS) if (m.version <= 44) insert.run(m.version, 1)
    return db
  }

  it('completes without throwing', () => {
    const db = preV45Db()
    try {
      expect(() => {
        initLegacySchema(db)
        runMigrations(db)
      }).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('reaches the registry head — the comparison nobody was making', () => {
    const db = preV45Db()
    try {
      initLegacySchema(db)
      runMigrations(db)
      expect(userVersion(db)).toBe(LATEST_VERSION)
    } finally {
      db.close()
    }
  })

  it('adds memory_index.source and its index', () => {
    const db = preV45Db()
    try {
      initLegacySchema(db)
      runMigrations(db)
      expect(columnsOf(db, 'memory_index')).toContain('source')
      expect(indexExists(db, 'idx_memory_index_source')).toBe(true)
    } finally {
      db.close()
    }
  })

  it('leaves existing rows honestly unlabelled rather than back-guessed', () => {
    // Property 3: provenance is recorded, never inferred. A pre-provenance row
    // must come out of the migration as `unknown`, not as `user-explicit`.
    const db = preV45Db()
    try {
      db.prepare(
        `INSERT INTO memory_index
           (name, project_slug, type, description, body, file_path, created_at, updated_at)
         VALUES ('old', '__global__', 'user', '', 'body', 'p.md', 1, 1)`
      ).run()
      initLegacySchema(db)
      runMigrations(db)
      const row = db.prepare('SELECT source FROM memory_index WHERE name=?').get('old') as {
        source: string
      }
      expect(row.source).toBe('unknown')
    } finally {
      db.close()
    }
  })
})

describe.runIf(HAS_NATIVE_SQLITE)('the failure this test exists to prevent', () => {
  it('a legacy-segment statement depending on a migration-supplied column still throws', () => {
    // The negative control. This is verbatim what schema-init used to run, and it
    // proves the hazard is real rather than hypothetical — so anyone tempted to
    // put a column-dependent statement back into the legacy segment can see what
    // it does. Keep this failing on purpose.
    const db = preV45Shape()
    try {
      expect(() =>
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_probe_source ON memory_index(source, updated_at DESC)'
        )
      ).toThrow(/no such column: source/)
    } finally {
      db.close()
    }
  })

  it('a fresh database is unaffected — the column is there from the start', () => {
    const db = new BetterSqlite3(':memory:')
    try {
      initLegacySchema(db)
      runMigrations(db)
      expect(columnsOf(db, 'memory_index')).toContain('source')
      expect(userVersion(db)).toBe(LATEST_VERSION)
    } finally {
      db.close()
    }
  })
})

function preV45Shape(): Database {
  const db = new BetterSqlite3(':memory:')
  db.exec(PRE_V45_MEMORY_INDEX)
  return db
}
