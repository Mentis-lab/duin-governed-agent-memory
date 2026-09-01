import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3, { type Database } from 'better-sqlite3'
import { MIGRATIONS, LATEST_VERSION, runMigrations, type Migration } from './db-migrations'
import { MIGRATION_BASELINE_SQL } from './migration-baseline.fixture'

// Persistence Phase / PS1 — migration ledger tests.
//
// These run against an in-memory better-sqlite3 instance so they don't
// depend on Electron's `app.getPath('userData')`. We construct the minimal
// baseline (the three tables migration v1 sanity-checks) so the canonical
// stamp migration succeeds; for the rollback test we deliberately omit the
// canary table to force an abort.
//
// Several tests inject synthetic migrations into the registry via the
// helper `withMigrations`. We never mutate the exported registry directly
// — instead each test swaps it for the duration via a try/finally.

const HAS_NATIVE_SQLITE: boolean = (() => {
  try {
    const probe = new BetterSqlite3(':memory:')
    probe.close()
    return true
  } catch {
    return false
  }
})()

function makeBaselineDb(): Database {
  const db = new BetterSqlite3(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // created_at is part of the app's base schema (schema-init.ts), not a
  // migration — several migrations (e.g. v11's forked-from index) reference
  // it, so the baseline must carry it to match production. The DDL is shared
  // with proof-receipts.test.ts (migration-baseline.fixture.ts) so the two
  // registry guards cannot drift apart again — that drift is what let v32
  // land against a fixture with no `goals` table and kill this whole suite.
  db.exec(MIGRATION_BASELINE_SQL)
  return db
}

// Replace the registry temporarily without mutating the export. We rely on
// the fact that `runMigrations` reads the live exported `MIGRATIONS` array
// — so this monkey-patches the array contents in place and restores after.
function withMigrations<T>(temp: Migration[], fn: () => T): T {
  const snapshot = MIGRATIONS.splice(0, MIGRATIONS.length)
  MIGRATIONS.push(...temp)
  try {
    return fn()
  } finally {
    MIGRATIONS.splice(0, MIGRATIONS.length)
    MIGRATIONS.push(...snapshot)
  }
}

describe.skipIf(!HAS_NATIVE_SQLITE)('db-migrations', () => {
  let db: Database

  beforeEach(() => {
    db = makeBaselineDb()
  })

  afterEach(() => {
    db.close()
  })

  it('stamps a fresh DB at LATEST_VERSION using the real registry', () => {
    const result = runMigrations(db)
    expect(result.startVersion).toBe(0)
    expect(result.endVersion).toBe(LATEST_VERSION)
    expect(result.applied).toEqual(
      MIGRATIONS.map((m) => m.version).filter((v) => v > 0)
    )
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
  })

  it('is a no-op on a DB already at LATEST_VERSION', () => {
    runMigrations(db)
    const beforeSecond = db.pragma('user_version', { simple: true })
    const result = runMigrations(db)
    expect(result.startVersion).toBe(beforeSecond)
    expect(result.endVersion).toBe(beforeSecond)
    expect(result.applied).toEqual([])
  })

  it('only runs migrations newer than the current user_version', () => {
    let ranV2 = 0
    let ranV3 = 0
    withMigrations(
      [
        { version: 1, description: 'baseline', up: () => {} },
        {
          version: 2,
          description: 'v2 work',
          up() {
            ranV2++
          }
        },
        {
          version: 3,
          description: 'v3 work',
          up() {
            ranV3++
          }
        }
      ],
      () => {
        // First run: all three migrations.
        runMigrations(db)
        expect(ranV2).toBe(1)
        expect(ranV3).toBe(1)

        // Pretend v2 was the floor (downgrade `user_version` by hand) — only
        // v3 should re-run.
        db.pragma('user_version = 2')
        runMigrations(db)
        expect(ranV2).toBe(1)
        expect(ranV3).toBe(2)
      }
    )
  })

  // Gate finding F3 — end-to-end proof of the one-way trap and its repair.
  it('re-applies v28 on a DB stranded by the 28 -> 32 registry gap', () => {
    // Replay commit 49ee04eb: a REAL shipped build whose registry carried
    // v32-v36 but NOT v28. Its migrations land the DB at user_version 36.
    const asShippedBy49ee04eb = MIGRATIONS.filter(
      (m) => m.version !== 28 && m.version <= 36
    )
    withMigrations(asShippedBy49ee04eb, () => {
      const r = runMigrations(db)
      expect(r.endVersion).toBe(36)
      expect(r.applied).not.toContain(28)
    })

    // v28's column is genuinely absent — this DB is the stranded one.
    const columns = (): string[] =>
      (db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    expect(columns()).not.toContain('closed_at')

    // The merged build opens it. Under the old `version <= start` skip rule
    // this applied ONLY [43] and closed_at stayed stranded forever, silently.
    const healed = runMigrations(db)
    expect(healed.startVersion).toBe(36)
    expect(healed.applied).toContain(28)
    expect(healed.repaired).toContain(28)
    expect(columns()).toContain('closed_at')

    // Repairing a below-stamp migration must never REWIND user_version.
    expect(healed.endVersion).toBe(LATEST_VERSION)
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)

    // And the repair is one-time: the ledger now accounts for v28.
    const again = runMigrations(db)
    expect(again.applied).toEqual([])
    expect(again.repaired).toEqual([])
  })

  it('reports no repairs on a healthy DB migrated by this build', () => {
    const first = runMigrations(db)
    expect(first.repaired).toEqual([])
    const second = runMigrations(db)
    expect(second.applied).toEqual([])
    expect(second.repaired).toEqual([])
  })

  it('rolls back DDL + version bump when a migration throws', () => {
    withMigrations(
      [
        { version: 1, description: 'baseline', up: () => {} },
        {
          version: 2,
          description: 'creates rollback_canary then explodes',
          up(d) {
            d.exec('CREATE TABLE rollback_canary (id INTEGER PRIMARY KEY)')
            throw new Error('boom')
          }
        }
      ],
      () => {
        expect(() => runMigrations(db)).toThrowError(/v2.*failed.*boom/)

        // user_version stayed at 1 (the previous successful migration).
        expect(db.pragma('user_version', { simple: true })).toBe(1)

        // The canary table was rolled back — the v2 transaction died.
        const exists = db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rollback_canary'"
          )
          .get()
        expect(exists).toBeUndefined()
      }
    )
  })

  it('refuses to run against a DB stamped higher than LATEST_VERSION (downgrade guard)', () => {
    db.pragma(`user_version = ${LATEST_VERSION + 5}`)
    expect(() => runMigrations(db)).toThrowError(
      /DB user_version is \d+ but this build only knows migrations up to v\d+/
    )
    // No side effect.
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION + 5)
  })

  it('aborts v1 baseline stamp if a required table is missing', () => {
    db.close()
    db = new BetterSqlite3(':memory:')
    // Omit `conversations` deliberately.
    db.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY);
      CREATE TABLE events (id TEXT PRIMARY KEY);
    `)
    expect(() => runMigrations(db)).toThrowError(
      /baseline table "conversations" is missing/
    )
    expect(db.pragma('user_version', { simple: true })).toBe(0)
  })

  it('WC-4 — migration v16 adds messages.proof_status as nullable TEXT (idempotent)', () => {
    // The real registry includes v16 from this prompt. After runMigrations:
    //   1. messages.proof_status column exists
    //   2. inserting a row with NULL proof_status succeeds
    //   3. running the migration again is a no-op (idempotency)
    runMigrations(db)
    const cols = db
      .prepare('PRAGMA table_info(messages)')
      .all() as Array<{ name: string; type: string; notnull: number }>
    const proofStatusCol = cols.find((c) => c.name === 'proof_status')
    expect(proofStatusCol, 'messages.proof_status must exist').toBeDefined()
    expect(proofStatusCol?.type).toBe('TEXT')
    expect(proofStatusCol?.notnull).toBe(0)

    // Idempotency — second run does not throw.
    const second = runMigrations(db)
    expect(second.applied).toEqual([])
  })

  it('v19 widens brain_decisions.choice: drops the 2-value CHECK and preserves rows', () => {
    // Build the pre-v19 (v18) table shape WITH the old 2-value CHECK, seed two
    // rows, then run only the v19 migration's up() and assert the rows survive
    // and a 5-taxonomy value ("done") now inserts (the CHECK is gone).
    db.exec(`
      CREATE TABLE brain_decisions (
        node_id    TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        choice     TEXT NOT NULL CHECK(choice IN ('cleared','blocked')),
        note       TEXT,
        decided_at TEXT NOT NULL
      );
      INSERT INTO brain_decisions (node_id, title, choice, note, decided_at)
        VALUES ('n1', 'Ship gate', 'cleared', null, '2026-06-01T00:00:00.000Z'),
               ('n2', 'Hold gate', 'blocked', 'careful', '2026-06-02T00:00:00.000Z');
    `)

    const v19 = MIGRATIONS.find((m) => m.version === 19)
    expect(v19, 'migration v19 must exist').toBeDefined()
    v19!.up(db)

    // Rows preserved verbatim.
    const rows = db
      .prepare('SELECT node_id, title, choice, note, decided_at FROM brain_decisions ORDER BY node_id')
      .all() as Array<{ node_id: string; choice: string; note: string | null }>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ node_id: 'n1', choice: 'cleared', note: null })
    expect(rows[1]).toMatchObject({ node_id: 'n2', choice: 'blocked', note: 'careful' })

    // The 2-value CHECK is gone — a new-taxonomy value now inserts.
    expect(() =>
      db
        .prepare(
          'INSERT INTO brain_decisions (node_id, title, choice, decided_at) VALUES (?,?,?,?)'
        )
        .run('n3', 'Done elsewhere', 'done', '2026-06-03T00:00:00.000Z')
    ).not.toThrow()
    const n3 = db.prepare('SELECT choice FROM brain_decisions WHERE node_id = ?').get('n3') as {
      choice: string
    }
    expect(n3.choice).toBe('done')
  })

  it('v22 adds automations.deliver_to as nullable TEXT (idempotent)', () => {
    // Build the pre-v22 automations shape (no deliver_to), seed a row, then run
    // only v22's up() and assert the column appears + old rows survive with NULL.
    // (drop the minimal baseline automations first so this test owns its shape)
    db.exec(`
      DROP TABLE IF EXISTS automations;
      CREATE TABLE automations (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        cron TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_run_at INTEGER,
        last_result TEXT
      );
      INSERT INTO automations (id, label, cron, prompt, created_at)
        VALUES ('a1', 'Nightly', '0 9 * * *', 'summarize', 0);
    `)

    const v22 = MIGRATIONS.find((m) => m.version === 22)
    expect(v22, 'migration v22 must exist').toBeDefined()
    v22!.up(db)

    const cols = db
      .prepare('PRAGMA table_info(automations)')
      .all() as Array<{ name: string; type: string; notnull: number }>
    const col = cols.find((c) => c.name === 'deliver_to')
    expect(col, 'automations.deliver_to must exist').toBeDefined()
    expect(col?.type).toBe('TEXT')
    expect(col?.notnull).toBe(0)

    // Existing row preserved with NULL deliver_to.
    const row = db.prepare('SELECT deliver_to FROM automations WHERE id = ?').get('a1') as {
      deliver_to: string | null
    }
    expect(row.deliver_to).toBeNull()

    // A ChannelRef JSON now stores + reads back.
    db.prepare('UPDATE automations SET deliver_to = ? WHERE id = ?').run(
      JSON.stringify({ kind: 'feishu', target: 'Theo' }),
      'a1'
    )
    const updated = db.prepare('SELECT deliver_to FROM automations WHERE id = ?').get('a1') as {
      deliver_to: string
    }
    expect(JSON.parse(updated.deliver_to)).toEqual({ kind: 'feishu', target: 'Theo' })

    // Idempotency — running up() again is a no-op (duplicate column swallowed).
    expect(() => v22!.up(db)).not.toThrow()
  })

  it('stops applying after a failure and reports the partial result via thrown error', () => {
    const order: number[] = []
    withMigrations(
      [
        {
          version: 1,
          description: 'baseline',
          up() {
            order.push(1)
          }
        },
        {
          version: 2,
          description: 'fails here',
          up() {
            order.push(2)
            throw new Error('mid-flight')
          }
        },
        {
          version: 3,
          description: 'should not run',
          up() {
            order.push(3)
          }
        }
      ],
      () => {
        expect(() => runMigrations(db)).toThrow(/v2.*failed/)
        expect(order).toEqual([1, 2])
        // v1 stamped, v2 rolled back.
        expect(db.pragma('user_version', { simple: true })).toBe(1)
      }
    )
  })
})
