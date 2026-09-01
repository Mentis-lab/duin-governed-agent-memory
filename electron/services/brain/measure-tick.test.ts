import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock the provider registry so we can assert the tick's model selection is provider-agnostic +
// local-first WITHOUT a live registry. getOllamaModels drives the "local available?" branch;
// routeModel is the cloud fallback we assert is only reached when NO local model exists.
const routeModel = vi.fn((_task: string) => 'gpt-4o-mini') // a cloud model id (fallback path)
const getOllamaModels = vi.fn(() => [] as string[])
vi.mock('../providers/registry', () => ({
  routeModel: (...a: unknown[]) => routeModel(...(a as [string])),
  getOllamaModels: () => getOllamaModels(),
  chatOnce: async () => ({ content: '' })
}))

import {
  measureTick,
  startMeasureTick,
  stopMeasureTick,
  measureTickEnabled
} from './measure-tick'
import { selectMeasureModelLocalFirst, type MeasureModelRouter } from './judgment-measure-live'
import type { MeasureDeps } from './judgment-measure'
import { __resetOperatorModel, recordFacts, promoteFact, confirmFact, getOperatorFacts, listByStatus } from './operator-model'

// A/B deps whose model flips the answer (with-fact honors it, without does not) → measurable lift.
function stubDeps(): MeasureDeps {
  return {
    probes: () => ['q1', 'q2', 'q3'],
    answer: (_q, factText) => (factText ? 'honors it' : 'ignores it'),
    grade: (_fact, answer) => answer === 'honors it'
  }
}

describe('selectMeasureModelLocalFirst (provider-agnostic, LOCAL-FIRST)', () => {
  beforeEach(() => {
    routeModel.mockClear()
    getOllamaModels.mockClear()
  })

  it('prefers a detected LOCAL model — never touches the cloud router', () => {
    const router: MeasureModelRouter = {
      localModels: () => ['llama3.2:latest', 'qwen2.5:7b'],
      route: vi.fn(() => 'some-cloud-model')
    }
    const picked = selectMeasureModelLocalFirst(router)
    expect(picked).toBe('ollama:llama3.2:latest') // the first local model, provider-agnostic
    expect(router.route).not.toHaveBeenCalled() // cloud fallback NOT reached when local exists
  })

  it('falls back to the configured cloud provider via routeModel when NO local model is available', () => {
    const route = vi.fn((_t: string) => 'operator-configured-model')
    const router: MeasureModelRouter = { localModels: () => [], route }
    const picked = selectMeasureModelLocalFirst(router)
    expect(picked).toBe('operator-configured-model')
    expect(route).toHaveBeenCalledWith('extraction') // routed through the abstraction, nothing hardcoded
  })

  it('does not hardcode a provider — selection comes entirely from the injected router', () => {
    const router: MeasureModelRouter = { localModels: () => [], route: () => 'zhipu-or-whatever-key-exists' }
    expect(selectMeasureModelLocalFirst(router)).toBe('zhipu-or-whatever-key-exists')
  })

  it('is failure-isolated: a throwing router yields null (keyless-safe), not an exception', () => {
    const router: MeasureModelRouter = {
      localModels: () => {
        throw new Error('registry blew up')
      },
      route: () => null
    }
    expect(() => selectMeasureModelLocalFirst(router)).not.toThrow()
    expect(selectMeasureModelLocalFirst(router)).toBeNull()
  })

  it('default router prefers local (getOllamaModels) over the cloud routeModel', () => {
    getOllamaModels.mockReturnValueOnce(['mistral:latest'])
    expect(selectMeasureModelLocalFirst()).toBe('ollama:mistral:latest')
    expect(routeModel).not.toHaveBeenCalled()
  })
})

describe('measureTick (the scheduled measure pass)', () => {
  beforeEach(() => __resetOperatorModel())
  afterEach(() => {
    stopMeasureTick()
    vi.useRealTimers()
    delete process.env.DUIN_MEASURE_TICK
  })

  it('invokes runMeasurePass and persists efficacy for eligible facts', async () => {
    recordFacts([{ fact: 'Lead with the risk' }])
    const f = getOperatorFacts()[0]
    promoteFact(f.id)
    confirmFact(f.id) // → promoted
    measureTick(stubDeps())
    // measureTick is fire-and-forget; let its async pass settle.
    await vi.waitFor(() => {
      const pf = listByStatus('promoted').find((x) => x.id === f.id)!
      expect(pf.efficacy).toBeTruthy()
      expect(pf.efficacy!.trials).toBeGreaterThan(0)
    })
  })

  it('respects the batch cap: measures at most N facts per pass', async () => {
    recordFacts([{ fact: 'Lead with the risk' }, { fact: 'Prefer local models' }, { fact: 'Cite every source' }])
    for (const f of getOperatorFacts()) {
      promoteFact(f.id)
      confirmFact(f.id)
    }
    measureTick(stubDeps(), 1) // cap = 1
    await vi.waitFor(() => {
      const measured = listByStatus('promoted').filter((x) => x.efficacy != null)
      expect(measured.length).toBe(1) // only ONE fact measured despite three eligible
    })
    // A second capped pass prioritizes an un-measured fact → coverage grows to 2, not re-measuring the head.
    measureTick(stubDeps(), 1)
    await vi.waitFor(() => {
      const measured = listByStatus('promoted').filter((x) => x.efficacy != null)
      expect(measured.length).toBe(2)
    })
  })

  it('swallows a throwing measure — the app stays safe (never rejects to the caller)', async () => {
    recordFacts([{ fact: 'boom' }])
    const f = getOperatorFacts()[0]
    promoteFact(f.id)
    confirmFact(f.id)
    const throwingDeps: MeasureDeps = {
      probes: () => {
        throw new Error('probe exploded')
      },
      answer: () => '',
      grade: () => false
    }
    // Note: measureFact already drops a throwing trial, so also assert the tick itself never throws.
    expect(() => measureTick(throwingDeps)).not.toThrow()
  })

  it('is a cheap no-op when there are no eligible facts', () => {
    expect(() => measureTick(stubDeps())).not.toThrow()
  })

  it('flag OFF (DUIN_MEASURE_TICK=0) ⇒ start is a no-op, tick never scheduled', () => {
    process.env.DUIN_MEASURE_TICK = '0'
    expect(measureTickEnabled()).toBe(false)
    vi.useFakeTimers()
    const spy = vi.fn()
    startMeasureTick({ probes: spy, answer: () => '', grade: () => false })
    vi.advanceTimersByTime(24 * 60 * 60_000) // a full day
    expect(spy).not.toHaveBeenCalled() // nothing scheduled while flag is off
  })

  it('flag ON ⇒ the scheduler fires the pass on its clock (injectable timer)', async () => {
    delete process.env.DUIN_MEASURE_TICK
    recordFacts([{ fact: 'Lead with the risk' }])
    const f = getOperatorFacts()[0]
    promoteFact(f.id)
    confirmFact(f.id)
    vi.useFakeTimers()
    startMeasureTick(stubDeps())
    // Advance past INITIAL_MS (60s) so the first settle-delayed pass fires.
    await vi.advanceTimersByTimeAsync(61_000)
    // Flush the fire-and-forget async pass.
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
    await vi.waitFor(() => {
      const pf = listByStatus('promoted').find((x) => x.id === f.id)!
      expect(pf.efficacy).toBeTruthy()
    })
  })
})
