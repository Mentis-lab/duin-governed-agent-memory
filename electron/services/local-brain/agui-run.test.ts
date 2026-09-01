import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  RunState, SESSIONS, MAX_SESSIONS, createRun, getRun, dropRun, turnResumeEnabled
} from './agui-run'

describe('agui-run — RunState frame ring', () => {
  it('assigns monotonic ids from 1 and tracks lastId', () => {
    const rs = new RunState('r1')
    expect(rs.lastId).toBe(0)
    expect(rs.emit('a').id).toBe(1)
    expect(rs.emit('b').id).toBe(2)
    expect(rs.emit('c').id).toBe(3)
    expect(rs.lastId).toBe(3)
    expect(rs.size).toBe(3)
  })

  it('replayAfter returns exactly the frames a reconnecting client missed', () => {
    const rs = new RunState('r2')
    ;['a', 'b', 'c', 'd'].forEach((d) => rs.emit(d))
    expect(rs.replayAfter(0).map((f) => f.data)).toEqual(['a', 'b', 'c', 'd']) // saw nothing
    expect(rs.replayAfter(2).map((f) => f.data)).toEqual(['c', 'd']) // saw up to id 2
    expect(rs.replayAfter(4)).toEqual([]) // fully caught up
    expect(rs.replayAfter(99)).toEqual([]) // beyond the head
  })

  it('NEVER evicts an undelivered frame, even past the cap', () => {
    const rs = new RunState('r3', { maxFrames: 3 })
    for (let i = 0; i < 6; i++) rs.emit(`f${i}`)
    // nothing delivered yet → all 6 retained despite maxFrames=3 (correctness over the bound)
    expect(rs.size).toBe(6)
    expect(rs.replayAfter(0).length).toBe(6)
  })

  it('evicts the oldest DELIVERED frames once over the frame cap', () => {
    const rs = new RunState('r4', { maxFrames: 3 })
    for (let i = 1; i <= 6; i++) rs.emit(`f${i}`) // ids 1..6, none delivered → size 6
    rs.markDelivered(6) // client caught up fully
    expect(rs.size).toBe(3) // evicted down to the cap (kept ids 4,5,6)
    expect(rs.replayAfter(0).map((f) => f.id)).toEqual([4, 5, 6])
  })

  it('evicts on the BYTE cap too, delivered-only', () => {
    const rs = new RunState('r5', { maxBytes: 10 })
    rs.emit('12345') // 5 bytes, id1
    rs.emit('67890') // 5 bytes, id2  → 10 bytes, at cap
    rs.emit('abcde') // 5 bytes, id3  → 15 > 10, but nothing delivered → retained
    expect(rs.size).toBe(3)
    rs.markDelivered(3)
    expect(rs.byteSize).toBeLessThanOrEqual(10) // now over-byte delivered frames dropped
    expect(rs.size).toBeLessThan(3)
  })

  it('markDelivered is monotonic — a lower id never rewinds delivery', () => {
    const rs = new RunState('r6', { maxFrames: 2 })
    for (let i = 1; i <= 4; i++) rs.emit(`f${i}`)
    rs.markDelivered(4)
    expect(rs.size).toBe(2) // ids 3,4
    rs.markDelivered(1) // stale ack — must not un-evict or change state
    expect(rs.size).toBe(2)
    expect(rs.replayAfter(0).map((f) => f.id)).toEqual([3, 4])
  })

  it('single-subscriber: a new attach supersedes the prior; detach is owner-scoped', () => {
    const rs = new RunState('r7')
    const a = rs.attach()
    expect(rs.isCurrent(a)).toBe(true)
    const b = rs.attach() // reconnect
    expect(rs.isCurrent(a)).toBe(false) // stale writer displaced
    expect(rs.isCurrent(b)).toBe(true)
    rs.detach(a) // stale token detach is a no-op
    expect(rs.isCurrent(b)).toBe(true)
    expect(rs.hasSubscriber).toBe(true)
    rs.detach(b)
    expect(rs.hasSubscriber).toBe(false)
  })

  it('write() targets the current subscriber and a reconnect redirects it', () => {
    const rs = new RunState('rw')
    const a: string[] = [], b: string[] = []
    const ta = rs.attach((s) => { a.push(s); return true })
    rs.write('one')
    expect(a).toEqual(['one'])
    const tb = rs.attach((s) => { b.push(s); return true }) // reconnect → new writer
    rs.write('two')
    expect(a).toEqual(['one']) // old writer no longer receives
    expect(b).toEqual(['two']) // redirected to the reconnected subscriber
    rs.detach(ta) // stale token detach is a no-op on the live writer
    expect(rs.write('three')).toBe(true)
    expect(b).toEqual(['two', 'three'])
    rs.detach(tb)
    expect(rs.write('four')).toBe(false) // nobody attached → buffered-only
  })

  it('done marks the run terminal', () => {
    const rs = new RunState('r8')
    expect(rs.isTerminal).toBe(false)
    rs.done()
    expect(rs.isTerminal).toBe(true)
  })

  it('abort() invokes the registered abort fn (Stop beacon); no-op when unset', () => {
    const rs = new RunState('r9')
    expect(() => rs.abort()).not.toThrow() // unset → safe no-op
    let aborted = 0
    rs.setAbort(() => { aborted++ })
    rs.abort()
    expect(aborted).toBe(1)
    rs.abort() // idempotent-safe (fn may be called again; server's turnAbort.abort is idempotent)
    expect(aborted).toBe(2)
  })

  it('whenDone resolves on done()', async () => {
    const rs = new RunState('r10')
    let resolved = false
    const p = rs.whenDone().then(() => { resolved = true })
    expect(resolved).toBe(false)
    rs.done()
    await p
    expect(resolved).toBe(true)
    await rs.whenDone() // already terminal → resolves immediately
  })
})

describe('agui-run — SESSIONS registry', () => {
  beforeEach(() => SESSIONS.clear())
  afterEach(() => SESSIONS.clear())

  it('createRun registers and getRun retrieves; dropRun removes', () => {
    const rs = createRun('run-a')
    expect(getRun('run-a')).toBe(rs)
    dropRun('run-a')
    expect(getRun('run-a')).toBeUndefined()
  })

  it('bounds the registry at MAX_SESSIONS, evicting terminal runs first', () => {
    // fill exactly to the ceiling, marking the earliest ones terminal
    for (let i = 0; i < MAX_SESSIONS; i++) {
      const rs = createRun(`run-${i}`)
      if (i < 3) rs.done() // first three are terminal
    }
    expect(SESSIONS.size).toBe(MAX_SESSIONS)
    createRun('overflow') // one past the ceiling → a terminal run is evicted first
    expect(SESSIONS.size).toBe(MAX_SESSIONS)
    expect(getRun('overflow')).toBeDefined()
    expect(getRun('run-0')).toBeUndefined() // oldest terminal evicted
    expect(getRun('run-3')).toBeDefined() // a non-terminal run survived
  })

  it('falls back to oldest-first eviction when no terminal runs exist', () => {
    for (let i = 0; i < MAX_SESSIONS; i++) createRun(`live-${i}`) // all non-terminal
    createRun('newest')
    expect(SESSIONS.size).toBe(MAX_SESSIONS)
    expect(getRun('live-0')).toBeUndefined() // oldest dropped
    expect(getRun('newest')).toBeDefined()
  })
})

describe('agui-run — flag gate', () => {
  const ENV = 'DUIN_TURN_RESUME'
  afterEach(() => delete process.env[ENV])
  it('turnResumeEnabled reflects the flag (default ON; only "0" disables)', () => {
    delete process.env[ENV]
    expect(turnResumeEnabled()).toBe(true)
    process.env[ENV] = '1'
    expect(turnResumeEnabled()).toBe(true)
    process.env[ENV] = '0'
    expect(turnResumeEnabled()).toBe(false)
  })
})
