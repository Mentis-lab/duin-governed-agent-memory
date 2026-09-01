import { describe, it, expect } from 'vitest'
import { nextKnobValue, type KnobVerdict } from './rsi-proposer'

const arch = (o: Record<number, KnobVerdict>) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v])) as Map<number, KnobVerdict>

describe('nextKnobValue — QD stepping-stone search: explore → exploit', () => {
  const bound = { min: 1, max: 5 }
  it('EXPLORE: prefers an unexplored (novel) value over the current', () => {
    expect(nextKnobValue(3, bound, arch({}))).toBe(1)
  })
  it('EXPLORE: never re-proposes a rolled-back value (the greedy dead-end)', () => {
    expect(nextKnobValue(3, bound, arch({ 1: 'rolled-back', 2: 'rolled-back' }))).toBe(4)
  })
  it('EXPLORE: skips already-explored values (kept/improved) in favour of novelty', () => {
    expect(nextKnobValue(3, bound, arch({ 1: 'improved', 2: 'kept' }))).toBe(4)
  })
  it('EXPLOIT: when novelty is exhausted, CONVERGES to a proven-improved value (consumes the contract)', () => {
    // all explored, cur=3 flat-ish; value 1 delivered a lift → converge to it, not rest
    expect(nextKnobValue(3, bound, arch({ 1: 'improved', 2: 'kept', 4: 'rolled-back', 5: 'kept' }))).toBe(1)
  })
  it('a kept-but-FLAT value is NOT a convergence target (only proven-improved is)', () => {
    // 1,2,4,5 all kept-flat (no lift), cur=3 → no novelty, no improved → rest
    expect(nextKnobValue(3, bound, arch({ 1: 'kept', 2: 'kept', 4: 'kept', 5: 'kept' }))).toBeNull()
  })
  it('rests (null) when the improved value IS the current value (already converged)', () => {
    expect(nextKnobValue(1, bound, arch({ 1: 'improved', 2: 'rolled-back', 3: 'kept', 4: 'rolled-back', 5: 'kept' }))).toBeNull()
  })
})
