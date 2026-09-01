import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { duinFetch, isLoopbackHttpUrl } from './loopback-auth'
import { CONTROLLED_GET_PATHS } from '../../../electron/shared/control-plane-policy'

const originalFetch = globalThis.fetch
const controlToken = vi.fn(async () => 'control-token')

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { api: { controlToken } })
  globalThis.fetch = vi.fn(async () => new Response('{}')) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.unstubAllGlobals()
})

describe('isLoopbackHttpUrl', () => {
  it.each([
    'http://127.0.0.1:8799/agui',
    'https://localhost/state/config',
    'http://[::1]:8799/state/config'
  ])('accepts exact HTTP(S) loopback URL %s', (url) => {
    expect(isLoopbackHttpUrl(url)).toBe(true)
  })

  it.each([
    'https://localhost.example/state/config',
    'https://example.com/state/config',
    'ftp://localhost/state/config',
    'file:///state/config',
    'not-a-url'
  ])('rejects non-loopback or non-HTTP URL %s', (url) => {
    expect(isLoopbackHttpUrl(url)).toBe(false)
  })
})

describe('duinFetch', () => {
  it.each([
    ['/state/config', { method: 'POST', body: '{}' }],
    ['/state/pick-folder', { method: 'POST' }],
    ['/state/upload', { method: 'POST', body: new Blob(['x']) }]
  ] as const)('attaches control auth to representative local mutation %s', async (path, init) => {
    await duinFetch(`http://127.0.0.1:8799${path}`, init)
    const fetchMock = vi.mocked(globalThis.fetch)
    const sent = fetchMock.mock.calls[0][1]
    expect(new Headers(sent?.headers).get('x-duin-control')).toBe('control-token')
    expect(sent?.redirect).toBe('error')
  })

  it('authenticates known effectful GET routes but not pure reads', async () => {
    for (const path of CONTROLLED_GET_PATHS) {
      await duinFetch(`http://127.0.0.1:8799${path}?x=1`)
    }
    await duinFetch('http://127.0.0.1:8799/state/decisions')
    const fetchMock = vi.mocked(globalThis.fetch)
    for (let i = 0; i < CONTROLLED_GET_PATHS.size; i++) {
      expect(new Headers(fetchMock.mock.calls[i][1]?.headers).get('x-duin-control')).toBe('control-token')
    }
    expect(fetchMock.mock.calls[CONTROLLED_GET_PATHS.size][1]).toBeUndefined()
  })

  it('never requests or attaches the token for a remote mutation', async () => {
    await duinFetch('https://brain.example/state/config', { method: 'POST', body: '{}' })
    expect(controlToken).not.toHaveBeenCalled()
    const sent = vi.mocked(globalThis.fetch).mock.calls[0][1]
    expect(new Headers(sent?.headers).has('x-duin-control')).toBe(false)
  })
})
