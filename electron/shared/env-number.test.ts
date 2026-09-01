import { describe, it, expect, afterEach } from 'vitest'
import { envNumber, envNum } from './env-number'

// The distinction this module exists for: "unset" and "explicitly zero" are DIFFERENT states, and
// `Number(env) || FALLBACK` cannot express both. Measured in this repo: construct.ts documents
// "0 disables the sleep — used by tests", the suite sets the var to '0', and the old idiom handed
// back 500 on every run. The contract was false and nothing failed.

describe('envNumber — zero is a value, not an absence', () => {
  it('returns an explicit 0 rather than the fallback', () => {
    expect(envNumber('0', 500)).toBe(0)
    expect(envNumber(' 0 ', 500)).toBe(0)
  })

  it('falls back only when there is genuinely no answer', () => {
    expect(envNumber(undefined, 500)).toBe(500)
    expect(envNumber('', 500)).toBe(500)
    expect(envNumber('   ', 500)).toBe(500)
    expect(envNumber('abc', 500)).toBe(500)
    expect(envNumber('NaN', 500)).toBe(500)
    expect(envNumber('Infinity', 500)).toBe(500)
  })

  it('reads ordinary values', () => {
    expect(envNumber('42', 1)).toBe(42)
    expect(envNumber('-3', 1)).toBe(-3)
    expect(envNumber('2.5', 1)).toBe(2.5)
  })

  // Falling back rather than clamping is deliberate: clamping is itself a collapse, because the
  // caller cannot tell "you asked for the floor" from "you asked for nonsense and got the floor".
  it('falls back — does not clamp — when out of range', () => {
    expect(envNumber('-5', 3, { min: 0 })).toBe(3)
    expect(envNumber('999', 3, { max: 10 })).toBe(3)
    expect(envNumber('0', 3, { min: 0 })).toBe(0) // 0 is IN range here, so it wins
  })

  it('honours the integer requirement', () => {
    expect(envNumber('2.5', 3, { integer: true })).toBe(3)
    expect(envNumber('2', 3, { integer: true })).toBe(2)
  })

  describe('envNum reads process.env', () => {
    const KEY = 'DUIN_TEST_ENV_NUMBER'
    afterEach(() => delete process.env[KEY])

    it('distinguishes unset from zero', () => {
      expect(envNum(KEY, 7)).toBe(7)
      process.env[KEY] = '0'
      expect(envNum(KEY, 7)).toBe(0)
    })
  })
})
