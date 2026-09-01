import { describe, it, expect, vi } from 'vitest'
import { isIncompleteAnswer, finalizeAnswer, type GenResult } from './answer-completeness'

// MITIGATION coverage: the bare tool-call preamble quirk (DeepSeek V4 Pro etc.).
// The chat answer path (server.ts handleAgui) calls chatStream on the primary
// round, then finalizeAnswer with a `regenerate` closure that wraps ONE more
// chatStream. These tests exercise the seam directly: `regenerate` stands in for
// the mocked call-2 chatStream, and the primary (call-1) result is passed in.

describe('isIncompleteAnswer (narrow trigger)', () => {
  it('flags a turn that streamed nothing substantive', () => {
    expect(isIncompleteAnswer('', [])).toBe(true)
    expect(isIncompleteAnswer('   \n ', [])).toBe(true)
    expect(isIncompleteAnswer('', [{ id: 't1' }])).toBe(true)
  })

  it('flags a bare narration preamble that left native tool calls behind', () => {
    expect(isIncompleteAnswer('Let me pull the current state of your notes:', [{ id: 't1' }])).toBe(true)
    expect(isIncompleteAnswer("I'll check that for you", [{ id: 't1' }])).toBe(true)
  })

  it('does NOT flag a normal complete answer — no blanket short=fail', () => {
    // Terse but legitimate — must pass untouched.
    expect(isIncompleteAnswer('Yes.', [])).toBe(false)
    expect(isIncompleteAnswer('42.', [])).toBe(false)
    expect(isIncompleteAnswer('The top priority this week is the playtest.', [])).toBe(false)
    // A narration-looking string with NO tool calls is a normal answer, not the quirk.
    expect(isIncompleteAnswer('Let me know if you want more:', [])).toBe(false)
    // A real answer that happens to carry a stray tool call is not flagged.
    expect(isIncompleteAnswer('Done — I wrote the note to DUIN/x.md.', [{ id: 't1' }])).toBe(false)
  })
})

describe('finalizeAnswer (one-retry mitigation)', () => {
  it('passes a complete answer through WITHOUT re-generating', async () => {
    const regenerate = vi.fn(async (): Promise<GenResult> => ({ content: 'should not run', toolCalls: [] }))
    const out = await finalizeAnswer('The answer is 42.', [], { regenerate })
    expect(out).toEqual({ status: 'ok', text: 'The answer is 42.' })
    expect(regenerate).not.toHaveBeenCalled()
  })

  it('retries once and surfaces the full answer when the primary is a bare preamble', async () => {
    // call 1 (passed in): bare preamble + native tool call, no substantive prose.
    // call 2 (regenerate): a full answer.
    const regenerate = vi.fn(async (): Promise<GenResult> => ({
      content: 'Your top priority this week is the playtest.',
      toolCalls: []
    }))
    const log = vi.fn()
    const out = await finalizeAnswer('Let me pull the current state of your notes:', [{ id: 't1' }], {
      regenerate,
      log
    })
    expect(out).toEqual({ status: 'ok', text: 'Your top priority this week is the playtest.' })
    expect(regenerate).toHaveBeenCalledTimes(1) // exactly one retry, no loop
    expect(log).toHaveBeenCalledTimes(1) // the quirk is logged/observable
  })

  it('surfaces an error (not a persisted preamble) when BOTH the primary and the retry are empty', async () => {
    const regenerate = vi.fn(async (): Promise<GenResult> => ({ content: '', toolCalls: [{ id: 't2' }] }))
    const out = await finalizeAnswer('', [{ id: 't1' }], { regenerate })
    expect(out).toEqual({ status: 'error' })
    expect(regenerate).toHaveBeenCalledTimes(1) // still capped at one retry
  })
})
