import { describe, it, expect, afterEach } from 'vitest'
import {
  calibrationConsumeMode,
  DECISION_WINDOW_CONSUMED
} from './compounding-health-live'
import { CALIBRATION_MODE_SCORE } from './compounding-health'

describe('calibrationConsumeMode (P4b — HONEST consumption metric)', () => {
  const saved = process.env.DUIN_CALIBRATION_CONSUME
  afterEach(() => {
    if (saved === undefined) delete process.env.DUIN_CALIBRATION_CONSUME
    else process.env.DUIN_CALIBRATION_CONSUME = saved
  })

  it('reports the wire as PRESENT (the const gates the honest baseline)', () => {
    expect(DECISION_WINDOW_CONSUMED).toBe(true)
  })

  it("defaults to 'rerank' now that the P4b wire is present — NOT advisory", () => {
    delete process.env.DUIN_CALIBRATION_CONSUME
    expect(calibrationConsumeMode()).toBe('rerank')
    // and that mode scores the Grounding calibration sub-axis at 100 (was 20 advisory)
    expect(CALIBRATION_MODE_SCORE[calibrationConsumeMode()]).toBe(100)
    expect(CALIBRATION_MODE_SCORE.advisory).toBe(20)
  })

  it('remains env-overridable for ops (advisory/gate/rerank)', () => {
    process.env.DUIN_CALIBRATION_CONSUME = 'advisory'
    expect(calibrationConsumeMode()).toBe('advisory')
    process.env.DUIN_CALIBRATION_CONSUME = 'gate'
    expect(calibrationConsumeMode()).toBe('gate')
  })
})
