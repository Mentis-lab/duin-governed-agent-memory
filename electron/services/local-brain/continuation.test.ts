import { describe, it, expect } from 'vitest'
import {
  CONTINUE_PROMPT,
  CONTEXT_HEADROOM,
  continuationVerdict,
  estimateTokens,
  maxContinuations
} from './continuation'

const base = {
  truncated: true,
  continuations: 0,
  maxContinuations: 64,
  sliceChars: 5000,
  answerText: 'x'.repeat(5000),
  contextWindow: 0
}

describe('continuationVerdict', () => {
  it('continues a capped answer — the operator-visible output limit is gone', () => {
    expect(continuationVerdict(base)).toBe('continue')
  })

  it('does nothing when the model stopped because it was FINISHED', () => {
    // finishReason 'stop' — the overwhelmingly common case. Continuation must never
    // fire here or every normal answer would be pointlessly extended.
    expect(continuationVerdict({ ...base, truncated: false })).toBe('not-truncated')
  })

  // ANTI-LIVELOCK. A model can report 'length' while emitting nothing at all — reasoning is
  // billed against the same budget, so it can exhaust the cap before writing one character.
  // Without this the turn would ask for a continuation forever, each round producing nothing
  // and re-latching truncated.
  it('refuses to continue an EMPTY slice', () => {
    expect(continuationVerdict({ ...base, sliceChars: 0 })).toBe('empty-slice')
  })

  it('stops at the continuation budget', () => {
    expect(continuationVerdict({ ...base, continuations: 64 })).toBe('budget-exhausted')
    expect(continuationVerdict({ ...base, continuations: 63 })).toBe('continue')
  })

  it('disables continuation entirely at 0, restoring stop-at-the-cap', () => {
    expect(continuationVerdict({ ...base, maxContinuations: 0 })).toBe('budget-exhausted')
  })

  // Each slice is appended to the prompt, so the request grows with the answer. Stopping
  // here trades a bounded answer for a provider-side context_length_exceeded fired
  // mid-document, which has no good user-facing form.
  describe('context headroom', () => {
    const ctx = 200_000
    // The gate is CONTEXT_HEADROOM of the window, measured in ESTIMATED TOKENS.
    const latinCharsAtLimit = ctx * CONTEXT_HEADROOM * 3.5

    it('continues while the answer still fits', () => {
      expect(
        continuationVerdict({ ...base, contextWindow: ctx, answerText: 'x'.repeat(latinCharsAtLimit - 20_000) })
      ).toBe('continue')
    })

    it('stops once the answer approaches the context window', () => {
      expect(
        continuationVerdict({ ...base, contextWindow: ctx, answerText: 'x'.repeat(latinCharsAtLimit + 20_000) })
      ).toBe('context-full')
    })

    it('treats an unknown window (0) as no constraint, not as a zero-size one', () => {
      expect(continuationVerdict({ ...base, contextWindow: 0, answerText: 'x'.repeat(5_000_000) }))
        .toBe('continue')
    })

    it('a 1M-context model carries a genuinely long document', () => {
      expect(continuationVerdict({ ...base, contextWindow: 1_000_000, answerText: 'x'.repeat(230_000) }))
        .toBe('continue')
    })

    // REGRESSION PIN. A single chars-per-token ratio cannot serve both scripts, and a flat 3 was
    // wrong for the one this operator uses most: CJK is DENSER (~1.26 chars/token measured), and
    // denser means FEWER chars per token, so dividing Chinese by 3 under-counted its tokens by
    // more than half. The guard then declared a 128k-window model safe while it was already past
    // its real limit — and the failure behind the guard is an unhandled provider rejection.
    it('does not under-count Chinese — the same char count stops sooner than Latin', () => {
      const chars = 120_000
      const ctxSmall = 128_000
      expect(continuationVerdict({ ...base, contextWindow: ctxSmall, answerText: 'x'.repeat(chars) }))
        .toBe('continue')
      expect(continuationVerdict({ ...base, contextWindow: ctxSmall, answerText: '一'.repeat(chars) }))
        .toBe('context-full')
    })
  })

  describe('estimateTokens', () => {
    it('counts CJK as far more tokens per character than Latin', () => {
      expect(estimateTokens('一'.repeat(1000))).toBeGreaterThan(estimateTokens('x'.repeat(1000)) * 2)
    })

    it('handles a mixed-script answer, which is what this operator actually writes', () => {
      const mixed = '北澜 playtest 的 booth 预算是 920万'
      // Between the pure-Latin and pure-CJK estimates for the same length — i.e. it is
      // actually weighing the two scripts rather than picking one ratio for the whole string.
      expect(estimateTokens(mixed)).toBeGreaterThan(estimateTokens('x'.repeat(mixed.length)))
      expect(estimateTokens(mixed)).toBeLessThan(estimateTokens('一'.repeat(mixed.length)))
    })

    it('is zero for empty text and never negative', () => {
      expect(estimateTokens('')).toBe(0)
    })
  })

  // Ordering matters: a caller that only checks `=== 'continue'` is unaffected, but the
  // reason it gets back must name the REAL blocker so the terminal can explain itself.
  it('reports the most specific blocker when several apply', () => {
    expect(
      continuationVerdict({ ...base, sliceChars: 0, continuations: 99, contextWindow: 1000 })
    ).toBe('empty-slice')
  })
})

describe('maxContinuations', () => {
  it('defaults to 64 slices — past any real request, present only to bound a looping model', () => {
    expect(maxContinuations({} as NodeJS.ProcessEnv)).toBe(64)
  })

  it('honours DUIN_MAX_CONTINUATIONS, including 0 to switch continuation off', () => {
    expect(maxContinuations({ DUIN_MAX_CONTINUATIONS: '5' } as never)).toBe(5)
    expect(maxContinuations({ DUIN_MAX_CONTINUATIONS: '0' } as never)).toBe(0)
  })

  it('ignores junk rather than disabling itself on a typo', () => {
    expect(maxContinuations({ DUIN_MAX_CONTINUATIONS: 'lots' } as never)).toBe(64)
    expect(maxContinuations({ DUIN_MAX_CONTINUATIONS: '-1' } as never)).toBe(64)
  })
})

describe('CONTINUE_PROMPT', () => {
  // The seam is where continuation shows. The prompt has to suppress the three reflexes
  // that would corrupt it, so pin them: no repetition, no re-introduction, no apology.
  it('suppresses repeating, re-introducing, and apologising', () => {
    expect(CONTINUE_PROMPT).toMatch(/do not repeat/i)
    expect(CONTINUE_PROMPT).toMatch(/do not re-introduce/i)
    expect(CONTINUE_PROMPT).toMatch(/do not apologise|do not apologize/i)
    expect(CONTINUE_PROMPT).toMatch(/exactly where it stopped/i)
  })

  it('tells the model WHY it stopped, so it does not infer it was interrupted or failed', () => {
    expect(CONTINUE_PROMPT).toMatch(/not because it was finished/i)
  })
})
