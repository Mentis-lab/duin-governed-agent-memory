// retrieval-search.ts — the outer loop: search the bounded retrieval config space using probe runs
// as the objective, and hand the winner to the EXISTING keep-if-better gate rather than a new one.
//
// This is the half EvolveMem (arXiv 2605.13941) contributes and DUIN lacked. What it deliberately
// does NOT copy:
//
//   * Their revert rule is `f_{r-1} - f_r > 0.01` — a flat 1-percentage-point threshold on a metric
//     measured over 200 questions, where the binomial standard error is ~3.5pp. That reverts noise
//     and keeps noise indiscriminately. Here the accept threshold is DERIVED from the probe count
//     (see `noiseFloor`), so a small probe set automatically demands a larger effect.
//   * Their exploration is a random perturbation. Randomness would make a sweep unreproducible and
//     unresumable; candidate order here is deterministic, and an archive of already-measured
//     fingerprints means a config is never paid for twice.
//   * They optimize on the same question set they report, for all seven rounds. This module returns
//     the winning config and its measurements; it does NOT decide to enact. Enaction stays behind
//     brain/self-improve-fitness.ts's gate, which owns held-out windowing and rollback. Keeping the
//     search and the gate separate is the whole reason a sweep here cannot overfit its way into the
//     live app.
//
// Coordinate descent, not a grid: the space is 8-dimensional and a full grid is astronomically
// larger than any affordable probe budget. Coordinate descent finds the axis-aligned improvements
// that dominate real retrieval tuning (top-k breadth, fusion balance) for a cost linear in
// dimensions, and stops as soon as a full pass buys nothing.
import {
  RETRIEVAL_TUNABLE_BOUNDS,
  clampRetrievalTunables,
  retrievalConfigFingerprint,
  type RetrievalTunables
} from './retrieval-tunables'
import { runRetrievalProbes, type ProbeRun, type RetrievalProbe, type SearchFn } from './retrieval-probe'
import type { EngineFitness } from '../brain/self-improve-fitness'

/** Per-dimension step for neighbour generation. Sized to be a MEANINGFUL move, not a rounding nudge. */
export const SWEEP_STEPS: Record<keyof RetrievalTunables, number> = {
  searchK: 2,
  poolMultiplier: 1,
  poolFloor: 10,
  fuseWLex: 0.25,
  fuseWVec: 0.25,
  fuseK: 20,
  recencyMaxBoost: 0.05,
  recencyHalfLifeDays: 10
}

/** Dimension order for coordinate descent — most-implicated first, so a small budget spends it on
 *  the knobs measurement has already pointed at rather than on recency half-life. */
export const SWEEP_ORDER: (keyof RetrievalTunables)[] = [
  'searchK',
  'fuseWLex',
  'fuseWVec',
  'poolMultiplier',
  'fuseK',
  'poolFloor',
  'recencyMaxBoost',
  'recencyHalfLifeDays'
]

/**
 * One standard error of a proportion measured over `n` probes. This is the floor an improvement must
 * clear to be believable. Uses p=0.5 (the maximum-variance case) unless a measured rate is supplied,
 * so the threshold is conservative when we know nothing.
 *
 * The point: an accept threshold must be a function of how much evidence there is. A fixed constant
 * is either too strict on a large probe set (missing real gains) or too loose on a small one
 * (chasing noise) — and the latter is exactly how a self-tuning loop convinces itself it is working.
 */
export function noiseFloor(n: number, p = 0.5, sigmas = 1): number {
  if (!(n > 0)) return Infinity
  return sigmas * Math.sqrt((p * (1 - p)) / n)
}

/** Deterministic axis-aligned neighbours of `config` along `dim`: one step down, one step up, both
 *  clamped into the bound. Values equal to the incumbent are dropped. PURE. */
export function neighborsAlong(
  config: RetrievalTunables,
  dim: keyof RetrievalTunables
): RetrievalTunables[] {
  return [stepAlong(config, dim, -1), stepAlong(config, dim, 1)].filter(
    (c): c is RetrievalTunables => c !== null
  )
}

/**
 * One step along `dim` in `dir` (-1 down, +1 up), or null when that would leave the bound or not
 * move at all. The unit of the line search below. PURE.
 */
export function stepAlong(
  config: RetrievalTunables,
  dim: keyof RetrievalTunables,
  dir: -1 | 1
): RetrievalTunables | null {
  const bound = RETRIEVAL_TUNABLE_BOUNDS[dim]
  const cur = config[dim]
  const raw = cur + dir * SWEEP_STEPS[dim]
  if (raw < bound.min || raw > bound.max) return null
  const cand = clampRetrievalTunables({ ...config, [dim]: raw })
  return cand[dim] === cur ? null : cand
}

export interface SweepStep {
  round: number
  dim: keyof RetrievalTunables | 'baseline'
  fingerprint: string
  config: RetrievalTunables
  recallAtK: number
  mrr: number
  hitRate: number
  /** recall delta vs the incumbent at the time this candidate was measured */
  delta: number
  decision: 'baseline' | 'accept' | 'reject'
  reason: string
}

export interface SweepResult {
  baseline: ProbeRun
  best: ProbeRun
  bestConfig: RetrievalTunables
  /** did the sweep beat the baseline by more than the noise floor */
  improved: boolean
  /** total recall gain over baseline (0 when not improved) */
  gain: number
  /** the threshold every accept had to clear — reported so a reader can judge the result */
  threshold: number
  /** probe runs actually paid for (baseline included) */
  evaluated: number
  /** true when the sweep stopped because a full pass found nothing, not because it ran out of budget */
  converged: boolean
  steps: SweepStep[]
}

export interface SweepOpts {
  /** hard ceiling on probe runs, baseline included. The cost control. */
  maxEvals?: number
  /** full coordinate-descent passes before stopping. */
  maxPasses?: number
  /** how many standard errors an improvement must clear. Higher = more conservative. */
  sigmas?: number
  /** absolute floor on the accept threshold, applied on top of the derived one. */
  minDelta?: number
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000

/**
 * Search the config space. Starts from `start` (normally the vault's current config, so a sweep
 * asks "can we do better than what we run today", not "better than the shipped default").
 *
 * Returns the best config found and every step taken. NEVER returns a config worse than the
 * baseline: if nothing clears the threshold, `bestConfig` is the baseline and `improved` is false.
 */
export async function sweepRetrievalConfig(
  probes: RetrievalProbe[],
  searchFn: SearchFn,
  start: RetrievalTunables,
  opts: SweepOpts = {}
): Promise<SweepResult> {
  const maxEvals = Math.max(1, opts.maxEvals ?? 24)
  const maxPasses = Math.max(1, opts.maxPasses ?? 3)
  const sigmas = opts.sigmas ?? 1
  const steps: SweepStep[] = []

  const baseConfig = clampRetrievalTunables(start)
  const baseline = await runRetrievalProbes(probes, searchFn, baseConfig)
  let evaluated = 1

  // Derived from the OBSERVED baseline rate, so a system already at 0.9 recall is not asked to clear
  // the same bar as one at 0.5.
  const threshold = Math.max(
    opts.minDelta ?? 0,
    noiseFloor(baseline.n, baseline.recallAtK || 0.5, sigmas)
  )

  steps.push({
    round: 0,
    dim: 'baseline',
    fingerprint: baseline.configFingerprint,
    config: baseConfig,
    recallAtK: baseline.recallAtK,
    mrr: baseline.mrr,
    hitRate: baseline.hitRate,
    delta: 0,
    decision: 'baseline',
    reason: `baseline recall@${baseline.k}=${baseline.recallAtK} over n=${baseline.n}; accept threshold ${round4(threshold)}`
  })

  // Archive of every fingerprint already paid for — a config is never measured twice, including
  // across passes and including the baseline.
  const seen = new Set<string>([baseline.configFingerprint])
  let incumbent = baseline
  let incumbentConfig = baseConfig
  let converged = false

  // Budget exhaustion must NEVER be reported as convergence. Once the budget is spent no pass can
  // accept anything, so "a full pass accepted nothing" becomes true for the wrong reason — and a
  // sweep that merely ran out of money would claim it had found the optimum.
  let budgetExhausted = false

  for (let pass = 1; pass <= maxPasses; pass++) {
    let acceptedThisPass = 0
    for (const dim of SWEEP_ORDER) {
      if (evaluated >= maxEvals) {
        budgetExhausted = true
        break
      }
      // LINE SEARCH. Try each direction; the moment one improves, keep walking THAT direction until
      // it stops paying. Without this a monotone dimension (recall rising with breadth is the common
      // case) advances one step per full pass, so every other dimension is re-measured between
      // steps — measured at 40 probe runs to move one knob three steps, versus ~19 with the walk.
      for (const dir of [-1, 1] as const) {
        let movedOnThisDim = false
        for (;;) {
          if (evaluated >= maxEvals) {
            budgetExhausted = true
            break
          }
          const cand = stepAlong(incumbentConfig, dim, dir)
          if (!cand) break // hit the bound
          const fp = retrievalConfigFingerprint(cand)
          if (seen.has(fp)) break // already paid for this cell — nothing more to learn this way
          seen.add(fp)

          const run = await runRetrievalProbes(probes, searchFn, cand)
          evaluated++
          const delta = round4(run.recallAtK - incumbent.recallAtK)
          const accept = delta > threshold
          steps.push({
            round: pass,
            dim,
            fingerprint: fp,
            config: cand,
            recallAtK: run.recallAtK,
            mrr: run.mrr,
            hitRate: run.hitRate,
            delta,
            decision: accept ? 'accept' : 'reject',
            reason: accept
              ? `+${delta} recall clears threshold ${round4(threshold)}`
              : `${delta >= 0 ? '+' : ''}${delta} recall does not clear threshold ${round4(threshold)}`
          })
          if (!accept) break
          incumbent = run
          incumbentConfig = cand
          acceptedThisPass++
          movedOnThisDim = true
        }
        if (movedOnThisDim || budgetExhausted) break
      }
    }
    if (acceptedThisPass === 0) {
      // A full pass over every dimension bought nothing. That is convergence ONLY if the pass was
      // actually able to look — otherwise it is exhaustion wearing convergence's clothes.
      converged = !budgetExhausted
      break
    }
  }

  const gain = round4(incumbent.recallAtK - baseline.recallAtK)
  return {
    baseline,
    best: incumbent,
    bestConfig: incumbentConfig,
    improved: gain > threshold,
    gain: gain > threshold ? gain : 0,
    threshold: round4(threshold),
    evaluated,
    converged,
    steps
  }
}

/**
 * Deterministic train/test split of a probe set by STRIDE, not by prefix.
 *
 * Prefix-cutting would be wrong here and quietly so: real probe sets arrive grouped (the LoCoMo
 * artifact is ordered by conversation, LongMemEval by question type), so a prefix cut trains on
 * some conversations and tests on entirely different ones — measuring transfer across topics rather
 * than generalization of the config. A stride split keeps both halves distributionally identical.
 *
 * `every` = 3 puts every 3rd probe in test (~33%). PURE, no RNG, so a split is reproducible and a
 * sweep can be resumed or audited.
 */
export function splitProbes(
  probes: RetrievalProbe[],
  every = 3
): { train: RetrievalProbe[]; test: RetrievalProbe[] } {
  const n = Math.max(2, Math.floor(every))
  const train: RetrievalProbe[] = []
  const test: RetrievalProbe[] = []
  probes.forEach((p, i) => ((i + 1) % n === 0 ? test : train).push(p))
  return { train, test }
}

export interface HeldoutVerdict {
  /** best-config score on probes the sweep never optimized against */
  heldoutRecall: number
  /** baseline score on the same unseen probes */
  heldoutBaseline: number
  /** gain that survived onto unseen probes */
  heldoutGain: number
  /** noise floor of the (smaller) test split */
  heldoutThreshold: number
  /** did the training gain survive — the only number worth quoting */
  confirmed: boolean
  /** trainGain - heldoutGain: how much of the improvement was fitting the probe set */
  overfitGap: number
}

/**
 * Sweep on a TRAIN split and report the winner on a TEST split it never saw.
 *
 * This is the check EvolveMem does not do: it scores every one of its seven rounds on the same QA
 * set it reports, and offers cross-benchmark transfer as the defense — but the transferred config
 * was CONTINUED-evolved on the target, which is a warm start, not held-out evidence. A config
 * search over eight dimensions on a few dozen probes can absolutely fit the probe set, and without
 * this split there is no way to tell a real retrieval gain from a memorized one.
 *
 * `confirmed: false` with a large `overfitGap` is the signal to distrust the sweep, not to re-run it.
 */
export async function sweepWithHoldout(
  probes: RetrievalProbe[],
  searchFn: SearchFn,
  start: RetrievalTunables,
  opts: SweepOpts & { every?: number } = {}
): Promise<SweepResult & { heldout: HeldoutVerdict }> {
  const { train, test } = splitProbes(probes, opts.every ?? 3)
  const swept = await sweepRetrievalConfig(train, searchFn, start, opts)

  const baseRun = await runRetrievalProbes(test, searchFn, clampRetrievalTunables(start))
  const bestRun = await runRetrievalProbes(test, searchFn, swept.bestConfig)
  const heldoutGain = round4(bestRun.recallAtK - baseRun.recallAtK)
  const heldoutThreshold = round4(
    Math.max(opts.minDelta ?? 0, noiseFloor(baseRun.n, baseRun.recallAtK || 0.5, opts.sigmas ?? 1))
  )
  return {
    ...swept,
    heldout: {
      heldoutRecall: bestRun.recallAtK,
      heldoutBaseline: baseRun.recallAtK,
      heldoutGain,
      heldoutThreshold,
      confirmed: heldoutGain > heldoutThreshold,
      overfitGap: round4(swept.gain - heldoutGain)
    }
  }
}

/**
 * THE INTEGRATION SEAM. Project a probe run into the EngineFitness shape that
 * brain/self-improve-fitness.ts's `gateVector` already consumes, so retrieval joins the existing
 * multi-objective no-regression gate as one more engine — no second gate, no second policy.
 *
 * Why this matters more than it looks: the RSI loop is frozen because its engines are starved.
 * `recall-efficacy:*` accrues one observation per real user turn, and the maturity gate needs n>=20
 * in BOTH the pre- and post-windows, so on the live vault it has 17 observations all-time and every
 * adjudication returns 'maturing' forever. A probe run manufactures n = probes.length observations
 * on demand, from labelled ground truth, in seconds. A 40-probe set clears the maturity gate the
 * first time it is run. That converts a loop that cannot currently reach a verdict into one that can.
 *
 * `gated` uses the same n>=20 floor as calibration so the gate treats this engine no differently.
 */
export const PROBE_FITNESS_MIN_N = 20

export function probeRunToFitness(run: ProbeRun, engine = 'retrieval-probe:recall'): EngineFitness {
  return {
    engine,
    score: run.n > 0 ? run.recallAtK : null,
    n: run.n,
    gated: run.n < PROBE_FITNESS_MIN_N
  }
}
