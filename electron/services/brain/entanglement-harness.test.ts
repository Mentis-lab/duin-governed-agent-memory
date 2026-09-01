import { describe, it, expect } from 'vitest'
import { runEntanglement, EXAMPLE_PROBES, type EntanglementProbe, type AnswerFn, type ShiftGrader } from './entanglement-harness'

const probes: EntanglementProbe[] = [
  { id: 'p1', query: 'q1', groundedExpectation: 'e1' },
  { id: 'p2', query: 'q2', groundedExpectation: 'e2' },
  { id: 'p3', query: 'q3', groundedExpectation: 'e3' }
]
const shiftGrader: ShiftGrader = (bare, grounded) => bare !== grounded

describe('entanglement-harness (item 22 — is it DUIN or the model?)', () => {
  it('grounding shifting under BOTH models → fully DUIN-attributable', async () => {
    const answer: AnswerFn = (_q, _p, grounded) => (grounded ? 'GROUNDED' : 'BARE')
    const r = await runEntanglement(probes, 'deepseek', 'ollama:llama', answer, shiftGrader)
    expect(r.attributionScore).toBe(1)
    expect(r.entanglementRate).toBe(0)
    expect(r.results.every((x) => x.duinAttributable)).toBe(true)
  })

  it('grounding shifting under only ONE model → fully model-entangled', async () => {
    const answer: AnswerFn = (_q, provider, grounded) => (provider === 'deepseek' && grounded ? 'MOVED' : 'SAME')
    const r = await runEntanglement(probes, 'deepseek', 'ollama:llama', answer, shiftGrader)
    expect(r.attributionScore).toBe(0)
    expect(r.entanglementRate).toBe(1)
    expect(r.results.every((x) => x.modelEntangled)).toBe(true)
  })

  it('empty probe set → zeroed report, never divides by zero', async () => {
    const r = await runEntanglement([], 'a', 'b', () => 'x', () => false)
    expect(r).toMatchObject({ n: 0, attributionScore: 0, entanglementRate: 0 })
  })

  it('ships an illustrative example probe set', () => {
    expect(EXAMPLE_PROBES.length).toBeGreaterThan(0)
    expect(EXAMPLE_PROBES.every((p) => p.id && p.query && p.groundedExpectation)).toBe(true)
  })
})
