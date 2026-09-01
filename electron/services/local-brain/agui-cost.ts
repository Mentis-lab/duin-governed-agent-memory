// Per-turn cost meter for the /agui chat path.
//
// THE GAP THIS FILLS. The turn loop had no idea what it was spending. The provider layer computed
// normalized usage per request and handed it to telemetry and the prefix-cache tracker, but the
// callback that drives the turn never received it, so nothing could total a turn or refuse the
// next model call. A wedged agentic loop could spend its whole 32-round budget with no meter and
// no ceiling — the same shape as the extraction outage that burned 705 doomed calls before anyone
// noticed.
//
// This does NOT invent a cost model. `costOfUsage` / `accrue` / `checkCostCeiling` already exist
// in longrun/cost-budget.ts (pure, tested) and serve the long-run loop engine; this module adapts
// the provider's NormalizedUsage into that vocabulary and reads the chat-side budget knob.
//
// PURE except readTurnBudgetUsd(), which reads the env.

import type { NormalizedUsage } from '../providers/usage-accounting'
import type { TokenUsage } from '../longrun/run-journal'
import { costOfUsage, accrue, checkCostCeiling, type PriceTable } from '../longrun/cost-budget'

/**
 * Hard USD ceiling for ONE turn. Env `DUIN_TURN_COST_BUDGET_USD`; 0 / unset / garbage disables it.
 *
 * DEFAULT OFF, deliberately. A ceiling that fires mid-answer is a worse experience than a large
 * bill for anyone who has not chosen a number, and the operator has never been asked for one. The
 * meter runs regardless — knowing the spend is useful on its own, and it is what makes a ceiling
 * choosable later.
 */
export function readTurnBudgetUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DUIN_TURN_COST_BUDGET_USD)
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

/** Adapt the provider's normalized usage to the cost table's vocabulary. `cacheWriteTokens` bills
 *  at full input price (it IS a full-price prompt write), `cacheReadTokens` at the cached rate. */
export function toTokenUsage(model: string, u: NormalizedUsage): TokenUsage {
  return {
    model,
    inputTokens: Math.max(0, (u.inputTokens || 0) + (u.cacheWriteTokens || 0)),
    outputTokens: Math.max(0, u.outputTokens || 0),
    cachedInputTokens: Math.max(0, u.cacheReadTokens || 0)
  }
}

export interface TurnCost {
  /** USD accrued so far this turn. */
  spentUsd: number
  /** Provider-reported tokens, summed across every model call in the turn. */
  inputTokens: number
  outputTokens: number
  /** Model calls that reported usage. A provider that returns none leaves this at 0 while the
   *  turn still runs — the meter is best-effort by construction, never a gate on answering. */
  metered: number
}

export function emptyTurnCost(): TurnCost {
  return { spentUsd: 0, inputTokens: 0, outputTokens: 0, metered: 0 }
}

/** PURE. Fold one model call's usage into the running turn total. */
export function accrueTurnCost(
  prev: TurnCost,
  model: string,
  usage: NormalizedUsage | undefined,
  priceTable: PriceTable = {}
): TurnCost {
  if (!usage) return prev
  const tu = toTokenUsage(model, usage)
  return {
    spentUsd: accrue(prev.spentUsd, costOfUsage(tu, priceTable)),
    inputTokens: prev.inputTokens + tu.inputTokens,
    outputTokens: prev.outputTokens + tu.outputTokens,
    metered: prev.metered + 1
  }
}

/**
 * PURE. Should the loop refuse the NEXT model call?
 *
 * `isContinuation` waives the ceiling: a continuation round is the same answer still being
 * written, and cutting there truncates a document the operator is watching stream — the ceiling
 * exists to stop runaway *work*, not to sever a reply mid-sentence. The next fresh round is
 * refused instead.
 */
export function shouldRefuseForBudget(
  cost: TurnCost,
  budgetUsd: number,
  isContinuation: boolean
): { stop: boolean; reason?: string } {
  if (isContinuation) return { stop: false }
  return checkCostCeiling(cost.spentUsd, budgetUsd > 0 ? budgetUsd : null)
}

/** The operator-facing line when a turn is refused on budget. Concrete about the number, because
 *  "budget exceeded" without the figure is not actionable. */
export function budgetRefusalMessage(cost: TurnCost, budgetUsd: number): string {
  return `Stopped: this turn reached its cost ceiling ($${cost.spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)}). Raise DUIN_TURN_COST_BUDGET_USD or split the task into smaller steps.`
}
