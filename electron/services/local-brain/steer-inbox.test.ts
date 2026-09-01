import { describe, expect, it } from 'vitest'
import { SteerInbox } from './steer-inbox'

describe('SteerInbox', () => {
  it('buffers steer text and reports pending', () => {
    const inbox = new SteerInbox()
    expect(inbox.hasPendingSteer).toBe(false)
    expect(inbox.pushSteer('focus on auth')).toBe(true)
    expect(inbox.hasPendingSteer).toBe(true)
    expect(inbox.pendingCount).toBe(1)
  })

  it('drains oldest→newest and clears the buffer', () => {
    const inbox = new SteerInbox()
    inbox.pushSteer('first')
    inbox.pushSteer('second')
    expect(inbox.drainSteers()).toEqual(['first', 'second'])
    expect(inbox.hasPendingSteer).toBe(false)
    expect(inbox.drainSteers()).toEqual([])
  })

  it('ignores empty / whitespace-only text', () => {
    const inbox = new SteerInbox()
    expect(inbox.pushSteer('   ')).toBe(false)
    expect(inbox.pushSteer('')).toBe(false)
    expect(inbox.hasPendingSteer).toBe(false)
  })

  it('trims the buffered text', () => {
    const inbox = new SteerInbox()
    inbox.pushSteer('  hello  ')
    expect(inbox.drainSteers()).toEqual(['hello'])
  })

  it('is idempotent on steerId — a repeat id never double-injects', () => {
    const inbox = new SteerInbox()
    expect(inbox.pushSteer('once', 'id-1')).toBe(true)
    expect(inbox.pushSteer('once', 'id-1')).toBe(false)
    expect(inbox.pendingCount).toBe(1)
    expect(inbox.drainSteers()).toEqual(['once'])
  })

  it('keeps the seen-id ledger after a drain so a late duplicate cannot re-inject', () => {
    const inbox = new SteerInbox()
    inbox.pushSteer('a', 'id-a')
    expect(inbox.drainSteers()).toEqual(['a'])
    // A late re-delivery of the same steerId after it was already drained.
    expect(inbox.pushSteer('a', 'id-a')).toBe(false)
    expect(inbox.hasPendingSteer).toBe(false)
  })

  it('allows distinct ids and id-less steers through', () => {
    const inbox = new SteerInbox()
    expect(inbox.pushSteer('x', 'id-x')).toBe(true)
    expect(inbox.pushSteer('y', 'id-y')).toBe(true)
    expect(inbox.pushSteer('z')).toBe(true) // no id → always accepted
    expect(inbox.pushSteer('z')).toBe(true) // id-less repeats are NOT deduped
    expect(inbox.pendingCount).toBe(4)
  })
})
