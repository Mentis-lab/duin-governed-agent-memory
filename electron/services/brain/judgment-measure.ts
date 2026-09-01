import { messageOf } from '../guarded'
// judgment-measure — the A/B behavioral verifier (legacy harness judgment_measure). Answers
// the question a naive memory system never asks of itself: does a learned fact actually
// CHANGE behavior, or is it dead weight accumulating in the store? For each promoted fact
// we run a held-out A/B probe — the model answers a relevant query WITH the fact injected
// and WITHOUT it — and grade whether each answer honors the fact:
//
//   flip        with-pass & without-FAIL  → the fact made the difference (earning its place)
//   both-pass   with-pass & without-pass  → redundant (the model already does this)
//   both-fail   with-FAIL & without-fail  → ineffective (the fact didn't help)
//   regression  with-FAIL & without-pass  → the fact HURT (behavior worse with it)
//
// A fact that never flips isn't earning its slot; any regression is a prune/veto signal.
// This is how the memory moat stays real instead of bloating — and it feeds the govern
// loop (a prune-candidate is exactly a fact the operator should veto). Pruning stays a
// CANDIDATE (never auto-deleted) — the harness keeps pruning human-gated, so do we.
//
// The scoring is PURE + unit-tested; the probe/answer/grade are injected so the loop is
// testable without a model (the real deps are a thin key-gated LLM adapter).

export type FlipOutcome = 'flip' | 'both-pass' | 'both-fail' | 'regression'

/** Classify one A/B trial from the two graded outcomes. PURE. */
export function scoreFlip(withPass: boolean, withoutPass: boolean): FlipOutcome {
  if (withPass && !withoutPass) return 'flip'
  if (withPass && withoutPass) return 'both-pass'
  if (!withPass && !withoutPass) return 'both-fail'
  return 'regression'
}

export type MeasureOutcome = 'keep' | 'prune-candidate' | 'inconclusive'

export interface MeasureVerdict {
  verdict: MeasureOutcome
  flips: number
  regressions: number
  trials: number
  flipRate: number
}

export interface MeasurePolicy {
  /** Below this many trials the result is inconclusive (never prune on thin evidence). */
  minTrials: number
  /** Flip-rate at or above which the fact earns KEEP. */
  keepFlipRate: number
}
export const DEFAULT_MEASURE_POLICY: MeasurePolicy = { minTrials: 3, keepFlipRate: 0.5 }

/** Aggregate A/B trial outcomes into a KEEP / PRUNE-candidate / INCONCLUSIVE verdict.
 *  Asymmetric + safe: any regression → prune-candidate; demonstrably inert →
 *  prune-candidate; thin or undiscriminating evidence → inconclusive (never prune). PURE. */
export function measureVerdict(
  outcomes: FlipOutcome[],
  policy: MeasurePolicy = DEFAULT_MEASURE_POLICY
): MeasureVerdict {
  const trials = outcomes.length
  const flips = outcomes.filter((o) => o === 'flip').length
  const regressions = outcomes.filter((o) => o === 'regression').length
  // `both-pass` means the WITHOUT arm already satisfied the rule, so that trial could not
  // tell the two arms apart. It is a FAILED PROBE, not a measured absence of effect, and it
  // does not belong in the denominator. Collapsing it into "proven inert" retired facts that
  // were demonstrably working — a rule that reshaped an answer 7x over still scored zero
  // flips because the coarse yes/no grader said yes to both arms.
  const informative = trials - outcomes.filter((o) => o === 'both-pass').length
  // Reported rate stays over informative trials, so it means "of the times we could tell,
  // how often did the rule decide the answer".
  const flipRate = informative ? flips / informative : 0
  let verdict: MeasureOutcome
  // minTrials now bites on trials that actually discriminated, so a fact cannot be pruned
  // on three probes that each proved nothing.
  if (informative < policy.minTrials) verdict = 'inconclusive'
  else if (regressions > 0) verdict = 'prune-candidate' // it made things worse somewhere
  else if (flipRate >= policy.keepFlipRate) verdict = 'keep'
  else if (flips === 0) verdict = 'prune-candidate' // every informative trial said inert
  else verdict = 'inconclusive' // some signal, below the keep bar → gather more
  return { verdict, flips, regressions, trials, flipRate }
}

export interface MeasureDeps {
  /** Probe queries where the fact SHOULD apply (the held-out cases to A/B). */
  probes(factText: string): Promise<string[]> | string[]
  /** Model answer to a query, with the fact injected (factText) or without it (null). */
  answer(query: string, factText: string | null): Promise<string> | string
  /** Does the answer honor the fact? (the grader). */
  grade(factText: string, answer: string): Promise<boolean> | boolean
}

/** Run the held-out A/B measurement for one fact. Best-effort per trial (a thrown
 *  probe/answer/grade drops that trial rather than failing the whole measurement). */
export async function measureFact(
  factText: string,
  deps: MeasureDeps,
  policy: MeasurePolicy = DEFAULT_MEASURE_POLICY
): Promise<MeasureVerdict> {
  const queries = (await deps.probes(factText)) || []
  const outcomes: FlipOutcome[] = []
  for (const q of queries) {
    try {
      const withA = await deps.answer(q, factText)
      const withoutB = await deps.answer(q, null)
      const withPass = await deps.grade(factText, withA)
      const withoutPass = await deps.grade(factText, withoutB)
      outcomes.push(scoreFlip(withPass, withoutPass))
    } catch (e) { console.debug('[judgment-measure] drop this trial:', messageOf(e)) }
  }
  return measureVerdict(outcomes, policy)
}

export interface FactMeasurement extends MeasureVerdict {
  id: string
  text: string
}

/** Measure a set of promoted facts and return their verdicts (for review). Does NOT
 *  mutate the store — pruning stays human/govern-gated. */
export async function measureFacts(
  facts: { id: string; text: string }[],
  deps: MeasureDeps,
  policy: MeasurePolicy = DEFAULT_MEASURE_POLICY
): Promise<FactMeasurement[]> {
  const out: FactMeasurement[] = []
  for (const f of facts) {
    const v = await measureFact(f.text, deps, policy)
    out.push({ id: f.id, text: f.text, ...v })
  }
  return out
}
