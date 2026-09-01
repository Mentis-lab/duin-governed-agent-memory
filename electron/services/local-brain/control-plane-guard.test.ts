import { describe, it, expect } from 'vitest'
import { admitControlPlaneRequest, type ControlPlaneTokens } from './control-plane-guard'

// The admission predicate SECURITY.md describes: reject cross-site writes (external Origin on a
// mutating verb) AND DNS-rebinding (a non-loopback Host on any verb) AND — since the 2026-08-25
// contract change — unauthenticated mutations: a mutating verb (or controlled effectful GET) must
// carry the per-launch control token, or the strictly-stronger exec token the external bridge and
// bench already hold. Legitimate callers keep working by presenting the credential they already
// have; reads stay tokenless.

const CONTROL = 'control-token-test-value-0123456789abcdef'
const EXEC = 'exec-token-test-value-fedcba9876543210ab'
const TOKENS: ControlPlaneTokens = { control: CONTROL, exec: EXEC }

const req = (method: string, headers: Record<string, string> = {}, url = '/agui') => ({
  method,
  url,
  headers
})

describe('admitControlPlaneRequest — host + origin rules (unchanged semantics)', () => {
  it('allows loopback callers that present a credential', () => {
    // In-process bridge / renderer: loopback Host + control token.
    expect(
      admitControlPlaneRequest(req('POST', { host: '127.0.0.1:8799', 'x-duin-control': CONTROL }), TOKENS).ok
    ).toBe(true)
    // External Feishu bridge / bench: exec token is the stronger credential and also admits.
    expect(
      admitControlPlaneRequest(req('POST', { host: '127.0.0.1:8799', 'x-duin-exec': EXEC }), TOKENS).ok
    ).toBe(true)
    // Renderer with a non-http(s) Origin (file://) — not a browser-attack shape.
    expect(
      admitControlPlaneRequest(
        req('POST', { host: 'localhost:8799', origin: 'file://', 'x-duin-control': CONTROL }),
        TOKENS
      ).ok
    ).toBe(true)
    // A localhost-origin write (an in-app fetch that does set Origin) — allowed.
    expect(
      admitControlPlaneRequest(
        req('POST', { host: '127.0.0.1:8799', origin: 'http://127.0.0.1:8799', 'x-duin-control': CONTROL }),
        TOKENS
      ).ok
    ).toBe(true)
    // Absent Host (HTTP/1.0-ish client) is still not a rebinding signal.
    expect(admitControlPlaneRequest(req('POST', { 'x-duin-exec': EXEC }), TOKENS).ok).toBe(true)
  })

  it('blocks a cross-site write (external http(s) Origin) even WITH a valid token', () => {
    const v = admitControlPlaneRequest(
      req('POST', { host: '127.0.0.1:8799', origin: 'https://evil.example', 'x-duin-control': CONTROL }),
      TOKENS
    )
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('cross-origin-write')
    for (const m of ['PUT', 'PATCH', 'DELETE']) {
      expect(
        admitControlPlaneRequest(req(m, { origin: 'https://evil.example', 'x-duin-control': CONTROL }), TOKENS).ok
      ).toBe(false)
    }
  })

  it('blocks DNS rebinding (non-loopback Host) on EVERY verb, including reads', () => {
    expect(admitControlPlaneRequest(req('GET', { host: 'evil.example' }), TOKENS).reason).toBe('dns-rebind-host')
    expect(admitControlPlaneRequest(req('POST', { host: 'evil.example:8799', 'x-duin-control': CONTROL }), TOKENS).reason).toBe(
      'dns-rebind-host'
    )
    expect(admitControlPlaneRequest(req('GET', { host: 'attacker.test' }), TOKENS).ok).toBe(false)
  })

  it('does not block a cross-origin READ that carries no rebinding Host', () => {
    expect(
      admitControlPlaneRequest(req('GET', { host: '127.0.0.1:8799', origin: 'https://evil.example' }, '/state/spaces'), TOKENS).ok
    ).toBe(true)
  })

  it('accepts the IPv6 loopback literal in Host', () => {
    expect(admitControlPlaneRequest(req('POST', { host: '[::1]:8799', 'x-duin-control': CONTROL }), TOKENS).ok).toBe(true)
  })
})

describe('admitControlPlaneRequest — token rule (the 2026-08-25 contract change)', () => {
  it('refuses a tokenless mutation the old guard admitted', () => {
    // This exact shape (loopback Host, no Origin, no token) used to be the allowed
    // "Feishu bridge / CLI" row. Non-browser local processes are precisely what the
    // token now excludes; real bridges present x-duin-exec.
    const v = admitControlPlaneRequest(req('POST', { host: '127.0.0.1:8799' }), TOKENS)
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('control-token-required')
  })

  it('refuses a wrong, empty, or array token', () => {
    expect(admitControlPlaneRequest(req('POST', { 'x-duin-control': 'nope' }), TOKENS).ok).toBe(false)
    expect(admitControlPlaneRequest(req('POST', { 'x-duin-control': '' }), TOKENS).ok).toBe(false)
    const arrayHeader = { method: 'POST', url: '/agui', headers: { 'x-duin-control': [CONTROL, CONTROL] } }
    expect(admitControlPlaneRequest(arrayHeader, TOKENS).ok).toBe(false)
  })

  it('fails CLOSED for mutations when no token is minted at all', () => {
    const none: ControlPlaneTokens = { control: null, exec: null }
    expect(admitControlPlaneRequest(req('POST', { host: '127.0.0.1:8799' }), none).ok).toBe(false)
    // …while reads stay up (status probes, diagnostics).
    expect(admitControlPlaneRequest(req('GET', { host: '127.0.0.1:8799' }, '/health'), none).ok).toBe(true)
  })

  it('requires the token on the controlled effectful GETs, and only those', () => {
    for (const path of ['/debug/self-improve-bench', '/state/futures', '/state/predicted-risks']) {
      expect(admitControlPlaneRequest(req('GET', { host: '127.0.0.1:8799' }, path), TOKENS).reason).toBe(
        'control-token-required'
      )
      expect(
        admitControlPlaneRequest(req('GET', { host: '127.0.0.1:8799', 'x-duin-control': CONTROL }, path), TOKENS).ok
      ).toBe(true)
      // The query string does not defeat the path match.
      expect(admitControlPlaneRequest(req('GET', { host: '127.0.0.1:8799' }, `${path}?x=1`), TOKENS).ok).toBe(false)
    }
    // An ordinary read needs nothing.
    expect(admitControlPlaneRequest(req('GET', { host: '127.0.0.1:8799' }, '/state/spaces'), TOKENS).ok).toBe(true)
  })
})
