import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the OpenAI SDK with a controllable stream so we can simulate the
// "provider opened a socket then stopped sending chunks" case without a
// real network call. The mock has to live ABOVE the registry import so
// vi.mock hoisting catches it before the module under test loads.
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

// Keychain returns a non-empty key so getClientForProvider doesn't throw.
vi.mock('../keychain', () => ({
  getKey: () => 'test-key'
}))

// event-log is a pure-side-effect module; stub it to no-op.
vi.mock('../event-log', () => ({
  recordEvent: vi.fn(),
  boundedJsonPreview: (s: unknown) => String(s ?? '')
}))

import {
  chatStream,
  chatOnce,
  StreamInactivityError,
  __setStreamInactivityForTesting,
  resetProviderClients
} from './registry'

// A controllable async-iterable stream: pushes chunks the test code feeds it,
// honors AbortSignal, and lets the test "stall" by simply never pushing.
function makeControllableStream() {
  const queue: any[] = []
  let resolveNext: ((v: { value: any; done: boolean }) => void) | null = null
  let rejectNext: ((e: Error) => void) | null = null
  let closed = false

  const push = (chunk: any) => {
    if (closed) return
    if (resolveNext) {
      const r = resolveNext
      resolveNext = null
      rejectNext = null
      r({ value: chunk, done: false })
    } else {
      queue.push(chunk)
    }
  }
  const end = () => {
    closed = true
    if (resolveNext) {
      const r = resolveNext
      resolveNext = null
      rejectNext = null
      r({ value: undefined, done: true })
    }
  }
  const fail = (err: Error) => {
    closed = true
    if (rejectNext) {
      const rj = rejectNext
      resolveNext = null
      rejectNext = null
      rj(err)
    }
  }

  let signalHandler: (() => void) | null = null
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
      return new Promise<{ value: any; done: boolean }>((res, rej) => {
        resolveNext = res
        rejectNext = rej
      })
    },
    attachSignal(signal: AbortSignal) {
      signalHandler = () => {
        const err: any = new Error('Request was aborted.')
        err.name = 'AbortError'
        fail(err)
      }
      if (signal.aborted) signalHandler()
      else signal.addEventListener('abort', signalHandler, { once: true })
    }
  }

  return { stream, push, end, fail }
}

function makeChunk(content: string) {
  return {
    choices: [
      {
        delta: { content },
        index: 0,
        finish_reason: null
      }
    ]
  }
}

beforeEach(() => {
  mockCreate.mockReset()
  resetProviderClients()
})

describe('chatStream — SSE inactivity watchdog (T1)', () => {
  it('fires StreamInactivityError when the provider stops sending chunks', async () => {
    // 50 ms watchdog so the test stays fast.
    __setStreamInactivityForTesting(50)

    // Fresh stalling stream per attempt — the watchdog will retry up to 3
    // times with exponential backoff (2/4/8s), so we cap the test wait by
    // shrinking the backoff via fake timers. Instead of fake timers, just
    // accept the real backoff but keep the test runtime bounded with a
    // generous-but-not-infinite vitest timeout.
    mockCreate.mockImplementation((_req: unknown, opts: { signal: AbortSignal }) => {
      const fresh = makeControllableStream()
      fresh.stream.attachSignal(opts.signal)
      return Promise.resolve(fresh.stream)
    })

    let errorMessage: string | null = null
    let onDoneCalled = false

    const start = Date.now()
    await chatStream(
      [{ role: 'user', content: 'hi' }],
      'deepseek-v4-pro',
      undefined,
      {
        onChunk: () => {
          /* no-op */
        },
        onDone: () => {
          onDoneCalled = true
        },
        onError: (msg) => {
          errorMessage = msg
        }
      }
    )
    const elapsed = Date.now() - start

    expect(onDoneCalled).toBe(false)
    expect(errorMessage).toMatch(/Stream stalled|provider sent no chunks/i)
    expect(elapsed).toBeLessThan(20_000)

    __setStreamInactivityForTesting(null)
  }, 25_000)

  it('does NOT fire when chunks arrive within the watchdog window', async () => {
    __setStreamInactivityForTesting(200)

    const controllable = makeControllableStream()
    mockCreate.mockImplementation((_req: unknown, opts: { signal: AbortSignal }) => {
      controllable.stream.attachSignal(opts.signal)
      // Feed a chunk every 50ms (well inside 200ms watchdog) and finish.
      const t1 = setTimeout(() => controllable.push(makeChunk('hello ')), 30)
      const t2 = setTimeout(() => controllable.push(makeChunk('world')), 80)
      const t3 = setTimeout(() => controllable.end(), 130)
      void t1
      void t2
      void t3
      return Promise.resolve(controllable.stream)
    })

    let received = ''
    let errored = false
    let done = false
    await chatStream(
      [{ role: 'user', content: 'hi' }],
      'deepseek-v4-pro',
      undefined,
      {
        onChunk: (c) => {
          received += c
        },
        onDone: (full) => {
          done = true
          received = full
        },
        onError: () => {
          errored = true
        }
      }
    )

    expect(errored).toBe(false)
    expect(done).toBe(true)
    expect(received).toBe('hello world')

    __setStreamInactivityForTesting(null)
  })

  it('can be disabled by setting threshold to 0', async () => {
    __setStreamInactivityForTesting(0)

    const controllable = makeControllableStream()
    mockCreate.mockImplementation((_req: unknown, opts: { signal: AbortSignal }) => {
      controllable.stream.attachSignal(opts.signal)
      // Stall briefly then finish — the watchdog should NOT fire.
      setTimeout(() => controllable.push(makeChunk('ok')), 50)
      setTimeout(() => controllable.end(), 100)
      return Promise.resolve(controllable.stream)
    })

    let errored = false
    let done = false
    await chatStream(
      [{ role: 'user', content: 'hi' }],
      'deepseek-v4-pro',
      undefined,
      {
        onChunk: () => {},
        onDone: () => {
          done = true
        },
        onError: () => {
          errored = true
        }
      }
    )

    expect(errored).toBe(false)
    expect(done).toBe(true)

    __setStreamInactivityForTesting(null)
  })

  it('user-signal abort wins over the inactivity watchdog', async () => {
    __setStreamInactivityForTesting(500)

    const controllable = makeControllableStream()
    mockCreate.mockImplementation((_req: unknown, opts: { signal: AbortSignal }) => {
      controllable.stream.attachSignal(opts.signal)
      // Never send a chunk; rely on the user signal to break out.
      return Promise.resolve(controllable.stream)
    })

    const userAbort = new AbortController()
    let doneContent = ''
    let errored = false

    const p = chatStream(
      [{ role: 'user', content: 'hi' }],
      'deepseek-v4-pro',
      undefined,
      {
        onChunk: () => {},
        onDone: (full) => {
          doneContent = full
        },
        onError: () => {
          errored = true
        }
      },
      userAbort.signal
    )

    // Fire the user abort before the watchdog can.
    setTimeout(() => userAbort.abort(), 50)
    await p

    expect(errored).toBe(false)
    expect(doneContent).toContain('[cancelled]')

    __setStreamInactivityForTesting(null)
  })

  it('StreamInactivityError carries the configured threshold', () => {
    const e = new StreamInactivityError(45_000)
    expect(e.name).toBe('StreamInactivityError')
    expect(e.inactivityMs).toBe(45_000)
    expect(e.message).toMatch(/45s/)
  })
})

describe('chatStream — streaming-vitals heartbeat (T4)', () => {
  it('fires onVitals while the stream is active and stops when it ends', async () => {
    __setStreamInactivityForTesting(0)

    const controllable = makeControllableStream()
    mockCreate.mockImplementation((_req: unknown, opts: { signal: AbortSignal }) => {
      controllable.stream.attachSignal(opts.signal)
      // Drip chunks across a window long enough for at least one heartbeat
      // (provider fires every 2s; we tick out chunks slowly).
      setTimeout(() => controllable.push(makeChunk('a')), 100)
      setTimeout(() => controllable.push(makeChunk('b')), 2_200)
      setTimeout(() => controllable.end(), 2_400)
      return Promise.resolve(controllable.stream)
    })

    const vitalsCalls: Array<{ lastChunkAt: number; chunkCount: number }> = []
    let done = false
    await chatStream(
      [{ role: 'user', content: 'hi' }],
      'deepseek-v4-pro',
      undefined,
      {
        onChunk: () => {},
        onVitals: (v) =>
          vitalsCalls.push({ lastChunkAt: v.lastChunkAt, chunkCount: v.chunkCount }),
        onDone: () => {
          done = true
        },
        onError: () => {}
      }
    )

    expect(done).toBe(true)
    // At least one heartbeat fired in the ~2.4s window. Provider lifts the
    // 2s heartbeat regardless of chunk arrival so the renderer can show a
    // staleness indicator on slow providers.
    expect(vitalsCalls.length).toBeGreaterThanOrEqual(1)
    const last = vitalsCalls[vitalsCalls.length - 1]
    expect(last.chunkCount).toBeGreaterThanOrEqual(1)
    expect(last.lastChunkAt).toBeGreaterThan(0)

    __setStreamInactivityForTesting(null)
  }, 10_000)
})

// Reasoning Audit Phase R2 — chatOnce now returns BOTH the visible body
// and any chain-of-thought the provider emitted alongside it. These tests
// pin the SDK response-shape contract: both `message.reasoning` and
// `message.reasoning_content` (the two field names different OpenAI-
// compatible APIs use) must be picked up. Without this pin, a future
// refactor could silently drop reasoning at the boundary again.
describe('chatOnce — reasoning channel extraction (R2)', () => {
  it('returns body only when neither reasoning field is set', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: { content: 'plain body' },
          finish_reason: 'stop'
        }
      ]
    })
    const result = await chatOnce(
      [{ role: 'user', content: 'q' }],
      'deepseek-v4-pro'
    )
    expect(result.content).toBe('plain body')
    expect(result.reasoning).toBeUndefined()
  })

  it('extracts reasoning from message.reasoning (OpenRouter shape)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'final answer',
            reasoning: 'I thought through it like this'
          },
          finish_reason: 'stop'
        }
      ]
    })
    const result = await chatOnce(
      [{ role: 'user', content: 'q' }],
      'deepseek-v4-pro'
    )
    expect(result.content).toBe('final answer')
    expect(result.reasoning).toBe('I thought through it like this')
  })

  it('extracts reasoning from message.reasoning_content (DashScope / DeepSeek shape)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'final answer',
            reasoning_content: 'CoT on the other field name'
          },
          finish_reason: 'stop'
        }
      ]
    })
    const result = await chatOnce(
      [{ role: 'user', content: 'q' }],
      'deepseek-v4-pro'
    )
    expect(result.content).toBe('final answer')
    expect(result.reasoning).toBe('CoT on the other field name')
  })

  it('prefers message.reasoning when both fields are populated', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'final answer',
            reasoning: 'primary CoT',
            reasoning_content: 'duplicate CoT'
          },
          finish_reason: 'stop'
        }
      ]
    })
    const result = await chatOnce(
      [{ role: 'user', content: 'q' }],
      'deepseek-v4-pro'
    )
    expect(result.reasoning).toBe('primary CoT')
  })

  it('treats whitespace-only reasoning as absent', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: { content: 'body', reasoning: '   \n  ' },
          finish_reason: 'stop'
        }
      ]
    })
    const result = await chatOnce(
      [{ role: 'user', content: 'q' }],
      'deepseek-v4-pro'
    )
    expect(result.reasoning).toBeUndefined()
  })

  it('trims surrounding whitespace from preserved reasoning', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'body',
            reasoning: '  actual reasoning  \n'
          },
          finish_reason: 'stop'
        }
      ]
    })
    const result = await chatOnce(
      [{ role: 'user', content: 'q' }],
      'deepseek-v4-pro'
    )
    expect(result.reasoning).toBe('actual reasoning')
  })
})

// ── Fix A/B descriptor field tests ──────────────────────────────────
import { MODEL_CATALOG, resolveModel } from './registry'

describe('reasoning token exhaustion guards (Fix A/B)', () => {
  const deepseekIds = ['deepseek-v4-pro', 'deepseek-v4-flash']

  for (const id of deepseekIds) {
    it(`${id} has defaultMaxTokens set`, () => {
      const desc = resolveModel(id)
      expect(desc.defaultMaxTokens).toBe(16_384)
    })

    it(`${id} has reasoningCapOnToolUse`, () => {
      expect(resolveModel(id).reasoningCapOnToolUse).toBe(true)
    })
  }

  it('no legacy DeepSeek aliases exist in the catalog', () => {
    // `duin-brain` is the external agent/DUIN connector: its `provider` field is
    // cosmetic (chat:send branches on the id before any provider dispatch — it
    // never calls a DeepSeek API), so it's exempt from the deepseek-v4 naming
    // rule this test enforces for real DeepSeek models.
    const stale = MODEL_CATALOG.filter(
      (m) => m.provider === 'deepseek' && m.id !== 'duin-brain' && !m.id.startsWith('deepseek-v4-')
    )
    expect(stale).toEqual([])
  })

  it.each([
    ['deepseek-chat', 'deepseek-v4-flash'],
    ['deepseek-reasoner', 'deepseek-v4-pro'],
    ['deepseek-v3', 'deepseek-v4-flash'],
    ['deepseek-r1', 'deepseek-v4-pro']
  ])('retired model %s resolves to %s', (retired, expected) => {
    const desc = resolveModel(retired)
    expect(desc.id).toBe(expected)
    expect(desc.apiModelId).toBe(expected)
  })

  // Was: "non-DeepSeek models have no defaultMaxTokens by default". That encoded a SNAPSHOT
  // ("only DeepSeek caps output") as an invariant, so it broke the moment two OneAI reasoners
  // deliberately set 8_192 — 9446dd4 (gpt-5.5-oneai, 2026-07-12) and d825437 (gpt-5.6-sol-oneai,
  // 2026-07-15). Nothing was wrong with those models; the test was asserting the wrong thing.
  //
  // What actually matters is that an output cap is DELIBERATE: an accidental defaultMaxTokens
  // silently truncates long generations, and a missing one lets a reasoner run away. So the
  // allowlist is the assertion — adding a cap means adding a line here, which is the conscious
  // act the original test was reaching for.
  it('only the models on the explicit allowlist cap output tokens', () => {
    // Re-pinned for the 2026-08-21 catalog redo: every current Anthropic /
    // Kimi / GLM / Qwen entry thinks by default (adaptive or hybrid), so the
    // whole set carries the 16_384 cap the old catalog gave only to
    // deepseek-v4 and kimi-k3 — same finishReason-'length' rationale as the
    // 2026-08-03 GLM-5.2 note this replaces.
    const EXPECTED_CAPPED: Record<string, number> = {
      'claude-fable-5': 16_384,
      'claude-opus-5': 16_384,
      'claude-sonnet-5': 16_384,
      'claude-haiku-4-5': 16_384,
      'claude-opus-4-8': 16_384,
      'claude-sonnet-4-6': 16_384,
      'deepseek-v4-flash': 16_384,
      'deepseek-v4-pro': 16_384,
      'kimi-k3': 16_384,
      'kimi-k2.6': 16_384,
      'kimi-k2.7-code': 16_384,
      'kimi-k2.7-code-highspeed': 16_384,
      'glm-5.3': 16_384,
      'glm-5.3-flash': 16_384, // thinking cannot be disabled — same cap, same reason as glm-5.3
      'glm-5-turbo': 16_384,
      'glm-4.7': 16_384,
      'glm-4.7-flashx': 16_384,
      'glm-5v-turbo': 16_384,
      'qwen3.8-max': 16_384,
      'qwen3.7-plus': 16_384,
      'qwen3.7-flash': 16_384,
      'qwen3.8-flash': 16_384, // thinking pinned off like qwen3.7-flash; same runaway backstop as the rest of the Qwen set
      'qwen3-coder-next': 16_384,
      'qwen3-coder-plus': 16_384,
      'gemini-3.1-pro-preview': 16_384,
      'gemini-3.7-flash': 16_384,
      'gemini-3.5-flash-lite': 16_384,
      'gemini-2.5-pro': 16_384,
      'gpt-5.5-oneai': 8_192,
      'gpt-5.6-sol-oneai': 8_192
    }
    const actual = Object.fromEntries(
      MODEL_CATALOG.filter((m) => m.defaultMaxTokens != null).map((m) => [m.id, m.defaultMaxTokens])
    )
    expect(actual).toEqual(EXPECTED_CAPPED)
  })

  it('chatStream sends max_tokens from defaultMaxTokens when caller omits maxTokens', async () => {
    __setStreamInactivityForTesting(0)
    const controllable = makeControllableStream()
    mockCreate.mockImplementation((_req: unknown, opts: { signal: AbortSignal }) => {
      controllable.stream.attachSignal(opts.signal)
      setTimeout(() => controllable.push(makeChunk('ok')), 10)
      setTimeout(() => controllable.end(), 20)
      return Promise.resolve(controllable.stream)
    })

    await chatStream(
      [{ role: 'user', content: 'hi' }],
      'deepseek-v4-pro',
      undefined,
      { onChunk: () => {}, onDone: () => {}, onError: () => {} }
    )

    const createArg = mockCreate.mock.calls[0][0]
    expect(createArg.max_tokens).toBe(16_384)
    __setStreamInactivityForTesting(null)
  })

  it('Moonshot (Kimi): sends max_completion_tokens NOT max_tokens, omits sampling, keeps reasoning_effort', async () => {
    // Kimi K3 is an OpenAI-compat reasoning model that 400s on max_tokens (needs
    // max_completion_tokens) and locks sampling. The generic body killed every Kimi turn before a
    // token streamed. Pin the moonshot-specific shaping so it can't regress.
    __setStreamInactivityForTesting(0)
    const controllable = makeControllableStream()
    mockCreate.mockImplementation((_req: unknown, opts: { signal: AbortSignal }) => {
      controllable.stream.attachSignal(opts.signal)
      setTimeout(() => controllable.push(makeChunk('ok')), 10)
      setTimeout(() => controllable.end(), 20)
      return Promise.resolve(controllable.stream)
    })

    await chatStream(
      [{ role: 'user', content: 'hi' }],
      'kimi-k3',
      undefined, // tools
      { onChunk: () => {}, onDone: () => {}, onError: () => {} },
      undefined, // signal
      { temperature: 0.7, topP: 0.9, reasoningEffort: 'max' } // a config that WOULD 400 K3 if forwarded
    )

    const arg = mockCreate.mock.calls[0][0]
    expect(arg.max_completion_tokens).toBe(16_384) // the fix: correct token param
    expect(arg.max_tokens).toBeUndefined() // the bug: never send this to Kimi
    expect(arg.temperature).toBeUndefined() // sampling is locked on K3 — omitted
    expect(arg.top_p).toBeUndefined()
    expect(arg.reasoning_effort).toBe('max') // Kimi accepts 'max' (not remapped to 'high')
    __setStreamInactivityForTesting(null)
  })

  it('chatStream sends reasoning_effort when tools are offered on a capped model', async () => {
    __setStreamInactivityForTesting(0)
    const controllable = makeControllableStream()
    mockCreate.mockImplementation((_req: unknown, opts: { signal: AbortSignal }) => {
      controllable.stream.attachSignal(opts.signal)
      setTimeout(() => controllable.push(makeChunk('ok')), 10)
      setTimeout(() => controllable.end(), 20)
      return Promise.resolve(controllable.stream)
    })

    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'test_tool',
          description: 'test',
          parameters: { type: 'object', properties: {} }
        }
      }
    ]

    await chatStream(
      [{ role: 'user', content: 'hi' }],
      'deepseek-v4-pro',
      tools,
      { onChunk: () => {}, onDone: () => {}, onError: () => {} }
    )

    const createArg = mockCreate.mock.calls[0][0]
    expect(createArg.reasoning_effort).toBe('low')
    __setStreamInactivityForTesting(null)
  })

  it('chatStream sends reasoning_effort on every turn for a capped (reasoning) model, even without tools', async () => {
    __setStreamInactivityForTesting(0)
    const controllable = makeControllableStream()
    mockCreate.mockImplementation((_req: unknown, opts: { signal: AbortSignal }) => {
      controllable.stream.attachSignal(opts.signal)
      setTimeout(() => controllable.push(makeChunk('ok')), 10)
      setTimeout(() => controllable.end(), 20)
      return Promise.resolve(controllable.stream)
    })

    await chatStream(
      [{ role: 'user', content: 'hi' }],
      'deepseek-v4-pro',
      undefined,
      { onChunk: () => {}, onDone: () => {}, onError: () => {} }
    )

    const createArg = mockCreate.mock.calls[0][0]
    // Chat-latency fix: reasoning models (reasoningCapOnToolUse) now get
    // reasoning_effort:'low' on EVERY turn — not just tool-use turns — to cap the
    // 20-33k-char chain-of-thought that parked grounded chat at 0 tokens for 1-2min.
    expect(createArg.reasoning_effort).toBe('low')
    __setStreamInactivityForTesting(null)
  })

  it('caller-provided maxTokens overrides defaultMaxTokens', async () => {
    __setStreamInactivityForTesting(0)
    const controllable = makeControllableStream()
    mockCreate.mockImplementation((_req: unknown, opts: { signal: AbortSignal }) => {
      controllable.stream.attachSignal(opts.signal)
      setTimeout(() => controllable.push(makeChunk('ok')), 10)
      setTimeout(() => controllable.end(), 20)
      return Promise.resolve(controllable.stream)
    })

    await chatStream(
      [{ role: 'user', content: 'hi' }],
      'deepseek-v4-pro',
      undefined,
      { onChunk: () => {}, onDone: () => {}, onError: () => {} },
      undefined,
      { maxTokens: 4096 }
    )

    const createArg = mockCreate.mock.calls[0][0]
    expect(createArg.max_tokens).toBe(4096)
    __setStreamInactivityForTesting(null)
  })
})

describe('resolveModel — openrouter: prefix routing (browse-added models)', () => {
  it('routes an openrouter:<id> model to the OpenRouter provider with the exact api id', () => {
    const d = resolveModel('openrouter:openai/gpt-4o')
    expect(d.provider).toBe('openrouter')
    expect(d.apiModelId).toBe('openai/gpt-4o')
  })

  it('does NOT fall through to the generic deepseek default (the mis-route this fixes)', () => {
    expect(resolveModel('openrouter:anthropic/claude-3.5-sonnet').provider).toBe('openrouter')
  })

  it('preserves an api id that itself contains slashes and colons', () => {
    expect(resolveModel('openrouter:x-ai/grok-2:beta').apiModelId).toBe('x-ai/grok-2:beta')
  })
})

// ── resolveModel — settings.customModels routing (imported live models) ──────
// Imported models for the five UA providers (groq/mistral/moonshot/github-models/
// deepinfra) are persisted to settings.customModels with a `provider`. resolveModel
// must honor that provider + wire id, NOT silently fall through to the deepseek
// fallback (which would route chat to the wrong provider/key/wire-id).
import { __setCustomModelsForTesting } from './registry'

describe('resolveModel — settings.customModels routing (imported live models)', () => {
  beforeEach(() => {
    __setCustomModelsForTesting(null)
  })

  it('routes an imported DeepInfra model to the deepinfra provider (not the deepseek fallback)', () => {
    __setCustomModelsForTesting([
      {
        id: 'meta-llama/Llama-3.3-70B-Instruct',
        provider: 'deepinfra',
        contextWindow: 131072,
        supportsTools: false,
        supportsVision: false
      }
    ])
    const d = resolveModel('meta-llama/Llama-3.3-70B-Instruct')
    expect(d.provider).toBe('deepinfra')
    // id IS the wire id for a non-namespaced import.
    expect(d.apiModelId).toBe('meta-llama/Llama-3.3-70B-Instruct')
  })

  it.each(['groq', 'mistral', 'moonshot', 'github-models', 'deepinfra'] as const)(
    'routes an imported %s model to its own provider',
    (provider) => {
      __setCustomModelsForTesting([
        { id: `live-${provider}-model`, provider, contextWindow: 65536, supportsTools: false, supportsVision: false }
      ])
      expect(resolveModel(`live-${provider}-model`).provider).toBe(provider)
    }
  )

  it('honors a persisted apiModelId distinct from the local id (collision-namespaced import)', () => {
    // buildLiveModelImports namespaces a colliding local id to `<provider>:<apiModelId>`
    // while preserving the wire id verbatim in apiModelId.
    __setCustomModelsForTesting([
      {
        id: 'deepinfra:mistralai/Mistral-Small',
        provider: 'deepinfra',
        apiModelId: 'mistralai/Mistral-Small',
        contextWindow: 65536,
        supportsTools: false,
        supportsVision: false
      }
    ])
    const d = resolveModel('deepinfra:mistralai/Mistral-Small')
    expect(d.provider).toBe('deepinfra')
    expect(d.apiModelId).toBe('mistralai/Mistral-Small')
  })

  it('does NOT reroute a known catalog id via a custom record (catalog wins)', () => {
    __setCustomModelsForTesting([{ id: 'deepseek-v4-pro', provider: 'groq' }])
    // Catalog is consulted before customModels, so a real catalog id is unaffected.
    expect(resolveModel('deepseek-v4-pro').provider).toBe('deepseek')
  })

  it('falls back to the deepseek default when a custom record has no valid provider', () => {
    __setCustomModelsForTesting([{ id: 'headless-custom', contextWindow: 4096 }])
    const d = resolveModel('headless-custom')
    expect(d.provider).toBe('deepseek')
    expect(d.apiModelId).toBe('headless-custom')
  })
})

// The operator (2026-08-22): "expand the same test to all the other AI providers." Each provider's
// OpenAI-compat endpoint has its own accepted request shape; sending the wrong one 400s the turn
// (the Kimi break). This table pins the token param + thinking + reasoning_effort the app emits
// for a representative model of every provider family, so a future catalog/registry change can't
// silently reintroduce a per-provider 400.
describe('per-provider request shaping (chatStream body)', () => {
  async function bodyFor(modelId: string) {
    __setStreamInactivityForTesting(0)
    const controllable = makeControllableStream()
    mockCreate.mockReset()
    mockCreate.mockImplementation((_req: unknown, opts: { signal: AbortSignal }) => {
      controllable.stream.attachSignal(opts.signal)
      setTimeout(() => controllable.push(makeChunk('ok')), 10)
      setTimeout(() => controllable.end(), 20)
      return Promise.resolve(controllable.stream)
    })
    await chatStream(
      [{ role: 'user', content: 'hi' }],
      modelId,
      undefined,
      { onChunk: () => {}, onDone: () => {}, onError: () => {} }
    )
    const arg = mockCreate.mock.calls[0][0]
    __setStreamInactivityForTesting(null)
    return arg
  }

  // [model, expected token-param key, extra shape assertions]
  const CASES: Array<{
    model: string
    tokenKey: 'max_tokens' | 'max_completion_tokens'
    note: string
    expect?: (arg: Record<string, unknown>) => void
  }> = [
    { model: 'gpt-5.6-sol', tokenKey: 'max_completion_tokens', note: 'real OpenAI reasoning API rejects max_tokens',
      expect: (a) => { expect(a.reasoning_effort).toBeUndefined() /* not a catalog reasoner */ } },
    { model: 'kimi-k3', tokenKey: 'max_completion_tokens', note: 'Kimi rejects max_tokens',
      expect: (a) => { expect(a.reasoning_effort).toBe('low') } },
    { model: 'deepseek-v4-pro', tokenKey: 'max_tokens', note: 'OpenAI-compat, classic param',
      expect: (a) => { expect(a.reasoning_effort).toBe('low') /* reasoningCapOnToolUse */ } },
    { model: 'deepseek-v4-flash', tokenKey: 'max_tokens', note: 'disableThinking → thinking off',
      expect: (a) => { expect(a.thinking).toEqual({ type: 'disabled' }) } },
    { model: 'glm-5.3', tokenKey: 'max_tokens', note: 'Zhipu OpenAI-compat',
      expect: (a) => { expect(a.reasoning_effort).toBe('low') /* isReasoner */ } },
    // glm-5.3-flash: "thinking.type only supports enabled" (docs.bigmodel.cn + docs.z.ai,
    // 2026-08-26) — a mandatory reasoner, so the thinking-off keys must stay ABSENT and
    // the reasoner effort cap applies. This is the model OpenRouter previewed as ox-alpha;
    // that pin is retired onto this id.
    { model: 'glm-5.3-flash', tokenKey: 'max_tokens', note: 'Zhipu OpenAI-compat; thinking mandatory, no thinking-off switch',
      expect: (a) => {
        expect(a.model).toBe('glm-5.3-flash')
        expect(a.reasoning_effort).toBe('low')
        expect(a.thinking).toBeUndefined()
        expect(a.enable_thinking).toBeUndefined()
      } },
    { model: 'glm-4.7-flashx', tokenKey: 'max_tokens', note: 'disableThinking → thinking off',
      expect: (a) => { expect(a.thinking).toEqual({ type: 'disabled' }) } },
    { model: 'qwen3.8-max', tokenKey: 'max_tokens', note: 'DashScope OpenAI-compat' },
    { model: 'qwen3.7-flash', tokenKey: 'max_tokens', note: 'DashScope disableThinking → enable_thinking:false',
      expect: (a) => { expect(a.enable_thinking).toBe(false) } },
    // qwen3.8-flash: thinking is OFF by default upstream (qianwenai.com / qwencloud.com
    // cards, 2026-08-27) and disableThinking pins that on the wire — same DashScope key as
    // the qwen3.7 line, no reasoner effort cap, no Zhipu-shaped thinking object.
    { model: 'qwen3.8-flash', tokenKey: 'max_tokens', note: 'DashScope disableThinking → enable_thinking:false (off by default upstream, pinned)',
      expect: (a) => {
        expect(a.model).toBe('qwen3.8-flash')
        expect(a.enable_thinking).toBe(false)
        expect(a.thinking).toBeUndefined()
        expect(a.reasoning_effort).toBeUndefined()
      } },
    { model: 'grok-4', tokenKey: 'max_tokens', note: 'xAI OpenAI-compat' },
    { model: 'gemini-3.7-flash', tokenKey: 'max_tokens', note: 'Google AI Studio OpenAI-compat' },
    { model: 'claude-opus-5', tokenKey: 'max_tokens', note: 'Anthropic OpenAI-compat layer takes max_tokens' }
  ]

  for (const c of CASES) {
    it(`${c.model}: ${c.tokenKey} (${c.note})`, async () => {
      const arg = await bodyFor(c.model)
      expect(arg[c.tokenKey], `${c.model} must send ${c.tokenKey}`).toBeDefined()
      const otherKey = c.tokenKey === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'
      expect(arg[otherKey], `${c.model} must NOT send ${otherKey}`).toBeUndefined()
      c.expect?.(arg as Record<string, unknown>)
    })
  }
})
