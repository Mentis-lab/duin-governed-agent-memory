import { describe, it, expect } from 'vitest'
import { surpriseGate, SURPRISE_REDUNDANT_THRESHOLD, type SurpriseGateResult } from './surprise-gate'
import type { EmbedFn } from './claim-entities'

// Deterministic fake embedder: maps each text to a fixed unit-ish vector via a lookup, so cosine
// is fully controlled by the test. Unknown texts get a unique orthogonal axis (definitely novel).
function fakeEmbed(table: Record<string, number[]>): EmbedFn {
  let axis = 100
  return async (texts: string[]) =>
    texts.map((t) => {
      if (table[t]) return table[t]
      const v = new Array(200).fill(0)
      v[axis++] = 1 // each unknown text on its own axis ⇒ cosine 0 to everything else
      return v
    })
}

describe('surpriseGate', () => {
  it('skips a clearly-redundant (near-paraphrase) machine candidate', async () => {
    const embed = fakeEmbed({
      'Theo works at Orbis Inc': [1, 0, 0],
      'Theo is employed by Orbis Inc': [0.99, 0.14, 0], // cosine ≈ 0.99 ≥ threshold
    })
    const res = await surpriseGate(['Theo is employed by Orbis Inc'], ['Theo works at Orbis Inc'], embed)
    expect(res.keep).toEqual([])
    expect(res.skipped).toHaveLength(1)
    expect(res.skipped[0].similarity).toBeGreaterThanOrEqual(SURPRISE_REDUNDANT_THRESHOLD)
    expect(res.skipped[0].nearest).toBe('Theo works at Orbis Inc')
    expect(res.failedOpen).toBe(false)
  })

  it('keeps a novel candidate that only shares a topic', async () => {
    const embed = fakeEmbed({
      'Theo works at Orbis Inc': [1, 0, 0],
      'Theo prefers rich Feishu formatting': [0.3, 0.95, 0], // related-ish but cosine 0.3 < threshold
    })
    const res = await surpriseGate(['Theo prefers rich Feishu formatting'], ['Theo works at Orbis Inc'], embed)
    expect(res.keep).toEqual(['Theo prefers rich Feishu formatting'])
    expect(res.skipped).toEqual([])
  })

  it('partitions a mixed batch (keep novel, skip redundant)', async () => {
    const embed = fakeEmbed({
      existing: [1, 0, 0],
      dupe: [0.98, 0.19, 0],
      // "novel" is unknown ⇒ its own orthogonal axis ⇒ cosine 0
    })
    const res = await surpriseGate(['dupe', 'novel'], ['existing'], embed)
    expect(res.keep).toEqual(['novel'])
    expect(res.skipped.map((s) => s.fact)).toEqual(['dupe'])
  })

  it('fails OPEN when the embedder throws (never drops a fact to a broken signal)', async () => {
    const boom: EmbedFn = async () => {
      throw new Error('embedder cold')
    }
    const res = await surpriseGate(['a', 'b'], ['x'], boom)
    expect(res.keep).toEqual(['a', 'b'])
    expect(res.failedOpen).toBe(true)
  })

  it('fails OPEN on an empty/mismatched embedding result (cold embedder returns [])', async () => {
    const cold: EmbedFn = async () => []
    const res = await surpriseGate(['a'], ['x'], cold)
    expect(res.keep).toEqual(['a'])
    expect(res.failedOpen).toBe(true)
  })

  it('keeps all when memory is empty (nothing to be redundant against)', async () => {
    const embed = fakeEmbed({})
    const res: SurpriseGateResult = await surpriseGate(['a', 'b'], [], embed)
    expect(res.keep).toEqual(['a', 'b'])
    expect(res.failedOpen).toBe(false)
  })

  it('keeps nothing when there are no candidates', async () => {
    const res = await surpriseGate([], ['x'], fakeEmbed({}))
    expect(res.keep).toEqual([])
    expect(res.skipped).toEqual([])
  })
})
