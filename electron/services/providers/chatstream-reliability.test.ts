import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mirror registry.test.ts's mock surface: a controllable fake OpenAI stream, a
// keychain whose key is overridable per-test (so we can force a setup-phase
// client failure), and a stubbed event-log we can inspect for telemetry.
const mockCreate = vi.fn()
vi.mock('openai', () => {
  return {
    default: class FakeOpenAI {
      chat = {
        completions: {
          create: mockCreate
        }
      }
    }
  }
})

// getKey is a mock so an individual test can make it return '' and drive
// getClientForProvider (a setup-phase call) into throwing "API key not
// configured". Default: a non-empty key so the client builds fine.
const mockGetKey = vi.fn<(env: string) => string | null>(() => 'test-key')
vi.mock('../keychain', () => ({
  getKey: (env: string) => mockGetKey(env)
}))

vi.mock('../event-log', () => ({
  recordEvent: vi.fn(),
  boundedJsonPreview: (s: unknown) => String(s ?? '')
}))

import {
  chatStream,
  resolveModel,
  resetProviderClients,
  __setStreamInactivityForTesting
} from './registry'
import { recordEvent } from '../event-log'

// A minimal controllable async-iterable stream: the test feeds chunks, ends,
// or fails it, and it records the AbortSignal the SDK was handed so a test can
// assert the attempt was aborted (the R1 output-char backstop path).
function makeControllableStream() {
  const queue: any[] = []
  let resolveNext: ((v: { value: any; done: boolean }) => void) | null = null
  let closed = false
  let capturedSignal: AbortSignal | null = null

  const push = (chunk: any): void => {
    if (closed) return
    if (resolveNext) {
      const r = resolveNext
      resolveNext = null
      r({ value: chunk, done: false })
    } else {
      queue.push(chunk)
    }
  }
  const end = (): void => {
    closed = true
    if (resolveNext) {
      const r = resolveNext
      resolveNext = null
      r({ value: undefined, done: true })
    }
  }

  const stream = {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      if (queue.length > 0) {
        return { value: queue.shift(), done: false }
      }
      if (closed) {
        return { value: undefined, done: true }
      }
      return new Promise<{ value: any; done: boolean }>((res) => {
        resolveNext = res
      })
    }
  }

  return {
    stream,
    push,
    end,
    setSignal: (s: AbortSignal) => {
      capturedSignal = s
    },
    getSignal: () => capturedSignal
  }
}

function makeContentChunk(content: string) {
  return {
    choices: [{ delta: { content }, index: 0, finish_reason: null }]
  }
}

// Wire the SDK mock so create() captures the signal and immediately feeds the
// provided chunks (via microtask) then ends — the common happy-path harness.
function driveStream(controllable: ReturnType<typeof makeControllableStream>, chunks: any[]): void {
  mockCreate.mockImplementation((_req: unknown, opts: { signal: AbortSignal }) => {
    controllable.setSignal(opts.signal)
    for (const c of chunks) controllable.push(c)
    controllable.end()
    return Promise.resolve(controllable.stream)
  })
}

beforeEach(() => {
  mockCreate.mockReset()
  mockGetKey.mockReset()
  mockGetKey.mockReturnValue('test-key')
  vi.mocked(recordEvent).mockReset()
  resetProviderClients()
  // Disable the inactivity watchdog for these tests (they assert terminal
  // dispatch, not timing) so nothing retries underneath us.
  __setStreamInactivityForTesting(0)
})

describe('R1 — max_tokens is ALWAYS sent', () => {
  it('sends DEFAULT_OUTPUT_TOKENS for a model that has no defaultMaxTokens', async () => {
    // gpt-4o resolves (RETIRED_MODEL_MAP) to gpt-5.6-terra, an OpenAI reasoning model with no
    // defaultMaxTokens — the class that previously sent no cap at all. The cap IS always sent; its
    // param NAME is provider-specific (2026-08-22): OpenAI/Kimi take max_completion_tokens, every
    // OpenAI-compat provider takes max_tokens.
    expect(resolveModel('gpt-4o').defaultMaxTokens).toBeUndefined()

    const c = makeControllableStream()
    driveStream(c, [makeContentChunk('hi')])

    await chatStream(
      [{ role: 'user', content: 'hi' }],
      'gpt-4o',
      undefined,
      { onChunk: () => {}, onDone: () => {}, onError: () => {} }
    )

    const createArg = mockCreate.mock.calls[0][0]
    // 8192 is the module default (DUIN_MAX_OUTPUT_TOKENS unset in the test env); OpenAI → the
    // max_completion_tokens param, never max_tokens.
    expect(createArg.max_completion_tokens).toBe(8192)
    expect(createArg.max_tokens).toBeUndefined()
  })

  it('still honors a caller-provided maxTokens', async () => {
    const c = makeControllableStream()
    driveStream(c, [makeContentChunk('hi')])

    await chatStream(
      [{ role: 'user', content: 'hi' }],
      'gpt-4o',
      undefined,
      { onChunk: () => {}, onDone: () => {}, onError: () => {} },
      undefined,
      { maxTokens: 512 }
    )

    // gpt-4o → OpenAI → max_completion_tokens carries the caller's override.
    expect(mockCreate.mock.calls[0][0].max_completion_tokens).toBe(512)
  })
})

describe('R1 — output-char backstop', () => {
  it('aborts the attempt and terminates as finishReason=length when the stream exceeds MAX_OUTPUT_CHARS', async () => {
    // One oversized chunk beyond the 400k-char default cap trips the backstop.
    const huge = 'x'.repeat(400_001)
    const c = makeControllableStream()
    mockCreate.mockImplementation((_req: unknown, opts: { signal: AbortSignal }) => {
      c.setSignal(opts.signal)
      c.push(makeContentChunk(huge))
      // Deliberately do NOT end — the backstop must terminate on its own.
      return Promise.resolve(c.stream)
    })

    const onDone = vi.fn()
    const onError = vi.fn()

    await chatStream(
      [{ role: 'user', content: 'go' }],
      'gpt-4o',
      undefined,
      { onChunk: () => {}, onDone, onError },
      undefined,
      undefined,
      { correlationId: 'corr-1', conversationId: 'conv-1' }
    )

    // Terminated cleanly via onDone with the truncated content — not onError.
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    expect(onDone.mock.calls[0][0].length).toBeGreaterThan(400_000)

    // The attempt's HTTP request was aborted.
    expect(c.getSignal()?.aborted).toBe(true)

    // Completion telemetry marks the truncation.
    const completed = vi
      .mocked(recordEvent)
      .mock.calls.map((call) => call[0])
      .find((e: any) => e.type === 'model.request.completed')
    expect(completed).toBeTruthy()
    expect((completed as any).payload.finishReason).toBe('length')
    expect((completed as any).payload.cancelled).toBe(false)
  })
})

describe('R2 — settle-once orphan protection', () => {
  it('routes a throwing onDone to exactly one onError and still settles', async () => {
    const c = makeControllableStream()
    driveStream(c, [makeContentChunk('done')])

    const onDone = vi.fn(async () => {
      // The real caller's onDone persists to SQLite / spills / recurses; a
      // throw here used to become an unhandled rejection that hung the turn.
      throw new Error('persist failed')
    })
    const onError = vi.fn()

    // The returned promise MUST settle (resolve, not reject).
    await expect(
      chatStream(
        [{ role: 'user', content: 'hi' }],
        'gpt-4o',
        undefined,
        { onChunk: () => {}, onDone, onError }
      )
    ).resolves.toBeUndefined()

    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toContain('persist failed')
    // The partial content is handed back so the caller can persist it.
    expect(onError.mock.calls[0][1]).toEqual({ content: 'done', reasoning: undefined })
  })

  it('routes a setup-phase throw (missing client) to onError, not a bare rejection', async () => {
    // Force getClientForProvider to throw during setup by making the key empty.
    mockGetKey.mockReturnValue('')

    const onDone = vi.fn()
    const onError = vi.fn()

    await expect(
      chatStream(
        [{ role: 'user', content: 'hi' }],
        'gpt-4o',
        undefined,
        { onChunk: () => {}, onDone, onError }
      )
    ).resolves.toBeUndefined()

    // The SDK was never even reached.
    expect(mockCreate).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toMatch(/API key not configured/i)
  })

  it('fires EXACTLY ONE terminal callback on the happy path', async () => {
    const c = makeControllableStream()
    driveStream(c, [makeContentChunk('a'), makeContentChunk('b')])

    let terminalCount = 0
    const onDone = vi.fn((_content?: string) => {
      terminalCount++
    })
    const onError = vi.fn((_error?: string) => {
      terminalCount++
    })

    await chatStream(
      [{ role: 'user', content: 'hi' }],
      'gpt-4o',
      undefined,
      { onChunk: () => {}, onDone, onError }
    )

    expect(terminalCount).toBe(1)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    expect(onDone.mock.calls[0][0]).toBe('ab')
  })
})

describe('status-less stream failure → non-stream quota probe', () => {
  // Some gateways RESET the streaming endpoint on an empty account instead of returning the
  // 402 JSON their non-stream endpoint serves, so the SDK surfaces only "Connection error.".
  // chatStream must then probe non-streaming and surface the REAL quota error — which is what
  // makes the answer-path provider fallback (and its "top up" exhaustion message) fire.
  it('surfaces the probed 402 instead of the generic connection error', async () => {
    vi.useFakeTimers()
    try {
      mockCreate.mockImplementation((req: { stream?: boolean }) => {
        if (req?.stream === false) return Promise.reject(new Error('402 Insufficient Balance'))
        return Promise.reject(new Error('Connection error.'))
      })
      let errMsg = ''
      const p = chatStream(
        [{ role: 'user', content: 'hi' }],
        'deepseek-v4-flash',
        undefined,
        { onChunk: () => {}, onDone: () => {}, onError: (e: string) => { errMsg = e } }
      )
      await vi.runAllTimersAsync()
      await p
      expect(errMsg).toContain('Insufficient Balance')
      expect(errMsg).not.toContain('Connection error')
      const probeCalls = mockCreate.mock.calls.filter((c) => c[0]?.stream === false)
      expect(probeCalls.length).toBe(1)
      expect(probeCalls[0][0].max_tokens).toBe(1)
      expect(probeCalls[0][1]?.maxRetries).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the original error when the probe finds nothing wrong', async () => {
    vi.useFakeTimers()
    try {
      mockCreate.mockImplementation((req: { stream?: boolean }) => {
        if (req?.stream === false) return Promise.resolve({ choices: [] })
        return Promise.reject(new Error('Connection error.'))
      })
      let errMsg = ''
      const p = chatStream(
        [{ role: 'user', content: 'hi' }],
        'deepseek-v4-flash',
        undefined,
        { onChunk: () => {}, onDone: () => {}, onError: (e: string) => { errMsg = e } }
      )
      await vi.runAllTimersAsync()
      await p
      expect(errMsg).toContain('Connection error')
    } finally {
      vi.useRealTimers()
    }
  })
})
