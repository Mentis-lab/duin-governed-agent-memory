import { describe, it, expect } from 'vitest'
import {
  stableCoreOf,
  layoutStablePrefixMessages,
  cacheablePrefixOf,
  verifyStableLayout,
  type PromptMessage
} from './prompt-layout.mjs'

// The point of the stable-prefix layout is a PROPERTY, not a shape: everything the provider
// prefill cache keys on must be byte-identical from one turn to the next, while the per-turn
// grounding still reaches the model. These tests assert that property directly — a layout that
// merely "looks split" but lets a volatile byte leak into the cached prefix fails here.

const CORE = {
  preamble: 'You are DUIN. Rules follow.',
  brainGrounding: 'BRAIN: the operator is Theo.',
  memoryIndex: 'MEMORY: prefers terse answers.'
}

/** Two consecutive turns of the same thread, with genuinely different per-turn grounding. */
const TURN_1_TAIL = 'RETRIEVAL: agentic.\n\nCONTEXT (retrieved for: what is lamprey?):\nlamprey.md — a fish.'
const TURN_2_TAIL = 'RETRIEVAL: fallback.\n\nCONTEXT (retrieved for: when is BW?):\nbw.md — July.'

const HISTORY_1: PromptMessage[] = [{ role: 'user', content: 'what is lamprey?' }]
const HISTORY_2: PromptMessage[] = [
  { role: 'user', content: 'what is lamprey?' },
  { role: 'assistant', content: 'A fish [lamprey.md].' },
  { role: 'user', content: 'when is BW?' }
]

describe('stable-prefix layout', () => {
  it('keeps message[0] byte-identical across turns with different grounding', () => {
    const t1 = layoutStablePrefixMessages(CORE, HISTORY_1, TURN_1_TAIL)
    const t2 = layoutStablePrefixMessages(CORE, HISTORY_2, TURN_2_TAIL)
    expect(t1[0].role).toBe('system')
    expect(t1[0].content).toBe(t2[0].content)
  })

  it('keeps the WHOLE cacheable prefix of turn 2 an extension of turn 1', () => {
    // This is the real cache property: turn 2's prefix must START with turn 1's stable prefix,
    // otherwise the provider re-prefills the thread from the first differing byte.
    const t1 = layoutStablePrefixMessages(CORE, HISTORY_1, TURN_1_TAIL)
    const t2 = layoutStablePrefixMessages(CORE, HISTORY_2, TURN_2_TAIL)
    expect(cacheablePrefixOf(t2).startsWith(cacheablePrefixOf(t1))).toBe(true)
  })

  it('leaks NO volatile turn content into the cacheable prefix', () => {
    const t2 = layoutStablePrefixMessages(CORE, HISTORY_2, TURN_2_TAIL)
    const prefix = cacheablePrefixOf(t2)
    expect(prefix).not.toContain('CONTEXT (retrieved for:')
    expect(prefix).not.toContain('RETRIEVAL:')
    expect(prefix).not.toContain('when is BW?')
  })

  it('still delivers the volatile grounding — on the last user message', () => {
    const msgs = layoutStablePrefixMessages(CORE, HISTORY_2, TURN_2_TAIL)
    const last = msgs[msgs.length - 1]
    expect(last.role).toBe('user')
    expect(last.content).toContain('CONTEXT (retrieved for: when is BW?)')
    expect(last.content).toContain('bw.md — July.')
    // the user's actual question survives, and comes AFTER the grounding
    expect(typeof last.content === 'string' && last.content.endsWith('when is BW?')).toBe(true)
  })

  it('preserves the wire shape: one leading system message, then history verbatim', () => {
    const msgs = layoutStablePrefixMessages(CORE, HISTORY_2, TURN_2_TAIL)
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    // earlier turns are untouched — only the FINAL user message carries the tail
    expect(msgs[1].content).toBe('what is lamprey?')
    expect(msgs[2].content).toBe('A fish [lamprey.md].')
  })

  it('drops empty core blocks instead of emitting dead separators', () => {
    const core = stableCoreOf({ preamble: 'P', brainGrounding: '', memoryIndex: '' })
    expect(core).toBe('P')
  })

  it('omits an absent language directive entirely — the byte-identical default', () => {
    // The reply-language feature is default-off ('auto'), and this is what makes that free: an
    // absent/empty directive must leave the core byte-for-byte what it was before the field existed.
    expect(stableCoreOf({ ...CORE, languageDirective: '' })).toBe(stableCoreOf(CORE))
    expect(stableCoreOf({ ...CORE, languageDirective: undefined })).toBe(stableCoreOf(CORE))
  })

  it('places the language directive FIRST in the core, and keeps the core stable across turns', () => {
    const withLang = { ...CORE, languageDirective: 'RESPONSE LANGUAGE: reply in 日本語 (Japanese).' }
    const core = stableCoreOf(withLang)
    expect(core.startsWith('RESPONSE LANGUAGE: reply in 日本語 (Japanese).')).toBe(true)
    expect(core).toContain(CORE.preamble)
    // Turn-invariant ⇒ it must not break the prefill cache: two turns yield the same core, and the
    // directive never leaks into the volatile tail.
    const t1 = layoutStablePrefixMessages(withLang, HISTORY_1, TURN_1_TAIL)
    const t2 = layoutStablePrefixMessages(withLang, HISTORY_2, TURN_2_TAIL)
    expect(t1[0].content).toBe(t2[0].content)
    expect(cacheablePrefixOf(t2).startsWith(cacheablePrefixOf(t1))).toBe(true)
  })

  it('never DROPS the turn grounding when history has no user message', () => {
    // Degenerate shape DUIN does not produce today, but silently discarding the retrieved
    // CONTEXT would be a correctness bug, not a layout nicety.
    const msgs = layoutStablePrefixMessages(CORE, [{ role: 'assistant', content: 'hi' }], TURN_1_TAIL)
    expect(msgs.some((m) => typeof m.content === 'string' && m.content.includes('CONTEXT (retrieved for:'))).toBe(true)
  })

  it('is pure — identical inputs produce identical bytes', () => {
    expect(stableCoreOf(CORE)).toBe(stableCoreOf({ ...CORE }))
  })

  it('self-verifies for the instrument — the same check the benchmark executes', () => {
    // verifyStableLayout() is what scripts/efficiency-benchmark.mjs RUNS to score
    // ctx.byte-stable-prefix. Asserting it here keeps the instrument's proof and the suite's proof
    // from drifting apart: if this fails, the benchmark's tier drops too.
    expect(verifyStableLayout()).toEqual({
      pass: true,
      coreStable: true,
      grows: true,
      noLeak: true,
      delivered: true
    })
  })
})
