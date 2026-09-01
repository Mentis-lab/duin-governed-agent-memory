import { describe, it, expect, vi, afterEach } from 'vitest'

import { ipv4FirstFetch, isConnectFailure } from './ipv4-first-fetch'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function connectError(code: string): Error {
  const err = new Error('fetch failed') as Error & { cause: { code: string } }
  err.cause = { code }
  return err
}

type FetchInit = RequestInit & { dispatcher?: unknown }

/** Install a fake fetch and capture the init of every attempt, so the tests can
 *  assert WHICH attempt carried the IPv4 dispatcher — the whole point of the
 *  helper — without casting through vi.fn()'s inferred zero-arg tuple. */
function stubFetch(...outcomes: Array<Response | Error>) {
  const inits: Array<FetchInit | undefined> = []
  let i = 0
  globalThis.fetch = (async (_input: unknown, init?: FetchInit) => {
    inits.push(init)
    const outcome = outcomes[Math.min(i++, outcomes.length - 1)]
    if (outcome instanceof Error) throw outcome
    return outcome
  }) as unknown as typeof fetch
  return { inits, calls: () => inits.length }
}

describe('isConnectFailure', () => {
  it('recognises the codes that mean "never connected"', () => {
    for (const code of ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED']) {
      expect(isConnectFailure(connectError(code))).toBe(true)
    }
  })

  it('does NOT treat a real answer or an unrelated fault as a connect failure', () => {
    // Retrying these would double the latency of an error that will not change.
    expect(isConnectFailure(connectError('CERT_HAS_EXPIRED'))).toBe(false)
    expect(isConnectFailure(connectError('ENOTFOUND'))).toBe(false)
    expect(isConnectFailure(new Error('boom'))).toBe(false)
    expect(isConnectFailure(undefined)).toBe(false)
  })

  it('reads the code off the error itself as well as off .cause', () => {
    const flat = new Error('x') as Error & { code: string }
    flat.code = 'ETIMEDOUT'
    expect(isConnectFailure(flat)).toBe(true)
  })
})

describe('ipv4FirstFetch', () => {
  it('makes ONE request when the IPv4 attempt succeeds', async () => {
    const stub = stubFetch(new Response('ok', { status: 200 }))

    const res = await ipv4FirstFetch('https://example.com/x')
    expect(res.status).toBe(200)
    expect(stub.calls()).toBe(1)
    // First attempt must carry the IPv4 dispatcher.
    expect(stub.inits[0]?.dispatcher).toBeDefined()
  })

  it('falls back to default address selection when IPv4 cannot connect', async () => {
    // This is what keeps a genuinely IPv6-only host reachable.
    const stub = stubFetch(
      connectError('UND_ERR_CONNECT_TIMEOUT'),
      new Response('ok', { status: 200 })
    )

    const res = await ipv4FirstFetch('https://v6only.example/x')
    expect(res.status).toBe(200)
    expect(stub.calls()).toBe(2)
    // The retry must NOT pin the family, or an IPv6-only host stays unreachable.
    expect(stub.inits[1]?.dispatcher).toBeUndefined()
  })

  it('does not retry an error that is not a connect failure', async () => {
    const stub = stubFetch(connectError('CERT_HAS_EXPIRED'))

    await expect(ipv4FirstFetch('https://bad-cert.example')).rejects.toThrow()
    expect(stub.calls()).toBe(1)
  })

  it('does not retry once the caller has aborted', async () => {
    // A cancelled request must stay cancelled — retrying would resurrect work
    // the caller already gave up on.
    const ctrl = new AbortController()
    ctrl.abort()
    const stub = stubFetch(connectError('UND_ERR_CONNECT_TIMEOUT'))

    await expect(ipv4FirstFetch('https://example.com', { signal: ctrl.signal })).rejects.toThrow()
    expect(stub.calls()).toBe(1)
  })

  it('preserves method, headers and body across the fallback', async () => {
    const stub = stubFetch(connectError('ETIMEDOUT'), new Response('{}', { status: 200 }))

    await ipv4FirstFetch('https://example.com', {
      method: 'POST',
      headers: { 'X-T': '1' },
      body: 'payload'
    })
    const second = stub.inits[1]
    expect(second?.method).toBe('POST')
    expect(second?.body).toBe('payload')
    expect((second?.headers as Record<string, string>)['X-T']).toBe('1')
  })
})
