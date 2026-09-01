import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../providers/registry', () => ({ routeModel: () => null, chatOnce: async () => ({ content: '' }) }))

import {
  measureOne,
  selectMeasureModelLocalOnly,
  selectMeasureModelLocalFirst,
  type MeasureModelRouter
} from './judgment-measure-live'
import { __resetOperatorModel, recordFacts, promoteFact, confirmFact, getOperatorFacts, listByStatus } from './operator-model'
import type { MeasureDeps } from './judgment-measure'

// The fact flips the answer (with-fact honors it, without-fact does not) → measurable lift.
const stubDeps: MeasureDeps = {
  probes: () => ['q1', 'q2', 'q3'],
  answer: (_q, factText) => (factText ? 'honors it' : 'ignores it'),
  grade: (_fact, answer) => answer === 'honors it'
}

beforeEach(() => __resetOperatorModel())

describe('measureOne (item 13 — incremental measure on promotion)', () => {
  it('measures one promoted fact and persists its efficacy', async () => {
    recordFacts([{ fact: 'Lead with the risk' }])
    const f = getOperatorFacts()[0]
    promoteFact(f.id)
    confirmFact(f.id) // → promoted (measureHook is unset in this unit test, so no auto-fire)
    await measureOne(f.id, stubDeps)
    const pf = listByStatus('promoted').find((x) => x.id === f.id)!
    expect(pf.efficacy).toBeTruthy()
    expect(pf.efficacy!.trials).toBeGreaterThan(0)
  })

  it('is a no-op for an unknown id', async () => {
    await expect(measureOne('nope', stubDeps)).resolves.toBeUndefined()
  })
})

describe('measure model selection — billable cloud-fallback gating (measure-tick safety)', () => {
  const withLocal: MeasureModelRouter = { localModels: () => ['llama3'], route: () => 'cloud-model' }
  const noLocal: MeasureModelRouter = { localModels: () => [], route: () => 'cloud-model' }

  it('local-only prefers a detected local model', () => {
    expect(selectMeasureModelLocalOnly(withLocal)).toBe('ollama:llama3')
  })
  it('local-only NEVER falls back to a billable cloud model (returns null so the pass no-ops)', () => {
    expect(selectMeasureModelLocalOnly(noLocal)).toBeNull()
  })
  it('local-first still prefers local, then DOES fall back to cloud (autonomy-on path)', () => {
    expect(selectMeasureModelLocalFirst(withLocal)).toBe('ollama:llama3')
    expect(selectMeasureModelLocalFirst(noLocal)).toBe('cloud-model')
  })
})
