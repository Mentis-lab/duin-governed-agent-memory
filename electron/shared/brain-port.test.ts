import { describe, it, expect } from 'vitest'
import { brainPortFrom, DEFAULT_LOCAL_BRAIN_PORT, LOCAL_BRAIN_ORIGIN, LOCAL_BRAIN_PORT } from './brain-port'

describe('brain-port — one declared loopback port', () => {
  it('defaults to 8799 and honours a valid DUIN_BRAIN_PORT', () => {
    expect(brainPortFrom({})).toBe(DEFAULT_LOCAL_BRAIN_PORT)
    expect(brainPortFrom({ DUIN_BRAIN_PORT: '8899' })).toBe(8899)
  })
  it('rejects garbage and out-of-range values', () => {
    for (const bad of ['', 'abc', '0', '-1', '70000', '12.5']) expect(brainPortFrom({ DUIN_BRAIN_PORT: bad })).toBe(DEFAULT_LOCAL_BRAIN_PORT)
  })
  it('origin is derived from the port', () => {
    expect(LOCAL_BRAIN_ORIGIN).toBe(`http://127.0.0.1:${LOCAL_BRAIN_PORT}`)
  })
})
