// Backlog finding 5 (critical). The per-launch host-exec token was sent as a plaintext
// `x-duin-exec` header to whatever endpoint Settings > Brain names — the send site was
// even annotated "local brain only", but nothing enforced it. Point Brain at any
// non-default endpoint (an onboarding-guided, named feature) and the one credential
// separating "chat can read notes" from "chat can run shell commands, delete files,
// send email" went out over the wire on every turn, silently.

import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-duin-bridge-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('./local-brain/server', () => ({
  getBrainExecToken: () => 'EXEC-SECRET',
  getBrainControlToken: () => 'CONTROL-SECRET'
}))

vi.mock('./providers/registry', () => ({
  readStreamInactivityMs: () => 60_000
}))

import { isLoopbackBrainUrl, streamFromDuin } from './duin-bridge'

function sseResponse(frames: string[]): Response {
  return new Response(frames.join('\n\n') + '\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  })
}

function expectRedirectRejected(call: unknown[] | undefined): void {
  expect(call).toBeDefined()
  expect(call?.[1]).toMatchObject({ redirect: 'error' })
}

describe('isLoopbackBrainUrl — who is allowed to receive the exec token', () => {
  it('accepts the shapes a local brain actually runs on', () => {
    for (const u of [
      'http://127.0.0.1:8799/agui/run',
      'http://localhost:8799/agui/run',
      'http://LOCALHOST:8799/agui/run',
      'https://127.0.0.1:8799/',
      'http://[::1]:8799/agui/run'
    ]) {
      expect(isLoopbackBrainUrl(u), u).toBe(true)
    }
  })

  it('accepts the whole 127.0.0.0/8 block, not just 127.0.0.1', () => {
    expect(isLoopbackBrainUrl('http://127.0.0.2:8799/')).toBe(true)
    expect(isLoopbackBrainUrl('http://127.1.2.3:8799/')).toBe(true)
  })

  it('refuses anything that is not this machine', () => {
    for (const u of [
      'https://brain.example.com/agui/run',
      'http://10.0.0.5:8799/agui/run',
      'http://192.168.1.20:8799/agui/run',
      'https://evil.test/agui/run'
    ]) {
      expect(isLoopbackBrainUrl(u), u).toBe(false)
    }
  })

  it('refuses lookalike hosts that merely contain a loopback string', () => {
    // The bug class this guards: a substring check would hand the token to these.
    for (const u of [
      'https://127.0.0.1.evil.test/agui/run',
      'https://localhost.evil.test/agui/run',
      'https://notlocalhost/agui/run'
    ]) {
      expect(isLoopbackBrainUrl(u), u).toBe(false)
    }
  })

  it('refuses an unparseable endpoint rather than assuming it is local', () => {
    expect(isLoopbackBrainUrl('')).toBe(false)
    expect(isLoopbackBrainUrl('not a url')).toBe(false)
  })

  it('refuses non-HTTP protocols even when the hostname is loopback', () => {
    expect(isLoopbackBrainUrl('ftp://127.0.0.1/resource')).toBe(false)
    expect(isLoopbackBrainUrl('ws://localhost:8799/agui')).toBe(false)
    expect(isLoopbackBrainUrl('file://localhost/tmp/brain')).toBe(false)
  })
})

describe('credentialed DUIN transport', () => {
  it('rejects redirects on the initial turn request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sseResponse([
      'id: 1\ndata: {"type":"TEXT_MESSAGE_CONTENT","delta":"ok"}',
      'id: 2\ndata: {"type":"RUN_FINISHED"}'
    ]))

    await streamFromDuin('hello', 'conversation', {
      emit: vi.fn(),
      execToken: 'EXEC-SECRET'
    })

    expectRedirectRejected(fetchMock.mock.calls[0])
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-duin-exec': 'EXEC-SECRET',
      'x-duin-control': 'CONTROL-SECRET'
    })
    fetchMock.mockRestore()
  })

  it('rejects redirects on reconnect requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sseResponse([
        'id: 1\ndata: {"type":"RUN_STARTED","runId":"server-run"}'
      ]))
      .mockResolvedValueOnce(sseResponse([
        'id: 2\ndata: {"type":"TEXT_MESSAGE_CONTENT","delta":"resumed"}',
        'id: 3\ndata: {"type":"RUN_FINISHED"}'
      ]))

    await streamFromDuin('hello', 'conversation', {
      emit: vi.fn(),
      execToken: 'EXEC-SECRET'
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expectRedirectRejected(fetchMock.mock.calls[0])
    expectRedirectRejected(fetchMock.mock.calls[1])
    fetchMock.mockRestore()
  })

  it('rejects redirects on the resumable stop beacon', async () => {
    const controller = new AbortController()
    let reads = 0
    const body = {
      getReader: () => ({
        read: async () => {
          reads += 1
          if (reads === 1) {
            return {
              done: false,
              value: new TextEncoder().encode('id: 1\ndata: {"type":"RUN_STARTED","runId":"server-run"}\n\n')
            }
          }
          controller.abort()
          return { done: true, value: undefined }
        },
        cancel: async () => undefined
      })
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, body } as unknown as Response)
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))

    await streamFromDuin('hello', 'conversation', {
      emit: vi.fn(),
      execToken: 'EXEC-SECRET',
      signal: controller.signal
    })
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[1]?.body).toContain('"abort":true')
    expectRedirectRejected(fetchMock.mock.calls[1])
    fetchMock.mockRestore()
  })
})
