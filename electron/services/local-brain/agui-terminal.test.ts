// R3/Phase-2 — the deadline timer emits THIS terminal sequence independent of the round loop. The
// frames must uphold the AG-UI terminal contract: a RUN_ERROR (telemetry / bridge chat:error) then
// a clean close (TEXT_MESSAGE_END + RUN_FINISHED) so a wedged fan-out can never leave the turn
// without a terminal frame, and the client always unblocks.

import { describe, it, expect } from 'vitest'
import {
  deadlineTerminalFrames,
  DEADLINE_TIMEOUT_NOTE,
  OUTPUT_CAP_NOTE,
  OUTPUT_CAP_EMPTY_NOTE,
  CONTEXT_FULL_NOTE
} from './agui-terminal'

describe('deadlineTerminalFrames — deadline terminal contract', () => {
  it('emits RUN_ERROR first and RUN_FINISHED last', () => {
    const frames = deadlineTerminalFrames()
    expect(frames[0].type).toBe('RUN_ERROR')
    expect(frames[frames.length - 1].type).toBe('RUN_FINISHED')
  })

  it('carries the time-budget message on RUN_ERROR and closes the message stream', () => {
    const frames = deadlineTerminalFrames()
    const types = frames.map((f) => f.type)
    expect(types).toEqual(['RUN_ERROR', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED'])
    expect(frames[0].message).toBe('turn exceeded the time budget')
    expect(frames[1].delta).toBe(DEADLINE_TIMEOUT_NOTE)
  })

  it('exactly one RUN_FINISHED (single terminal) and one RUN_ERROR', () => {
    const frames = deadlineTerminalFrames()
    expect(frames.filter((f) => f.type === 'RUN_FINISHED')).toHaveLength(1)
    expect(frames.filter((f) => f.type === 'RUN_ERROR')).toHaveLength(1)
  })

  it('is a fresh array each call (no shared mutable frame state across turns)', () => {
    expect(deadlineTerminalFrames()).not.toBe(deadlineTerminalFrames())
    expect(deadlineTerminalFrames()).toEqual(deadlineTerminalFrames())
  })
})

// A turn that ends on finishReason 'length' used to emit a bare RUN_FINISHED — byte-identical to a
// turn that finished. The operator saw a document that stopped mid-sentence reported as success,
// which is the exact metric that fooled the 2026-08-03 acceptance pass (RUN_FINISHED + a character
// count, both true, both meaningless). It reuses this sequence rather than adding a frame type:
// duin-bridge already renders RUN_ERROR-with-text as a kept annotated message, and the bench
// harnesses break on a fixed tuple and would hang on an unknown terminal.
describe('deadlineTerminalFrames — output-cap truncation is distinguishable from success', () => {
  it('says the response was truncated, not that the turn ran out of time', () => {
    const frames = deadlineTerminalFrames('output-cap')
    expect(frames.map((f) => f.type)).toEqual([
      'RUN_ERROR',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED'
    ])
    expect(frames[0].message).toBe('response truncated — continuation budget exhausted')
    expect(frames[1].delta).toBe(OUTPUT_CAP_NOTE)
  })

  it('does not reuse the deadline note — the remedy differs (continue vs. narrow the request)', () => {
    expect(OUTPUT_CAP_NOTE).not.toBe(DEADLINE_TIMEOUT_NOTE)
    expect(deadlineTerminalFrames('output-cap')[1].delta).not.toBe(DEADLINE_TIMEOUT_NOTE)
    expect(deadlineTerminalFrames('max-wallclock')[1].delta).toBe(DEADLINE_TIMEOUT_NOTE)
  })

  // Continuation makes the per-response cap invisible, so a turn that still stops has hit one of
  // the REAL limits — and they do not share a remedy. `context-full` means the answer grew until it
  // crowded out room to write more, so "ask me to continue" is exactly the advice that cannot work:
  // the next request is the one that overflows. It must not reuse the output-cap note.
  it('context-full gets its own note, because "continue" is the wrong advice there', () => {
    const frames = deadlineTerminalFrames('context-full')
    expect(frames[0].message).toBe('response truncated — the answer filled the context window')
    expect(frames[1].delta).toBe(CONTEXT_FULL_NOTE)
    expect(frames[1].delta).not.toBe(OUTPUT_CAP_NOTE)
    expect(CONTEXT_FULL_NOTE).toMatch(/will not get further|start a fresh one/i)
  })

  it('still upholds the terminal contract: exactly one RUN_FINISHED, RUN_ERROR first', () => {
    const frames = deadlineTerminalFrames('output-cap')
    expect(frames[0].type).toBe('RUN_ERROR')
    expect(frames.filter((f) => f.type === 'RUN_FINISHED')).toHaveLength(1)
    expect(frames[frames.length - 1].type).toBe('RUN_FINISHED')
  })

  it('every cut reason produces a distinct RUN_ERROR message (property 8)', () => {
    const messages = (
      ['stalled', 'max-wallclock', 'output-cap', 'output-cap-empty', 'context-full', 'max-rounds'] as const
    ).map(
      (r) => deadlineTerminalFrames(r)[0].message
    )
    // Assert the PROPERTY (all distinct), not a count — a hardcoded 4 fails the moment a new
    // cut reason is added, which is noise rather than signal about the property itself.
    expect(new Set(messages).size).toBe(messages.length)
  })

  // Measured against the live Zhipu API 2026-08-03: at max_tokens=512 the response returned
  // completion_tokens=512 with reasoning_tokens=508 and content = ''. Reasoning is billed against
  // the same budget, so the cap can bind before a single character of ANSWER is written. Told
  // "stops mid-thought" above an empty reply, an operator reads a bug; they need to be told the
  // allowance went on thinking.
  it('distinguishes "truncated mid-document" from "budget spent before answering"', () => {
    const partial = deadlineTerminalFrames('output-cap')
    const empty = deadlineTerminalFrames('output-cap-empty')
    expect(empty[0].message).not.toBe(partial[0].message)
    expect(empty[1].delta).toBe(OUTPUT_CAP_EMPTY_NOTE)
    expect(empty[1].delta).not.toBe(OUTPUT_CAP_NOTE)
    // The empty case must explain WHERE the budget went, or it reads as a silent failure.
    expect(String(empty[1].delta)).toMatch(/reasoning|thinking/i)
  })
})
