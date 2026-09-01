import { describe, it, expect } from 'vitest'
import {
  hashState,
  trackProgress,
  detectRepeat,
  shouldEscalate,
  type StateActionHash
} from './progress-watchdog'

// L4 — forward-progress watchdog. Pure; runs everywhere.

describe('hashState', () => {
  it('is stable regardless of object key order', () => {
    expect(hashState({ a: 1, b: 2 })).toBe(hashState({ b: 2, a: 1 }))
  })

  it('is stable for nested structures', () => {
    expect(hashState({ x: { p: 1, q: [1, 2] } })).toBe(hashState({ x: { q: [1, 2], p: 1 } }))
  })

  it('changes when state changes (advance is detectable)', () => {
    expect(hashState({ files: ['a'] })).not.toBe(hashState({ files: ['a', 'b'] }))
  })

  it('array order is significant', () => {
    expect(hashState([1, 2])).not.toBe(hashState([2, 1]))
  })

  it('returns a 64-char hex sha256', () => {
    expect(hashState('anything')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('handles null/undefined without throwing', () => {
    expect(() => hashState(null)).not.toThrow()
    expect(() => hashState(undefined)).not.toThrow()
    expect(hashState(null)).not.toBe(hashState(undefined))
  })
})

describe('trackProgress', () => {
  it('advance resets the stall count to 0', () => {
    expect(trackProgress('h1', 'h2', 5)).toEqual({ advanced: true, stallCount: 0 })
  })

  it('no-progress increments the stall count (the silent stall this kills)', () => {
    expect(trackProgress('h1', 'h1', 2)).toEqual({ advanced: false, stallCount: 3 })
  })

  it('first iteration (null prev) counts as progress', () => {
    expect(trackProgress(null, 'h1', 0)).toEqual({ advanced: true, stallCount: 0 })
  })
})

describe('detectRepeat', () => {
  it('true when a (state,action) pair recurs within the window', () => {
    const h: StateActionHash[] = [
      { state: 's1', action: 'a1' },
      { state: 's2', action: 'a2' },
      { state: 's1', action: 'a1' }
    ]
    expect(detectRepeat(h)).toBe(true)
  })

  it('false when every pair in the window is distinct', () => {
    const h: StateActionHash[] = [
      { state: 's1', action: 'a1' },
      { state: 's2', action: 'a2' },
      { state: 's3', action: 'a3' }
    ]
    expect(detectRepeat(h)).toBe(false)
  })

  it('only inspects the trailing window (default 4)', () => {
    const h: StateActionHash[] = [
      { state: 's1', action: 'a1' }, // outside a window of 4 once 4 newer entries exist
      { state: 's2', action: 'a2' },
      { state: 's3', action: 'a3' },
      { state: 's4', action: 'a4' },
      { state: 's1', action: 'a1' }
    ]
    // window 4 -> [s2,s3,s4,s1] all distinct
    expect(detectRepeat(h, 4)).toBe(false)
    // window 5 -> the s1/a1 repeat is now visible
    expect(detectRepeat(h, 5)).toBe(true)
  })

  it('distinguishes same state / different action (oscillation, not repeat)', () => {
    const h: StateActionHash[] = [
      { state: 's1', action: 'a1' },
      { state: 's1', action: 'a2' }
    ]
    expect(detectRepeat(h)).toBe(false)
  })

  it('edge: empty history is not a repeat', () => {
    expect(detectRepeat([])).toBe(false)
  })
})

describe('shouldEscalate', () => {
  it('escalates at the boundary K', () => {
    expect(shouldEscalate(3, 3)).toBe(true)
    expect(shouldEscalate(4, 3)).toBe(true)
  })

  it('does not escalate below K', () => {
    expect(shouldEscalate(2, 3)).toBe(false)
  })

  it('k <= 0 disables the guard', () => {
    expect(shouldEscalate(100, 0)).toBe(false)
    expect(shouldEscalate(100, -1)).toBe(false)
  })
})
