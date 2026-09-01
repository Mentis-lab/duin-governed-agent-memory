import { describe, it, expect, vi } from 'vitest'
import {
  classifyError,
  withRetry,
  CircuitBreaker,
  nextProviderInChain,
  type RetryOptions
} from './resilience'

// L6 dependency resilience — pure/seam-injected. jitterFn + sleepFn are injected
// so retry sequencing is deterministic (no Math.random, no real timers).

describe('classifyError', () => {
  it('classifies rate-limit and 5xx as transient', () => {
    expect(classifyError({ status: 429 })).toBe('transient')
    expect(classifyError({ status: 500 })).toBe('transient')
    expect(classifyError({ status: 503 })).toBe('transient')
    expect(classifyError({ statusCode: 502 })).toBe('transient')
  })

  it('classifies network codes/messages as transient', () => {
    expect(classifyError({ code: 'ECONNRESET' })).toBe('transient')
    expect(classifyError({ code: 'ETIMEDOUT' })).toBe('transient')
    expect(classifyError(new Error('socket hang up'))).toBe('transient')
    expect(classifyError('request timeout after 30s')).toBe('transient')
  })

  it('classifies 4xx client errors as permanent', () => {
    expect(classifyError({ status: 400 })).toBe('permanent')
    expect(classifyError({ status: 401 })).toBe('permanent')
    expect(classifyError({ status: 403 })).toBe('permanent')
    expect(classifyError({ status: 404 })).toBe('permanent')
  })

  it('classifies quota exhaustion as permanent — even with a 429 status', () => {
    expect(classifyError({ code: 'insufficient_quota' })).toBe('permanent')
    expect(classifyError(new Error('quota-exhausted for this key'))).toBe('permanent')
    // OpenAI ships insufficient_quota as a 429 — quota marker must win over 429->transient.
    expect(classifyError({ status: 429, code: 'insufficient_quota' })).toBe('permanent')
  })

  it('treats unknown/empty errors as transient (retry once is cheaper)', () => {
    expect(classifyError(null)).toBe('transient')
    expect(classifyError(undefined)).toBe('transient')
    expect(classifyError({})).toBe('transient')
    expect(classifyError(new Error('some unrecognized failure'))).toBe('transient')
    expect(classifyError({ status: 418 })).toBe('transient') // teapot: unknown -> transient
  })
})

describe('withRetry', () => {
  // Records the sleep durations so we can assert the backoff sequence.
  function tracked(overrides: Partial<RetryOptions> = {}): {
    opts: RetryOptions
    sleeps: number[]
  } {
    const sleeps: number[] = []
    const opts: RetryOptions = {
      retries: 3,
      baseMs: 100,
      // identity jitter so the backoff math is asserted directly
      jitterFn: (_attempt, backoff) => backoff,
      sleepFn: async (ms) => {
        sleeps.push(ms)
      },
      ...overrides
    }
    return { opts, sleeps }
  }

  it('returns on first success without sleeping (happy path)', async () => {
    const { opts, sleeps } = tracked()
    const fn = vi.fn(async () => 'ok')
    await expect(withRetry(fn, opts)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleeps).toEqual([])
  })

  it('retries transient failures then succeeds — exponential backoff base*2^attempt', async () => {
    const { opts, sleeps } = tracked()
    let calls = 0
    const fn = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw { status: 503 }
      return 'recovered'
    })
    await expect(withRetry(fn, opts)).resolves.toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(3)
    // attempt 0 -> 100, attempt 1 -> 200
    expect(sleeps).toEqual([100, 200])
  })

  it('rethrows a permanent error immediately without retrying (the failure the invariant kills)', async () => {
    const { opts, sleeps } = tracked()
    const fn = vi.fn(async () => {
      throw { status: 401 }
    })
    await expect(withRetry(fn, opts)).rejects.toEqual({ status: 401 })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleeps).toEqual([])
  })

  it('rethrows after exhausting retries (boundary: retries+1 total attempts)', async () => {
    const { opts, sleeps } = tracked({ retries: 2 })
    const fn = vi.fn(async () => {
      throw { status: 500 }
    })
    await expect(withRetry(fn, opts)).rejects.toEqual({ status: 500 })
    expect(fn).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
    expect(sleeps).toEqual([100, 200]) // slept before each retry, not after the last failure
  })

  it('caps backoff at maxMs before applying jitter', async () => {
    const { opts, sleeps } = tracked({ retries: 4, baseMs: 100, maxMs: 250 })
    let calls = 0
    const fn = vi.fn(async () => {
      calls += 1
      if (calls < 4) throw { status: 500 }
      return 'ok'
    })
    await expect(withRetry(fn, opts)).resolves.toBe('ok')
    // 100, 200, min(400,250)=250
    expect(sleeps).toEqual([100, 200, 250])
  })

  it('passes (attempt, cappedBackoff) to the injected jitterFn', async () => {
    const jitterFn = vi.fn((_attempt: number, backoff: number) => backoff + 7)
    const { opts, sleeps } = tracked({ retries: 2, jitterFn })
    let calls = 0
    const fn = async () => {
      calls += 1
      if (calls < 2) throw { status: 500 }
      return 'ok'
    }
    await withRetry(fn, opts)
    expect(jitterFn).toHaveBeenCalledWith(0, 100)
    expect(sleeps).toEqual([107])
  })

  it('honours a custom isTransient predicate over classifyError', async () => {
    const { opts } = tracked({ retries: 3, isTransient: () => false })
    const fn = vi.fn(async () => {
      throw { status: 500 } // normally transient
    })
    await expect(withRetry(fn, opts)).rejects.toEqual({ status: 500 })
    expect(fn).toHaveBeenCalledTimes(1) // predicate said permanent -> no retry
  })

  it('with retries:0 makes exactly one attempt', async () => {
    const { opts, sleeps } = tracked({ retries: 0 })
    const fn = vi.fn(async () => {
      throw { status: 500 }
    })
    await expect(withRetry(fn, opts)).rejects.toBeTruthy()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleeps).toEqual([])
  })
})

describe('CircuitBreaker', () => {
  function makeClock(start = 0): { now: () => number; set: (t: number) => void } {
    let t = start
    return { now: () => t, set: (v) => (t = v) }
  }

  it('starts closed and allows requests', () => {
    const clock = makeClock()
    const b = new CircuitBreaker({ key: 'p', failureThreshold: 3, cooldownMs: 1000, clock: clock.now })
    expect(b.state()).toBe('closed')
    expect(b.canRequest()).toBe(true)
  })

  it('trips open after N consecutive failures (the failure the breaker kills)', () => {
    const clock = makeClock()
    const b = new CircuitBreaker({ key: 'p', failureThreshold: 3, cooldownMs: 1000, clock: clock.now })
    b.onFailure()
    b.onFailure()
    expect(b.state()).toBe('closed') // still under threshold
    expect(b.canRequest()).toBe(true)
    b.onFailure() // third failure trips it
    expect(b.state()).toBe('open')
    expect(b.canRequest()).toBe(false)
  })

  it('a success resets the consecutive-failure count', () => {
    const clock = makeClock()
    const b = new CircuitBreaker({ key: 'p', failureThreshold: 3, cooldownMs: 1000, clock: clock.now })
    b.onFailure()
    b.onFailure()
    b.onSuccess() // reset
    b.onFailure()
    b.onFailure()
    expect(b.state()).toBe('closed') // only 2 since reset
  })

  it('open -> half-open after cooldown (boundary: exactly cooldownMs)', () => {
    const clock = makeClock(1000)
    const b = new CircuitBreaker({ key: 'p', failureThreshold: 1, cooldownMs: 500, clock: clock.now })
    b.onFailure() // opened at t=1000
    expect(b.state()).toBe('open')
    clock.set(1499)
    expect(b.state()).toBe('open') // 499ms < cooldown
    clock.set(1500)
    expect(b.state()).toBe('half-open') // exactly cooldownMs elapsed
    expect(b.canRequest()).toBe(true) // half-open lets one trial through
  })

  it('half-open success closes the breaker', () => {
    const clock = makeClock(0)
    const b = new CircuitBreaker({ key: 'p', failureThreshold: 1, cooldownMs: 100, clock: clock.now })
    b.onFailure() // open at 0
    clock.set(100)
    expect(b.state()).toBe('half-open')
    b.onSuccess()
    expect(b.state(200)).toBe('closed')
    expect(b.canRequest(200)).toBe(true)
  })

  it('half-open failure re-opens the breaker for another cooldown', () => {
    const clock = makeClock(0)
    const b = new CircuitBreaker({ key: 'p', failureThreshold: 1, cooldownMs: 100, clock: clock.now })
    b.onFailure() // open at 0
    clock.set(100)
    expect(b.state()).toBe('half-open')
    b.onFailure(100) // trial failed -> re-open at 100
    expect(b.state(100)).toBe('open')
    expect(b.state(199)).toBe('open')
    expect(b.state(200)).toBe('half-open') // cooldown from the re-open, not the original
  })

  it('a non-positive threshold disables tripping (0 disables)', () => {
    const clock = makeClock()
    const b = new CircuitBreaker({ key: 'p', failureThreshold: 0, cooldownMs: 1000, clock: clock.now })
    for (let i = 0; i < 10; i++) b.onFailure()
    expect(b.state()).toBe('closed')
    expect(b.canRequest()).toBe(true)
  })

  it('defaults clock to Date.now when none injected', () => {
    const b = new CircuitBreaker({ key: 'p', failureThreshold: 1, cooldownMs: 10_000 })
    b.onFailure()
    expect(b.canRequest()).toBe(false) // just opened, within cooldown
  })
})

describe('nextProviderInChain', () => {
  it('returns the first untried provider', () => {
    expect(nextProviderInChain(['a', 'b', 'c'], [])).toBe('a')
    expect(nextProviderInChain(['a', 'b', 'c'], ['a'])).toBe('b')
    expect(nextProviderInChain(['a', 'b', 'c'], ['a', 'b'])).toBe('c')
  })

  it('returns null when the chain is exhausted (escalate)', () => {
    expect(nextProviderInChain(['a', 'b'], ['a', 'b'])).toBeNull()
    expect(nextProviderInChain([], [])).toBeNull()
    expect(nextProviderInChain([], ['a'])).toBeNull()
  })

  it('skips tried entries regardless of order', () => {
    expect(nextProviderInChain(['a', 'b', 'c'], ['b'])).toBe('a')
    expect(nextProviderInChain(['a', 'b', 'c'], ['a', 'c'])).toBe('b')
  })
})
