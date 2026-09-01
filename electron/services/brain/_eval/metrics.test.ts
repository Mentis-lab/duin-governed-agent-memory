import { describe, it, expect } from 'vitest'
import {
  rankOf,
  supportingFactRecallAtK,
  supportSentenceRecallAtK,
  normalizeAnswer,
  answerEM,
  answerF1,
  citationRecallStmts,
  citationPrecisionStmts,
  citationRecall,
  citationPrecision,
  type CitedStatement,
  type SupportScorer
} from './metrics'
import type { Citation, NoteText } from '../retrieve-agent'

describe('rankOf', () => {
  it('1-based rank, 0 when absent', () => {
    expect(rankOf(['a', 'b', 'c'], 'b')).toBe(2)
    expect(rankOf(['a', 'b'], 'z')).toBe(0)
  })
})

describe('supportingFactRecallAtK (factor 1)', () => {
  it('fraction of gold in the top-k', () => {
    expect(supportingFactRecallAtK(['a', 'b', 'c'], ['a', 'c'], 3)).toBe(1)
    expect(supportingFactRecallAtK(['a', 'b', 'c'], ['a', 'c'], 2)).toBe(0.5) // c is at rank 3
  })
  it('present-but-outside-k counts as a miss, not a skip', () => {
    expect(supportingFactRecallAtK(['x', 'y', 'z', 'w', 'v', 'gold'], ['gold'], 5)).toBe(0)
    expect(supportingFactRecallAtK(['x', 'y', 'z', 'w', 'v', 'gold'], ['gold'], 6)).toBe(1)
  })
  it('empty gold → 1 (nothing to recall); empty retrieved → 0', () => {
    expect(supportingFactRecallAtK([], [], 5)).toBe(1)
    expect(supportingFactRecallAtK([], ['a'], 5)).toBe(0)
  })
})

describe('supportSentenceRecallAtK (factor 1, sentence-level)', () => {
  const cites: Citation[] = [
    { note: 'a.md', lines: [2, 4], snippet: '', why: '' },
    { note: 'b.md', snippet: '', why: '' } // no lines → coarse note cover
  ]
  it('gold line is covered iff a citation range on that note spans it', () => {
    expect(supportSentenceRecallAtK(cites, [{ note: 'a.md', line: 3 }], 10)).toBe(1)
    expect(supportSentenceRecallAtK(cites, [{ note: 'a.md', line: 9 }], 10)).toBe(0) // outside [2,4]
  })
  it('a no-lines citation covers its note coarsely', () => {
    expect(supportSentenceRecallAtK(cites, [{ note: 'b.md', line: 7 }], 10)).toBe(1)
  })
  it('respects k (citation outside top-k does not count)', () => {
    expect(supportSentenceRecallAtK(cites, [{ note: 'b.md', line: 7 }], 1)).toBe(0)
  })
})

describe('answer EM / F1 (factor 2, SQuAD normalization)', () => {
  it('normalizes case, punctuation, and leading articles', () => {
    expect(normalizeAnswer('The Beacon, Project!')).toBe('beacon project')
  })
  it('EM matches any alias after normalization', () => {
    expect(answerEM('the Sam Rivera', ['Sam Rivera', 'Sam'])).toBe(1)
    expect(answerEM('Jordan', ['Sam Rivera', 'Sam'])).toBe(0)
  })
  it('F1 is max token-overlap over aliases; partial overlap is partial credit', () => {
    expect(answerF1('Sam Rivera', ['Sam Rivera'])).toBe(1)
    // pred 2 tokens, gold 1 token, 1 common → P=1/2, R=1 → F1 = 2*.5*1/1.5
    expect(answerF1('Sam Rivera', ['Rivera'])).toBeCloseTo((2 * 0.5 * 1) / 1.5, 5)
    expect(answerF1('completely different', ['Sam Rivera'])).toBe(0)
  })
})

// ── ALCE factor 3: a hand-built token-requirement scorer so the redundant branch
//    is deterministic. A claim carries required tokens; a premise supports it iff
//    it contains ALL of them.
const need = (claim: string): string[] => claim.split(' ').filter(Boolean)
const tokenScorer: SupportScorer = (premise, claim) => need(claim).every((t) => premise.includes(t))

describe('ALCE citationRecall / citationPrecision (factor 3, injected scorer)', () => {
  it('recall: statement supported iff the UNION of premises entails it', () => {
    const stmts: CitedStatement[] = [
      { statement: 'alpha beta', premises: [{ note: 'a', text: 'alpha' }, { note: 'b', text: 'beta' }] }
    ]
    expect(citationRecallStmts(stmts, tokenScorer)).toBe(1) // union has alpha+beta
    const miss: CitedStatement[] = [
      { statement: 'alpha beta', premises: [{ note: 'a', text: 'alpha' }] }
    ]
    expect(citationRecallStmts(miss, tokenScorer)).toBe(0) // beta missing
  })

  it('precision: a necessary citation is precise; a redundant/irrelevant one is not', () => {
    // A+B are jointly necessary; C is irrelevant → C penalized, A and B credited.
    const stmts: CitedStatement[] = [
      {
        statement: 'alpha beta',
        premises: [
          { note: 'a', text: 'alpha' }, // alone insufficient, but removing it breaks support → precise
          { note: 'b', text: 'beta' }, // same → precise
          { note: 'c', text: 'gamma' } // irrelevant, support holds without it → NOT precise
        ]
      }
    ]
    expect(citationPrecisionStmts(stmts, tokenScorer)).toBeCloseTo(2 / 3, 5)
  })

  it('precision: a citation that alone supports the claim is precise', () => {
    const stmts: CitedStatement[] = [
      { statement: 'alpha', premises: [{ note: 'a', text: 'alpha beta' }] }
    ]
    expect(citationPrecisionStmts(stmts, tokenScorer)).toBe(1)
  })

  it('convenience wrappers resolve premises from notes via readNote', () => {
    const notes: NoteText[] = [
      { id: 'sam.md', text: 'Sam Rivera owns Beacon.', lines: ['Sam Rivera owns Beacon.'] }
    ]
    const cites: Citation[] = [{ note: 'sam.md', snippet: 's', why: 'Sam Rivera' }]
    const scorer: SupportScorer = (p, c) => c.split(' ').every((t) => p.includes(t))
    expect(citationRecall(cites, notes, scorer)).toBe(1)
    expect(citationPrecision(cites, notes, scorer)).toBe(1)
  })
})
