import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Adversarial probe of the R2 settle-once terminal dispatch in registry.ts.
// Same mock surface as chatstream-reliability.test.ts: controllable fake OpenAI
// stream, overridable keychain (to force setup-phase failures), stubbed
// event-log.
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

const mockGetKey = vi.fn<(env: string) => string | null>(() => 'test-key')
vi.mock('../keychain', () => ({
  getKey: (env: string) => mockGetKey(env)
}))

vi.mock('../event-log', () => ({
  recordEvent: vi.fn(),
  boundedJsonPreview: (s: unknown) => String(s ?? '')
}))

import { chatStream, resetProviderClients, __setStreamInactivityForTesting } from './registry'

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
      if (queue.length > 0) return { value: queue.shift(), done: false }
      if (closed) return { value: undefined, done: true }
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

function contentChunk(content: string) {
  return { choices: [{ delta: { content }, index: 0, finish_reason: null }] }
}

function driveStream(c: ReturnType<typeof makeControllableStream>, chunks: any[]): void {
  mockCreate.mockImplementation((_req: unknown, opts: { signal: AbortSignal }) => {
    c.setSignal(opts.signal)
    for (const ch of chunks) c.push(ch)
    c.end()
    return Promise.resolve(c.stream)
  })
}

// Faithful multi-attempt driver: every provider request (including retries)
// gets a FRESH stream that re-delivers `chunks`, exactly as a real provider
// would on a re-issued request. (driveStream reuses one stream, which a retry
// finds already closed — fine for single-attempt tests, misleading for retries.)
function driveFreshStreamEachCall(chunks: any[]): void {
  mockCreate.mockImplementation((_req: unknown, opts: { signal: AbortSignal }) => {
    const c = makeControllableStream()
    c.setSignal(opts.signal)
    for (const ch of chunks) c.push(ch)
    c.end()
    return Promise.resolve(c.stream)
  })
}

beforeEach(() => {
  mockCreate.mockReset()
  mockGetKey.mockReset()
  mockGetKey.mockReturnValue('test-key')
  resetProviderClients()
  __setStreamInactivityForTesting(0) // watchdog off — isolate terminal-dispatch behavior
})

afterEach(() => {
  vi.useRealTimers()
})

// ─────────────────────────────────────────────────────────────────────────
// HOLE 1 — settleError does NOT guard a throwing onError.
//
// R2's own docstring guarantees a terminal throw "can't become an unhandled
// rejection that leaves the caller's turn promise unsettled." settleDone wraps
// its callbacks.onError call in try/catch (line ~1198). settleError does NOT —
// it calls callbacks.onError bare (line ~1214). So if onError throws, the throw
// propagates out of chatStream and the returned promise REJECTS, which is
// exactly the "unhandled rejection / turn never settles" failure the fix claims
// to prevent. The asymmetry is the hole.
// ─────────────────────────────────────────────────────────────────────────
describe('HOLE 1 — throwing onError escapes settleError as a rejection', () => {
  it('setup-phase error: a throwing onError rejects chatStream instead of settling', async () => {
    // Missing key → getClientForProvider throws in the setup block → settleError.
    mockGetKey.mockReturnValue('')

    const onError = vi.fn(() => {
      // A real renderer onError could throw (serialization, disposed webContents,
      // a bug in the error toast). settleDone anticipates exactly this for its
      // own onError call; settleError does not.
      throw new Error('onError blew up')
    })

    // Contract (mirrors the passing reliability test, which used a non-throwing
    // onError): chatStream MUST resolve to undefined, never reject.
    await expect(
      chatStream(
        [{ role: 'user', content: 'hi' }],
        'gpt-4o',
        undefined,
        { onChunk: () => {}, onDone: () => {}, onError }
      )
    ).resolves.toBeUndefined()
  })

  it('stream-error path: a throwing onError on a 401 rejects chatStream', async () => {
    const c = makeControllableStream()
    mockCreate.mockImplementation((_req: unknown, opts: { signal: AbortSignal }) => {
      c.setSignal(opts.signal)
      const err = Object.assign(new Error('unauthorized'), { status: 401 })
      return Promise.reject(err)
    })

    const onError = vi.fn(() => {
      throw new Error('onError blew up')
    })

    await expect(
      chatStream(
        [{ role: 'user', content: 'hi' }],
        'gpt-4o',
        undefined,
        { onChunk: () => {}, onDone: () => {}, onError }
      )
    ).resolves.toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// HOLE 2 — a throwing onChunk (a pure caller/renderer bug) is misclassified as
// a transient provider error and drives the retry loop, firing the SAME
// provider request up to 4 times.
//
// onChunk is awaited (line ~1481) but NOT guarded. Its throw lands in the outer
// catch, where — having no `.status` and not being an abort/inactivity — it
// matches `retries < maxRetries && !status` and RETRIES. A client-side
// serialization/UI bug thus silently issues 3 extra full LLM generations
// (duplicate billing + duplicate side effects), then reports it to the user as
// a provider "Unknown error".
// ─────────────────────────────────────────────────────────────────────────
describe('HOLE 2 — throwing onChunk triggers a duplicate-request retry storm', () => {
  // Real timers: the retry path uses 2s+4s+8s exponential backoff, so let the
  // whole thing run to completion (well under the 30s per-test budget). Fake
  // timers muddied the interplay with the stream's real-promise next().
  it('issues exactly ONE provider request for a client-side onChunk bug', async () => {
    driveFreshStreamEachCall([contentChunk('a')])

    let terminal = 0
    const onDone = vi.fn(() => {
      terminal++
    })
    const onError = vi.fn(() => {
      terminal++
    })

    await chatStream(
      [{ role: 'user', content: 'hi' }],
      'gpt-4o',
      undefined,
      {
        onChunk: () => {
          throw new Error('renderer onChunk bug')
        },
        onDone,
        onError
      }
    )

    // Ground-truth diagnostics for the report.
    // A bug in the caller's onChunk must NOT cause the provider request to be
    // re-issued. If this reads >1, the callback bug triggered a retry storm.
    expect({
      providerRequests: mockCreate.mock.calls.length,
      terminalCallbacks: terminal,
      onErrorCalls: onError.mock.calls.length,
      onDoneCalls: onDone.mock.calls.length
    }).toEqual({ providerRequests: 1, terminalCallbacks: 1, onErrorCalls: 1, onDoneCalls: 0 })
  }, 30_000)
})

// ─────────────────────────────────────────────────────────────────────────
// CONTROL — characterize the onChunk-throw path's terminal count. Confirms the
// path is NOT a zero/two-terminal orphan (it does eventually settle exactly
// once), so HOLE 2 is scoped to the retry storm, not a settle-once break.
// ─────────────────────────────────────────────────────────────────────────
describe('CONTROL — onChunk throw still yields exactly one terminal', () => {
  it('settles via a single onError after exhausting retries', async () => {
    driveFreshStreamEachCall([contentChunk('a')])

    let terminal = 0
    const onDone = vi.fn(() => {
      terminal++
    })
    const onError = vi.fn(() => {
      terminal++
    })

    await chatStream(
      [{ role: 'user', content: 'hi' }],
      'gpt-4o',
      undefined,
      {
        onChunk: () => {
          throw new Error('renderer onChunk bug')
        },
        onDone,
        onError
      }
    )

    expect(terminal).toBe(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onDone).not.toHaveBeenCalled()
  }, 30_000)
})
