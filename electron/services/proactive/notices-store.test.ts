import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  listNotices,
  markAllRead,
  markRead,
  noticeCounts,
  pruneNotices,
  recordNotice,
  resolveByActionId,
  setNoticesPath,
  __resetNotices
} from './notices-store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duin-notices-'))
  __resetNotices()
  setNoticesPath(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('recordNotice — an inbox entry survives whether or not delivery worked', () => {
  it('records and persists', () => {
    const n = recordNotice({ kind: 'watch', title: 'Forecast resolved', severity: 'info' })
    expect(n?.readAt).toBeNull()
    expect(n?.count).toBe(1)

    const onDisk = JSON.parse(readFileSync(join(dir, 'notices.json'), 'utf-8'))
    expect(Object.keys(onDisk.notices)).toHaveLength(1)
  })

  it('refuses an empty title instead of filing a blank row', () => {
    expect(recordNotice({ kind: 'watch', title: '   ' })).toBeNull()
    expect(listNotices()).toHaveLength(0)
  })

  it('folds a repeat into the existing row and makes it unread again', () => {
    const first = recordNotice({ kind: 'watch', title: 'Job failed', dedupKey: 'jobFail:nightly' })
    markRead([first!.id])
    expect(noticeCounts().unread).toBe(0)

    const second = recordNotice({ kind: 'watch', title: 'Job failed', dedupKey: 'jobFail:nightly' })
    expect(second?.id).toBe(first?.id)
    expect(second?.count).toBe(2)
    // A recurrence is news again; leaving it read would hide the second failure.
    expect(noticeCounts().unread).toBe(1)
    expect(listNotices()).toHaveLength(1)
  })

  it('does not fold a repeat once the coalesce window has passed', () => {
    const t0 = 1_000_000
    recordNotice({ kind: 'watch', title: 'Drift', dedupKey: 'k', now: t0 })
    recordNotice({ kind: 'watch', title: 'Drift', dedupKey: 'k', now: t0 + 31 * 60_000 })
    expect(listNotices()).toHaveLength(2)
  })
})

describe('ordering and counts', () => {
  it('leads with owed decisions however old they are', () => {
    const t0 = 1_000_000
    recordNotice({ kind: 'approval', title: 'Approve the deploy', needsDecision: true, actionId: 'a1', now: t0 })
    recordNotice({ kind: 'watch', title: 'Much newer note', now: t0 + 60 * 60_000 })

    const [first] = listNotices()
    expect(first.title).toBe('Approve the deploy')
    expect(noticeCounts()).toEqual({ unread: 2, needsDecision: 1 })
  })

  it('separates unread from owed in the counts', () => {
    recordNotice({ kind: 'watch', title: 'A note' })
    const owed = recordNotice({ kind: 'approval', title: 'Decide', needsDecision: true, actionId: 'x' })
    markRead([owed!.id])
    // Reading an owed decision does not answer it.
    expect(noticeCounts()).toEqual({ unread: 1, needsDecision: 1 })
  })
})

describe('resolveByActionId — an answer given elsewhere clears the ask', () => {
  it('resolves and stops counting', () => {
    recordNotice({ kind: 'approval', title: 'Approve', needsDecision: true, actionId: 'act-9' })
    expect(noticeCounts().needsDecision).toBe(1)

    // The operator may answer in a channel reply, or it may time out to deny. Either
    // way the inbox must stop asking.
    expect(resolveByActionId('act-9')).toBe(1)
    expect(noticeCounts().needsDecision).toBe(0)
  })

  it('is a no-op for an unknown action', () => {
    expect(resolveByActionId('nope')).toBe(0)
  })
})

describe('read state', () => {
  it('marks one and marks all', () => {
    const a = recordNotice({ kind: 'watch', title: 'One' })!
    recordNotice({ kind: 'watch', title: 'Two' })
    expect(markRead([a.id])).toBe(1)
    expect(markRead([a.id])).toBe(0)
    expect(noticeCounts().unread).toBe(1)
    expect(markAllRead()).toBe(1)
    expect(noticeCounts().unread).toBe(0)
  })
})

describe('pruning', () => {
  it('ages out read rows but never an unanswered decision', () => {
    const t0 = 1_000_000
    const old = recordNotice({ kind: 'watch', title: 'Old note', now: t0 })!
    markRead([old.id], t0)
    recordNotice({ kind: 'approval', title: 'Still owed', needsDecision: true, actionId: 'z', now: t0 })

    const later = t0 + 8 * 24 * 60 * 60_000
    expect(pruneNotices(7 * 24 * 60 * 60_000, later)).toBe(1)
    expect(listNotices().map((n) => n.title)).toEqual(['Still owed'])
  })
})

describe('corrupt store', () => {
  it('quarantines unreadable bytes rather than letting the next write erase them', () => {
    writeFileSync(join(dir, 'notices.json'), '{ this is not json', 'utf-8')
    setNoticesPath(dir)

    expect(listNotices()).toHaveLength(0)
    const quarantined = readdirSync(dir).filter((f) => f.endsWith('.corrupt'))
    expect(quarantined).toHaveLength(1)
    expect(readFileSync(join(dir, quarantined[0]), 'utf-8')).toBe('{ this is not json')

    // And the store still works afterwards.
    recordNotice({ kind: 'watch', title: 'After recovery' })
    expect(existsSync(join(dir, 'notices.json'))).toBe(true)
  })
})
