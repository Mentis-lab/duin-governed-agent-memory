import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { decideBreadth, DEFAULT_SPREAD_MIN, DEFAULT_SPREAD_WINDOW } from './grounding-breadth'

const h = (...files: string[]) => files.map((file) => ({ file }))

function clearEnv(): void {
  delete process.env.DUIN_WHOLENOTE_SPREAD_MIN
  delete process.env.DUIN_WHOLENOTE_SPREAD_WINDOW
}
beforeEach(clearEnv)
afterEach(clearEnv)

describe('decideBreadth — the narrow/broad split', () => {
  it('no hits → snippets (there is no source to widen to)', () => {
    const d = decideBreadth({ hits: [] })
    expect(d.breadth).toBe('snippets')
    expect(d.reason).toBe('no-hits')
    expect(d.distinctFiles).toBe(0)
  })

  it('evidence concentrated in ONE note → snippets (the categories DUIN already wins)', () => {
    const d = decideBreadth({ hits: h('a.md', 'a.md', 'a.md', 'a.md') })
    expect(d.breadth).toBe('snippets')
    expect(d.reason).toBe('concentrated')
    expect(d.distinctFiles).toBe(1) // five chunks of one note is still one place to look
  })

  it('two sources is still concentrated at the default threshold', () => {
    const d = decideBreadth({ hits: h('a.md', 'b.md', 'a.md') })
    expect(d.breadth).toBe('snippets')
    expect(d.distinctFiles).toBe(2)
  })

  it('three-plus distinct sources → whole-note (the multi-session failure mode)', () => {
    const d = decideBreadth({ hits: h('a.md', 'b.md', 'c.md') })
    expect(d.breadth).toBe('whole-note')
    expect(d.reason).toBe('spread')
    expect(d.files).toEqual(['a.md', 'b.md', 'c.md'])
  })

  it('returns the deduped source set in RANK order, so the caller widens a bounded set', () => {
    const d = decideBreadth({ hits: h('b.md', 'a.md', 'b.md', 'c.md', 'a.md') })
    expect(d.files).toEqual(['b.md', 'a.md', 'c.md'])
    expect(d.distinctFiles).toBe(3)
  })
})

describe('decideBreadth — window and threshold', () => {
  it('only the top `window` hits count, so a long tail cannot fake spread', () => {
    // 2 sources inside a window of 2; the third source is below the cut.
    const d = decideBreadth({ hits: h('a.md', 'b.md', 'c.md'), window: 2 })
    expect(d.distinctFiles).toBe(2)
    expect(d.breadth).toBe('snippets')
  })

  it('spreadMin is honoured, including 0 = always widen when anything was retrieved', () => {
    expect(decideBreadth({ hits: h('a.md'), spreadMin: 0 }).breadth).toBe('whole-note')
    expect(decideBreadth({ hits: h('a.md', 'b.md'), spreadMin: 2 }).breadth).toBe('whole-note')
    expect(decideBreadth({ hits: h('a.md', 'b.md'), spreadMin: 9 }).breadth).toBe('snippets')
  })

  it('env overrides apply and an explicit 0 is not treated as unset (property 8)', () => {
    process.env.DUIN_WHOLENOTE_SPREAD_MIN = '0'
    expect(decideBreadth({ hits: h('only.md') }).breadth).toBe('whole-note')
    process.env.DUIN_WHOLENOTE_SPREAD_MIN = '4'
    expect(decideBreadth({ hits: h('a.md', 'b.md', 'c.md') }).breadth).toBe('snippets')
    process.env.DUIN_WHOLENOTE_SPREAD_WINDOW = '1'
    delete process.env.DUIN_WHOLENOTE_SPREAD_MIN
    expect(decideBreadth({ hits: h('a.md', 'b.md', 'c.md') }).distinctFiles).toBe(1)
  })

  it('garbage env falls back to the shipped defaults rather than throwing', () => {
    process.env.DUIN_WHOLENOTE_SPREAD_MIN = 'not-a-number'
    process.env.DUIN_WHOLENOTE_SPREAD_WINDOW = ''
    const d = decideBreadth({ hits: h('a.md', 'b.md', 'c.md') })
    expect(d.breadth).toBe('whole-note') // default min 3 still applied
    expect(DEFAULT_SPREAD_MIN).toBe(3)
    expect(DEFAULT_SPREAD_WINDOW).toBe(8)
  })

  it('ignores blank/whitespace file names without counting them as sources', () => {
    const d = decideBreadth({ hits: [{ file: '' }, { file: '   ' }, { file: 'a.md' }] })
    expect(d.distinctFiles).toBe(1)
    expect(d.files).toEqual(['a.md'])
  })
})
