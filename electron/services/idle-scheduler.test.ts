import { describe, it, expect } from 'vitest'
import { runWhenIdle } from './idle-scheduler'
import { resetStallsForTest } from './main-stall-monitor'

// Deterministic harness: injected clock, idle source, and scheduler. The
// scheduler queue is drained by hand so each case controls exactly how much
// waiting happens.
function harness(idleSeq: number[], startIdle: number) {
  let t = 0
  let idle = startIdle
  const queue: Array<{ fn: () => void; due: number }> = []
  const seq = [...idleSeq]
  return {
    now: () => t,
    getIdleMs: () => {
      if (seq.length > 0) idle = seq.shift() as number
      return idle
    },
    schedule: (fn: () => void, ms: number) => {
      queue.push({ fn, due: t + ms })
    },
    /** Advance the clock and run everything that came due, in order. */
    advance(ms: number) {
      const target = t + ms
      for (;;) {
        const next = queue.filter((q) => q.due <= target).sort((a, b) => a.due - b.due)[0]
        if (!next) break
        queue.splice(queue.indexOf(next), 1)
        t = next.due
        next.fn()
      }
      t = target
    },
    pending: () => queue.length
  }
}

describe('runWhenIdle', () => {
  it('runs on the first tick when the operator is already idle — never on the caller stack', () => {
    resetStallsForTest()
    const h = harness([], 60_000)
    let ran = 0
    runWhenIdle('t1', () => (ran += 1), {
      idleMs: 30_000,
      maxDelayMs: 600_000,
      pollMs: 1000,
      getIdleMs: h.getIdleMs,
      schedule: h.schedule,
      now: h.now
    })
    // Deferred by contract: SwrJsonCache's "a rebuild never runs inside the
    // request" invariant rides on this call NOT running fn synchronously.
    expect(ran).toBe(0)
    h.advance(0)
    expect(ran).toBe(1)
    expect(h.pending()).toBe(0)
  })

  it('defers while the operator is active, then runs on the first idle poll', () => {
    resetStallsForTest()
    // active (0ms idle) for two polls, then idle.
    const h = harness([0, 0, 45_000], 0)
    let ran = 0
    runWhenIdle('t2', () => (ran += 1), {
      idleMs: 30_000,
      maxDelayMs: 600_000,
      pollMs: 1000,
      getIdleMs: h.getIdleMs,
      schedule: h.schedule,
      now: h.now
    })
    expect(ran).toBe(0)
    h.advance(1000)
    expect(ran).toBe(0)
    h.advance(1000)
    expect(ran).toBe(1)
  })

  it('runs anyway once maxDelayMs is exceeded, even under constant activity', () => {
    resetStallsForTest()
    const h = harness([], 0) // never idle
    let ran = 0
    runWhenIdle('t3', () => (ran += 1), {
      idleMs: 30_000,
      maxDelayMs: 5000,
      pollMs: 1000,
      getIdleMs: h.getIdleMs,
      schedule: h.schedule,
      now: h.now
    })
    expect(ran).toBe(0)
    h.advance(4000)
    expect(ran).toBe(0)
    h.advance(2000) // waited >= maxDelayMs on this poll
    expect(ran).toBe(1)
    expect(h.pending()).toBe(0)
  })

  it('a throwing task is contained and never reschedules itself', () => {
    resetStallsForTest()
    const h = harness([], 60_000)
    runWhenIdle(
      't4',
      () => {
        throw new Error('boom')
      },
      {
        idleMs: 1000,
        maxDelayMs: 60_000,
        pollMs: 1000,
        getIdleMs: h.getIdleMs,
        schedule: h.schedule,
        now: h.now
      }
    )
    expect(() => h.advance(0)).not.toThrow()
    expect(h.pending()).toBe(0)
  })

  it('an unreadable idle source degrades to running, not starving', () => {
    resetStallsForTest()
    const h = harness([], 0)
    let ran = 0
    runWhenIdle('t5', () => (ran += 1), {
      idleMs: 30_000,
      maxDelayMs: 600_000,
      pollMs: 1000,
      getIdleMs: () => {
        throw new Error('no powerMonitor')
      },
      schedule: h.schedule,
      now: h.now
    })
    h.advance(0)
    expect(ran).toBe(1)
    expect(h.pending()).toBe(0)
  })
})
