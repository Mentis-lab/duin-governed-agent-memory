import { describe, it, expect } from 'vitest'
import { MIGRATIONS, LATEST_VERSION, runMigrations, type Migration } from './db-migrations'
import type { Database } from 'better-sqlite3'

// 2026-07-25 adversarial review — the reserved-gap reservation in db-migrations.ts is void.
//
// c67a0cdd appended v32-v36 AND v43 in one commit, with this comment (db-migrations.ts:440-442):
//
//     Versions 28-31 are reserved by concurrent workstreams; this workstream owns
//     32-36 exclusively (v37 reserved, unused).
//
// A reservation only works while the registry's MAX version stays BELOW the reserved
// numbers. It does not: LATEST_VERSION is 43. runMigrations skips every migration whose
// `version <= user_version` (db-migrations.ts:572), and every DB that launches this build
// is stamped to LATEST_VERSION. So a migration later assigned a reserved number is a
// permanent NO-OP on every install that has already run today's build — it will never
// execute, and nothing reports that it didn't.
//
// The concrete casualty is already on disk: `duin/localization-phase0` carries the deferred
// FTS5 bigram work as v28 (sessions_fts rebuild) and v29 (memory_index_fts / rag_chunks_fts
// rebuild). v28 now COLLIDES with the shipped v28 (conversations.closed_at) and v29 lands in
// the gap. Merging that branch as written means the FTS rebuild silently never happens on any
// existing vault — CJK recall stays broken while a fresh install (which gets the schema from
// schema-init, not the migration) looks fine, so the bug is invisible to the developer.
//
// These tests do not assert a fix. They pin the arithmetic so the next person to append a
// migration sees the constraint.

// node:sqlite shim — the Electron better-sqlite3 ABI cannot load under vitest, and this
// suite must RUN (a dark test proves nothing). runMigrations only needs pragma/transaction.
type RawDb = {
  exec(sql: string): void
  prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown }
}

let DatabaseSync: (new (path: string) => RawDb) | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  DatabaseSync = (require('node:sqlite') as { DatabaseSync: new (path: string) => RawDb })
    .DatabaseSync
} catch {
  DatabaseSync = null
}

function shim(raw: RawDb): Database {
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    pragma: (source: string, opts?: { simple?: boolean }) => {
      const m = /^\s*user_version\s*=\s*(\d+)\s*$/.exec(source)
      if (m) {
        raw.exec(`PRAGMA user_version = ${m[1]}`)
        return undefined
      }
      const row = raw.prepare('SELECT * FROM pragma_user_version') as {
        get(): { user_version: number }
      }
      const v = row.get().user_version
      return opts?.simple ? v : [{ user_version: v }]
    },
    transaction: (fn: (...a: unknown[]) => unknown) =>
      ((...a: unknown[]) => {
        raw.exec('BEGIN')
        try {
          const out = fn(...a)
          raw.exec('COMMIT')
          return out
        } catch (err) {
          raw.exec('ROLLBACK')
          throw err
        }
      }) as unknown
  } as unknown as Database
}

// Swap the registry for the duration of one test without mutating the export's identity —
// runMigrations reads the live array, so splice in place and restore.
function withMigrations<T>(replacement: Migration[], fn: () => T): T {
  const saved = MIGRATIONS.slice()
  MIGRATIONS.length = 0
  MIGRATIONS.push(...replacement)
  try {
    return fn()
  } finally {
    MIGRATIONS.length = 0
    MIGRATIONS.push(...saved)
  }
}

describe('db-migrations — the reserved-gap reservation is unsatisfiable', () => {
  const RESERVED = [29, 30, 31, 37, 38, 39, 40, 41, 42]

  it('every reserved version is already BELOW the shipped LATEST_VERSION', () => {
    const shipped = new Set(MIGRATIONS.map((m) => m.version))
    for (const v of RESERVED) {
      expect(shipped.has(v), `v${v} must genuinely be a gap`).toBe(false)
      // This is the defect: the gate is `version <= user_version`, and every DB reaches
      // LATEST_VERSION, so a reserved number is behind the stamp before it is ever used.
      expect(v, `v${v} is reserved but already passed by LATEST_VERSION`).toBeLessThan(
        LATEST_VERSION
      )
    }
  })

  it('the deferred FTS5 bigram migration numbers (v28, v29) are unreachable or collided', () => {
    const shipped = new Set(MIGRATIONS.map((m) => m.version))
    // duin/localization-phase0 numbers the sessions_fts rebuild v28 — taken by closed_at.
    expect(shipped.has(28), 'v28 is already occupied by conversations.closed_at').toBe(true)
    // …and its external-content FTS rebuild v29 is in the dead gap.
    expect(shipped.has(29)).toBe(false)
    expect(29).toBeLessThan(LATEST_VERSION)
  })

  it.skipIf(!DatabaseSync)(
    'runMigrations SKIPS a gap-numbered migration on a DB already at LATEST_VERSION',
    () => {
      const raw = new DatabaseSync!(':memory:')
      const db = shim(raw)
      // A user who launched today's build is stamped here.
      db.pragma(`user_version = ${LATEST_VERSION}`)

      let ran = false
      const deferredFts: Migration = {
        version: 29, // a reserved gap number, exactly as localization-phase0 uses
        description: 'deferred CJK bigram FTS rebuild',
        up() {
          ran = true
        }
      }

      const result = withMigrations([deferredFts], () => runMigrations(db))

      // The migration is silently not applied — no throw, no warning, no record.
      expect(ran, 'a gap-numbered migration never executes on an existing install').toBe(false)
      expect(result.applied).toEqual([])
      expect(result.endVersion).toBe(LATEST_VERSION)
    }
  )

  it.skipIf(!DatabaseSync)('…while the same migration DOES run on a fresh v0 DB', () => {
    const raw = new DatabaseSync!(':memory:')
    const db = shim(raw)

    let ran = false
    const deferredFts: Migration = {
      version: 29,
      description: 'deferred CJK bigram FTS rebuild',
      up() {
        ran = true
      }
    }

    withMigrations([deferredFts], () => runMigrations(db))

    // This asymmetry is what hides the bug: it works on the developer's fresh DB and
    // silently does nothing on every real vault.
    expect(ran).toBe(true)
  })
})
