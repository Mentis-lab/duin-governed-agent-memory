// Long-run L5 — cost budget + burn rate. checkCeilings already covers
// iters/wallclock/tokens; this adds the missing DOLLAR dimension (the $500
// surprise). Cost is DATA, not hardcoded: a PriceTable (from settings/env) is
// injected, so unknown models simply cost 0 (never blocks silently — it only
// alerts on known spend). On a budget breach the loop finishes the current
// commit+journal, then halts: stop-not-corrupt.
//
// All PURE. TokenUsage is imported from run-journal.ts (dependency A -> B).

import type { TokenUsage } from './run-journal'

/** USD price per 1M tokens for one model. */
export interface ProviderPrice {
  inputPerMTok: number
  outputPerMTok: number
  cachedInputPerMTok?: number
}

/** model-id -> price. Injected (from settings/env) so cost is data, not code. */
export type PriceTable = Record<string, ProviderPrice>

/**
 * Conservative blended $/Mtok fallback used when a model is not in the price
 * table (production wires `priceTable: {}`, so without this every unknown model
 * would accrue $0 and the cost budget / burn-rate would never fire). Deliberately
 * on the cheap-but-nonzero side so cost ACCRUES for unknown models rather than
 * being silently inert. A caller that truly wants the old zero behavior passes
 * `fallback={inputPerMTok:0,outputPerMTok:0}`.
 */
export const DEFAULT_PROVIDER_PRICE: ProviderPrice = { inputPerMTok: 1, outputPerMTok: 3 }

/**
 * PURE. (input*inputRate + cached*cachedRate + output*outputRate) / 1e6.
 * Unknown model (no `usage.model`, or not in the table) falls back to
 * `fallback` (default DEFAULT_PROVIDER_PRICE) so cost still accrues instead of
 * silently reading 0. A model without a cachedInputPerMTok bills cached tokens
 * at 0. Negative token counts are floored at 0; zero tokens ⇒ 0.
 */
export function costOfUsage(
  usage: TokenUsage,
  priceTable: PriceTable,
  fallback: ProviderPrice = DEFAULT_PROVIDER_PRICE
): number {
  const price = (usage.model && priceTable[usage.model]) || fallback
  const input = Math.max(0, usage.inputTokens || 0)
  const output = Math.max(0, usage.outputTokens || 0)
  const cached = Math.max(0, usage.cachedInputTokens ?? 0)
  const cachedRate = price.cachedInputPerMTok ?? 0
  return (input * price.inputPerMTok + cached * cachedRate + output * price.outputPerMTok) / 1e6
}

/** PURE. The single accumulate op for Loop.costSpent. Negative deltas ignored. */
export function accrue(spent: number, delta: number): number {
  return spent + Math.max(0, delta)
}

/** PURE. Spend per hour. elapsedMs <= 0 -> 0. Feeds the L5 alert + L8 digest. */
export function burnRatePerHour(spent: number, elapsedMs: number): number {
  return elapsedMs <= 0 ? 0 : spent / (elapsedMs / 3.6e6)
}

/** Mirror of CeilingDecision so the caller merges it into the existing stop path. */
export interface CostCeilingDecision {
  stop: boolean
  reason?: string
}

/**
 * PURE. budget != null && budget > 0 && spent >= budget -> stop 'cost-budget';
 * else no stop. A null or non-positive budget disables the cost ceiling. On a
 * breach the loop halts AFTER the current commit+journal lands (stop-not-corrupt).
 */
export function checkCostCeiling(spent: number, budget: number | null): CostCeilingDecision {
  if (budget != null && budget > 0 && spent >= budget) {
    return { stop: true, reason: 'cost-budget' }
  }
  return { stop: false }
}
