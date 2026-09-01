// vault-trash retention + recovery.
//
// .trash became the single recovery surface for a dozen code paths during the data-loss audit, and it
// was append-only with no retention, no size cap, and no way to browse it. Two gaps, opposite in
// character: it grew without bound, and the preserved bytes were in practice unreachable — the only
// route to a tombstone was reading raw JSONL or catching a path in a printed string.
//
// pruneTrash is DELETION inside the module whose entire job is preservation, so most of what follows
// pins what it must REFUSE to delete rather than what it removes.
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  tombstoneToTrash,
  snapshotToTrash,
  listTombstones,
  restoreTombstone,
  pruneTrash,
  TRASH_DIR_NAME,
  TOMBSTONE_JOURNAL,
  MIN_KEEP_DAYS
} from './vault-trash'

let vault: string
const DAY = 24 * 60 * 60 * 1000
const NOW = 1800000000000 // fixed clock; never Date.now() in assertions

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'duin-trash-'))
})

const note = (rel: string, body: string): string => {
  const abs = join(vault, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body)
  return abs
}
/** Append a journal line with an explicit age, so retention can be tested without waiting. */
const journalAt = (to: string, from: string, daysAgo: number, op = 'delete'): void => {
  appendFileSync(
    join(vault, TRASH_DIR_NAME, TOMBSTONE_JOURNAL),
    JSON.stringify({ at: new Date(NOW - daysAgo * DAY).toISOString(), actor: 'test', from, to, op }) + '\n'
  )
}
const stage = (rel: string, body: string, daysAgo: number): string => {
  const abs = note(rel, body)
  const r = tombstoneToTrash(vault, abs, 'test')
  if (!r.ok) throw new Error(r.error)
  // Rewrite the journal line with the age we want.
  const j = join(vault, TRASH_DIR_NAME, TOMBSTONE_JOURNAL)
  const kept = readFileSync(j, 'utf-8').split(/\r?\n/).filter((l) => l.trim() && !l.includes(r.trashRel))
  writeFileSync(j, kept.join('\n') + (kept.length ? '\n' : ''))
  journalAt(r.trashRel, rel, daysAgo)
  return r.trashRel
}

describe('listTombstones — the recovery surface', () => {
  it('joins the journal to the bytes actually on disk, newest first', () => {
    tombstoneToTrash(vault, note('a.md', 'AAA'), 'ui', 'cleanup')
    tombstoneToTrash(vault, note('sub/b.md', 'BBB'), 'agent')
    const list = listTombstones(vault)
    expect(list).toHaveLength(2)
    expect(list[0].from).toBe('sub/b.md') // newest first
    expect(list[0].actor).toBe('agent')
    expect(list[1].reason).toBe('cleanup')
    for (const t of list) {
      expect(t.present).toBe(true)
      expect(t.bytes).toBe(3)
    }
  })

  it('reports a journalled tombstone whose bytes are gone as present=false, not silently hidden', () => {
    const rel = stage('c.md', 'CCC', 0)
    unlinkSync(join(vault, rel))
    const t = listTombstones(vault).find((x) => x.to === rel)!
    expect(t.present).toBe(false)
  })

  it('SKIPS a malformed journal line and never rewrites the journal', () => {
    tombstoneToTrash(vault, note('d.md', 'DDD'), 'ui')
    const j = join(vault, TRASH_DIR_NAME, TOMBSTONE_JOURNAL)
    const before = readFileSync(j, 'utf-8')
    appendFileSync(j, '{"at":"broken",,,\n')
    expect(listTombstones(vault)).toHaveLength(1) // the good line still reads
    expect(readFileSync(j, 'utf-8').startsWith(before)).toBe(true) // torn line untouched
  })

  it('is empty (not throwing) on a vault that has never trashed anything', () => {
    expect(listTombstones(vault)).toEqual([])
  })
})

describe('restoreTombstone', () => {
  it('puts the bytes back at their original path', () => {
    const abs = note('notes/keep.md', 'ORIGINAL')
    const r = tombstoneToTrash(vault, abs, 'agent')
    expect(existsSync(abs)).toBe(false)
    const res = restoreTombstone(vault, (r as { trashRel: string }).trashRel)
    expect(res.ok).toBe(true)
    expect(readFileSync(abs, 'utf-8')).toBe('ORIGINAL')
  })

  it('REFUSES to clobber a file that now occupies the origin', () => {
    const abs = note('notes/keep.md', 'ORIGINAL')
    const r = tombstoneToTrash(vault, abs, 'agent') as { trashRel: string }
    writeFileSync(abs, 'SOMETHING NEWER')
    const res = restoreTombstone(vault, r.trashRel)
    expect(res.ok).toBe(false)
    expect(readFileSync(abs, 'utf-8')).toBe('SOMETHING NEWER') // untouched
    expect(restoreTombstone(vault, r.trashRel, { overwrite: true }).ok).toBe(true)
  })

  it('leaves the tombstone in place after restoring (copy, not move)', () => {
    const abs = note('x.md', 'X')
    const r = tombstoneToTrash(vault, abs, 'ui') as { trashRel: string }
    restoreTombstone(vault, r.trashRel)
    expect(existsSync(join(vault, r.trashRel))).toBe(true)
  })

  it('refuses an unknown tombstone rather than guessing', () => {
    expect(restoreTombstone(vault, '.trash/never-existed.md').ok).toBe(false)
  })
})

describe('pruneTrash — what it must REFUSE to delete', () => {
  it('NEVER removes anything inside the hard floor, however far over the caps', () => {
    const recent = [0, 1, 5, 20].map((d, i) => stage(`r${i}.md`, 'x'.repeat(100), d))
    const res = pruneTrash(vault, { maxEntries: 1, maxBytes: 1, now: NOW })
    expect(res.removed).toEqual([]) // caps say prune everything; the floor says no
    for (const rel of recent) expect(existsSync(join(vault, rel))).toBe(true)
  })

  it('removes oldest-first ONLY once past the floor AND over a cap', () => {
    const old1 = stage('o1.md', 'a'.repeat(50), MIN_KEEP_DAYS + 40)
    const old2 = stage('o2.md', 'b'.repeat(50), MIN_KEEP_DAYS + 20)
    const fresh = stage('f.md', 'c'.repeat(50), 1)
    const res = pruneTrash(vault, { maxEntries: 2, now: NOW })
    expect(res.removed).toEqual([old1]) // only the single oldest, to get back under the cap
    expect(existsSync(join(vault, old1))).toBe(false)
    expect(existsSync(join(vault, old2))).toBe(true)
    expect(existsSync(join(vault, fresh))).toBe(true)
  })

  it('is a strict no-op when under the caps', () => {
    const rel = stage('u.md', 'small', MIN_KEEP_DAYS + 100)
    expect(pruneTrash(vault, { now: NOW }).removed).toEqual([])
    expect(existsSync(join(vault, rel))).toBe(true)
  })

  it('NEVER deletes the journal itself', () => {
    stage('j1.md', 'x'.repeat(999), MIN_KEEP_DAYS + 90)
    pruneTrash(vault, { maxEntries: 0, maxBytes: 0, now: NOW })
    expect(existsSync(join(vault, TRASH_DIR_NAME, TOMBSTONE_JOURNAL))).toBe(true)
  })

  it('PROTECTS an unexplained file that has no journal line', () => {
    // A file in .trash nobody can account for is the last thing to delete on a guess.
    mkdirSync(join(vault, TRASH_DIR_NAME), { recursive: true })
    const orphan = join(vault, TRASH_DIR_NAME, 'mystery.md')
    writeFileSync(orphan, 'unaccounted for')
    pruneTrash(vault, { maxEntries: 0, maxBytes: 0, minKeepDays: 0, now: NOW })
    expect(existsSync(orphan)).toBe(true)
  })

  it('treats an UNPARSEABLE date as young (protected), not as infinitely old', () => {
    const abs = note('bad-date.md', 'keep me')
    const r = tombstoneToTrash(vault, abs, 'test') as { trashRel: string }
    const j = join(vault, TRASH_DIR_NAME, TOMBSTONE_JOURNAL)
    writeFileSync(j, JSON.stringify({ at: 'not-a-date', actor: 't', from: 'bad-date.md', to: r.trashRel, op: 'delete' }) + '\n')
    pruneTrash(vault, { maxEntries: 0, maxBytes: 0, now: NOW })
    expect(existsSync(join(vault, r.trashRel))).toBe(true)
  })

  it('records the prune in the journal — the audit of the audit', () => {
    stage('p1.md', 'x'.repeat(100), MIN_KEEP_DAYS + 60)
    stage('p2.md', 'y'.repeat(100), MIN_KEEP_DAYS + 50)
    const res = pruneTrash(vault, { maxEntries: 1, now: NOW })
    expect(res.removed.length).toBe(1)
    // Read the RAW journal: a prune record names no `to`, so listTombstones correctly omits it —
    // that API returns recoverable entries, and a prune is bookkeeping, not something to restore.
    const lines = readFileSync(join(vault, TRASH_DIR_NAME, TOMBSTONE_JOURNAL), 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const prune = lines.find((l) => l.op === 'prune')!
    expect(prune).toBeTruthy()
    expect(prune.removed).toBe(1)
    expect(Number(prune.freedBytes)).toBeGreaterThan(0)
  })

  it('listTombstones stays semantically clean: only recoverable entries, never prune bookkeeping', () => {
    stage('q1.md', 'x'.repeat(100), MIN_KEEP_DAYS + 60)
    stage('q2.md', 'y'.repeat(100), MIN_KEEP_DAYS + 50)
    pruneTrash(vault, { maxEntries: 1, now: NOW })
    for (const t of listTombstones(vault)) expect(t.op).not.toBe('prune')
  })

  it('does not treat snapshot (overwrite) tombstones differently from deletes', () => {
    const abs = note('s.md', 'z'.repeat(80))
    snapshotToTrash(vault, abs, 'test')
    expect(existsSync(abs)).toBe(true) // snapshot leaves the original
    expect(listTombstones(vault)[0].op).toBe('overwrite')
  })

  it('is safe on a vault with no .trash at all', () => {
    expect(pruneTrash(vault, { now: NOW })).toEqual({ removed: [], freedBytes: 0, kept: 0 })
  })
})
