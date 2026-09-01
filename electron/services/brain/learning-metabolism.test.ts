import { describe, it, expect } from 'vitest'
import { distinctiveTokens, isStrong, matchStale, worldTopics, type Topic } from './learning-metabolism'

const NOW = Date.UTC(2026, 6, 4)
const topic = (label: string): Topic => ({ id: label, label, tokens: distinctiveTokens(label) })

describe('learning-metabolism — tokenization', () => {
  it('distinctiveTokens keeps CJK + alnum≥3, drops stopwords + short bits', () => {
    const t = distinctiveTokens('recommit orbis as the priority for 北澜')
    expect(t.has('recommit')).toBe(true)
    expect(t.has('orbis')).toBe(true)
    expect(t.has('priority')).toBe(true)
    expect(t.has('北澜')).toBe(true)
    expect(t.has('the')).toBe(false) // stopword
    expect(t.has('as')).toBe(false) // too short
  })
  it('isStrong flags entity-bearing tokens (CJK / numeric-code / long), not common short words', () => {
    expect(isStrong('北澜')).toBe(true)
    expect(isStrong('orbis')).toBe(true)
    expect(isStrong('priority')).toBe(true) // ≥5
    expect(isStrong('slot')).toBe(false) // 4 chars, no CJK/digit
  })
})

describe('learning-metabolism — matchStale (conservative: ≥2 shared incl. a strong token)', () => {
  const topics = [topic('recommit orbis as priority'), topic('protect strategic slot')]

  it('fires when a fact shares ≥2 distinctive tokens incl. a strong one', () => {
    const hit = matchStale('the operator treats orbis as the top priority right now', topics)
    expect(hit?.label).toBe('recommit orbis as priority') // shares orbis (strong) + priority
  })
  it('does NOT fire on a single shared token', () => {
    expect(matchStale('the operator likes a clear priority', topics)).toBeNull() // only "priority"
  })
  it('does NOT fire on weak-only overlap (no strong/entity token)', () => {
    // shares "protect" + "slot"? "slot" is weak(4), "protect" ≥5 strong → would fire; use a
    // genuinely weak overlap instead:
    expect(matchStale('open the door slot wide', [topic('a slot here')])).toBeNull()
  })
  it('picks the topic with the most overlap', () => {
    const hit = matchStale('protect the strategic slot and the 北澜 launch', [topic('protect strategic slot'), topic('北澜 launch')])
    expect(hit?.label).toBe('protect strategic slot') // 3 shared vs 1
  })
})

describe('learning-metabolism — worldTopics (only resolved/passed become topics)', () => {
  it('a resolved decision (past review) becomes a topic; a future one does not', () => {
    const topics = worldTopics(
      [
        { id: 'd1', title: 'recommit orbis as priority', reviewOn: '2026-06-01' }, // past → resolved
        { id: 'd2', title: 'future thing', reviewOn: '2026-12-01' } // future → not
      ],
      [],
      NOW
    )
    expect(topics.map((t) => t.id)).toEqual(['d1'])
    expect(topics[0].tokens.has('orbis')).toBe(true)
  })
  it('a passed stream (decide-by past) becomes a topic', () => {
    const topics = worldTopics([], [{ id: 's1', title: '北澜 beta stream', decide_by: '2026-05-01' }], NOW)
    expect(topics.map((t) => t.id)).toEqual(['s1'])
  })
})
