import { describe, it, expect } from 'vitest'
import { splitMarkdownBlocks, createBlockStream, streamRenderWork, collectRefDefinitions } from './markdown-blocks.mjs'

describe('splitMarkdownBlocks', () => {
  it('splits blank-line-separated top-level blocks', () => {
    expect(splitMarkdownBlocks('# H\n\npara one\n\npara two')).toEqual(['# H', 'para one', 'para two'])
  })
  it('NEVER splits inside a fenced code block (even with blank lines)', () => {
    const md = 'intro\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\nafter'
    const blocks = splitMarkdownBlocks(md)
    expect(blocks).toHaveLength(3)
    expect(blocks[1]).toBe('```js\nconst a = 1\n\nconst b = 2\n```') // fence kept whole, blank inside preserved
    expect(blocks[2]).toBe('after')
  })
  it('keeps a table (no blank lines) in one block', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |'
    expect(splitMarkdownBlocks(md)).toEqual([md])
  })
  it('an unclosed fence keeps everything after it in the open (last) block', () => {
    const blocks = splitMarkdownBlocks('done\n\n```py\nx = 1\n\ny = 2')
    expect(blocks[blocks.length - 1]).toBe('```py\nx = 1\n\ny = 2') // still open — not split on the blank
  })
  it('empty / whitespace input → no blocks', () => {
    expect(splitMarkdownBlocks('')).toEqual([])
    expect(splitMarkdownBlocks('\n\n')).toEqual([])
  })
})

describe('createBlockStream — incremental', () => {
  it('closes a block on a blank line and exposes the open tail', () => {
    const s = createBlockStream()
    s.push('para one\n')
    let r = s.push('\n') // blank line closes "para one"
    expect(r.closed).toEqual(['para one'])
    r = s.push('para two continues')
    expect(r.closed).toEqual(['para one'])
    expect(r.open).toBe('para two continues')
  })
  it('feeding a doc chunk-by-chunk yields the same blocks as splitting it whole (fence-safe)', () => {
    const md = 'a\n\n```js\nk\n\nv\n```\n\nb'
    const s = createBlockStream()
    for (const ch of md.match(/[\s\S]{1,3}/g)!) s.push(ch)
    const r = s.push('') // flush view
    const whole = splitMarkdownBlocks(md)
    // closed + open should reconstruct the same block set (open = last block)
    expect([...r.closed, r.open].filter(Boolean)).toEqual(whole)
  })
})

describe('collectRefDefinitions — cross-block reference resolution (fixes the isolated-island leak)', () => {
  it('harvests reference-link and footnote definitions', () => {
    const md = 'See [the docs][ref] and a claim.[^1]\n\ntext\n\n[ref]: https://x.example\n[^1]: the note'
    expect(collectRefDefinitions(md)).toBe('[ref]: https://x.example\n[^1]: the note')
  })
  it('is EMPTY for the common case (no reference-style syntax) → block content unchanged, memo preserved', () => {
    expect(collectRefDefinitions('# H\n\njust normal [inline](https://x) prose\n\nmore')).toBe('')
  })
  it('does not mistake an inline link `[t](url)` for a definition', () => {
    expect(collectRefDefinitions('a [link](https://x) here')).toBe('')
  })
  it('appending harvested defs makes an isolated use-block self-contained', () => {
    const md = 'Para uses [the docs][ref].\n\n[ref]: https://x.example'
    const blocks = splitMarkdownBlocks(md)
    const defs = collectRefDefinitions(md)
    // the use-block, standalone, has no def (would leak raw [the docs][ref]); with defs appended it resolves
    expect(blocks[0]).toBe('Para uses [the docs][ref].')
    expect(`${blocks[0]}\n\n${defs}`).toContain('[ref]: https://x.example')
  })
})

describe('streamRenderWork — the scaling probe hook', () => {
  it('returns a finite checksum (forces the work; used by the ratio probe)', () => {
    const w = streamRenderWork(50)
    expect(Number.isFinite(w)).toBe(true)
  })
  it('scales roughly LINEARLY with block count (the incremental win — not O(n²))', () => {
    // wall-clock is noisy, but the RATIO of work at 2n vs n should be ~2 (linear), never ~4 (quadratic)
    const w1 = streamRenderWork(400)
    const w2 = streamRenderWork(800)
    const ratio = w2 / w1
    expect(ratio).toBeGreaterThan(1.7)
    expect(ratio).toBeLessThan(2.6) // linear-ish; a whole-doc re-parse would be ~4
  })
})
