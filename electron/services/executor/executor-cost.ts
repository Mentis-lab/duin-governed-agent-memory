// executor-cost — what a delegated run is spending, and the ceiling that stops it.
//
// Reuses the long-run cost vocabulary (longrun/cost-budget.ts: costOfUsage / accrue /
// checkCostCeiling — pure, tested) with a DeepSeek price table, so the executor's spend is
// counted the same way the loop engine counts a loop's. The meter always runs; the ceiling is
// off by default (a run cut mid-task is a worse surprise than a known bill for anyone who never
// chose a number) and set with DUIN_EXECUTOR_BUDGET_USD.
//
// The point of showing it: dsh runs on a cached model, so cacheReadTokens dominate and cost a
// tenth of fresh input. A summary that surfaces the cache-read share makes the whole reason to
// delegate to dsh visible instead of implicit.

import { costOfUsage, checkCostCeiling, type PriceTable, type ProviderPrice } from '../longrun/cost-budget'
import type { ExecutorUsage } from './executor-types'

/**
 * Approximate published DeepSeek rates (USD per 1M tokens), late 2026. DATA, not a gate:
 * unknown models fall back to the cost table's blended default, and the ceiling is off unless
 * the operator sets one, so a stale figure changes a displayed number, never whether a run
 * proceeds. Cache-read is ~a tenth of fresh input — the executor's whole economic case.
 */
export const DEEPSEEK_PRICES: PriceTable = {
  'deepseek-v4-flash': { inputPerMTok: 0.28, outputPerMTok: 0.42, cachedInputPerMTok: 0.028 },
  'deepseek-v4-pro': { inputPerMTok: 0.55, outputPerMTok: 2.19, cachedInputPerMTok: 0.055 }
}

/** USD ceiling for one delegated run. `DUIN_EXECUTOR_BUDGET_USD`; 0 / unset / garbage = meter only. */
export function readExecutorBudgetUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DUIN_EXECUTOR_BUDGET_USD)
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

export interface ExecutorCost {
  spentUsd: number
  /** The share of spend that was cached input, 0..1 — the number that makes dsh's case. */
  cacheReadShare: number
}

/**
 * PURE. USD for a run's summed usage under `model`. cacheWrite bills at full input price (it IS a
 * full-price prompt write); cacheRead at the cached rate. Returns the spend and the fraction of
 * the priced INPUT that came from cache, so the summary can say "83% cached".
 */
export function executorCostOf(model: string, usage: ExecutorUsage, table: PriceTable = DEEPSEEK_PRICES): ExecutorCost {
  const spentUsd = costOfUsage(
    {
      model,
      inputTokens: Math.max(0, usage.inputTokens + usage.cacheWriteTokens),
      outputTokens: Math.max(0, usage.outputTokens),
      cachedInputTokens: Math.max(0, usage.cacheReadTokens)
    },
    table
  )
  const pricedInput = usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens
  const cacheReadShare = pricedInput > 0 ? usage.cacheReadTokens / pricedInput : 0
  return { spentUsd, cacheReadShare }
}

/** PURE. Should the run stop before the next model call? Off when budget <= 0. */
export function shouldStopForBudget(spentUsd: number, budgetUsd: number): { stop: boolean; reason?: string } {
  const d = checkCostCeiling(spentUsd, budgetUsd > 0 ? budgetUsd : null)
  return d.stop ? { stop: true, reason: `cost-budget ($${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)})` } : { stop: false }
}

/** The operator-facing spend line for a run summary. */
export function costLine(model: string, usage: ExecutorUsage, table: PriceTable = DEEPSEEK_PRICES): string {
  const { spentUsd, cacheReadShare } = executorCostOf(model, usage, table)
  const known: ProviderPrice | undefined = table[model]
  const pct = Math.round(cacheReadShare * 100)
  return known
    ? `~$${spentUsd.toFixed(4)} (${pct}% of input served from cache)`
    : `~$${spentUsd.toFixed(4)} (est.; ${model} not in the price table)`
}
