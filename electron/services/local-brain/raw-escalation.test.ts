import { describe, it, expect } from 'vitest'
import { escalateToRaw, renderRawEscalation } from './raw-escalation'
import { fuseSearchHits, type SearchHit } from './index-store'

// Apply/Retrieval — thin-recall → raw-source escalation (TierMem). Pure.

describe('escalateToRaw', () => {
  it('does not escalate when there are no hits', () => {
    expect(escalateToRaw({ query: 'q', hits: [] })).toMatchObject({
      escalate: false,
      reason: 'no-hits'
    })
  })

  it('does not escalate when the top hit is confident', () => {
    const d = escalateToRaw({ query: 'q', hits: [{ file: 'a.md', score: 1, rawScore: 0.8 }] })
    expect(d).toMatchObject({ escalate: false, reason: 'confident', files: [] })
  })

  it('escalates the top distinct files when recall is thin', () => {
    const d = escalateToRaw({
      query: 'q',
      hits: [
        { file: 'a.md', score: 0.2, rawScore: 0.2 },
        { file: 'b.md', score: 0.3, rawScore: 0.3 },
        { file: 'a.md', score: 0.25, rawScore: 0.25 }, // duplicate file
        { file: 'c.md', score: 0.1, rawScore: 0.1 }
      ]
    })
    expect(d.escalate).toBe(true)
    expect(d.reason).toBe('thin-recall')
    // top-2 distinct by rank score: b (0.3), a (0.25)
    expect(d.files).toEqual(['b.md', 'a.md'])
  })

  it('respects the maxFiles cap', () => {
    const d = escalateToRaw({
      query: 'q',
      hits: [
        { file: 'a.md', score: 0.1, rawScore: 0.1 },
        { file: 'b.md', score: 0.2, rawScore: 0.2 },
        { file: 'c.md', score: 0.3, rawScore: 0.3 }
      ],
      maxFiles: 1
    })
    expect(d.files).toEqual(['c.md'])
  })

  it('ignores blank/invalid file entries', () => {
    const d = escalateToRaw({ query: 'q', hits: [{ file: '   ', score: 0.1, rawScore: 0.1 }] })
    expect(d).toMatchObject({ escalate: false, reason: 'no-hits' })
  })

  // The regression guard. `score` is top-normalized, so reading confidence off it
  // makes every turn look perfect; a hit carrying no absolute signal must NOT be
  // treated as score-confident (the old bug) nor blindly escalated.
  it('reports no-signal when hits carry no absolute relevance', () => {
    const d = escalateToRaw({
      query: 'q',
      hits: [
        { file: 'a.md', score: 1 },
        { file: 'b.md', score: 0.6 }
      ]
    })
    expect(d).toMatchObject({ escalate: false, reason: 'no-signal', files: [] })
  })

  it('ignores the normalized rank score when deciding confidence', () => {
    // score=1 (top-normalized) but genuinely weak relevance ⇒ must still escalate.
    const d = escalateToRaw({ query: 'q', hits: [{ file: 'a.md', score: 1, rawScore: 0.1 }] })
    expect(d).toMatchObject({ escalate: true, reason: 'thin-recall', files: ['a.md'] })
  })

  it('lets a lexical-only hit compete for read slots without voting on confidence', () => {
    const d = escalateToRaw({
      query: 'q',
      hits: [
        { file: 'lex.md', score: 1 }, // BM25-only: no absolute scale to report
        { file: 'vec.md', score: 0.4, rawScore: 0.1 }
      ]
    })
    expect(d.escalate).toBe(true)
    expect(d.files).toEqual(['lex.md', 'vec.md'])
  })
})

// Scale-mismatch guard: drive the decision with the REAL producer's output instead
// of hand-written scores. The original unit tests passed while the feature was dead
// in production precisely because they invented scores fuseSearchHits can never emit.
describe('escalateToRaw ← fuseSearchHits (real producer)', () => {
  const v = (file: string, score: number): SearchHit => ({ file, snippet: `snip ${file}`, score })
  const l = (file: string, score: number): SearchHit => ({ file, snippet: `snip ${file}`, score })

  it('fused hits are top-normalized to exactly 1.0 regardless of true relevance', () => {
    const barelyRelevant = fuseSearchHits([v('weak.md', 0.1)], [l('weak.md', 1)], 6)
    expect(barelyRelevant[0].score).toBe(1)
    expect(barelyRelevant[0].rawScore).toBeCloseTo(0.1, 5)
  })

  it('escalates on a weakly-relevant fused recall', () => {
    const hits = fuseSearchHits([v('weak.md', 0.1), v('other.md', 0.08)], [l('weak.md', 1)], 6)
    const d = escalateToRaw({ query: 'what did we decide about beacon', hits })
    expect(d.escalate).toBe(true)
    expect(d.reason).toBe('thin-recall')
    expect(d.files[0]).toBe('weak.md')
  })

  it('does not escalate on a strongly-relevant fused recall', () => {
    const hits = fuseSearchHits([v('strong.md', 0.82)], [l('strong.md', 1)], 6)
    const d = escalateToRaw({ query: 'what did we decide about beacon', hits })
    expect(d).toMatchObject({ escalate: false, reason: 'confident' })
  })
})

describe('renderRawEscalation', () => {
  it('renders read sources into a labelled block', () => {
    const block = renderRawEscalation([
      { file: 'a.md', content: 'full text of A' },
      { file: 'b.md', content: 'full text of B' }
    ])
    expect(block).toMatch(/RAW SOURCE \(escalated/)
    expect(block).toMatch(/\[raw: a\.md\]\nfull text of A/)
    expect(block).toMatch(/\[raw: b\.md\]\nfull text of B/)
  })

  it('returns empty when nothing readable was passed (failed reads add nothing)', () => {
    expect(renderRawEscalation([])).toBe('')
    expect(renderRawEscalation([{ file: 'a.md', content: '   ' }])).toBe('')
  })
})
