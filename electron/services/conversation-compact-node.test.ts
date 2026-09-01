// compactConversation atomicity — EXECUTING coverage against Node's built-in `node:sqlite`, so the
// transaction runs for real without the Electron better-sqlite3 ABI.
//
// This file exists because the obvious test does not work. A sibling suite driving the real getDb() is
// skipIf(!nativeOk()) and NEVER runs under the node-env vitest — I first wrote these tests that way,
// they "passed", and a power control proved they passed with the transaction REMOVED. A test that cannot
// fail is worse than no test: it certifies the exact property it never checked. Injecting a node:sqlite
// handle through the seam (as conversation-cascade-node.test.ts already does for deleteConversation)
// makes the transaction genuinely executable here.
//
// The property under test: /compact used to DELETE the messages and THEN insert the summary, outside any
// transaction. The delete committed immediately, so a failing insert left the conversation permanently
// empty with nothing written back.
import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { Database } from 'better-sqlite3'
import { compactConversation, type CompactConversationDeps } from './conversation-store'

const SCHEMA = `
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    role TEXT,
    content TEXT,
    created_at INTEGER
  );
`

let db: DatabaseSync
const asDb = (): Pick<Database, 'prepare'> => db as unknown as Pick<Database, 'prepare'>

/** A real transaction over node:sqlite — mirrors the production `transactional` helper. */
const realTx = <T,>(fn: () => T): T => {
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
const deps = (): CompactConversationDeps => ({ db: asDb(), transactional: realTx })

const seed = (convId: string, n: number): void => {
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)').run(
      `${convId}-m${i}`,
      convId,
      i % 2 === 0 ? 'user' : 'assistant',
      `Message ${i} with enough substance to be worth preserving across a compaction.`,
      1000 + i
    )
  }
}
const count = (convId: string): number =>
  Number((db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(convId) as { n: number | bigint }).n)

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
})

describe('compactConversation — all-or-nothing (node:sqlite)', () => {
  it('replaces every message with the single summary row', () => {
    seed('c1', 6)
    const replaced = compactConversation('c1', { id: 'sum-1', content: 'A faithful summary.' }, deps())
    expect(replaced).toBe(6)
    expect(count('c1')).toBe(1)
    const row = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ?').get('c1') as { role: string; content: string }
    expect(row.role).toBe('system')
    expect(row.content).toContain('A faithful summary')
  })

  it('THE BUG: a failing insert leaves the conversation INTACT, never empty', () => {
    seed('c2', 6)
    seed('bystander', 1)
    // The summary id collides with a row in ANOTHER conversation, so the PK violation survives the
    // DELETE (which only clears c2). Same shape as a constraint error, disk-full, or an encryption
    // fault in production: the insert fails after the delete has run.
    expect(() => compactConversation('c2', { id: 'bystander-m0', content: 'summary that cannot be inserted' }, deps())).toThrow()
    expect(count('c2')).toBe(6) // asserted 0 before the fix: the DELETE had already committed
    expect(count('bystander')).toBe(1)
  })

  it('leaves other conversations untouched', () => {
    seed('a', 4)
    seed('b', 4)
    compactConversation('a', { id: 'sum-2', content: 'Summary of A only.' }, deps())
    expect(count('a')).toBe(1)
    expect(count('b')).toBe(4)
  })

  it('a rolled-back compact can be retried successfully afterwards', () => {
    seed('c3', 5)
    seed('other', 1)
    expect(() => compactConversation('c3', { id: 'other-m0', content: 'bad' }, deps())).toThrow()
    expect(count('c3')).toBe(5)
    expect(compactConversation('c3', { id: 'fresh-id', content: 'Good summary.' }, deps())).toBe(5)
    expect(count('c3')).toBe(1)
  })

  it('re-compacting an already-compacted thread keeps exactly one row', () => {
    seed('c4', 5)
    compactConversation('c4', { id: 's1', content: 'First summary.' }, deps())
    compactConversation('c4', { id: 's2', content: 'Second summary.' }, deps())
    expect(count('c4')).toBe(1)
    const row = db.prepare('SELECT content FROM messages WHERE conversation_id = ?').get('c4') as { content: string }
    expect(row.content).toContain('Second summary')
  })
})

// Backlog finding 6 (critical). The IPC handler snapshots the messages, then awaits a
// summarisation model call, then compacted. The delete was `WHERE conversation_id = ?`
// — everything — so a message the user sent while the summariser was thinking was
// destroyed: never summarised, never archived, and reported under a plain
// "Conversation compacted" success toast. The scoped replace is what bounds the delete
// to the block the summary actually stands for.
describe('compactConversation — scoped replace (backlog finding 6)', () => {
  const idsOf = (convId: string): string[] =>
    (
      db
        .prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
        .all(convId) as Array<{ id: string }>
    ).map((r) => r.id)

  it('deletes only the snapshot ids and leaves later messages alone', () => {
    seed('c1', 6)
    // The handler summarised the first four; two more arrived during the await.
    const snapshot = idsOf('c1').slice(0, 4)
    const replaced = compactConversation(
      'c1',
      { id: 'sum-1', content: 'A faithful summary.', createdAt: 1003 },
      deps(),
      { replaceIds: snapshot }
    )
    expect(replaced).toBe(4)
    // 2 survivors + the summary row.
    expect(count('c1')).toBe(3)
    const after = idsOf('c1')
    expect(after).toContain('c1-m4')
    expect(after).toContain('c1-m5')
    for (const gone of snapshot) expect(after).not.toContain(gone)
  })

  it('sorts the summary into the place of the block it replaced', () => {
    seed('c1', 6)
    const snapshot = idsOf('c1').slice(0, 4)
    compactConversation(
      'c1',
      { id: 'sum-1', content: 'A faithful summary.', createdAt: 1003 },
      deps(),
      { replaceIds: snapshot }
    )
    // Not appended after the newer turns — it stands where the replaced block was.
    expect(idsOf('c1')).toEqual(['sum-1', 'c1-m4', 'c1-m5'])
  })

  it('an empty or omitted id list keeps the previous whole-conversation behaviour', () => {
    seed('c1', 6)
    expect(
      compactConversation('c1', { id: 's-a', content: 'x' }, deps(), { replaceIds: [] })
    ).toBe(6)
    expect(count('c1')).toBe(1)

    seed('c2', 3)
    expect(compactConversation('c2', { id: 's-b', content: 'y' }, deps())).toBe(3)
    expect(count('c2')).toBe(1)
  })

  it('never touches another conversation, even if an id is passed by mistake', () => {
    seed('c1', 3)
    seed('c2', 3)
    compactConversation(
      'c1',
      { id: 'sum-1', content: 'A faithful summary.' },
      deps(),
      { replaceIds: ['c1-m0', 'c2-m0', 'c2-m1'] }
    )
    // Scoped by conversation_id AND id — c2 is untouched.
    expect(count('c2')).toBe(3)
    expect(count('c1')).toBe(3) // 2 survivors + summary
  })
})
