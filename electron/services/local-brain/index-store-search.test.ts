import { describe, it, expect } from 'vitest'
import {
  lexicalScan,
  fuseSearchHits,
  recencyMultiplier,
  chunkText,
  stripFrontmatter,
  tokenizeForLexical,
  mergeGraphNeighbors,
  applyRerankOrder,
  rocchioExpand,
  type ChunkRow,
  type SearchHit
} from './index-store'

const row = (id: number, file: string, text: string): ChunkRow => ({ rowid: id, file, text })

const l2 = (v: ArrayLike<number>): number => {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  return Math.sqrt(s)
}

describe('rocchioExpand (PRF query expansion)', () => {
  it('blends query + feedback centroid and returns a unit vector', () => {
    const out = rocchioExpand([1, 0], [[0, 1]], 1, 1)
    expect(l2(out)).toBeCloseTo(1, 5)
    // equal weights on [1,0] and [0,1] → 45°, both components equal
    expect(out[0]).toBeCloseTo(out[1], 5)
    expect(out[0]).toBeCloseTo(Math.SQRT1_2, 5)
  })

  it('keeps the original query dominant (alpha > beta)', () => {
    const out = rocchioExpand([1, 0, 0], [[0, 1, 0]], 0.7, 0.3)
    expect(l2(out)).toBeCloseTo(1, 5)
    // the query axis must outweigh the feedback axis
    expect(out[0]).toBeGreaterThan(out[1])
    expect(out[2]).toBeCloseTo(0, 5)
  })

  it('averages multiple feedback docs, not just the first', () => {
    const out = rocchioExpand([0, 0], [[1, 0], [0, 1]], 0, 1)
    // centroid of the two docs is [0.5,0.5] → normalized to equal components
    expect(out[0]).toBeCloseTo(out[1], 5)
    expect(l2(out)).toBeCloseTo(1, 5)
  })

  it('with no feedback docs, degrades to the normalized query', () => {
    const out = rocchioExpand([3, 4], [], 0.7, 0.3)
    expect(out[0]).toBeCloseTo(0.6, 5)
    expect(out[1]).toBeCloseTo(0.8, 5)
  })
})

describe('lexicalScan', () => {
  const rows: ChunkRow[] = [
    row(1, 'beacon.md', '# Beacon\nBeacon is blocked on the vendor SDK and a pending legal review.'),
    row(2, 'roadmap.md', 'The roadmap covers Q3 launches and the design system refresh.'),
    row(3, 'notes.md', 'Random thoughts about coffee and weekend plans.')
  ]

  it('surfaces the note that contains an exact query term (proper noun)', () => {
    const hits = lexicalScan(rows, "what's blocking Beacon?", 6)
    expect(hits[0].file).toBe('beacon.md')
    // beacon.md scores highest (matches both "blocking" and "beacon")
    expect(hits.some((h) => h.file === 'beacon.md')).toBe(true)
  })

  it('drops chunks with zero term overlap', () => {
    const hits = lexicalScan(rows, 'Beacon', 6)
    expect(hits.every((h) => h.file !== 'notes.md')).toBe(true)
  })

  it('keeps short (>1 char) tokens like "Q3"', () => {
    const hits = lexicalScan(rows, 'Q3', 6)
    expect(hits[0]?.file).toBe('roadmap.md')
  })

  it('returns [] for an empty corpus or a no-token query', () => {
    expect(lexicalScan([], 'beacon', 6)).toEqual([])
    expect(lexicalScan(rows, 'a', 6)).toEqual([]) // single-char token filtered out
  })

  it('normalizes the top hit score to 1', () => {
    const hits = lexicalScan(rows, 'Beacon blocked vendor', 6)
    expect(hits[0].score).toBe(1)
  })

  it('matches CJK terms via bigrams — the Chinese-vault recall fix (was: dropped)', () => {
    const cjkRows: ChunkRow[] = [
      row(1, '北澜-taptap.md', '北澜 与 TapTap 渠道 BD 合作进展与决策'),
      row(2, 'other.md', '完全无关的内容关于咖啡')
    ]
    const hits = lexicalScan(cjkRows, '北澜 TapTap 渠道', 6)
    expect(hits[0]?.file).toBe('北澜-taptap.md')
    expect(hits.some((h) => h.file === 'other.md')).toBe(false)
  })
})

describe('tokenizeForLexical', () => {
  it('keeps Latin words and BIGRAMS cjk runs (old split(/\\W+/) dropped CJK entirely)', () => {
    expect(tokenizeForLexical('北澜 TapTap 渠道')).toEqual(['北澜', 'taptap', '渠道'])
    expect(tokenizeForLexical('北澜渠道')).toEqual(['北澜', '澜渠', '渠道']) // overlapping bigrams
    expect(tokenizeForLexical('a hi the')).toEqual(['hi', 'the']) // single-char Latin dropped
  })
})

describe('fuseSearchHits (RRF)', () => {
  const v = (file: string, score: number): SearchHit => ({ file, snippet: `vec ${file}`, score })
  const l = (file: string, score: number): SearchHit => ({ file, snippet: `lex ${file}`, score })

  it('ranks a both-leg note top, and a keyword-only note above a weak vector-only note', () => {
    const fused = fuseSearchHits([v('a.md', 0.9), v('b.md', 0.5)], [l('beacon.md', 1), l('a.md', 0.8)], 6)
    // a.md is in BOTH legs → top; beacon.md (rank-1 lexical) outranks b.md (rank-2 vector-only)
    expect(fused.map((h) => h.file)).toEqual(['a.md', 'beacon.md', 'b.md'])
    expect(fused[0].snippet).toBe('vec a.md') // dedup prefers the vector snippet
  })

  it('surfaces a strong keyword match FIRST even when vector filled the top-k (the recall fix)', () => {
    const vector = [v('x1.md', 0.7), v('x2.md', 0.6), v('x3.md', 0.55)]
    const fused = fuseSearchHits(vector, [l('beacon.md', 1)], 4)
    expect(fused.some((h) => h.file === 'beacon.md')).toBe(true)
    expect(fused[0].file).toBe('beacon.md') // rank-1 lexical leads — the old precedence merge buried it last
  })

  it('caps the fused result to k', () => {
    const fused = fuseSearchHits([v('a', 1), v('b', 1), v('c', 1)], [l('d', 1), l('e', 1)], 3)
    expect(fused).toHaveLength(3)
  })

  it('lexical-only when vector is empty', () => {
    const fused = fuseSearchHits([], [l('beacon.md', 1)], 6)
    expect(fused.map((h) => h.file)).toEqual(['beacon.md'])
  })

  it('returns [] when both legs are empty', () => {
    expect(fuseSearchHits([], [], 6)).toEqual([])
  })
})

describe('chunkText — structure-aware chunking', () => {
  const SIZE = 800 // must match CHUNK_SIZE in index-store.ts

  it('returns [] for empty and a single chunk for text within one window', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n  ')).toEqual([])
    expect(chunkText('# Heading\n\nA short note.')).toEqual(['# Heading\n\nA short note.'])
  })

  it('splits on paragraph/heading boundaries, never mid-word, each chunk ≤ CHUNK_SIZE', () => {
    const para = (n: number, w: string): string => `## Section ${n}\n\n` + Array.from({ length: 40 }, () => w).join(' ')
    const doc = [para(1, 'alpha'), para(2, 'bravo'), para(3, 'charlie'), para(4, 'delta')].join('\n\n')
    const chunks = chunkText(doc)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(SIZE)
      // whole-word boundaries: no chunk starts/ends slicing a token (trimmed blocks)
      expect(c).toBe(c.trim())
    }
    // every heading stays attached to its section (not split off)
    const joined = chunks.join('\n')
    for (const n of [1, 2, 3, 4]) expect(joined).toContain(`## Section ${n}`)
  })

  it('keeps a heading together with the paragraph that follows it', () => {
    const doc = '# Title\n\n' + 'word '.repeat(50).trim() + '\n\n' + 'other '.repeat(300).trim()
    const chunks = chunkText(doc)
    // the title + its short first paragraph land in the same chunk
    const titleChunk = chunks.find((c) => c.includes('# Title'))!
    expect(titleChunk).toContain('word')
  })

  it('hard-splits a single oversized block on sentence boundaries, each piece ≤ CHUNK_SIZE', () => {
    const sentence = (w: string): string => Array.from({ length: 30 }, () => w).join(' ') + '.'
    const bigBlock = Array.from({ length: 12 }, (_, i) => sentence(`s${i}`)).join(' ') // one block, > SIZE
    expect(bigBlock.length).toBeGreaterThan(SIZE)
    const chunks = chunkText(bigBlock)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(SIZE)
  })

  it('preserves all content words across chunks (nothing dropped)', () => {
    const doc = Array.from({ length: 6 }, (_, i) => `Para ${i} keyword${i} ` + 'filler '.repeat(30).trim()).join('\n\n')
    const joined = chunkText(doc).join(' ')
    for (let i = 0; i < 6; i++) expect(joined).toContain(`keyword${i}`)
  })
})

describe('fuseSearchHits — temporal-recency prior', () => {
  const v = (file: string, score: number): SearchHit => ({ file, snippet: `vec ${file}`, score })
  const l = (file: string, score: number): SearchHit => ({ file, snippet: `lex ${file}`, score })
  const NOW = 1_700_000_000_000
  const daysAgo = (d: number): number => NOW - d * 86_400_000

  it('recencyMultiplier: zero/negative mtime neutral, fresh full boost, decays by half-life', () => {
    expect(recencyMultiplier(0, NOW)).toBe(1) // unknown mtime → neutral by construction
    expect(recencyMultiplier(-5, NOW)).toBe(1)
    expect(recencyMultiplier(NOW, NOW)).toBeCloseTo(1.15, 5) // age 0 → ×(1+weight)
    expect(recencyMultiplier(daysAgo(30), NOW)).toBeCloseTo(1.075, 3) // one half-life → boost halves
    expect(recencyMultiplier(NOW, NOW, 0)).toBe(1) // weight 0 → off
  })

  it('reorders a NEAR-TIE toward the fresher note', () => {
    const lexical = [l('stale.md', 1), l('fresh.md', 0.9)] // adjacent lexical ranks → near-equal fused
    expect(fuseSearchHits([], lexical, 6).map((h) => h.file)).toEqual(['stale.md', 'fresh.md'])
    const mtimes = new Map([['stale.md', daysAgo(400)], ['fresh.md', NOW]])
    const withRecency = fuseSearchHits([], lexical, 6, { mtimes, now: NOW })
    expect(withRecency.map((h) => h.file)).toEqual(['fresh.md', 'stale.md'])
  })

  it('does NOT flip a real relevance gap (fresh-but-weak stays below stale-but-strong)', () => {
    const vector = [v('weak.md', 0.5)] // vector-only, low RRF weight
    const lexical = [l('strong.md', 1)] // strong keyword hit, high RRF weight
    const mtimes = new Map([['strong.md', daysAgo(400)], ['weak.md', NOW]]) // weak is the fresh one
    const fused = fuseSearchHits(vector, lexical, 6, { mtimes, now: NOW })
    expect(fused[0].file).toBe('strong.md') // recency can't override the relevance gap
  })

  it('is a no-op when mtimes is empty (matches the recency-off order)', () => {
    const lexical = [l('a.md', 1), l('b.md', 0.9)]
    const off = fuseSearchHits([], lexical, 6)
    const empty = fuseSearchHits([], lexical, 6, { mtimes: new Map(), now: NOW })
    expect(empty.map((h) => h.file)).toEqual(off.map((h) => h.file))
  })
})

describe('mergeGraphNeighbors', () => {
  const hit = (file: string, score: number): SearchHit => ({ file, snippet: `s:${file}`, score })

  it('appends linked neighbours after base hits, deduped by file', () => {
    const base = [hit('a.md', 0.9), hit('b.md', 0.7)]
    const neighbors = [hit('c.md', 0.25), hit('a.md', 0.25), hit('d.md', 0.25)]
    const out = mergeGraphNeighbors(base, neighbors, 8)
    expect(out.map((h) => h.file)).toEqual(['a.md', 'b.md', 'c.md', 'd.md']) // a.md not duplicated
    expect(out.slice(0, 2)).toEqual(base) // base kept first, unchanged
  })

  it('respects the k cap', () => {
    const base = [hit('a.md', 0.9)]
    const neighbors = [hit('b.md', 0.25), hit('c.md', 0.25), hit('d.md', 0.25)]
    expect(mergeGraphNeighbors(base, neighbors, 2).map((h) => h.file)).toEqual(['a.md', 'b.md'])
  })

  it('is a no-op when there are no neighbours', () => {
    const base = [hit('a.md', 0.9)]
    expect(mergeGraphNeighbors(base, [], 8)).toEqual(base)
  })

  it('skips empty/blank neighbour files', () => {
    const base = [hit('a.md', 0.9)]
    const neighbors = [{ file: '', snippet: 'x', score: 0.25 }, hit('b.md', 0.25)]
    expect(mergeGraphNeighbors(base, neighbors, 8).map((h) => h.file)).toEqual(['a.md', 'b.md'])
  })
})

describe('applyRerankOrder', () => {
  const hit = (file: string, score: number): SearchHit => ({ file, snippet: `s:${file}`, score })

  it('reorders hits by cross-encoder scores (desc)', () => {
    const hits = [hit('a.md', 0.9), hit('b.md', 0.8), hit('c.md', 0.7)]
    const out = applyRerankOrder(hits, [0.1, 0.9, 0.5]) // b best, then c, then a
    expect(out.map((h) => h.file)).toEqual(['b.md', 'c.md', 'a.md'])
  })

  it('is stable on ties (keeps original order)', () => {
    const hits = [hit('a.md', 0.9), hit('b.md', 0.8), hit('c.md', 0.7)]
    expect(applyRerankOrder(hits, [0.5, 0.5, 0.5]).map((h) => h.file)).toEqual(['a.md', 'b.md', 'c.md'])
  })

  it('returns hits unchanged on a length mismatch (never drops a hit)', () => {
    const hits = [hit('a.md', 0.9), hit('b.md', 0.8)]
    expect(applyRerankOrder(hits, [0.1]).map((h) => h.file)).toEqual(['a.md', 'b.md'])
    expect(applyRerankOrder(hits, [] as unknown as number[])).toEqual(hits)
  })
})

describe('lexicalScan — BM25 (IDF + length normalization)', () => {
  it('a short on-topic note beats a long note that mentions the rare term MORE', () => {
    // The live failure mode: a one-paragraph decision note lost to a sprawling dev
    // log that name-dropped the term many times. BM25 must rank the terse note first
    // (rare term = high IDF; short doc = length-norm boost).
    const rows: ChunkRow[] = [
      row(1, 'decision.md', '风暴模拟器合作终止。决定终止与风暴模拟器的渠道合作。'),
      row(
        2,
        'devlog.md',
        '开发日志 ' + '进度更新 部署 修复 '.repeat(40) + ' 顺带提了风暴模拟器 风暴模拟器 风暴模拟器 风暴模拟器 风暴模拟器 '
      )
    ]
    const hits = lexicalScan(rows, '风暴模拟器合作为什么终止', 6)
    expect(hits[0].file).toBe('decision.md')
  })

  it('a rare distinctive term outweighs a common one (IDF)', () => {
    const rows: ChunkRow[] = [
      row(1, 'rare.md', ' SPLADE ' + 'the of and to a '.repeat(20)),
      row(2, 'common.md', 'the of and to a the of and to a the of and to a')
    ]
    // "the" is in both (low IDF); "SPLADE" only in rare.md (high IDF) → rare wins.
    const hits = lexicalScan(rows, 'the SPLADE', 6)
    expect(hits[0].file).toBe('rare.md')
  })
})

describe('stripFrontmatter', () => {
  it('removes a leading YAML block, keeps the body', () => {
    const t = '---\ntype: decision\ndate: 2026-05-14\ntags: [a, b]\n---\n# Title\n\nBody content.'
    expect(stripFrontmatter(t)).toBe('# Title\n\nBody content.')
  })
  it('handles CRLF frontmatter', () => {
    expect(stripFrontmatter('---\r\nk: v\r\n---\r\nbody')).toBe('body')
  })
  it('no-op when there is no frontmatter', () => {
    expect(stripFrontmatter('# Just a heading\ncontent')).toBe('# Just a heading\ncontent')
  })
  it('leaves a mid-body horizontal rule alone', () => {
    const t = '# Heading\n\nsome text\n\n---\n\nmore text'
    expect(stripFrontmatter(t)).toBe(t)
  })
})

describe('fuseSearchHits — weighted RRF (lexical favored)', () => {
  const v = (file: string, score: number): SearchHit => ({ file, snippet: `vec ${file}`, score })
  const l = (file: string, score: number): SearchHit => ({ file, snippet: `lex ${file}`, score })
  it('a strong lexical hit (BM25 #2) beats a vector-rank-1-only note (the terse-note fix)', () => {
    // decision.md: lexical rank 2, absent from vector. devlog.md: vector rank 1, absent
    // from lexical. Equal-weight RRF ties/favors devlog; weighted must surface decision.
    const vector = [v('devlog.md', 0.9), v('x.md', 0.8)]
    const lexical = [l('concept-index.md', 1), l('decision.md', 0.95)]
    const fused = fuseSearchHits(vector, lexical, 6)
    const rankDecision = fused.findIndex((h) => h.file === 'decision.md')
    const rankDevlog = fused.findIndex((h) => h.file === 'devlog.md')
    expect(rankDecision).toBeGreaterThanOrEqual(0)
    expect(rankDecision).toBeLessThan(rankDevlog) // decision.md outranks the vector-only devlog
  })
})
