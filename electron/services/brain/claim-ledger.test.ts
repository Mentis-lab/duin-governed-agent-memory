import { describe, it, expect, afterAll } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { rmSync, mkdirSync } from 'fs'
import { loadLedger, saveLedger, parseDateMs, gatherWorldState } from './claim-ledger'
import { classifyMutability, type Claim } from './claim-metabolism'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 6, 4)
const dir = join(tmpdir(), `claim-ledger-test-${NOW}`)
mkdirSync(join(dir, '.duin', '_state'), { recursive: true })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function claim(id: string): Claim {
  return {
    id, chunkId: `c-${id}`, notePath: `${id}.md`, subject: 's', relation: 'status', object: 'o',
    validFrom: NOW, validTo: null, observedAt: NOW, supersededBy: null,
    mutability: classifyMutability('status'), justifications: [], verdict: 'current', verdictBy: null
  }
}

describe('claim-ledger — persistence', () => {
  it('empty ledger loads as []', () => {
    expect(loadLedger(join(tmpdir(), 'no-such-vault-xyz'))).toEqual([])
  })
  it('save→load round-trips claims (JSONL)', () => {
    saveLedger(dir, [claim('a'), claim('b')])
    const back = loadLedger(dir)
    expect(back.map((c) => c.id)).toEqual(['a', 'b'])
    expect(back[0].verdict).toBe('current')
  })
})

describe('claim-ledger — parseDateMs', () => {
  it('parses YYYY-MM-DD and YYYY-MM; rejects junk', () => {
    expect(parseDateMs('2026-07-04')).toBe(Date.UTC(2026, 6, 4))
    expect(parseDateMs('2026-07')).toBe(Date.UTC(2026, 6, 1))
    expect(parseDateMs('someday')).toBeNull()
    expect(parseDateMs(null)).toBeNull()
  })
})

describe('claim-ledger — gatherWorldState (deterministic, conservative)', () => {
  it('a decision whose review window has PASSED is resolved; a future one is not', () => {
    const ws = gatherWorldState(
      [
        { id: 'past-dec', reviewOn: '2026-06-01' },   // before NOW
        { id: 'future-dec', reviewOn: '2026-12-01' },  // after NOW
        { id: 'status-dec', status: 'closed' }         // status signal
      ],
      [],
      NOW
    )
    expect(ws.resolvedDecisions.has('past-dec')).toBe(true)
    expect(ws.resolvedDecisions.has('future-dec')).toBe(false)
    expect(ws.resolvedDecisions.has('status-dec')).toBe(true)
  })
  it('a stream whose decide-by date has passed (or status done) is passed', () => {
    const ws = gatherWorldState(
      [],
      [
        { id: 'passed-stream', decide_by: '2026-05-01' },
        { id: 'live-stream', decide_by: '2026-09-01' },
        { id: 'done-stream', status: 'complete' }
      ],
      NOW
    )
    expect(ws.passedStreams.has('passed-stream')).toBe(true)
    expect(ws.passedStreams.has('live-stream')).toBe(false)
    expect(ws.passedStreams.has('done-stream')).toBe(true)
  })
  it('no anchors supplied → empty set (callers that never pass anchors keep todays behavior)', () => {
    expect(gatherWorldState([], [], NOW).pastAnchors.size).toBe(0)
  })

  it('an anchor whose window has CLOSED is past; one still open or in the future is not', () => {
    const ws = gatherWorldState([], [], NOW, [
      { id: 'closed', name: 'Closed Event', date: '2026-05-01', window_end: '2026-05-03' },
      { id: 'open-now', name: 'Open Event', date: '2026-07-01', window_end: '2026-08-01' },
      { id: 'future', name: 'Future Event', date: '2026-12-01' }
    ])
    // Both the id and the display name land, because claim refs cite anchors either way.
    expect(ws.pastAnchors.has('closed')).toBe(true)
    expect(ws.pastAnchors.has('Closed Event')).toBe(true)
    expect(ws.pastAnchors.has('open-now')).toBe(false)
    expect(ws.pastAnchors.has('future')).toBe(false)
  })

  it('a multi-day anchor is NOT past on its start date — closure is window_end, not date', () => {
    // date is behind NOW but the window runs past it: the event is still open.
    const ws = gatherWorldState([], [], NOW, [{ id: 'running', date: '2026-07-01', window_end: '2026-07-30' }])
    expect(ws.pastAnchors.has('running')).toBe(false)
  })

  it('an anchor with no parseable date is SKIPPED, never guessed past', () => {
    const ws = gatherWorldState([], [], NOW, [
      { id: 'undated', name: 'Undated' },
      { id: 'blank', date: '', window_end: '' },
      { id: 'garbage', date: 'someday' }
    ])
    expect(ws.pastAnchors.size).toBe(0)
  })
})
