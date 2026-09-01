import { describe, it, expect } from 'vitest'
import {
  costOfUsage,
  accrue,
  burnRatePerHour,
  checkCostCeiling,
  DEFAULT_PROVIDER_PRICE,
  type PriceTable
} from './cost-budget'
import type { TokenUsage } from './run-journal'

// L5 — cost budget + burn rate. Pure; runs everywhere.

const PRICES: PriceTable = {
  'duin-brain': { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
  'cheap-model': { inputPerMTok: 1, outputPerMTok: 2 }
}

describe('costOfUsage', () => {
  it('happy path: input + cached + output priced per 1M tokens', () => {
    const usage: TokenUsage = {
      model: 'duin-brain',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 1_000_000
    }
    // 1*3 + 1*0.3 + 1*15 = 18.3
    expect(costOfUsage(usage, PRICES)).toBeCloseTo(18.3, 10)
  })

  it('unknown model -> falls back to DEFAULT_PROVIDER_PRICE (cost accrues, not inert)', () => {
    // 5M input * $1/Mtok fallback = $5 (was 0 before the fallback).
    expect(costOfUsage({ model: 'mystery', inputTokens: 5_000_000, outputTokens: 0 }, PRICES)).toBeCloseTo(
      5_000_000 * DEFAULT_PROVIDER_PRICE.inputPerMTok / 1e6,
      10
    )
  })

  it('missing model field -> falls back to DEFAULT_PROVIDER_PRICE', () => {
    expect(costOfUsage({ inputTokens: 5_000_000, outputTokens: 0 }, PRICES)).toBeCloseTo(5, 10)
  })

  it('caller can opt back into zero-cost with an explicit zero fallback', () => {
    const zero = { inputPerMTok: 0, outputPerMTok: 0 }
    expect(costOfUsage({ model: 'mystery', inputTokens: 5_000_000, outputTokens: 9 }, PRICES, zero)).toBe(0)
    expect(costOfUsage({ inputTokens: 5_000_000, outputTokens: 9 }, {}, zero)).toBe(0)
  })

  it('model without cachedInputPerMTok bills cached tokens at 0', () => {
    const usage: TokenUsage = {
      model: 'cheap-model',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000
    }
    // 1*1 + cached*0 + 0 = 1
    expect(costOfUsage(usage, PRICES)).toBeCloseTo(1, 10)
  })

  it('edge: negative token counts floored at 0', () => {
    expect(costOfUsage({ model: 'cheap-model', inputTokens: -10, outputTokens: -10 }, PRICES)).toBe(0)
  })

  it('edge: zero usage -> 0', () => {
    expect(costOfUsage({ model: 'duin-brain', inputTokens: 0, outputTokens: 0 }, PRICES)).toBe(0)
  })
})

describe('accrue', () => {
  it('accumulates positive deltas', () => {
    expect(accrue(1.5, 0.5)).toBe(2)
  })

  it('ignores negative deltas (monotonic spend)', () => {
    expect(accrue(2, -1)).toBe(2)
  })

  it('edge: zero delta is a no-op', () => {
    expect(accrue(3, 0)).toBe(3)
  })
})

describe('burnRatePerHour', () => {
  it('computes spend per hour', () => {
    // $6 over 2h -> $3/h
    expect(burnRatePerHour(6, 2 * 3.6e6)).toBeCloseTo(3, 10)
  })

  it('edge: elapsedMs <= 0 -> 0 (no divide-by-zero)', () => {
    expect(burnRatePerHour(10, 0)).toBe(0)
    expect(burnRatePerHour(10, -5)).toBe(0)
  })
})

describe('checkCostCeiling', () => {
  it('does not stop below budget', () => {
    expect(checkCostCeiling(4.99, 5)).toEqual({ stop: false })
  })

  it('stops AT the budget boundary (breach-boundary) with reason cost-budget', () => {
    expect(checkCostCeiling(5, 5)).toEqual({ stop: true, reason: 'cost-budget' })
  })

  it('stops above the budget (the $500 surprise this kills)', () => {
    expect(checkCostCeiling(500, 100)).toEqual({ stop: true, reason: 'cost-budget' })
  })

  it('null budget disables the ceiling', () => {
    expect(checkCostCeiling(999, null)).toEqual({ stop: false })
  })

  it('zero / negative budget disables the ceiling (0 disables convention)', () => {
    expect(checkCostCeiling(999, 0)).toEqual({ stop: false })
    expect(checkCostCeiling(999, -1)).toEqual({ stop: false })
  })
})
