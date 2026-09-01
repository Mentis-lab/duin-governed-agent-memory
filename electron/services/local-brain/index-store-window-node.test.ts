// The date-window filter's admit/exclude rule, executed against a REAL SQLite database.
//
// WHY node:sqlite. better-sqlite3 is built for Electron's ABI and throws on construction under the
// node-env vitest, so a suite gated on `skipIf(!HAS_NATIVE_SQLITE)` reports PASS while executing
// nothing — it would certify the exact property it never checks. Node's built-in driver runs the
// real SQL, which is all this needs: one table, one range predicate. Same reasoning as
// index-store-defer-stamp-node.test.ts.
//
// WHAT IS ACTUALLY AT STAKE. `filesOutsideWindow` is a DENYLIST, and the temptation is to write the
// obvious whitelist ("files whose note_date is in range") instead. The whitelist is wrong in a way
// that does not look like a bug: it returns a thin answer rather than an error. It would drop every
// note on an install that has not reindexed since note_date shipped (all NULL ⇒ empty whitelist ⇒
// total retrieval outage presenting as "nothing found for that period"), and every connector-
// ingested src/ chunk (chunk rows, no notes_files row at all). These tests pin the direction.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { filesOutsideWindow } from './index-store'
import type { Database } from 'better-sqlite3'

const utc = (s: string): number => Date.parse(`${s}T00:00:00Z`)
const WINDOW = { from: utc('2026-06-08'), to: utc('2026-06-22') } // a 双周报 fortnight

let db: DatabaseSync

/** node:sqlite satisfies the .prepare().all() shape filesOutsideWindow uses. */
const asHandle = (d: DatabaseSync): Database => d as unknown as Database

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(
    'CREATE TABLE notes_files (file TEXT PRIMARY KEY, hash TEXT NOT NULL, mtime INTEGER, note_date INTEGER, note_date_src TEXT)'
  )
  const ins = db.prepare('INSERT INTO notes_files(file, hash, mtime, note_date, note_date_src) VALUES (?,?,?,?,?)')
  ins.run('in/mid.md', 'h', 0, utc('2026-06-15'), 'frontmatter')
  ins.run('in/first-day.md', 'h', 0, WINDOW.from, 'filename') // inclusive lower bound
  ins.run('out/before.md', 'h', 0, utc('2026-05-01'), 'filename')
  ins.run('out/after.md', 'h', 0, utc('2026-07-01'), 'filename')
  ins.run('out/last-day.md', 'h', 0, WINDOW.to, 'filename') // exclusive upper bound
  ins.run('unknown/legacy.md', 'h', 0, null, null) // pre-upgrade row
})

afterEach(() => db.close())

describe('filesOutsideWindow — excludes only what it can PROVE is out of range', () => {
  it('excludes dated notes on either side of the window', () => {
    const out = filesOutsideWindow(asHandle(db), WINDOW)
    expect(out.has('out/before.md')).toBe(true)
    expect(out.has('out/after.md')).toBe(true)
  })

  it('treats the window as half-open [from, to)', () => {
    const out = filesOutsideWindow(asHandle(db), WINDOW)
    expect(out.has('in/first-day.md')).toBe(false) // from is INCLUSIVE
    expect(out.has('out/last-day.md')).toBe(true) // to is EXCLUSIVE
  })

  it('ADMITS a NULL note_date — the whole-corpus outage this prevents', () => {
    // note_date is backfilled by the index walk. Before that walk every row is NULL, so a whitelist
    // would return nothing at all and the operator would read it as "I have no notes from then".
    const out = filesOutsideWindow(asHandle(db), WINDOW)
    expect(out.has('unknown/legacy.md')).toBe(false)
  })

  it('ADMITS a file with no notes_files row at all (connector-ingested src/ chunks)', () => {
    // That ledger tracks FILE notes only. A denylist never mentions src/…, so it stays searchable.
    const out = filesOutsideWindow(asHandle(db), WINDOW)
    expect(out.has('src/slack/general.md')).toBe(false)
  })

  it('fails OPEN when the column or table is missing, rather than excluding everything', () => {
    // A filter that cannot be computed must not silently become a filter that admits nothing.
    const bare = new DatabaseSync(':memory:')
    try {
      expect(filesOutsideWindow(asHandle(bare), WINDOW).size).toBe(0)
    } finally {
      bare.close()
    }
  })

  it('an empty window excludes every DATED note but still admits the undated ones', () => {
    const empty = { from: utc('2030-01-01'), to: utc('2030-01-02') }
    const out = filesOutsideWindow(asHandle(db), empty)
    expect(out.has('in/mid.md')).toBe(true)
    expect(out.has('unknown/legacy.md')).toBe(false)
  })
})
