import { describe, it, expect, beforeEach, vi } from 'vitest'

// ADVERSARIAL probe of the R1 output-cap fix (registry.ts:1498-1516).
// Mirrors the mock surface of chatstream-reliability.test.ts: a controllable
// fake OpenAI stream, an overridable keychain, and a stubbed event-log.
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

import {
  chatStream,
  resolveModel,
  resetProviderClients,
  __setStreamInactivityForTesting,
  type ToolCallAccumulator
} from './registry'
import { recordEvent } from '../event-log'

// The default backstop (DUIN_MAX_OUTPUT_CHARS unset in the test env).
const MAX_OUTPUT_CHARS = 400_000

function makeControllableStream() {
  const queue: any[] = []
  let closed = false
  let capturedSignal: AbortSignal | null = null

  const push = (chunk: any): void => {
    if (closed) return
    queue.push(chunk)
  }
  const end = (): void => {
    closed = true
  }

  const stream = {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      // If the attempt was aborted, behave like an aborted SDK stream: stop
      // yielding. This lets the test detect whether the backstop's abort()
      // actually halted consumption.
      if (capturedSignal?.aborted) {
        return { value: undefined, done: true }
      }
      if (queue.length > 0) {
        return { value: queue.shift(), done: false }
      }
      return { value: undefined, done: true }
    }
  }

  return {
    stream,
    push,
    end,
    setSignal: (s: AbortSignal) => {
      capturedSignal = s
    },
    getSignal: () => capturedSignal,
    remaining: () => queue.length
  }
}

function makeToolCallChunk(
  args: string,
  opts: { index?: number; id?: string; name?: string } = {}
) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: opts.index ?? 0,
              ...(opts.id ? { id: opts.id } : {}),
              function: {
                ...(opts.name ? { name: opts.name } : {}),
                arguments: args
              }
            }
          ]
        },
        index: 0,
        finish_reason: null
      }
    ]
  }
}

beforeEach(() => {
  mockCreate.mockReset()
  mockGetKey.mockReset()
  mockGetKey.mockReturnValue('test-key')
  vi.mocked(recordEvent).mockReset()
  resetProviderClients()
  // Disable the inactivity watchdog. This is faithful to production for a
  // runaway tool-call stream: the watchdog re-arms on EVERY chunk
  // (registry.ts:1545), so a steady char-by-char tool-argument stream never
  // trips it — exactly as a steady content stream never would. The char
  // backstop is meant to be the terminal guard. Disabling the timer here just
  // makes the test deterministic; it does not change the outcome.
  __setStreamInactivityForTesting(0)
})

describe('ADVERSARIAL — R1 output-cap holes', () => {
  it('CONTROL: content stream beyond MAX_OUTPUT_CHARS trips the backstop and aborts', async () => {
    const huge = 'x'.repeat(MAX_OUTPUT_CHARS + 1)
    const c = makeControllableStream()
    mockCreate.mockImplementation((_req: unknown, opts: { signal: AbortSignal }) => {
      c.setSignal(opts.signal)
      c.push({ choices: [{ delta: { content: huge }, index: 0, finish_reason: null }] })
      // Deliberately never end — the backstop must terminate on its own.
      return Promise.resolve(c.stream)
    })

    const onDone = vi.fn()
    const onError = vi.fn()
    await chatStream(
      [{ role: 'user', content: 'go' }],
      'gpt-4o',
      undefined,
      { onChunk: () => {}, onDone, onError }
    )

    expect(onDone).toHaveBeenCalledTimes(1)
    expect(c.getSignal()?.aborted).toBe(true) // backstop aborted the attempt
  })

  it('FIXED: an unbounded tool-call-argument stream trips the backstop', async () => {
    // gpt-4o supports tools. Offer a tool so `usableTools` is defined and the
    // provider is "allowed" to stream tool_calls.
    expect(resolveModel('gpt-4o').supportsTools).toBe(true)

    // A malfunctioning / adversarial provider streams tool-call ARGUMENTS
    // forever (e.g. a model emitting an endless JSON argument for a file-write
    // tool). Each chunk carries content='' and reasoning='' — only
    // delta.tool_calls[].function.arguments grows. We push far more than the
    // 400k-char cap: 8 chunks x 100k = 800k chars, double MAX_OUTPUT_CHARS.
    const CHUNK = 'A'.repeat(100_000)
    const CHUNKS = 8
    const totalArgChars = CHUNK.length * CHUNKS // 800_000

    const c = makeControllableStream()
    mockCreate.mockImplementation((_req: unknown, opts: { signal: AbortSignal }) => {
      c.setSignal(opts.signal)
      // First chunk seeds id + name; the rest append pure argument text.
      c.push(makeToolCallChunk(CHUNK, { id: 'call_runaway', name: 'write_file' }))
      for (let i = 1; i < CHUNKS; i++) c.push(makeToolCallChunk(CHUNK))
      c.end()
      return Promise.resolve(c.stream)
    })

    const onDone = vi.fn<(c: string, t?: ToolCallAccumulator[], r?: string) => void>()
    const onError = vi.fn()

    await chatStream(
      [{ role: 'user', content: 'go' }],
      'gpt-4o',
      [
        {
          type: 'function',
          function: { name: 'write_file', description: 'x', parameters: {} }
        }
      ],
      { onChunk: () => {}, onDone, onError },
      undefined,
      undefined,
      // Pass an audit so model.request.completed telemetry is recorded and the
      // finishReason claim below is observable.
      { conversationId: 'probe', correlationId: 'probe' }
    )

    // 1. The backstop fired: tool-call argument bytes now feed the char cap, so
    //    the attempt aborted mid-stream and NOT every chunk was consumed.
    expect(c.getSignal()?.aborted).toBe(true)
    expect(c.remaining()).toBeGreaterThan(0)

    // 2. Terminated via the normal clean-done (truncation) path, exactly one
    //    terminal callback, no error surfaced to the caller.
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()

    // 3. The accumulated tool-call arguments are BOUNDED: they crossed the cap
    //    (that's what tripped the guard) but did not run to the full 800k — the
    //    overshoot is at most one chunk's worth beyond MAX_OUTPUT_CHARS.
    const toolCalls = onDone.mock.calls[0][1]
    expect(toolCalls).toBeDefined()
    const argLen = toolCalls![0].function.arguments.length
    expect(argLen).toBeGreaterThan(MAX_OUTPUT_CHARS) // it crossed the cap
    expect(argLen).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + CHUNK.length) // bounded
    expect(argLen).toBeLessThan(totalArgChars) // did not consume the full runaway

    // 4. The completion telemetry now reports the length-truncation — the
    //    runaway is visible in the audit trail.
    const completed = vi
      .mocked(recordEvent)
      .mock.calls.map((call) => call[0])
      .find((e: any) => e.type === 'model.request.completed')
    expect((completed as any)?.payload.finishReason).toBe('length')
  })
})
