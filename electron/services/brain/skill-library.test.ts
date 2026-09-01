import { describe, it, expect } from 'vitest'
import {
  tokens,
  scoreOverlap,
  selectExemplars,
  renderExemplarsBlock,
  scoreEmbedded,
  selectExemplarsEmbedded,
  getSkillGroundingAsync,
  type SkillExemplar
} from './skill-library'
import { recordSuccess, __resetSuccessStore } from './success-miner'

/** Deterministic fake embedder: text → fixed vector via a lookup, [0,0,0] otherwise. */
const fakeEmbed = (map: Record<string, number[]>) => async (texts: string[]): Promise<number[][]> =>
  texts.map((t) => map[t] ?? [0, 0, 0])

describe('tokens', () => {
  it('keeps content words, drops stopwords + short tokens', () => {
    expect([...tokens('How do I write a concise summary')]).toEqual(['write', 'concise', 'summary'])
  })
})

describe('scoreOverlap', () => {
  it('is the fraction of request tokens the exemplar covers', () => {
    const rt = tokens('write a concise summary')
    expect(scoreOverlap(rt, 'give me a concise summary please')).toBeCloseTo(2 / 3, 5) // concise+summary of {write,concise,summary}
    expect(scoreOverlap(rt, 'unrelated deploy question')).toBe(0)
  })
})

describe('selectExemplars', () => {
  const traces = [
    { id: 'a', query: 'write a concise summary of the plan', answer: 'Be terse; cut hedging.' },
    { id: 'b', query: 'give me a concise summary now', answer: 'Bullet it.' }, // exact tokens
    { id: 'c', query: 'what is the capital of France', answer: 'Paris.' }
  ]
  it('returns the most relevant successes above the floor, top-K, best first', () => {
    const sel = selectExemplars('write a concise summary', traces, { topK: 2, floor: 0.34 })
    expect(sel.map((e) => e.id)).toEqual(['a', 'b']) // a covers 3/3, b covers concise+summary (2/3); c off-topic
    expect(sel[0].id).toBe('a') // higher overlap ranks first
    expect(sel[0].score).toBeGreaterThanOrEqual(sel[1].score)
  })

  it('is token-EXACT (v1 limitation): different word forms do not match', () => {
    // "summarize"/"concisely" ≠ "summary"/"concise" without stemming → below floor.
    const sel = selectExemplars('write a concise summary', [
      { id: 'x', query: 'summarize the deploy steps concisely', answer: 'ok' }
    ])
    expect(sel).toHaveLength(0)
  })
  it('returns nothing for an unrelated request', () => {
    expect(selectExemplars('deploy the kubernetes cluster', traces)).toHaveLength(0)
  })
  it('drops exemplars with an empty answer', () => {
    const sel = selectExemplars('concise summary', [{ id: 'x', query: 'concise summary', answer: '   ' }])
    expect(sel).toHaveLength(0)
  })
})

describe('scoreEmbedded', () => {
  it('is the cosine of two embeddings', () => {
    expect(scoreEmbedded([1, 0], [1, 0])).toBeCloseTo(1, 5)
    expect(scoreEmbedded([1, 0], [0, 1])).toBeCloseTo(0, 5)
  })
})

describe('selectExemplarsEmbedded', () => {
  const traces = [
    { id: 'a', query: 'qa', answer: 'A' },
    { id: 'b', query: 'qb', answer: 'B' },
    { id: 'c', query: 'qc', answer: '   ' } // empty answer → dropped before embed
  ]
  it('ranks by cosine, respects floor + topK, drops empty answers', async () => {
    const embed = fakeEmbed({ Q: [1, 0, 0], qa: [1, 0, 0], qb: [0, 1, 0] })
    const sel = await selectExemplarsEmbedded('Q', traces, embed, { topK: 2, floor: 0.5 })
    expect(sel.map((e) => e.id)).toEqual(['a']) // a cos=1 ≥ 0.5; b cos=0 < 0.5; c dropped
    expect(sel[0].score).toBeCloseTo(1, 5)
  })
  it('returns [] when the embedder is unavailable (empty matrix)', async () => {
    const sel = await selectExemplarsEmbedded('Q', traces, async () => [], { topK: 2, floor: 0.5 })
    expect(sel).toEqual([])
  })
})

describe('getSkillGroundingAsync', () => {
  it('falls back to the token-overlap ranker when embeddings are unavailable', async () => {
    __resetSuccessStore()
    recordSuccess('write a concise summary of the plan', 'Be terse; cut hedging.')
    // embedder returns [] → must fall back to the sync token-overlap grounding, not blank out.
    const block = await getSkillGroundingAsync('write a concise summary', async () => [])
    expect(block).toContain('WHAT HAS WORKED BEFORE')
    expect(block).toContain('Be terse')
    __resetSuccessStore()
  })
})

describe('renderExemplarsBlock', () => {
  it('is empty for no exemplars', () => {
    expect(renderExemplarsBlock([])).toBe('')
  })
  it('formats a lean-this-way few-shot block', () => {
    const ex: SkillExemplar[] = [{ id: 'a', query: 'summarize', answer: 'Be terse.', score: 1 }]
    const block = renderExemplarsBlock(ex)
    expect(block).toContain('WHAT HAS WORKED BEFORE')
    expect(block).toContain('When asked "summarize"')
    expect(block).toContain('Be terse.')
  })
})
