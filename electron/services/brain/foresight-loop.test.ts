import { describe, it, expect } from 'vitest'
import { overdueWindows, preplayOverdue, type ForesightLoopDeps } from './foresight-loop'
import type { DecisionSimResult, OptionForecast } from './decision-simulator'

const NOW = Date.UTC(2026, 6, 25)
const DAY = 86_400_000

const row = (over: Record<string, unknown> = {}) => ({
  id: 'w1',
  kind: 'decision-window',
  predicted: 'decide the thing',
  track: 'T',
  eval_after: { by: '2026-07-01' },
  ...over
})

function option(id: string, supported: number, unsupported = 0): OptionForecast {
  return {
    optionId: id,
    label: id,
    consequences: [
      ...Array.from({ length: supported }, () => ({ text: 't', horizon: 'near' as const, basis: 'b', supported: true })),
      ...Array.from({ length: unsupported }, () => ({ text: 't', horizon: 'near' as const, basis: '', supported: false }))
    ],
    riskDeltas: [],
    flagged: unsupported,
    forecast: { predicted: '', track: '' }
  }
}

const simOf = (options: OptionForecast[]): DecisionSimResult => ({
  decision: 'd',
  grounded: { risks: [], entities: [] },
  options,
  modelUsed: true
})

const deps = (sim: DecisionSimResult | null, riskTrust: number | null = null): ForesightLoopDeps => ({
  simulate: async () => sim,
  riskTrust: () => riskTrust
})

describe('overdueWindows', () => {
  it('selects only unresolved decision-windows past their decide-by date', () => {
    const rows = [
      row({ id: 'late' }),
      row({ id: 'future', eval_after: { by: '2026-12-01' } }),
      row({ id: 'decided', verdict: 'averted' }),
      row({ id: 'resolved', resolved: '2026-07-02' }),
      row({ id: 'other-kind', kind: 'driver' })
    ]
    expect(overdueWindows(rows, NOW).map((w) => w.id)).toEqual(['late'])
  })

  it('skips a row with no parseable due date rather than assuming it is overdue', () => {
    expect(overdueWindows([row({ eval_after: {} }), row({ eval_after: { by: 'someday' } })], NOW)).toEqual([])
  })

  it('orders most-overdue first and reports the day count', () => {
    const rows = [row({ id: 'a', eval_after: { by: '2026-07-20' } }), row({ id: 'b', eval_after: { by: '2026-07-01' } })]
    const w = overdueWindows(rows, NOW)
    expect(w.map((x) => x.id)).toEqual(['b', 'a'])
    expect(w[0].daysOverdue).toBe(Math.floor((NOW - Date.parse('2026-07-01')) / DAY))
  })
})

describe('preplayOverdue', () => {
  it('produces an advisory nudge that is always marked human-ratify', async () => {
    const r = await preplayOverdue([row()], NOW, deps(simOf([option('good', 4), option('weak', 0, 4)])))
    expect(r.overdue).toBe(1)
    expect(r.preplayed).toBe(1)
    expect(r.nudges[0].recommendation).toBe('good')
    expect(r.nudges[0].requiresHumanRatify).toBe(true)
  })

  it('abstains instead of recommending when the rollout cannot separate the options', async () => {
    const r = await preplayOverdue([row()], NOW, deps(simOf([option('a', 2), option('b', 2)])))
    expect(r.nudges[0].recommendation).toBeNull()
    expect(r.nudges[0].decisive).toBe(false)
  })

  it('reports whether ranking CHANGED the answer vs taking the first option', async () => {
    const changed = await preplayOverdue([row()], NOW, deps(simOf([option('first', 0, 4), option('second', 4)])))
    expect(changed.nudges[0].changedTheAnswer).toBe(true)
    const same = await preplayOverdue([row()], NOW, deps(simOf([option('first', 4), option('second', 0, 4)])))
    expect(same.nudges[0].changedTheAnswer).toBe(false)
  })

  it('skips a window whose simulation fails or returns nothing — never guesses', async () => {
    const throwing: ForesightLoopDeps = {
      simulate: async () => {
        throw new Error('model down')
      },
      riskTrust: () => null
    }
    expect((await preplayOverdue([row()], NOW, throwing)).preplayed).toBe(0)
    expect((await preplayOverdue([row()], NOW, deps(null))).preplayed).toBe(0)
    expect((await preplayOverdue([row()], NOW, deps(simOf([])))).preplayed).toBe(0)
  })

  it('honours the limit while still reporting the true overdue count', async () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]
    const r = await preplayOverdue(rows, NOW, deps(simOf([option('x', 2)])), 2)
    expect(r.overdue).toBe(3) // not silently truncated
    expect(r.preplayed).toBe(2)
  })
})
