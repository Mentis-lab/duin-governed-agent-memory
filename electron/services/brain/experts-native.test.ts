import { describe, it, expect } from 'vitest'
import { listExperts } from './experts-native'

// Deep correctness proven by live parity (parity.ts /state/experts → EXACT).
describe('listExperts', () => {
  it('returns the 5 default lens personas with key/label/frame', () => {
    const { experts } = listExperts(null)
    expect(experts.map((e) => e.key)).toEqual(['legal', 'financial', 'strategic', 'ethical', 'redteam'])
    expect(experts.every((e) => e.label && e.frame.length > 20)).toBe(true)
  })
})
