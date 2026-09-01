import { describe, it, expect } from 'vitest'
import { executorCostOf, costLine, readExecutorBudgetUsd, shouldStopForBudget, DEEPSEEK_PRICES } from './executor-cost'
import { emptyExecutorUsage, type ExecutorUsage } from './executor-types'

function usage(p: Partial<ExecutorUsage>): ExecutorUsage {
  return { ...emptyExecutorUsage(), ...p }
}

describe('executorCostOf', () => {
  it('prices input, cache-read and output on the DeepSeek table, and reports the cache share', () => {
    // 1M uncached input, 9M cached, 1M output on v4-flash: 1*0.28 + 9*0.028 + 1*0.42 = 0.952
    const c = executorCostOf('deepseek-v4-flash', usage({ inputTokens: 1_000_000, cacheReadTokens: 9_000_000, outputTokens: 1_000_000 }))
    expect(c.spentUsd).toBeCloseTo(0.952, 3)
    expect(c.cacheReadShare).toBeCloseTo(0.9, 3) // 9M of 10M priced input
  })

  it('cacheWrite bills at full input price', () => {
    const c = executorCostOf('deepseek-v4-flash', usage({ cacheWriteTokens: 1_000_000 }))
    expect(c.spentUsd).toBeCloseTo(0.28, 3)
  })

  it('an unknown model still accrues via the cost-table fallback, never silently zero', () => {
    const c = executorCostOf('some-other-model', usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }))
    expect(c.spentUsd).toBeGreaterThan(0)
  })

  it('zero usage is zero', () => {
    expect(executorCostOf('deepseek-v4-flash', emptyExecutorUsage()).spentUsd).toBe(0)
  })
})

describe('costLine', () => {
  it('states the spend and the cache share for a known model', () => {
    const line = costLine('deepseek-v4-flash', usage({ inputTokens: 1_000, cacheReadTokens: 9_000, outputTokens: 500 }))
    expect(line).toMatch(/\$0\./)
    expect(line).toMatch(/90% of input served from cache/)
  })
  it('flags an estimate for a model not in the table', () => {
    expect(costLine('mystery', usage({ inputTokens: 1000 }))).toMatch(/est\./)
  })
})

describe('the budget ceiling', () => {
  it('is off by default and reads a positive env value', () => {
    expect(readExecutorBudgetUsd({})).toBe(0)
    expect(readExecutorBudgetUsd({ DUIN_EXECUTOR_BUDGET_USD: '2.50' })).toBe(2.5)
    expect(readExecutorBudgetUsd({ DUIN_EXECUTOR_BUDGET_USD: 'nope' })).toBe(0)
    expect(readExecutorBudgetUsd({ DUIN_EXECUTOR_BUDGET_USD: '-1' })).toBe(0)
  })
  it('stops at or over the ceiling, never below it, and never when off', () => {
    expect(shouldStopForBudget(0.5, 1).stop).toBe(false)
    expect(shouldStopForBudget(1, 1).stop).toBe(true)
    expect(shouldStopForBudget(1.5, 1).stop).toBe(true)
    expect(shouldStopForBudget(999, 0).stop).toBe(false)
    expect(shouldStopForBudget(1, 1).reason).toMatch(/cost-budget/)
  })
})

describe('the price table', () => {
  it('has the models the executor routes to, and cache-read is far below input', () => {
    for (const id of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
      const p = DEEPSEEK_PRICES[id]
      expect(p, id).toBeTruthy()
      expect(p.cachedInputPerMTok!).toBeLessThan(p.inputPerMTok * 0.2)
    }
  })
})
