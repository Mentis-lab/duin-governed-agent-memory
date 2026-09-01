// Backlog finding 19. costBudgetUsd was the one long-run knob with no fallback path:
// loops:create stored an explicit input or null, nothing in the renderer has ever sent
// one (grep src/ — zero hits), and unlike maxIterations / maxWallclockMs / tokenBudget
// it never consulted the config. So DUIN_LOOP_COST_BUDGET_USD, documented as the hard
// dollar ceiling, could not fire on any loop the shipped app can create.

import { describe, it, expect } from 'vitest'

import {
  resolveLoopCostBudget,
  resolveLongRunConfig,
  LONGRUN_CONFIG_DEFAULTS,
  type LongRunConfig
} from './longrun-config'

const cfg = (over: Partial<LongRunConfig> = {}): LongRunConfig => ({
  ...LONGRUN_CONFIG_DEFAULTS,
  ...over
})

describe('resolveLoopCostBudget — the env ceiling actually reaches a new loop', () => {
  it('falls back to DUIN_LOOP_COST_BUDGET_USD when the caller sends nothing', () => {
    const fromEnv = resolveLongRunConfig({ DUIN_LOOP_COST_BUDGET_USD: '12.5' } as NodeJS.ProcessEnv)
    expect(fromEnv.costBudgetUsd).toBe(12.5)
    // This is the assertion the defect broke: undefined input used to become null.
    expect(resolveLoopCostBudget(undefined, fromEnv)).toBe(12.5)
  })

  it('an explicit per-loop budget still wins over the config', () => {
    expect(resolveLoopCostBudget(3, cfg({ costBudgetUsd: 12.5 }))).toBe(3)
  })

  it('an explicit 0 opts this loop out even when the config sets a ceiling', () => {
    expect(resolveLoopCostBudget(0, cfg({ costBudgetUsd: 12.5 }))).toBeNull()
  })

  it('no input and no configured ceiling stays null — unchanged default behaviour', () => {
    expect(resolveLoopCostBudget(undefined, cfg({ costBudgetUsd: 0 }))).toBeNull()
  })

  it('junk input does not become a ceiling', () => {
    for (const junk of [NaN, Infinity, -5, '10', null, {}]) {
      expect(resolveLoopCostBudget(junk, cfg({ costBudgetUsd: 0 }))).toBeNull()
    }
    // ...but junk still falls back to a configured ceiling rather than disabling it.
    expect(resolveLoopCostBudget('10', cfg({ costBudgetUsd: 7 }))).toBe(7)
  })
})
