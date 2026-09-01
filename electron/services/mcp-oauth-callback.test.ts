import { describe, it, expect } from 'vitest'
import { createOAuthSession } from './oauth-state'
import { decideMcpCallback } from './mcp-oauth-callback'

const STATE = 'mcp-state-value-0123456789ab' // 28 chars — length-checked, fixed for determinism

function cb(params: Record<string, string>): URL {
  const url = new URL('http://127.0.0.1:9877/oauth/callback')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url
}

describe('decideMcpCallback', () => {
  it('resolves with the code when state matches', () => {
    const session = createOAuthSession(() => STATE)
    expect(decideMcpCallback(cb({ code: 'legit', state: STATE }), session)).toEqual({
      kind: 'resolve',
      code: 'legit'
    })
  })

  // The core defect: pre-fix the loopback handler resolved `pending` with any
  // ?code and finishAuth persisted the attacker's tokens. A forged callback
  // that doesn't know the 192-bit state must be dropped, NOT accepted.
  it('drops a forged code with no state (cross-origin GET injection)', () => {
    const session = createOAuthSession(() => STATE)
    expect(decideMcpCallback(cb({ code: 'attacker' }), session)).toEqual({ kind: 'drop' })
  })

  it('drops a forged code carrying a wrong state', () => {
    const session = createOAuthSession(() => STATE)
    const wrong = 'x'.repeat(STATE.length)
    expect(decideMcpCallback(cb({ code: 'attacker', state: wrong }), session)).toEqual({
      kind: 'drop'
    })
  })

  // A wrong-state probe must be inert (drop), so it can neither settle the
  // promise nor lock out the real callback that follows.
  it('a forged probe does not consume the session or block the real callback', () => {
    const session = createOAuthSession(() => STATE)
    expect(decideMcpCallback(cb({ code: 'attacker' }), session)).toEqual({ kind: 'drop' })
    expect(decideMcpCallback(cb({ code: 'real', state: STATE }), session)).toEqual({
      kind: 'resolve',
      code: 'real'
    })
  })

  it('rejects a provider denial that carries the matching state', () => {
    const session = createOAuthSession(() => STATE)
    expect(decideMcpCallback(cb({ error: 'access_denied', state: STATE }), session)).toEqual({
      kind: 'reject',
      reason: 'access_denied'
    })
  })

  // A forged ?error with no valid state must NOT reject — that would let any
  // page abort the user's real consent flow (DoS). It drops instead.
  it('drops a forged error with no state (no attacker-triggered DoS)', () => {
    const session = createOAuthSession(() => STATE)
    expect(decideMcpCallback(cb({ error: 'access_denied' }), session)).toEqual({ kind: 'drop' })
  })

  it('state is single-use: a replay of the same state after success drops', () => {
    const session = createOAuthSession(() => STATE)
    expect(decideMcpCallback(cb({ code: 'legit', state: STATE }), session).kind).toBe('resolve')
    expect(decideMcpCallback(cb({ code: 'replay', state: STATE }), session)).toEqual({
      kind: 'drop'
    })
  })

  it('drops any callback when no auth is in flight (null session)', () => {
    expect(decideMcpCallback(cb({ code: 'x', state: STATE }), null)).toEqual({ kind: 'drop' })
  })

  it('rejects a state-verified callback that carries neither code nor error', () => {
    const session = createOAuthSession(() => STATE)
    expect(decideMcpCallback(cb({ state: STATE }), session)).toEqual({
      kind: 'reject',
      reason: 'authorization response missing code'
    })
  })
})
