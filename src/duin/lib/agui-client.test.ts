import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgent } from './agui-client'

const originalFetch = globalThis.fetch
const execToken = vi.fn(async () => 'exec-token')
const controlToken = vi.fn(async () => 'control-token')

function finishedResponse(): Response {
  return new Response('data: {"type":"RUN_FINISHED"}\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { api: { execToken, controlToken } })
  globalThis.fetch = vi.fn(async () => finishedResponse()) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.unstubAllGlobals()
})

const baseOpts = {
  threadId: 'thread-1',
  runId: 'run-1',
  messages: [{ role: 'user', content: 'hello' }],
  onEvent: vi.fn()
}

describe('runAgent credential boundary', () => {
  it('attaches execution and control credentials only to an exact loopback endpoint', async () => {
    await runAgent({ ...baseOpts, url: 'http://127.0.0.1:8799/agui' })
    const init = vi.mocked(globalThis.fetch).mock.calls[0][1]
    const headers = new Headers(init?.headers)
    expect(headers.get('x-duin-exec')).toBe('exec-token')
    expect(headers.get('x-duin-control')).toBe('control-token')
    expect(init?.redirect).toBe('error')
  })

  it.each([
    'https://brain.example/agui',
    'https://localhost.example/agui',
    'ftp://localhost/agui'
  ])('never requests or forwards local credentials to %s', async (url) => {
    await runAgent({ ...baseOpts, url })
    expect(execToken).not.toHaveBeenCalled()
    expect(controlToken).not.toHaveBeenCalled()
    const headers = new Headers(vi.mocked(globalThis.fetch).mock.calls[0][1]?.headers)
    expect(headers.has('x-duin-exec')).toBe(false)
    expect(headers.has('x-duin-control')).toBe(false)
  })
})
