// grounding-path.test.ts — the grounding branches are FIRST-WINS and silently skip each other.
// This pins the selection logic that decides which one runs, because on 2026-09-04 an entire
// 40-instance benchmark was invalidated by not knowing the answer.
//
// What happened: `DUIN_WHOLENOTE_GROUND=1` (the operator's own launcher setting) plus scattered
// evidence made `decideBreadth` return 'whole-note' on 120 of 120 probes. Whole-note grounding runs
// plain BM25 (its semantic arm is an empty list when DUIN_WHOLENOTE_MODE is the default 'bm25'), and
// setting contextOverride there skips the agentic retriever AND the four ranking stages. So the
// hybrid retriever, the cross-encoder reranker and graph expansion did not run on a single turn —
// and the result was written up as "DUIN vs a naive BM25 baseline" when both arms were BM25.
//
// The fix under test is observability, not behaviour: every turn now records WHICH branch produced
// its context. These tests pin the rule that decides that, so the same silent bypass cannot recur
// unnoticed.
import { describe, it, expect } from 'vitest'
import { decideBreadth, DEFAULT_SPREAD_MIN, DEFAULT_SPREAD_WINDOW } from './grounding-breadth'

const hit = (file: string) => ({ file }) as never
const spread = (n: number) => Array.from({ length: n }, (_, i) => hit(`s${i}.md`))

describe('decideBreadth — the switch that routed the benchmark around hybrid retrieval', () => {
  it('scattered evidence takes the WHOLE-NOTE path, which is BM25-only and skips the rest', () => {
    // this is the STALE shape: a 50-session haystack, hits landing in many distinct files
    const d = decideBreadth({ hits: spread(6) } as never)
    expect(d.breadth).toBe('whole-note')
    expect(d.reason).toBe('spread')
    expect(d.distinctFiles).toBe(6)
  })

  it('concentrated evidence keeps SNIPPETS, which is the only path where hybrid ranking survives', () => {
    const d = decideBreadth({ hits: [hit('a.md'), hit('a.md'), hit('b.md')] } as never)
    expect(d.breadth).toBe('snippets')
    expect(d.reason).toBe('concentrated')
    expect(d.distinctFiles).toBe(2)
  })

  it('the threshold is exactly DEFAULT_SPREAD_MIN distinct FILES, not hits', () => {
    expect(DEFAULT_SPREAD_MIN).toBe(3)
    // 5 hits, 2 files -> concentrated; duplicate files must not count twice
    expect(decideBreadth({ hits: [hit('a.md'), hit('a.md'), hit('a.md'), hit('b.md'), hit('b.md')] } as never).breadth).toBe('snippets')
    // 3 distinct files -> whole-note, at the boundary
    expect(decideBreadth({ hits: spread(3) } as never).breadth).toBe('whole-note')
  })

  it('no hits means SNIPPETS — there is no source to widen to, so it must not ship unrelated notes', () => {
    const d = decideBreadth({ hits: [] } as never)
    expect(d.breadth).toBe('snippets')
    expect(d.reason).toBe('no-hits')
  })

  it('only the first DEFAULT_SPREAD_WINDOW hits are considered', () => {
    expect(DEFAULT_SPREAD_WINDOW).toBe(8)
    // 2 distinct files inside the window, 6 more beyond it — must stay concentrated
    const hits = [hit('a.md'), hit('a.md'), hit('a.md'), hit('a.md'),
                  hit('b.md'), hit('b.md'), hit('b.md'), hit('b.md'),
                  ...spread(6)]
    expect(decideBreadth({ hits } as never).breadth).toBe('snippets')
  })

  it('spreadMin 0 forces whole-note on any hit — the escape hatch the July A/B was measured under', () => {
    expect(decideBreadth({ hits: [hit('only.md')], spreadMin: 0 } as never).breadth).toBe('whole-note')
  })

  it('REGRESSION — the benchmark shape: 6 distinct sources routed 120/120 probes to BM25', () => {
    // every STALE instance logged exactly this: breadth=whole-note distinctSources=6 (spread)
    const d = decideBreadth({ hits: spread(6) } as never)
    expect({ breadth: d.breadth, distinctFiles: d.distinctFiles, reason: d.reason })
      .toEqual({ breadth: 'whole-note', distinctFiles: 6, reason: 'spread' })
    // The turn record must now be able to say so: 'whole-note' is a distinct groundingPath value,
    // NOT folded into a generic "grounded" flag — that distinction is the whole point of the fix.
  })
})
