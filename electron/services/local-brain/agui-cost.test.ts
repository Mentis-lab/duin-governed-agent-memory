import { describe, it, expect } from 'vitest'
import {
  emptyTurnCost,
  accrueTurnCost,
  shouldRefuseForBudget,
  readTurnBudgetUsd,
  toTokenUsage,
  budgetRefusalMessage
} from './agui-cost'
import type { NormalizedUsage } from '../providers/usage-accounting'

// The per-turn cost meter. Two behaviours carry the design and must not regress:
//   · the meter is BEST-EFFORT — a provider that reports no usage must never disturb the turn;
//   · the ceiling WAIVES continuation rounds — a continuation is the same answer still being
//     written, and refusing there truncates a document the operator is watching stream.

const usage = (over: Partial<NormalizedUsage> = {}): NormalizedUsage => ({
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  promptTokens: 1_000_000,
  ...(over as object)
}) as NormalizedUsage

describe('readTurnBudgetUsd — default OFF', () => {
  it('is 0 (disabled) when unset', () => {
    expect(readTurnBudgetUsd({} as NodeJS.ProcessEnv)).toBe(0)
  })
  it('is 0 on garbage or a non-positive number', () => {
    expect(readTurnBudgetUsd({ DUIN_TURN_COST_BUDGET_USD: 'lots' } as never)).toBe(0)
    expect(readTurnBudgetUsd({ DUIN_TURN_COST_BUDGET_USD: '-5' } as never)).toBe(0)
    expect(readTurnBudgetUsd({ DUIN_TURN_COST_BUDGET_USD: '0' } as never)).toBe(0)
  })
  it('reads a positive ceiling', () => {
    expect(readTurnBudgetUsd({ DUIN_TURN_COST_BUDGET_USD: '2.50' } as never)).toBe(2.5)
  })
})

describe('toTokenUsage — adapting provider usage to the cost vocabulary', () => {
  it('bills cache WRITES at full input price and cache READS at the cached rate', () => {
    const t = toTokenUsage('m', usage({ inputTokens: 100, cacheWriteTokens: 40, cacheReadTokens: 900 }))
    expect(t.inputTokens).toBe(140) // 100 uncached + 40 cache-write
    expect(t.cachedInputTokens).toBe(900)
  })
  it('floors negative counts at 0', () => {
    const t = toTokenUsage('m', usage({ inputTokens: -5, outputTokens: -1, cacheReadTokens: -9 }))
    expect(t.inputTokens).toBe(0)
    expect(t.outputTokens).toBe(0)
    expect(t.cachedInputTokens).toBe(0)
  })
})

describe('accrueTurnCost', () => {
  it('accrues at the non-zero fallback price for an unknown model', () => {
    // DEFAULT_PROVIDER_PRICE = $1/Mtok in, $3/Mtok out ⇒ 1M+1M = $4.
    const c = accrueTurnCost(emptyTurnCost(), 'some-unlisted-model', usage())
    expect(c.spentUsd).toBeCloseTo(4, 6)
    expect(c.metered).toBe(1)
  })

  it('sums across model calls', () => {
    let c = emptyTurnCost()
    c = accrueTurnCost(c, 'm', usage())
    c = accrueTurnCost(c, 'm', usage())
    expect(c.metered).toBe(2)
    expect(c.inputTokens).toBe(2_000_000)
    expect(c.spentUsd).toBeCloseTo(8, 6)
  })

  // Best-effort: metering must never gate answering.
  it('is a no-op when the provider reported no usage', () => {
    const before = accrueTurnCost(emptyTurnCost(), 'm', usage())
    const after = accrueTurnCost(before, 'm', undefined)
    expect(after).toEqual(before)
  })
})

describe('shouldRefuseForBudget', () => {
  const spent = (usd: number) => ({ ...emptyTurnCost(), spentUsd: usd })

  it('never refuses when no ceiling is configured', () => {
    expect(shouldRefuseForBudget(spent(999), 0, false).stop).toBe(false)
  })
  it('refuses a fresh round once spend reaches the ceiling', () => {
    expect(shouldRefuseForBudget(spent(2), 2, false).stop).toBe(true)
    expect(shouldRefuseForBudget(spent(1.99), 2, false).stop).toBe(false)
  })
  // The rule that protects the reading experience.
  it('WAIVES the ceiling for a continuation round (never truncate mid-answer)', () => {
    expect(shouldRefuseForBudget(spent(99), 2, true).stop).toBe(false)
  })
})

describe('budgetRefusalMessage', () => {
  it('states both numbers so the refusal is actionable', () => {
    const m = budgetRefusalMessage({ ...emptyTurnCost(), spentUsd: 2.345 }, 2)
    expect(m).toContain('$2.35')
    expect(m).toContain('$2.00')
    expect(m).toContain('DUIN_TURN_COST_BUDGET_USD')
  })
})
