// Long-run L1-L8 — env-tunable caps for the durability/budget/context/resilience
// layers, mirroring loop-config.ts. Every knob is `Number(process.env.X)` with a
// sane default; a value of 0 disables that guard at its consumption site (the
// pure modules already treat 0/<=0 as "off"). `resolveLongRunConfig(env)` is pure
// and unit-testable; `readLongRunConfig()` reads the live process env.

export interface LongRunConfig {
  /** L5 hard USD budget default (loop.costBudgetUsd overrides). 0 disables. */
  costBudgetUsd: number
  /** L4 consecutive no-progress iterations before pause+escalate. 0 disables. */
  stallK: number
  /** L6 retry attempts for a transient turn failure. */
  retries: number
  /** L6 base backoff ms (exponential base*2^attempt). */
  backoffMs: number
  /** L6 circuit-breaker consecutive-failure trip threshold. 0 disables tripping. */
  breakerThreshold: number
  /** L6 breaker cooldown (open→half-open) ms. */
  breakerCooldownMs: number
  /** L7 minimum free disk on the artifact volume (bytes). 0 disables. */
  diskMinBytes: number
  /** L7 RSS ceiling for the alert (bytes). 0 disables. */
  rssMaxBytes: number
  /** L7 RSS ceiling that opts into a restart-to-recover (bytes). 0 disables. */
  rssRecycleBytes: number
  /** L3 hard char budget for the per-iteration bounded context. */
  contextMaxChars: number
  /** L8 digest cadence in iterations. 0 disables the by-iteration trigger. */
  digestEveryIters: number
  /** L8 digest cadence in ms. 0 disables the by-time trigger. */
  digestEveryMs: number
  /** L5 burn-rate alert threshold (USD/hour). 0 disables. */
  burnAlertPerHour: number
}

export const LONGRUN_CONFIG_DEFAULTS: LongRunConfig = {
  costBudgetUsd: 0,
  stallK: 3,
  retries: 3,
  backoffMs: 500,
  breakerThreshold: 5,
  breakerCooldownMs: 60_000,
  // L7 resource guards ON by default (env still overrides / 0 disables): pause a
  // loop before it runs the artifact volume out of disk, alert on runaway RSS.
  diskMinBytes: 500_000_000, // 500MB free-disk floor
  rssMaxBytes: 4_000_000_000, // 4GB RSS alert ceiling
  rssRecycleBytes: 0,
  contextMaxChars: 12_000,
  digestEveryIters: 10,
  digestEveryMs: 7_200_000,
  burnAlertPerHour: 0
}

/**
 * Parse an env string into a non-negative finite number, or fall back. Unlike a
 * bare `Number(x) || default`, an explicit `0` is honored (so "0 disables"
 * actually works) — only a missing/blank/invalid value uses the default.
 */
function numOr(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** PURE. Resolve the long-run config from a raw env map. */
export function resolveLongRunConfig(env: NodeJS.ProcessEnv): LongRunConfig {
  return {
    costBudgetUsd: numOr(env.DUIN_LOOP_COST_BUDGET_USD, LONGRUN_CONFIG_DEFAULTS.costBudgetUsd),
    stallK: numOr(env.DUIN_LOOP_STALL_K, LONGRUN_CONFIG_DEFAULTS.stallK),
    retries: numOr(env.DUIN_LOOP_RETRIES, LONGRUN_CONFIG_DEFAULTS.retries),
    backoffMs: numOr(env.DUIN_LOOP_BACKOFF_MS, LONGRUN_CONFIG_DEFAULTS.backoffMs),
    breakerThreshold: numOr(
      env.DUIN_LOOP_BREAKER_THRESHOLD,
      LONGRUN_CONFIG_DEFAULTS.breakerThreshold
    ),
    breakerCooldownMs: numOr(
      env.DUIN_LOOP_BREAKER_COOLDOWN_MS,
      LONGRUN_CONFIG_DEFAULTS.breakerCooldownMs
    ),
    diskMinBytes: numOr(env.DUIN_LOOP_DISK_MIN, LONGRUN_CONFIG_DEFAULTS.diskMinBytes),
    rssMaxBytes: numOr(env.DUIN_LOOP_RSS_MAX, LONGRUN_CONFIG_DEFAULTS.rssMaxBytes),
    rssRecycleBytes: numOr(env.DUIN_LOOP_RSS_RECYCLE, LONGRUN_CONFIG_DEFAULTS.rssRecycleBytes),
    contextMaxChars: numOr(env.DUIN_LOOP_CONTEXT_MAX_CHARS, LONGRUN_CONFIG_DEFAULTS.contextMaxChars),
    digestEveryIters: numOr(
      env.DUIN_LOOP_DIGEST_EVERY_ITERS,
      LONGRUN_CONFIG_DEFAULTS.digestEveryIters
    ),
    digestEveryMs: numOr(env.DUIN_LOOP_DIGEST_EVERY_MS, LONGRUN_CONFIG_DEFAULTS.digestEveryMs),
    burnAlertPerHour: numOr(env.DUIN_LOOP_BURN_ALERT, LONGRUN_CONFIG_DEFAULTS.burnAlertPerHour)
  }
}

export function readLongRunConfig(): LongRunConfig {
  return resolveLongRunConfig(process.env)
}

/** Resolve the hard USD ceiling a NEWLY created loop should carry.
 *
 *  `costBudgetUsd` was the one long-run knob with no fallback path: loops:create
 *  stored an explicit input or `null`, nothing in the renderer has ever sent one,
 *  and unlike maxIterations/maxWallclockMs/tokenBudget it never fell back to config.
 *  So `DUIN_LOOP_COST_BUDGET_USD` — documented here as the hard dollar ceiling —
 *  could not fire on any loop the shipped app is able to create, and no loop had a
 *  real cost backstop.
 *
 *  An explicit per-loop value still wins, including an explicit 0 to opt out.
 *  0 normalises to null because checkCostCeiling treats them identically
 *  (`budget != null && budget > 0`) and null is the column's honest "no ceiling".
 *  PURE. */
export function resolveLoopCostBudget(explicit: unknown, cfg: LongRunConfig): number | null {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) {
    return explicit > 0 ? explicit : null
  }
  return cfg.costBudgetUsd > 0 ? cfg.costBudgetUsd : null
}
