import { describe, it, expect } from 'vitest'
import { commitNumber } from './number-commit'

// The number field this kit replaces clamped on every keystroke, so a floor of 200 turned
// the "1" of "1000" into 200 before the next digit arrived and clearing a field wrote the
// default. commitNumber runs once, at commit, and these pin what "at commit" means.

describe('commitNumber — the draft is free until commit', () => {
  it('reverts an empty or unparsable draft to the current value', () => {
    expect(commitNumber('', 800, { min: 200 })).toBe(800)
    expect(commitNumber('   ', 800, { min: 200 })).toBe(800)
    expect(commitNumber('abc', 800, { min: 200 })).toBe(800)
  })

  it('clamps once to the floor and ceiling', () => {
    expect(commitNumber('1', 800, { min: 200, max: 2000 })).toBe(200)
    expect(commitNumber('99999', 800, { min: 200, max: 2000 })).toBe(2000)
    expect(commitNumber('1000', 800, { min: 200, max: 2000 })).toBe(1000)
  })

  it('rounds to a whole number unless told otherwise', () => {
    expect(commitNumber('12.6', 0)).toBe(13)
    expect(commitNumber('12.6', 0, { integer: false })).toBe(12.6)
  })

  it('keeps 0 as "off" below the floor when zeroMeansOff is set, and clamps it otherwise', () => {
    expect(commitNumber('0', 60, { min: 5, zeroMeansOff: true })).toBe(0)
    expect(commitNumber('0', 60, { min: 5 })).toBe(5)
  })
})
