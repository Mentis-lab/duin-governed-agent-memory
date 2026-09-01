import { describe, it, expect } from 'vitest'
import { reconcile } from './reconcile'
import type { JournalEntry, JournalKind } from './run-journal'

let seq = 0
function entry(kind: JournalKind, over: Partial<JournalEntry> = {}): JournalEntry {
  return {
    seq: seq++,
    ts: seq,
    loopId: 'loop-1',
    itemId: over.itemId ?? 'item-A',
    kind,
    gitSha: over.gitSha ?? null,
    usage: null,
    cost: null,
    note: null,
    ...over
  }
}

// A full committed iteration for one item: load → do → commit(sha).
function iteration(itemId: string, sha: string): JournalEntry[] {
  return [
    entry('load', { itemId }),
    entry('do', { itemId }),
    entry('commit', { itemId, gitSha: sha })
  ]
}

describe('reconcile — L2 idempotent resumability', () => {
  it('empty journal: nothing to reconcile, replay-safe, no resume item', () => {
    const r = reconcile({ loopId: 'loop-1', journal: [], gitSha: null })
    expect(r).toEqual({
      resumeItemId: null,
      alreadyCommitted: false,
      replaySafe: true,
      lastCommittedSha: null
    })
  })

  it('crash BEFORE the first commit: resume the in-progress item, replay-safe', () => {
    // A pre-existing repo (HEAD exists) but the loop journaled no commit yet.
    const journal = [entry('load', { itemId: 'item-A' }), entry('do', { itemId: 'item-A' })]
    const r = reconcile({ loopId: 'loop-1', journal, gitSha: 'preexisting' })
    expect(r.replaySafe).toBe(true)
    expect(r.alreadyCommitted).toBe(false)
    expect(r.resumeItemId).toBe('item-A')
    expect(r.lastCommittedSha).toBeNull()
  })

  it('last commit sha IS HEAD: step already durable (no-op), resume next item', () => {
    // item-A committed as sha-1 and that IS HEAD → skip it. item-B was started
    // (load) but not yet committed → resume item-B.
    const journal = [
      ...iteration('item-A', 'sha-1'),
      entry('load', { itemId: 'item-B' })
    ]
    const r = reconcile({ loopId: 'loop-1', journal, gitSha: 'sha-1' })
    expect(r.alreadyCommitted).toBe(true)
    expect(r.replaySafe).toBe(true)
    expect(r.resumeItemId).toBe('item-B')
    expect(r.lastCommittedSha).toBe('sha-1')
  })

  it('last commit sha IS HEAD and nothing started after: resume item is null (queue decides)', () => {
    const journal = iteration('item-A', 'sha-1')
    const r = reconcile({ loopId: 'loop-1', journal, gitSha: 'sha-1' })
    expect(r.alreadyCommitted).toBe(true)
    expect(r.resumeItemId).toBeNull()
  })

  it('HEAD is an EARLIER journaled sha: replay-safe forward, redo the last commit item', () => {
    // Two commits journaled (sha-1 then sha-2) but HEAD is still sha-1 — the
    // sha-2 commit did not land (crash between git-commit and journal fsync, or
    // a lost write). HEAD is known → resume forward and redo item-B.
    const journal = [...iteration('item-A', 'sha-1'), ...iteration('item-B', 'sha-2')]
    const r = reconcile({ loopId: 'loop-1', journal, gitSha: 'sha-1' })
    expect(r.replaySafe).toBe(true)
    expect(r.alreadyCommitted).toBe(false)
    expect(r.resumeItemId).toBe('item-B')
    expect(r.lastCommittedSha).toBe('sha-2')
  })

  it('HEAD is UNKNOWN to the journal: divergence, NOT replay-safe (caller escalates)', () => {
    const journal = iteration('item-A', 'sha-1')
    const r = reconcile({ loopId: 'loop-1', journal, gitSha: 'some-foreign-sha' })
    expect(r.replaySafe).toBe(false)
    expect(r.alreadyCommitted).toBe(false)
    expect(r.lastCommittedSha).toBe('sha-1')
  })

  it('commits journaled but HEAD is null (git lost the commits): divergence', () => {
    const journal = iteration('item-A', 'sha-1')
    const r = reconcile({ loopId: 'loop-1', journal, gitSha: null })
    expect(r.replaySafe).toBe(false)
    expect(r.alreadyCommitted).toBe(false)
  })

  it('picks the LAST commit entry as the anchor when several exist', () => {
    const journal = [
      ...iteration('item-A', 'sha-1'),
      ...iteration('item-B', 'sha-2'),
      ...iteration('item-C', 'sha-3')
    ]
    const r = reconcile({ loopId: 'loop-1', journal, gitSha: 'sha-3' })
    expect(r.lastCommittedSha).toBe('sha-3')
    expect(r.alreadyCommitted).toBe(true)
  })
})
