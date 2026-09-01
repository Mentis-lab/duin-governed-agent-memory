import { describe, it, expect } from 'vitest'
import { bm25Rank, rrfFuse, stripFrontmatter, buildWholeNoteContext, windowAroundMatch, tokenize, type WNNote } from './wholenote-ground'

const NOTES: WNNote[] = [
  { id: 'a.md', text: '---\ndate: 2026-01-01\n---\nThe binaural beats study had 38 subjects in Music and Medicine.' },
  { id: 'b.md', text: 'We hiked the GR-90 trail through the Moncayo natural park last summer.' },
  { id: 'c.md', text: 'Random unrelated note about lemon poppyseed cake baking tips.' },
  { id: 'd.md', text: 'The art event two weeks ago was held at the Metropolitan Museum of Art.' }
]

// A 39%-CJK corpus. The single-character tokenizer this replaced gave every Chinese query a df ≈ N
// token set, so BM25 could not separate these four notes at all.
const CJK_NOTES: WNNote[] = [
  { id: '渠道/风暴模拟器.md', text: '风暴模拟器的合作已经终止，转为低优先级长期跟踪。' },
  { id: '北澜/商务双周报.md', text: '北澜二测的 TapTap 联运渠道进展，本周签了三家。' },
  { id: '半导体/云帆泰克.md', text: '云帆泰克董事长赵慕青，深圳封测业务；澄川证券回购请求约 6600 万。' },
  { id: 'en/unrelated.md', text: 'Lemon poppyseed cake baking tips and nothing else at all.' }
]

describe('tokenize', () => {
  it('lowercases, splits words/CJK, drops stopwords by default', () => {
    expect(tokenize('The GR-90 Trail')).toEqual(['gr', '90', 'trail'])
    expect(tokenize('The and of', true)).toEqual(['the', 'and', 'of'])
  })
  it('emits overlapping CJK BIGRAMS, never single characters', () => {
    expect(tokenize('北澜渠道')).toEqual(['北澜', '澜渠', '渠道'])
    expect(tokenize('北澜 TapTap 渠道')).toEqual(['北澜', 'taptap', '渠道'])
  })
  it('does not let a bigram cross a punctuation boundary', () => {
    expect(tokenize('北澜。渠道')).toEqual(['北澜', '渠道'])
  })
  it('keeps a lone CJK character', () => {
    expect(tokenize('花了多少钱')).toEqual(['花了', '了多', '多少', '少钱'])
    expect(tokenize('钱')).toEqual(['钱'])
  })
})

describe('bm25Rank — CJK', () => {
  it('ranks the Chinese note a Chinese query is about first', () => {
    expect(bm25Rank('风暴模拟器的合作现在是什么状态', CJK_NOTES)[0].id).toBe('渠道/风暴模拟器.md')
    expect(bm25Rank('云帆泰克的董事长是谁', CJK_NOTES)[0].id).toBe('半导体/云帆泰克.md')
    expect(bm25Rank('北澜二测最新的渠道进展', CJK_NOTES)[0].id).toBe('北澜/商务双周报.md')
  })
  it('does not match an unrelated note on incidental single characters', () => {
    // 的/是/了 alone would have matched almost everything under the old tokenizer.
    expect(bm25Rank('云帆泰克的董事长是谁', CJK_NOTES).map((r) => r.id)).not.toContain('en/unrelated.md')
  })
  it('ranks a CJK/Latin mixed query on both halves', () => {
    expect(bm25Rank('北澜 TapTap 联运', CJK_NOTES)[0].id).toBe('北澜/商务双周报.md')
  })
})

describe('bm25Rank', () => {
  it('ranks the lexically-matching note first', () => {
    const r = bm25Rank('how many subjects were in the binaural beats study', NOTES)
    expect(r[0].id).toBe('a.md')
    expect(r[0].score).toBeGreaterThan(0)
  })
  it('returns [] on empty query or corpus', () => {
    expect(bm25Rank('', NOTES)).toEqual([])
    expect(bm25Rank('anything', [])).toEqual([])
  })
  it('only returns notes with a positive match', () => {
    const r = bm25Rank('Metropolitan Museum art event', NOTES)
    expect(r.map((x) => x.id)).toContain('d.md')
    expect(r.every((x) => x.score > 0)).toBe(true)
  })
})

describe('rrfFuse', () => {
  it('ranks ids appearing high in multiple rankings above single-ranking ids', () => {
    const fused = rrfFuse([['x', 'y', 'z'], ['y', 'x', 'w']])
    // x and y each appear at ranks {0,1} → identical RRF score → they are the top two (order by
    // stable insertion); w and z each appear once → below both.
    expect(new Set(fused.slice(0, 2))).toEqual(new Set(['x', 'y']))
    expect(fused).toContain('w')
    expect(fused).toContain('z')
    expect(fused.indexOf('z')).toBeGreaterThan(1)
  })
  it('surfaces ids present in only one ranking', () => {
    const fused = rrfFuse([['a'], ['b']])
    expect(new Set(fused)).toEqual(new Set(['a', 'b']))
  })
})

describe('stripFrontmatter', () => {
  it('removes a leading YAML block', () => {
    expect(stripFrontmatter('---\nk: v\n---\nBody here')).toBe('Body here')
  })
  it('leaves body-only text untouched', () => {
    expect(stripFrontmatter('No frontmatter here')).toBe('No frontmatter here')
  })
})

describe('windowAroundMatch', () => {
  it('returns text unchanged when it fits the budget', () => {
    expect(windowAroundMatch('short note', ['note'], 1000)).toBe('short note')
  })
  it('extracts the region around the best match from a large note, with ellipsis', () => {
    const filler = Array.from({ length: 200 }, (_, i) => `filler line ${i} lorem ipsum`).join('\n')
    const text = filler + '\nThe GR-90 trail runs through Moncayo.\n' + filler
    const w = windowAroundMatch(text, ['gr', '90', 'moncayo', 'trail'], 400)
    expect(w).toContain('GR-90 trail') // the matched line survived
    expect(w.length).toBeLessThan(text.length) // it trimmed
    expect(w).toContain('…') // elision marker
  })
  it('falls back to the head when no query token matches', () => {
    const text = 'a'.repeat(5000)
    const w = windowAroundMatch(text, ['zzzzz'], 100)
    expect(w.length).toBeLessThanOrEqual(102)
    expect(w).toContain('…')
  })
})

describe('buildWholeNoteContext', () => {
  it('windows an oversized note to its matched region when perNoteBudget is set', () => {
    const big = 'intro\n' + 'x '.repeat(20000) + '\nThe answer is 42 subjects.\n' + 'y '.repeat(20000)
    const notes: WNNote[] = [{ id: 'big.md', text: big }]
    const full = buildWholeNoteContext('how many subjects answer', notes, [], { topK: 1 })
    const windowed = buildWholeNoteContext('how many subjects answer', notes, [], { topK: 1, perNoteBudget: 500 })
    expect(windowed.context).toContain('42 subjects') // kept the evidence
    expect(windowed.context.length).toBeLessThan(full.context.length / 5) // much smaller
  })


  it('assembles whole-note blocks, frontmatter stripped, best-first', () => {
    const sem = [{ note: 'a.md', score: 0.9 }]
    const { context, used } = buildWholeNoteContext('binaural beats subjects study', NOTES, sem, { topK: 2 })
    expect(used[0]).toBe('a.md')
    expect(context).toContain('[Note: a.md]')
    expect(context).not.toContain('date: 2026-01-01') // frontmatter stripped
    expect(context).toContain('38 subjects')
  })
  it('respects the char budget but always includes at least one note', () => {
    const { used } = buildWholeNoteContext('trail moncayo', NOTES, [], { charBudget: 5 })
    expect(used.length).toBe(1) // budget tiny → exactly one note, never zero
  })
  it('demote pushes retired-backed notes out of the top-K when a rival exists', () => {
    // Two notes both match the query, so demoting the top one lets the rival take the single slot.
    const notes2: WNNote[] = [
      { id: 'p.md', text: 'Project alpha status meeting notes about the roadmap and timeline.' },
      { id: 'q.md', text: 'Project alpha budget and roadmap timeline discussion follow-up.' }
    ]
    const sem = [{ note: 'p.md', score: 0.9 }, { note: 'q.md', score: 0.85 }]
    const base = buildWholeNoteContext('project alpha roadmap timeline', notes2, sem, { topK: 1 })
    const top = base.used[0]
    expect(top).toBeDefined()
    const demoted = buildWholeNoteContext('project alpha roadmap timeline', notes2, sem, {
      topK: 1,
      demote: (id) => id === top
    })
    expect(demoted.used).not.toContain(top) // retired note lost its slot
    expect(demoted.used.length).toBe(1) // the rival took it
  })
  it('empty corpus → empty context', () => {
    expect(buildWholeNoteContext('q', [], []).context).toBe('')
  })
})
