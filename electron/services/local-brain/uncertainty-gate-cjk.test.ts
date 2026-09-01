import { describe, it, expect } from 'vitest'
import { shouldInjectRecall, estimateTokens, isSubstantive } from './uncertainty-gate'

// LANGUAGE-PARITY PIN for the uncertainty gate (G3).
//
// THE DEFECT. `substantive` was `q.length >= 12 || q.split(/\s+/).length >= 3`. Both clauses are
// latin-shaped: CJK is written without word spaces (so a whole sentence counts as ONE "word"), and
// a CJK codepoint carries roughly a whole token (so a 12-codepoint threshold is a ~12-token
// sentence, ~4× stricter than the same clause in latin). A short Chinese question therefore fell
// through to the short-query arm — and the thin-retrieval arm could not fire either, because
// THIN_RETRIEVAL_MAX = 0.35 sat below the entire observed rawScore band. Both arms dead ⇒ the turn
// lost BOTH the query-relevant recall AND the whole-dump fallback (agui-grounding gates the
// fallback on the same `uncertaintySkip`).
//
// The pin is PAIRS: the same question in both scripts must reach the same verdict. A one-sided
// test would pass again the moment someone re-latinises the heuristic.
//
// The lint registry (scripts/language-parity-lint.mjs) pins `uncertainty-gate.test.ts` by path for
// its R2 bilingual check; this file is additive and does not change that verdict.

/** Same question, two scripts. Each pair must land on the same `reason`. */
const PAIRS: { en: string; cjk: string; label: string }[] = [
  { label: 'a mid-length question', en: 'when is the launch window', cjk: '发行档期定了吗' },
  { label: 'a three-token question', en: 'who owns this', cjk: '谁负责这个' },
  { label: 'a Japanese question', en: 'what did we decide', cjk: '何を決めましたか' },
  { label: 'a Korean question', en: 'where is the plan', cjk: '계획은 어디에' }
]

describe('substantive-query — script parity', () => {
  it('counts CJK codepoints as tokens instead of assuming spaces exist', () => {
    // The exact shape the old whitespace split got wrong: one "word", nine tokens.
    expect('北澜的发行档期定了吗'.split(/\s+/).length).toBe(1)
    expect(estimateTokens('北澜的发行档期定了吗')).toBe(10)
    // Latin is unchanged — this must not be a rewrite of the working path.
    expect(estimateTokens('when is the launch window')).toBe(5)
    // Mixed script adds up rather than picking a side.
    expect(estimateTokens('北澜 launch window')).toBe(4)
    // Bare punctuation is not a token.
    expect(estimateTokens('AIT?')).toBe(1)
    expect(estimateTokens('  —  ')).toBe(0)
  })

  for (const { en, cjk, label } of PAIRS) {
    it(`${label} is SUBSTANTIVE in both scripts ("${en}" / "${cjk}")`, () => {
      expect(isSubstantive(en), `latin: ${en}`).toBe(true)
      expect(isSubstantive(cjk), `cjk: ${cjk}`).toBe(true)
      // …and the gate injects on both even when retrieval is confident.
      const hits = [{ score: 1, rawScore: 0.72 }]
      expect(shouldInjectRecall({ query: en, hits })).toMatchObject({
        inject: true,
        reason: 'substantive'
      })
      expect(shouldInjectRecall({ query: cjk, hits })).toMatchObject({
        inject: true,
        reason: 'substantive'
      })
    })
  }

  it('a short Chinese question keeps its operator-memory grounding (the reported defect)', () => {
    // 7 codepoints — under the old 12-char clause and ONE "word" under the old split, so the old
    // heuristic called this non-substantive and (with the dead thin arm) suppressed recall entirely.
    const q = '发行档期定了吗'
    expect(q.length).toBeLessThan(12)
    expect(shouldInjectRecall({ query: q, hits: [{ score: 1, rawScore: 0.72 }] })).toMatchObject({
      inject: true,
      reason: 'substantive'
    })
  })

  it('a CJK acknowledgement is suppressed on confident retrieval, like its latin twin', () => {
    const hits = [{ score: 1, rawScore: 0.72 }]
    for (const [en, cjk] of [
      ['thanks', '谢谢'],
      ['got it', '明白了'],
      ['ok', '好的'],
      ['sure', 'わかりました']
    ]) {
      expect(shouldInjectRecall({ query: en, hits }), `latin: ${en}`).toMatchObject({
        inject: false,
        reason: 'pleasantry'
      })
      expect(shouldInjectRecall({ query: cjk, hits }), `cjk: ${cjk}`).toMatchObject({
        inject: false,
        reason: 'pleasantry'
      })
    }
  })

  it('a bare CJK entity lookup routes to the thin-retrieval arm, like "AIT?"', () => {
    // 2 codepoints: below minSubstantiveChars(CJK)=4 and below the 3-token floor, so it is a short
    // lookup rather than a question — the CJK twin of "AIT?". Thin retrieval ⇒ inject; confident
    // retrieval ⇒ suppress. Both arms must agree across scripts.
    const thin = [{ score: 1, rawScore: 0.4 }]
    const confident = [{ score: 1, rawScore: 0.72 }]
    expect(shouldInjectRecall({ query: 'AIT?', hits: thin }).reason).toBe('thin-retrieval')
    expect(shouldInjectRecall({ query: '北澜', hits: thin }).reason).toBe('thin-retrieval')
    expect(shouldInjectRecall({ query: 'AIT?', hits: confident }).inject).toBe(false)
    expect(shouldInjectRecall({ query: '北澜', hits: confident }).inject).toBe(false)
  })
})

// ── THIN_RETRIEVAL_MAX recalibration (0.35 → 0.432) ──
// Sampled from the measured distribution written down in evidence-gate.ts (real Sample-brain index,
// 12,798 vectors, multilingual-e5-small): OFF-corpus best-hit rawScore spans [0.387, 0.495] and
// on-corpus spans [0.436, 0.744]. At 0.35 NOTHING in either class trips — the arm was unfireable
// on any real input, not merely mis-tuned.
describe('thin-retrieval threshold sits inside the measured score band', () => {
  /** Off-corpus quartiles from the evidence-gate calibration table. */
  const OFF_CORPUS = [0.387, 0.414, 0.43, 0.466, 0.495]
  /** On-corpus quartiles from the same table. */
  const ON_CORPUS = [0.436, 0.505, 0.538, 0.577, 0.744]

  const tripsThin = (rawScore: number): boolean =>
    // A short non-pleasantry query exercises the thin arm directly.
    shouldInjectRecall({ query: 'AIT?', hits: [{ score: 1, rawScore }] }).reason === 'thin-retrieval'

  it('fires on the low half of the OFF-corpus band (it fired on none of it at 0.35)', () => {
    const tripped = OFF_CORPUS.filter(tripsThin)
    expect(tripped.length).toBeGreaterThan(0)
    // Every value below the old 0.35 threshold would have been needed to fire at all before; the
    // whole off-corpus band is above it, which is why the count was zero.
    expect(OFF_CORPUS.every((s) => s > 0.35)).toBe(true)
  })

  it('never misreads an ON-corpus turn as thin (zero spurious injection)', () => {
    expect(ON_CORPUS.filter(tripsThin)).toEqual([])
  })
})
