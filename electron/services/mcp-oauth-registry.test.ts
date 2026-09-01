import { describe, it, expect, vi } from 'vitest'
import { beginOAuthSession, registerPending, routeOAuthCallback } from './mcp-oauth-registry'

function cb(params: Record<string, string>): URL {
  const url = new URL('http://127.0.0.1:9877/oauth/callback')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url
}

describe('mcp-oauth-registry: per-server keying (regression for the shared-slot race)', () => {
  // The core defect: mcp-oauth.ts used to hold ONE module-level `pending` / `activeSession`
  // slot shared by every McpOAuthProvider. Two OAuth-authed servers connecting concurrently
  // (mcp-manager.ts's initialize() fires connectServer() for every enabled server without
  // awaiting each) meant server B's state()/waitForCode() silently reassigned the slot out from
  // under server A's still-pending flow. This test exercises exactly that interleaving through
  // the real public API (beginOAuthSession/registerPending/routeOAuthCallback) and proves each
  // server's callback resolves only its own promise.
  it('two concurrent servers do not cross-wire: each callback resolves only its own pending promise', () => {
    const resolveA = vi.fn()
    const rejectA = vi.fn()
    const resolveB = vi.fn()
    const rejectB = vi.fn()

    // Interleaved exactly like two unawaited connectServer() calls would produce: A starts,
    // then B starts before A's callback has arrived.
    const sessionA = beginOAuthSession('server-a')
    registerPending('server-a', resolveA, rejectA)
    const sessionB = beginOAuthSession('server-b')
    registerPending('server-b', resolveB, rejectB)

    // A's browser tab completes first.
    const decisionA = routeOAuthCallback(cb({ code: 'code-a', state: sessionA.state }))

    expect(decisionA).toEqual({ kind: 'resolve', code: 'code-a' })
    expect(resolveA).toHaveBeenCalledWith('code-a')
    expect(rejectA).not.toHaveBeenCalled()
    // The old shared-slot bug would have left B's `pending` nulled out (or resolved with A's
    // code) as a side effect of settling A. Neither may happen.
    expect(resolveB).not.toHaveBeenCalled()
    expect(rejectB).not.toHaveBeenCalled()

    // B's browser tab completes afterward — must still resolve normally.
    const decisionB = routeOAuthCallback(cb({ code: 'code-b', state: sessionB.state }))
    expect(decisionB).toEqual({ kind: 'resolve', code: 'code-b' })
    expect(resolveB).toHaveBeenCalledWith('code-b')
    expect(rejectB).not.toHaveBeenCalled()
    // Settling B must not retroactively touch A's already-settled promise.
    expect(resolveA).toHaveBeenCalledTimes(1)
    expect(rejectA).not.toHaveBeenCalled()
  })

  it('a forged/mismatched-state callback drops without touching either in-flight server', () => {
    const resolveA = vi.fn()
    const rejectA = vi.fn()
    const resolveB = vi.fn()
    const rejectB = vi.fn()

    beginOAuthSession('server-c')
    registerPending('server-c', resolveA, rejectA)
    beginOAuthSession('server-d')
    registerPending('server-d', resolveB, rejectB)

    const decision = routeOAuthCallback(cb({ code: 'attacker', state: 'x'.repeat(32) }))

    expect(decision).toEqual({ kind: 'drop' })
    expect(resolveA).not.toHaveBeenCalled()
    expect(rejectA).not.toHaveBeenCalled()
    expect(resolveB).not.toHaveBeenCalled()
    expect(rejectB).not.toHaveBeenCalled()
  })

  it('routing is single-use per server: a replayed state cannot resolve twice', () => {
    const resolve = vi.fn()
    const reject = vi.fn()
    const session = beginOAuthSession('server-e')
    registerPending('server-e', resolve, reject)

    expect(routeOAuthCallback(cb({ code: 'first', state: session.state }))).toEqual({
      kind: 'resolve',
      code: 'first'
    })
    expect(routeOAuthCallback(cb({ code: 'replay', state: session.state }))).toEqual({
      kind: 'drop'
    })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledWith('first')
  })

  // Mirrors waitForCode()'s timeout path: `registerPending` returns a `clear()` that must be
  // identity-checked, not a bare `pendingByServer.delete(serverId)`. Without that check, a stale
  // timeout from an earlier attempt for the SAME server id (e.g. a manual reconnect superseding
  // a still-pending auto-connect) would delete the newer, still-live registration — the same
  // shape of bug as the cross-server case, one level narrower.
  it('a superseded registration`s clear() is a no-op against the newer registration for the same server', () => {
    const resolve1 = vi.fn()
    const reject1 = vi.fn()
    const resolve2 = vi.fn()
    const reject2 = vi.fn()

    // First attempt for server-f starts and registers its pending callback.
    const clear1 = registerPending('server-f', resolve1, reject1)

    // Before attempt 1's callback (or timeout) arrives, a second attempt for the SAME server id
    // starts (fresh session + fresh pending registration), superseding the first.
    const session2 = beginOAuthSession('server-f')
    const clear2 = registerPending('server-f', resolve2, reject2)
    void clear2

    // Attempt 1's stale timeout now fires. It must only clear ITS OWN entry.
    clear1()

    // The real callback arrives carrying attempt 2's state — it must still resolve attempt 2's
    // promise, proving clear1() did not delete it.
    const decision = routeOAuthCallback(cb({ code: 'code-2', state: session2.state }))
    expect(decision).toEqual({ kind: 'resolve', code: 'code-2' })
    expect(resolve2).toHaveBeenCalledWith('code-2')
    expect(reject2).not.toHaveBeenCalled()
    // Attempt 1's callbacks must never fire — it was superseded, not settled.
    expect(resolve1).not.toHaveBeenCalled()
    expect(reject1).not.toHaveBeenCalled()
  })

  it('an error callback rejects only the matching server', () => {
    const resolveA = vi.fn()
    const rejectA = vi.fn()
    const resolveB = vi.fn()
    const rejectB = vi.fn()

    const sessionG = beginOAuthSession('server-g')
    registerPending('server-g', resolveA, rejectA)
    beginOAuthSession('server-h')
    registerPending('server-h', resolveB, rejectB)

    const decision = routeOAuthCallback(cb({ error: 'access_denied', state: sessionG.state }))
    expect(decision).toEqual({ kind: 'reject', reason: 'access_denied' })
    expect(rejectA).toHaveBeenCalledWith(new Error('access_denied'))
    expect(resolveA).not.toHaveBeenCalled()
    expect(resolveB).not.toHaveBeenCalled()
    expect(rejectB).not.toHaveBeenCalled()
  })

  it('drops any callback when no server has an in-flight session', () => {
    expect(routeOAuthCallback(cb({ code: 'x', state: 'y'.repeat(32) }))).toEqual({ kind: 'drop' })
  })
})
