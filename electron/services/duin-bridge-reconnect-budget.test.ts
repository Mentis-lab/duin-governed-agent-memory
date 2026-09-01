// R8/Phase-2 — reconnect churn budget. A reconnect that receives ZERO new frames and parks on a
// non-advancing run must count against ONE absolute no-progress ceiling, NOT restart a fresh idle
// window each time. These pure helpers drive the decision inside streamFromDuin's reconnect loop.

import { describe, it, expect, afterEach } from 'vitest'
import { bridgeTurnCeilingMs, bridgeReconnectExhausted } from './duin-bridge'

describe('bridgeTurnCeilingMs — env-tunable, 240s default', () => {
  afterEach(() => { delete process.env.DUIN_BRIDGE_TURN_CEILING_MS })

  it('defaults to 240000 (180s server deadline + reconnect grace)', () => {
    expect(bridgeTurnCeilingMs()).toBe(240_000)
  })
  it('honors DUIN_BRIDGE_TURN_CEILING_MS', () => {
    process.env.DUIN_BRIDGE_TURN_CEILING_MS = '90000'
    expect(bridgeTurnCeilingMs()).toBe(90_000)
  })
  it('0 disables the budget', () => {
    process.env.DUIN_BRIDGE_TURN_CEILING_MS = '0'
    expect(bridgeTurnCeilingMs()).toBe(0)
  })
  it('empty string falls back to the default', () => {
    process.env.DUIN_BRIDGE_TURN_CEILING_MS = ''
    expect(bridgeTurnCeilingMs()).toBe(240_000)
  })
})

describe('bridgeReconnectExhausted — one absolute ceiling, not a fresh window per reconnect', () => {
  it('not exhausted while the no-progress gap is within the ceiling', () => {
    expect(bridgeReconnectExhausted(30_000, 240_000)).toBe(false)
    expect(bridgeReconnectExhausted(240_000, 240_000)).toBe(false) // exactly at the ceiling, not past
  })

  it('exhausted once the gap since the last committed frame exceeds the ceiling', () => {
    expect(bridgeReconnectExhausted(240_001, 240_000)).toBe(true)
    expect(bridgeReconnectExhausted(600_000, 240_000)).toBe(true)
  })

  it('a parked run cannot churn N reconnects × idle window: the gap accumulates against ONE ceiling', () => {
    // Simulate three stalled reconnects, each ~60s apart, with NO new frames between them.
    // The gap since last progress keeps growing (it is NOT reset per reconnect), so by the third
    // reconnect the single ceiling is blown — churn stops instead of running 4×60s.
    const ceiling = 120_000
    expect(bridgeReconnectExhausted(60_000, ceiling)).toBe(false) // 1st stalled reconnect: keep trying
    expect(bridgeReconnectExhausted(121_000, ceiling)).toBe(true) // 2nd+: absolute ceiling blown → stop
  })

  it('ceiling <= 0 disables the budget (unbounded, pre-fix behaviour)', () => {
    expect(bridgeReconnectExhausted(10_000_000, 0)).toBe(false)
    expect(bridgeReconnectExhausted(10_000_000, -1)).toBe(false)
  })
})
