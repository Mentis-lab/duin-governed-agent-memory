import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Regression cover for the E3 first-boot FTS backfill.
//
// The defect this pins: `backfillSessionsFts` selected pre-existing titles with
// `title <> ""`. better-sqlite3 is built with SQLITE_DQS=0, so a double-quoted
// token is parsed as an IDENTIFIER, not a string literal — the statement threw
// `no such column: ""` on the very first prepare, one line after
// `DELETE FROM sessions_fts` had already emptied the index. The catch swallowed
// it into `{rebuilt:false, rows:0}` and logged a single line, so an upgrading
// user's entire history went un-indexed and stayed that way: the incremental
// writers then keep `existing > 0` forever, so the early-return guard never lets
// the backfill run again.
//
// What made it invisible: the double-quoted form is valid SQL under SQLite's
// default DQS compatibility mode and reads as an obviously-correct empty-string
// compare, the failure is swallowed rather than thrown, and the only suite that
// covered the backfill was silently skipping (its `skipIf` probe opens the DB at
// COLLECTION time, before `beforeEach` creates the userData dir, so the guard
// always read "no native sqlite"). Hence this file guards on a plain in-memory
// binding probe and creates the directory before any DB is opened.
const TEST_USER_DATA = join(tmpdir(), `lamprey-fts-backfill-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: { getPath: () => TEST_USER_DATA },
  BrowserWindow: { getAllWindows: () => [] }
}))

import * as convStore from './conversation-store'
import { __resetDbForTests, getDb } from './database'

// Probe the BINDING only (`:memory:` needs no directory), matching
// event-log-prune.test.ts. Deliberately NOT `getDb()` — that resolves
// app.getPath('userData'), which does not exist until beforeEach runs.
const HAS_NATIVE_SQLITE: boolean = (() => {
  try {
    const probe = new BetterSqlite3(':memory:')
    probe.close()
    return true
  } catch {
    return false
  }
})()

beforeEach(() => {
  __resetDbForTests()
  if (existsSync(TEST_USER_DATA)) rmSync(TEST_USER_DATA, { recursive: true, force: true })
  mkdirSync(TEST_USER_DATA, { recursive: true })
})

afterAll(() => {
  __resetDbForTests()
  if (existsSync(TEST_USER_DATA)) rmSync(TEST_USER_DATA, { recursive: true, force: true })
})

describe('backfillSessionsFts — first boot after the E3 migration', () => {
  it.skipIf(!HAS_NATIVE_SQLITE)(
    'indexes pre-existing conversations + messages via the production force=false path',
    () => {
      // Stand in for a database written by a pre-E3 build: conversations and
      // messages already durable, sessions_fts created empty by schema-init.
      const a = convStore.createConversation('deepseek-chat')
      convStore.updateConversationTitle(a.id, 'Quarterly planning notes')
      // Marker is deliberately a single alphanumeric token: searchSessions passes
      // the query straight to `sessions_fts MATCH`, so a hyphenated word is read as
      // FTS5 column-filter syntax and errors out. That is a separate searchSessions
      // concern — keeping it out of the marker keeps this test about the backfill.
      convStore.saveMessage({
        id: 'msg-pre-e3',
        conversationId: a.id,
        role: 'user',
        content: 'Marker phrase canarybackfill4471.'
      })

      const db = getDb()
      db.exec('DELETE FROM sessions_fts')
      expect(convStore.searchSessions('canarybackfill4471')).toEqual([])

      // main.ts calls this with force=false. `existing === 0` after the wipe, so
      // the early return is passed and the real rebuild runs — the exact
      // production entry point, not the test-only force:true repair path.
      const res = convStore.backfillSessionsFts(false)

      expect(res.rebuilt).toBe(true)
      expect(res.rows).toBeGreaterThan(0)

      // Both halves of the rebuild must land: the title SELECT is the statement
      // that threw, and it threw BEFORE the message loop, so a regression takes
      // message bodies down with it.
      const titleHits = convStore.searchSessions('Quarterly')
      expect(titleHits.find((h) => h.source === 'conversation' && h.conversationId === a.id)).toBeTruthy()

      const bodyHits = convStore.searchSessions('canarybackfill4471')
      expect(bodyHits.find((h) => h.source === 'message' && h.conversationId === a.id)).toBeTruthy()
    }
  )

  it.skipIf(!HAS_NATIVE_SQLITE)('skips conversations whose title is NULL or empty', () => {
    const titled = convStore.createConversation('deepseek-chat')
    convStore.updateConversationTitle(titled.id, 'Has a real title')
    // Left untitled on purpose: exercises the `title IS NOT NULL AND title <> ''`
    // filter the defect lived inside.
    const untitled = convStore.createConversation('deepseek-chat')

    const db = getDb()
    db.exec('DELETE FROM sessions_fts')
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run('', untitled.id)

    const res = convStore.backfillSessionsFts(false)
    expect(res.rebuilt).toBe(true)

    const convRows = db
      .prepare("SELECT conversation_id FROM sessions_fts WHERE source = 'conversation'")
      .all() as { conversation_id: string }[]
    expect(convRows.map((r) => r.conversation_id)).toEqual([titled.id])
  })
})
