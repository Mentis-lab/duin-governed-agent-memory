import { describe, it, expect } from 'vitest'
import { withPrefillCacheMarkers, needsExplicitCacheMarkers, stableLayoutActive } from './prefill-cache'

const THREAD = [
  { role: 'system', content: 'STABLE CORE' },
  { role: 'user', content: 'q1' },
  { role: 'assistant', content: 'a1' },
  { role: 'user', content: 'CONTEXT ...\n\nq2' }
]

describe('prefill cache markers', () => {
  it('marks Anthropic-via-OpenRouter only, and only under the stable layout', () => {
    expect(needsExplicitCacheMarkers('anthropic/claude-sonnet-4.5', true)).toBe(true)
    expect(needsExplicitCacheMarkers('deepseek-v4-pro', true)).toBe(false)
    expect(needsExplicitCacheMarkers('google/gemma-4-31b-it', true)).toBe(false)
  })

  it('NEVER marks under the legacy layout — a write-only cache is a pure cost regression', () => {
    // Anthropic bills a cache write at ~1.25x input and refunds it only on a later read. Under the
    // legacy layout message[0] carries the per-turn CONTEXT, so its prefix hash differs every turn:
    // every request would write an entry nothing can ever match. Marking must stay off until the
    // byte-stable layout gives the breakpoint something reusable to point at.
    expect(needsExplicitCacheMarkers('anthropic/claude-sonnet-4.5', false)).toBe(false)
    expect(withPrefillCacheMarkers(THREAD, 'anthropic/claude-sonnet-4.5', false)).toBe(THREAD)
  })

  it('defaults the gate to the DUIN_STABLE_PREFIX env flag', () => {
    const expected = process.env.DUIN_STABLE_PREFIX === '1'
    expect(stableLayoutActive()).toBe(expected)
    // with the flag off (the default in this suite) the default-arg call must be a no-op
    if (!expected) expect(withPrefillCacheMarkers(THREAD, 'anthropic/claude-opus-4.1')).toBe(THREAD)
  })

  it('returns auto-caching providers UNTOUCHED (same reference, no wire change)', () => {
    expect(withPrefillCacheMarkers(THREAD, 'deepseek-v4-pro', true)).toBe(THREAD)
  })

  it('marks the stable system core and the end of the stable history prefix', () => {
    const out = withPrefillCacheMarkers(THREAD, 'anthropic/claude-sonnet-4.5', true) as any[]
    expect(out[0].content).toEqual([
      { type: 'text', text: 'STABLE CORE', cache_control: { type: 'ephemeral' } }
    ])
    // breakpoint 2 = the assistant turn just before the final user message. This is deliberately
    // NOT the final message: that one carries the volatile tail, which is stripped before the next
    // turn re-sends it, so a breakpoint there would write a prefix that can never recur.
    expect(out[2].content[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(out[3].content).toBe('CONTEXT ...\n\nq2')
  })

  it('does not mutate the caller array', () => {
    const input = THREAD.map((m) => ({ ...m }))
    withPrefillCacheMarkers(input, 'anthropic/claude-opus-4.1', true)
    expect(input[0].content).toBe('STABLE CORE')
  })

  it('sets no history breakpoint on turn 1 (nothing stable to reuse yet)', () => {
    const t1 = [
      { role: 'system', content: 'STABLE CORE' },
      { role: 'user', content: 'CONTEXT ...\n\nq1' }
    ]
    const out = withPrefillCacheMarkers(t1, 'anthropic/claude-haiku-4.5', true) as any[]
    expect(Array.isArray(out[0].content)).toBe(true)
    expect(out[1].content).toBe('CONTEXT ...\n\nq1')
  })

  it('leaves already-part-array content alone', () => {
    const pre = [{ role: 'system', content: [{ type: 'text', text: 'x' }] }]
    const out = withPrefillCacheMarkers(pre, 'anthropic/claude-sonnet-4.5', true) as any[]
    expect(out[0].content).toEqual([{ type: 'text', text: 'x' }])
  })

  it('handles an empty message list', () => {
    expect(withPrefillCacheMarkers([], 'anthropic/claude-sonnet-4.5', true)).toEqual([])
  })

  it('marks the END of a multi-block system run, not blindly index 0', () => {
    // Regression guard: another feature (server.ts under DUIN_FORWARD_NOTES) can prepend its own
    // system block ahead of the stable core. Marking index 0 would cut the cached region short of
    // the core — the exact thing the breakpoint exists to cache.
    const withPrepended = [
      { role: 'system', content: 'FORWARD NOTES (volatile)' },
      { role: 'system', content: 'STABLE CORE' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'CONTEXT ...\n\nq2' }
    ]
    const out = withPrefillCacheMarkers(withPrepended, 'anthropic/claude-sonnet-4.5', true) as any[]
    expect(out[0].content).toBe('FORWARD NOTES (volatile)') // untouched
    expect(out[1].content[0]).toEqual({
      type: 'text',
      text: 'STABLE CORE',
      cache_control: { type: 'ephemeral' }
    })
  })
})
