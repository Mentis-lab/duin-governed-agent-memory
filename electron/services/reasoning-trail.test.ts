// R6 reasoning-trail tests, extracted from final-response-composer.test.ts
// when UB-5 excised the composer. The trail itself is kept (user-directed
// reasoning audit): multi-round turns persist every round's chain-of-thought.

import { describe, it, expect } from 'vitest'
import { concatReasoningTrail, MAX_REASONING_BYTES } from './reasoning-trail'

describe('concatReasoningTrail (R6, kept through UB-5)', () => {
  it('returns undefined when nothing has reasoning', () => {
    expect(concatReasoningTrail([], undefined)).toBeUndefined()
    expect(concatReasoningTrail(['', '   ', undefined], undefined)).toBeUndefined()
  })

  it('numbers surviving rounds, skipping empty entries before numbering', () => {
    const out = concatReasoningTrail(['first', '', 'third'], undefined)
    expect(out).toContain('--- round 1 ---\nfirst')
    expect(out).toContain('--- round 2 ---\nthird')
    expect(out).not.toContain('--- round 3 ---')
  })

  it('appends the trailing segment last with the historical composer label', () => {
    const out = concatReasoningTrail(['r1'], 'tail')
    expect(out!.endsWith('--- composer ---\ntail')).toBe(true)
  })

  it('single round + no tail keeps just the one numbered block', () => {
    const out = concatReasoningTrail(['only'], undefined)
    expect(out).toBe('--- round 1 ---\nonly')
  })

  it('bounds an over-cap trail and says what it dropped', () => {
    const big = 'x'.repeat(MAX_REASONING_BYTES)
    const out = concatReasoningTrail([big, big], undefined)!
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_REASONING_BYTES)
    expect(out).toContain('elided from the middle')
  })

  // This string is replayed into the NEXT turn as <think>…</think>, so the final rounds —
  // the conclusion the model actually reached — are what the next turn needs most. A
  // head-slice deleted exactly those. Keep both ends.
  it('keeps the LAST round, not just the first', () => {
    const big = 'x'.repeat(MAX_REASONING_BYTES)
    const out = concatReasoningTrail([big, big, 'THE-CONCLUSION'], undefined)!
    expect(out).toContain('--- round 1 ---')
    expect(out).toContain('THE-CONCLUSION')
  })

  // REGRESSION PIN. The budget was checked in UTF-8 BYTES while the cut was made in UTF-16
  // units, so CJK reasoning overflowed the cap it was measured against — and could be severed
  // mid-surrogate. Chinese is the operator's other working language, so this was not exotic.
  it('bounds BYTES for CJK reasoning, not characters', () => {
    const cjk = '思'.repeat(MAX_REASONING_BYTES) // ~3 bytes each — 3x over on its own
    const out = concatReasoningTrail([cjk, cjk], undefined)!
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_REASONING_BYTES)
  })
})
