import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { syntheticLedger, syntheticReplayScore, SYNTHETIC_LABEL } from './calibration-replay'

describe('calibration-replay (C+ synthetic demo)', () => {
  it('is a skilled, non-degenerate cohort at n>=minN', () => {
    const s = syntheticReplayScore()
    expect(s.n).toBeGreaterThanOrEqual(20)
    expect(s.brier).not.toBeNull()
    expect(s.baseRate).not.toBeNull()
    expect(s.skillScore).not.toBeNull()
    expect(s.skillScore!).toBeGreaterThan(0) // beats the base rate
    expect(s.synthetic).toBe(true)
    expect(s.label).toBe(SYNTHETIC_LABEL)
  })

  it('is deterministic (same ledger + score across calls)', () => {
    expect(syntheticLedger()).toEqual(syntheticLedger())
    expect(syntheticReplayScore().brier).toBe(syntheticReplayScore().brier)
  })

  it('cannot write the real ledger — the module imports no fs', () => {
    const src = readFileSync(join(__dirname, 'calibration-replay.ts'), 'utf-8')
    expect(src).not.toMatch(/from ['"]fs['"]/) // structural guarantee: never touches real state
  })
})
