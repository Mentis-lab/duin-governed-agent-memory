import { describe, it, expect } from 'vitest'
import { boundToBudget, chunkText, headSlice } from './output-bound'
import type { EmbedFn } from '../brain/claim-entities'

// Deterministic fake embedder: known texts get fixed vectors; unknown texts get their own orthogonal axis.
function fakeEmbed(table: Record<string, number[]>): EmbedFn {
  let axis = 100
  return async (texts: string[]) =>
    texts.map((t) => {
      if (table[t]) return table[t]
      const v = new Array(200).fill(0)
      v[axis++] = 1
      return v
    })
}

describe('chunkText', () => {
  it('splits on blank lines (paragraphs), falls back to lines', () => {
    expect(chunkText('a\n\nb\n\nc')).toEqual(['a', 'b', 'c'])
    expect(chunkText('x\ny\nz')).toEqual(['x', 'y', 'z'])
  })
})

describe('boundToBudget', () => {
  const query = 'wafer calibration query'
  const relevant = 'the wafer calibration data is here'
  const filler = 'unrelated filler about deploys'
  const embed = fakeEmbed({
    [query]: [1, 0, 0],
    [relevant]: [0.99, 0.14, 0], // cosine ≈ 0.99 to query
    [filler]: [0, 1, 0] // cosine 0
  })

  it('under budget → untouched', async () => {
    expect(await boundToBudget('short text', query, 100, embed)).toBe('short text')
  })

  it('no query → head-slice fallback (byte-identical to today)', async () => {
    const text = 'a'.repeat(50)
    expect(await boundToBudget(text, '', 10, embed)).toBe(headSlice(text, 10))
  })

  it('keeps the query-RELEVANT chunk that a blind head-slice would drop', async () => {
    // filler is FIRST (a head-slice would keep it); the relevant chunk is second and would be cut.
    const text = `${filler}\n\n${relevant}`
    const out = await boundToBudget(text, query, relevant.length + 10, embed)
    expect(out).toContain('wafer calibration data')
    expect(out).not.toContain('unrelated filler')
  })

  it('fail-open to head-slice when the embedder throws', async () => {
    const boom: EmbedFn = async () => {
      throw new Error('cold')
    }
    const text = 'p1\n\np2\n\np3\n\np4'
    expect(await boundToBudget(text, query, 8, boom)).toBe(headSlice(text, 8))
  })

  it('fail-open on an empty/mismatched embedding result', async () => {
    const bad: EmbedFn = async () => []
    const text = 'p1\n\np2\n\np3\n\np4'
    expect(await boundToBudget(text, query, 8, bad)).toBe(headSlice(text, 8))
  })

  it('single chunk → head-slice (nothing to rank)', async () => {
    const text = 'one big blob with no paragraph breaks '.repeat(5)
    expect(await boundToBudget(text, query, 20, embed)).toBe(headSlice(text, 20))
  })
})
