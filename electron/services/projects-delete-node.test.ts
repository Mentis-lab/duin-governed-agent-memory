// deleteProject atomicity — EXECUTING coverage against Node's built-in
// `node:sqlite` (DatabaseSync), so the SQL runs for real without the Electron
// better-sqlite3 ABI. Mirrors conversation-cascade-node.test.ts.
//
// The defect: deleteProject ran `UPDATE conversations SET project_id = NULL`
// and `DELETE FROM projects` as two separate autocommits. If the DELETE failed
// (SQLITE_BUSY past busy_timeout, IO error), the UPDATE was already committed —
// the project still existed but every conversation had been permanently severed
// from it. conversations.project_id is the ONLY store of that membership, and
// the old project.deleted event recorded a COUNT, never the ids, so nothing in
// the DB or the event log could reconstruct which conversations to reattach.

import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { Database } from 'better-sqlite3'
import { deleteProject, type DeleteProjectDeps } from './projects-store'

const SCHEMA = `
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT);
`

let db: DatabaseSync
// The seam types `db` as better-sqlite3's Database; node:sqlite is a structural
// superset of the tiny prepare().run()/all() subset it uses.
const asDb = () => db as unknown as Database

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

function projectIdOf(convId: string): string | null {
  const row = db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(convId) as
    | { project_id: string | null }
    | undefined
  return row ? row.project_id : null
}
function projectExists(id: string): boolean {
  return db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id) !== undefined
}

interface EmittedEvent {
  type: string
  projectId: string
  extra: Record<string, unknown>
}

function baseDeps(over: Partial<DeleteProjectDeps> = {}): {
  deps: DeleteProjectDeps
  events: EmittedEvent[]
} {
  const events: EmittedEvent[] = []
  const deps: DeleteProjectDeps = {
    db: asDb(),
    transactional: tx,
    // Pass-through by default; the retry behaviour is database.ts's own tested
    // concern. Individual tests override this to assert it is actually wired.
    withWriteRetry: (fn) => fn(),
    emitEvent: (type, projectId, extra) => void events.push({ type, projectId, extra }),
    ...over
  }
  return { deps, events }
}

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run('p1', 'Proj One')
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run('p2', 'Proj Two')
  // Three conversations in p1, one in p2, one unassigned.
  db.prepare('INSERT INTO conversations (id, project_id) VALUES (?, ?)').run('c1', 'p1')
  db.prepare('INSERT INTO conversations (id, project_id) VALUES (?, ?)').run('c2', 'p1')
  db.prepare('INSERT INTO conversations (id, project_id) VALUES (?, ?)').run('c3', 'p1')
  db.prepare('INSERT INTO conversations (id, project_id) VALUES (?, ?)').run('c4', 'p2')
  db.prepare('INSERT INTO conversations (id, project_id) VALUES (?, ?)').run('c5', null)
})

describe('deleteProject — atomic detach+delete (node:sqlite)', () => {
  it('REGRESSION: a failing DELETE must NOT leave conversations detached', () => {
    // Simulate the documented trigger: the second statement raises SQLITE_BUSY
    // after busy_timeout. Fail only the DELETE, exactly as a lock held by the
    // headless CLI writer would.
    const realPrepare = db.prepare.bind(db)
    const { deps } = baseDeps({
      db: {
        prepare: ((sql: string) => {
          if (sql.startsWith('DELETE FROM projects')) {
            return {
              run: () => {
                const err = new Error('database is locked') as Error & { code: string }
                err.code = 'SQLITE_BUSY'
                throw err
              }
            }
          }
          return realPrepare(sql)
        }) as unknown as Database['prepare']
      } as Pick<Database, 'prepare'>
    })

    expect(() => deleteProject('p1', deps)).toThrow(/locked/)

    // The whole operation rolled back: the project still exists AND every
    // conversation still knows it belongs to that project. Pre-fix, the UPDATE
    // had already autocommitted and c1/c2/c3 were severed forever.
    expect(projectExists('p1')).toBe(true)
    expect(projectIdOf('c1')).toBe('p1')
    expect(projectIdOf('c2')).toBe('p1')
    expect(projectIdOf('c3')).toBe('p1')
    // Untouched neighbours stay untouched.
    expect(projectIdOf('c4')).toBe('p2')
    expect(projectIdOf('c5')).toBe(null)
  })

  it('commits the detach + delete together on the happy path', () => {
    const { deps } = baseDeps()
    deleteProject('p1', deps)

    expect(projectExists('p1')).toBe(false)
    expect(projectIdOf('c1')).toBe(null)
    expect(projectIdOf('c2')).toBe(null)
    expect(projectIdOf('c3')).toBe(null)
    // Conversations are DETACHED, never deleted.
    expect(
      Number(
        (db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number | bigint }).n
      )
    ).toBe(5)
    // Other projects are unaffected.
    expect(projectExists('p2')).toBe(true)
    expect(projectIdOf('c4')).toBe('p2')
  })

  it('records WHICH conversations were detached, not just how many', () => {
    // Traceability: the count alone cannot name a conversation to reattach.
    const { deps, events } = baseDeps()
    deleteProject('p1', deps)

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('project.deleted')
    expect(events[0].extra.detachedConversations).toBe(3)
    expect(events[0].extra.detachedConversationIds).toEqual(['c1', 'c2', 'c3'])
  })

  it('emits the event INSIDE the transaction — no event when the delete rolls back', () => {
    const realPrepare = db.prepare.bind(db)
    const { deps, events } = baseDeps({
      db: {
        prepare: ((sql: string) => {
          if (sql.startsWith('DELETE FROM projects')) {
            return {
              run: () => {
                throw new Error('io error')
              }
            }
          }
          return realPrepare(sql)
        }) as unknown as Database['prepare']
      } as Pick<Database, 'prepare'>
    })

    expect(() => deleteProject('p1', deps)).toThrow(/io error/)
    expect(events).toHaveLength(0)
  })

  it('routes the whole transaction through withWriteRetry (BUSY is retryable)', () => {
    let attempts = 0
    const { deps } = baseDeps({
      // Stand-in for database.ts:withWriteRetry — retry once on BUSY.
      withWriteRetry: (fn) => {
        try {
          return fn()
        } catch {
          return fn()
        }
      }
    })
    const realPrepare = db.prepare.bind(db)
    deps.db = {
      prepare: ((sql: string) => {
        if (sql.startsWith('DELETE FROM projects')) {
          attempts++
          if (attempts === 1) {
            return {
              run: () => {
                const err = new Error('database is locked') as Error & { code: string }
                err.code = 'SQLITE_BUSY'
                throw err
              }
            }
          }
        }
        return realPrepare(sql)
      }) as unknown as Database['prepare']
    } as Pick<Database, 'prepare'>

    // The first attempt rolls back cleanly; the retry then succeeds in full.
    deleteProject('p1', deps)
    expect(attempts).toBe(2)
    expect(projectExists('p1')).toBe(false)
    expect(projectIdOf('c1')).toBe(null)
  })
})
