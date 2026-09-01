import { describe, expect, it } from 'vitest'
import { RunState } from './agui-run'

// The steer inbox is composed onto every RunState; these lock the delegation the steer beacon
// (server.ts) and the round-loop drain rely on.
describe('RunState — steer inbox delegation', () => {
  it('buffers and drains steer text', () => {
    const rs = new RunState('run-1')
    expect(rs.hasPendingSteer).toBe(false)
    expect(rs.pushSteer('focus on auth')).toBe(true)
    expect(rs.hasPendingSteer).toBe(true)
    expect(rs.drainSteers()).toEqual(['focus on auth'])
    expect(rs.hasPendingSteer).toBe(false)
  })

  it('is idempotent on steerId across the RunState boundary', () => {
    const rs = new RunState('run-2')
    expect(rs.pushSteer('once', 'sid-1')).toBe(true)
    expect(rs.pushSteer('once', 'sid-1')).toBe(false)
    expect(rs.drainSteers()).toEqual(['once'])
  })
})
