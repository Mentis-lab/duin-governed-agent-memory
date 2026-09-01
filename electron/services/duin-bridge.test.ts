// Live integration test: prove the DUIN bridge compiles against the real ChatEventMap
// types and that a real turn from a running brain (:8765/agui) arrives as
// chat:chunk + chat:done. Network test; needs the brain running, otherwise it self-skips.

import { describe, it, expect, vi } from 'vitest'
import { streamFromDuin, resolveBrainUrl, mapAndEmit, type ChatEmit } from './duin-bridge'

const BRAIN_HEALTH = 'http://127.0.0.1:8765/health'

async function brainUp(): Promise<boolean> {
  try {
    const r = await fetch(BRAIN_HEALTH, { signal: AbortSignal.timeout(3000) })
    return r.ok
  } catch {
    return false
  }
}

describe('duin-bridge → lamprey chat:* (live brain)', () => {
  it(
    'streams a real DUIN turn as chat:chunk + chat:done',
    async (ctx) => {
      if (!(await brainUp())) {
        console.warn('[spike] DUIN brain not reachable at :8765 — skipping live test')
        ctx.skip()
        return
      }

      const emit = vi.fn() as unknown as ChatEmit
      const calls: Array<[string, unknown]> = []
      ;(emit as unknown as ReturnType<typeof vi.fn>).mockImplementation((ch: string, p: unknown) => {
        calls.push([ch, p])
      })

      const result = await streamFromDuin(
        'Integration test. In ONE short sentence, confirm you are the connected agent/DUIN brain. Do not use any tools.',
        'spike-conv-vitest',
        { emit, threadId: 'spike-thread-vitest' },
      )

      const channels = calls.map((c) => c[0])
      console.log('[spike] AG-UI types:', result.eventTypes)
      console.log('[spike] emitted channels:', channels)
      console.log('[spike] assistant text:', result.text.trim().slice(0, 200))

      expect(result.ok).toBe(true)
      expect(result.chunks).toBeGreaterThan(0)
      expect(result.text.trim().length).toBeGreaterThan(0)
      expect(channels).toContain('chat:chunk')
      expect(channels).toContain('chat:done')
      // every emitted payload carries the conversationId the renderer keys on
      for (const [, p] of calls) {
        expect((p as { conversationId: string }).conversationId).toBe('spike-conv-vitest')
      }
    },
    90_000,
  )
})

describe('mapAndEmit — completeness-retry reset (TEXT_MESSAGE_RESET)', () => {
  const freshAcc = () => ({
    text: '',
    chunks: 0,
    reasoning: 0,
    reasoningText: '',
    toolStarts: new Map<string, number>(),
  })

  it('zeroes the accumulator and emits chat:reset so only the retry prose survives', () => {
    const calls: Array<[string, unknown]> = []
    const emit = ((ch: string, p: unknown) => {
      calls.push([ch, p])
    }) as unknown as ChatEmit
    const acc = freshAcc()

    // Preamble the brain streamed, then discarded.
    mapAndEmit({ type: 'TEXT_MESSAGE_CONTENT', delta: 'Let me pull the ' }, 'c1', emit, acc)
    mapAndEmit({ type: 'TEXT_MESSAGE_CONTENT', delta: 'current state…' }, 'c1', emit, acc)
    expect(acc.text).toBe('Let me pull the current state…')
    expect(acc.chunks).toBe(2)

    // The reset frame the server emits before re-streaming.
    const outcome = mapAndEmit({ type: 'TEXT_MESSAGE_RESET' }, 'c1', emit, acc)
    expect(outcome).toBeNull()
    expect(acc.text).toBe('')
    expect(acc.chunks).toBe(0)
    expect(calls.some(([ch, p]) => ch === 'chat:reset' && (p as { conversationId: string }).conversationId === 'c1')).toBe(true)

    // Clean prose re-streamed after the reset — this is all that should persist.
    mapAndEmit({ type: 'TEXT_MESSAGE_CONTENT', delta: 'The current state is X.' }, 'c1', emit, acc)
    expect(acc.text).toBe('The current state is X.')
    expect(acc.chunks).toBe(1)
  })
})

describe('mapAndEmit — ANSI in the reasoning stream', () => {
  const freshAcc = () => ({
    text: '',
    chunks: 0,
    reasoning: 0,
    reasoningText: '',
    toolStarts: new Map<string, number>(),
  })

  // STEP labels are assembled from tool / retrieval / subprocess output, so any
  // step that shells out can carry terminal escapes. The reasoning card renders
  // markdown, not a terminal, so an unstripped \u001b[1m surfaced in the DOM as a
  // literal "1m". Strip still happens at ingest.
  it('strips escapes from a STEP and shows it on its own line', () => {
    const calls: Array<[string, unknown]> = []
    const emit = ((ch: string, pay: unknown) => {
      calls.push([ch, pay])
    }) as unknown as ChatEmit
    const acc = freshAcc()

    mapAndEmit({ type: 'STEP', label: '\u001b[1msearching\u001b[0m the vault' }, 'c1', emit, acc)

    const reasoningEvents = calls.filter(([ch]) => ch === 'chat:reasoning')
    expect(reasoningEvents).toHaveLength(1)
    expect((reasoningEvents[0][1] as { content: string }).content).toBe('\nsearching the vault\n')
  })

  // REGRESSION PIN (2026-08-05). A STEP is an operator-facing STATUS LINE — the
  // long-turn heartbeat, the retrieval trace, the engine-fallback notice. It must
  // never enter acc.reasoningText, because that string is persisted to
  // `messages.reasoning` and replayed into the NEXT turn as <think>…</think>
  // (chat-history.ts, `includePastReasoningInContext`, default on).
  //
  // The watchdog polls every 5s, so a heartbeat lands wherever it falls — including
  // between two REASONING token frames. While both fed one buffer, a real session
  // persisted `…(I saw DUstill working — round 2/32 · 105s elapsedIN_SHIP_BACKLOG.md…`.
  // The model read that back, found its own thinking spliced with garbage and ending
  // on a heartbeat, and opened the next turn apologising for a truncation that never
  // happened. Status is ephemeral; thinking is the record.
  it('keeps a STEP out of the persisted reasoning, even mid-token', () => {
    const emit = (() => {}) as unknown as ChatEmit
    const acc = freshAcc()

    mapAndEmit({ type: 'REASONING', delta: 'I saw DU' }, 'c1', emit, acc)
    mapAndEmit({ type: 'STEP', label: 'still working — round 2/32 · 105s elapsed' }, 'c1', emit, acc)
    mapAndEmit({ type: 'REASONING', delta: 'IN_SHIP_BACKLOG.md' }, 'c1', emit, acc)

    expect(acc.reasoningText).toBe('I saw DUIN_SHIP_BACKLOG.md')
    expect(acc.reasoningText).not.toContain('still working')
    // Only the two genuine reasoning deltas counted.
    expect(acc.reasoning).toBe(2)
  })

  it('does not emit for a label that was NOTHING BUT an escape sequence', () => {
    const calls: Array<[string, unknown]> = []
    const emit = ((ch: string, pay: unknown) => {
      calls.push([ch, pay])
    }) as unknown as ChatEmit
    const acc = freshAcc()

    mapAndEmit({ type: 'THINKING', delta: '\u001b[0m' }, 'c1', emit, acc)

    expect(acc.reasoningText).toBe('')
    expect(acc.reasoning).toBe(0)
    expect(calls.filter(([ch]) => ch === 'chat:reasoning')).toHaveLength(0)
  })

  it('leaves clean reasoning byte-identical', () => {
    const acc = freshAcc()
    const emit = (() => {}) as unknown as ChatEmit
    mapAndEmit({ type: 'REASONING', delta: 'weighing option A vs B' }, 'c1', emit, acc)
    expect(acc.reasoningText).toBe('weighing option A vs B')
  })
})

describe('duin-bridge demo fallback (no brain)', () => {
  it('emits a friendly demo reply when the brain is unreachable', async () => {
    const calls: Array<[string, unknown]> = []
    const emit = ((ch: string, p: unknown) => {
      calls.push([ch, p])
    }) as unknown as ChatEmit

    // Point at a port nothing is listening on so fetch rejects (connection refused).
    const result = await streamFromDuin('hello', 'demo-conv', {
      emit,
      brainUrl: 'http://127.0.0.1:1/agui',
    })

    const channels = calls.map((c) => c[0])
    expect(result.ok).toBe(true)
    expect(result.chunks).toBeGreaterThan(0)
    expect(channels).toContain('chat:chunk')
    expect(channels).toContain('chat:done')
    expect(channels).not.toContain('chat:error')
    expect(result.text.toLowerCase()).toContain('demo')
    for (const [, p] of calls) {
      expect((p as { conversationId: string }).conversationId).toBe('demo-conv')
    }
  })
})

describe('resolveBrainUrl', () => {
  it('prefers explicit, then env, then the localhost default', () => {
    const prev = process.env.DUIN_BRAIN_URL
    delete process.env.DUIN_BRAIN_URL
    // Default now points at the in-process LOCAL brain (:8799), so a fresh
    // install works with no external server. Explicit / env still win.
    expect(resolveBrainUrl()).toBe('http://127.0.0.1:8799/agui')
    expect(resolveBrainUrl('http://example.test/agui')).toBe('http://example.test/agui')
    process.env.DUIN_BRAIN_URL = 'http://env.test/agui'
    expect(resolveBrainUrl()).toBe('http://env.test/agui')
    expect(resolveBrainUrl('http://explicit.test/agui')).toBe('http://explicit.test/agui')
    if (prev === undefined) delete process.env.DUIN_BRAIN_URL
    else process.env.DUIN_BRAIN_URL = prev
  })

  it('coerces a :8765 stub-sidecar target back to the :8799 real brain', () => {
    const prev = process.env.DUIN_BRAIN_URL
    // A stale DUIN_BRAIN_URL / old deploy env pointing chat at the stub sidecar
    // must NOT be honored — :8765 is AGUI_BRAIN=stub and only echoes "You said: …".
    process.env.DUIN_BRAIN_URL = 'http://127.0.0.1:8765/agui'
    expect(resolveBrainUrl()).toBe('http://127.0.0.1:8799/agui')
    // Explicit :8765 (e.g. a mis-set Brain setting) is coerced too.
    expect(resolveBrainUrl('http://127.0.0.1:8765/agui')).toBe('http://127.0.0.1:8799/agui')
    // A non-8765 explicit/env target is still respected.
    expect(resolveBrainUrl('http://example.test/agui')).toBe('http://example.test/agui')
    if (prev === undefined) delete process.env.DUIN_BRAIN_URL
    else process.env.DUIN_BRAIN_URL = prev
  })
})

describe('mapAndEmit — TOOL_CALL_END status (backlog finding 25)', () => {
  const freshAcc = () => ({
    text: '',
    chunks: 0,
    reasoning: 0,
    reasoningText: '',
    toolStarts: new Map<string, number>()
  })

  const endWith = (result: string): { status?: string; result?: string } => {
    const calls: Array<[string, unknown]> = []
    const emit = ((ch: string, p: unknown) => {
      calls.push([ch, p])
    }) as unknown as ChatEmit
    const acc = freshAcc()
    mapAndEmit({ type: 'TOOL_CALL_START', toolCallId: 't1', toolName: 'run_command' }, 'c1', emit, acc)
    mapAndEmit({ type: 'TOOL_CALL_END', toolCallId: 't1', result }, 'c1', emit, acc)
    const hit = calls.find(([ch]) => ch === 'chat:tool-call-result')
    return (hit?.[1] ?? {}) as { status?: string; result?: string }
  }

  it('does not report a deny-first gate refusal as success', () => {
    // The real string agui-guard's deniedResult() produces.
    const denial =
      "Error: 'run_command' was blocked by DUIN's deny-first execution gate — this turn is not " +
      'authorized to run system commands or perform irreversible file operations.'
    const payload = endWith(denial)
    // This branch hardcoded 'success', so every refusal rendered as a green checkmark.
    expect(payload.status).not.toBe('success')
    expect(payload.status).toBe('error')
    expect(payload.result).toContain('deny-first execution gate')
  })

  it('still reports an ordinary tool result as success', () => {
    expect(endWith('3 notes matched').status).toBe('success')
  })

  it('agrees with the native path on an explicit user denial', () => {
    // classifyToolResult is shared with ipc/chat.ts's resolveToolCall, so the brain
    // path and the native path cannot disagree about what a result string means.
    expect(endWith('Action denied by user.').status).toBe('denied')
  })

  it('reports an error result as an error', () => {
    expect(endWith('Error: file not found').status).toBe('error')
  })
})
