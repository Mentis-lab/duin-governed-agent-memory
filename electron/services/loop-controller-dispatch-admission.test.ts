// Backlog finding 4 (critical). tickLoops computed its `due` list once, before the
// first await, having filtered the in-flight guard only at that moment — then awaited
// a full iteration per loop. An iteration is allowed to outlast the 30s tick cadence,
// so a second tick would see only the loop currently being awaited, select the NEXT
// one from the same due set, and start it; when the first tick's await returned it
// started that loop too. Two concurrent iterations of one loop on one conversation.
//
// admitLoopDispatch is the dispatch-time re-check that closes the window.

import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('no electron in test')
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { admitLoopDispatch } from './loop-controller'

describe('admitLoopDispatch — the reentrancy window finding 4 described', () => {
  it('skips a loop another tick started after this tick built its due list', () => {
    // Tick A selected [L1, L2] while nothing ran. It is now awaiting L1. Tick B
    // meanwhile started L2. Tick A must NOT start L2 a second time.
    const running = new Set(['L1', 'L2'])
    expect(admitLoopDispatch('L2', running, 4)).toBe('skip')
  })

  it('runs a loop nobody has picked up', () => {
    expect(admitLoopDispatch('L2', new Set(['L1']), 4)).toBe('run')
  })

  it('stops the pass when concurrency is already saturated', () => {
    // `slots` was computed pre-await too, so the cap needs re-asking, not just the id.
    expect(admitLoopDispatch('L3', new Set(['L1', 'L2']), 2)).toBe('stop')
  })

  it('treats a maxConcurrent below 1 as 1, matching the caller clamp', () => {
    expect(admitLoopDispatch('L1', new Set(), 0)).toBe('run')
    expect(admitLoopDispatch('L2', new Set(['L1']), 0)).toBe('stop')
  })

  it('id check wins over the cap check, so a duplicate is skipped not silently stopping the pass', () => {
    // If these were ordered the other way, a saturated set containing this very loop
    // would 'stop' the whole pass and strand the loops behind it in the due list.
    expect(admitLoopDispatch('L1', new Set(['L1', 'L2']), 2)).toBe('skip')
  })
})
