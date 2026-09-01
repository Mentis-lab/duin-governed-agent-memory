// transfer-ab — the WHOLE-BRAIN A/B litmus for the transfer pilot (#4b). judgment-measure
// asks "does ONE fact change behavior?"; this asks the pilot's core question at brain scale:
//
//   does operator-2's ACCUMULATED brain make outputs fit operator-2 better than the same
//   model COLD (empty operator profile)?
//
// For a fixed query set we produce two answers per query — (a) GROUNDED with operator-2's
// buildOperatorBlock() + taste + calibration context, and (b) COLD (no operator profile) — then
// a blind preference grader (position-randomized so it can't cheat on slot) picks which answer
// fits operator-2 better. Per-query verdicts aggregate into `fitLift = withMoatWins − coldWins`,
// honest-NULL below a sample floor (never fabricate a lift on thin evidence).
//
// THE RUBRIC IS HELD OUT. Until 2026-08-01 the judge was handed buildOperatorGrounding() — the
// GROUNDED arm's own prompt — as its scoring rubric. That rewards the grounded answer for echoing
// text the cold answer never saw, so the measurement could only come out one way; it ran daily
// from 2026-07-25 and returned 31-1 for the moat, which is what the construction predicts rather
// than what it discovered. The rubric is now built from HUMAN rulings that are disjoint from the
// grounded prompt by construction (buildHumanRubric), and the facts it quotes are EXCLUDED from
// the grounded arm's grounding. That handicaps the moat — it answers with 9 fewer confirmed rules
// — which is the conservative direction: a lift measured under a handicap is real.
//
// If the held-out rubric is too thin to grade with, the judge returns 'inconclusive'. It never
// falls back to the operator profile: "no independent rubric" and "graded circularly" are
// different states and must not share a value (constitution property 8).
//
// MEASUREMENT-ONLY: this never writes MOAT state (no promote/veto/prune, no store mutation) — it
// cannot change what the brain believes. Its callers do append the RESULT to the transfer-A/B
// history (transfer-ab-store), which is how the RSI bench reads a measured moat-fit number back;
// that record is an observation about the brain, never an input to it. The
// scoring is PURE + unit-tested; the answer/judge/grounding are injected deps (mirrors the
// judgment-measure MeasureDeps shape) so the loop is testable without a model. The live adapter
// (makeTransferDeps) is a thin key-gated LLM wrapper that degrades to 'inconclusive' keyless.

import { buildOperatorBlock, getOperatorFacts, type OperatorFact } from './operator-model'
import { buildStyleFingerprint } from './style-fingerprint-service'
import { loadKindRates } from './calibration-weight'
import { chatOnce, routeModel } from '../providers/registry'
import { firewallClear } from '../governance/confidential-firewall'
import { messageOf } from '../guarded'

// ──────────────────── pure scoring core ────────────────────

/** A blind grader's preference between two answers labelled A/B (it does NOT know which slot
 *  holds the grounded answer). 'inconclusive' = the grader couldn't decide (e.g. keyless). */
export type Preference = 'A' | 'B' | 'tie' | 'inconclusive'

/** A moat-relative verdict for one query: did the operator-2-GROUNDED answer win, lose, tie, or
 *  was the comparison inconclusive? */
export type FitVerdict = 'with-moat' | 'cold' | 'tie' | 'inconclusive'

/** Map a blind slot preference back onto the moat: which slot held the grounded answer decides
 *  whether a preference for A/B means the moat won or the cold answer won. PURE. */
export function resolveFit(pref: Preference, groundedSlot: 'A' | 'B'): FitVerdict {
  if (pref === 'inconclusive') return 'inconclusive'
  if (pref === 'tie') return 'tie'
  return pref === groundedSlot ? 'with-moat' : 'cold'
}

export interface TransferPolicy {
  /** Below this many DECIDED comparisons (with-moat + cold + tie), fitLift is honest-null and the
   *  verdict is 'inconclusive' — never claim a lift from a handful of trials. */
  minSamples: number
}
export const DEFAULT_TRANSFER_POLICY: TransferPolicy = { minSamples: 5 }

export interface FitLift {
  withMoatWins: number
  coldWins: number
  ties: number
  inconclusive: number
  /** Comparisons that produced a real preference or tie (the honest denominator for the floor). */
  decided: number
  /** Total queries attempted (including dropped/inconclusive). */
  samples: number
  /** withMoatWins − coldWins. NULL below the sample floor (honest — no lift claimed on thin data). */
  fitLift: number | null
  verdict: 'moat-fits-better' | 'cold-fits-better' | 'no-difference' | 'inconclusive'
}

/** Aggregate per-query verdicts into the pilot's headline `fitLift`. Sample-gated: below the floor
 *  the lift is NULL and the verdict is inconclusive (never fabricate a direction). PURE. */
export function aggregateFitLift(
  verdicts: FitVerdict[],
  policy: TransferPolicy = DEFAULT_TRANSFER_POLICY
): FitLift {
  const withMoatWins = verdicts.filter((v) => v === 'with-moat').length
  const coldWins = verdicts.filter((v) => v === 'cold').length
  const ties = verdicts.filter((v) => v === 'tie').length
  const inconclusive = verdicts.filter((v) => v === 'inconclusive').length
  const decided = withMoatWins + coldWins + ties
  const samples = verdicts.length
  const belowFloor = decided < policy.minSamples
  const fitLift = belowFloor ? null : withMoatWins - coldWins
  let verdict: FitLift['verdict']
  if (belowFloor || fitLift === null) verdict = 'inconclusive'
  else if (fitLift > 0) verdict = 'moat-fits-better'
  else if (fitLift < 0) verdict = 'cold-fits-better'
  else verdict = 'no-difference'
  return { withMoatWins, coldWins, ties, inconclusive, decided, samples, fitLift, verdict }
}

// ──────────────────── the held-out rubric (pure) ────────────────────

/** The judge's scoring rubric: operator rulings that the GROUNDED arm does not get to see.
 *  `endorsedFacts` are quoted to the judge AND withheld from grounding (that is what makes them
 *  held out); `rejectedFacts` are already absent from grounding by construction. */
export interface HumanRubric {
  endorsedFacts: string[]
  rejectedFacts: string[]
  /** Renderable rubric text, or '' when the evidence is too thin to grade with. */
  text: string
  /** endorsedFacts.length + rejectedFacts.length. */
  size: number
}

/** Below this many human rulings the rubric cannot discriminate, and the judge must abstain rather
 *  than grade on noise. Deliberately small: this is a floor against ZERO evidence, not a power
 *  calculation — the sample floor in TransferPolicy is what guards the aggregate. */
export const MIN_RUBRIC_FACTS = 6

/** Select the judge's rubric from operator facts. PURE — takes the fact list, reads no store.
 *
 *  Only two statuses are unambiguous HUMAN rulings:
 *    - `vetoed`  + adjudicatedBy 'human'  → vetoFact stamps 'human'; a person said "never true".
 *    - `promoted`+ adjudicatedBy 'human'  → confirmFact stamped 'human' and the govern loop promoted it.
 *
 *  `reverted` + 'human' is deliberately EXCLUDED even though it is the largest bucket (14 rows on
 *  2026-08-01). revertFact does NOT stamp adjudicatedBy, so that combination means "a human endorsed
 *  it and something later reverted it" — the human and the machine disagree. A contested row is not
 *  a ruling, and reading it as one would put 14 rows the operator once AFFIRMED into a rejected list. */
export function selectHumanRubric(facts: OperatorFact[]): HumanRubric {
  const human = facts.filter((f) => f.adjudicatedBy === 'human')
  const endorsedFacts = human.filter((f) => f.status === 'promoted').map((f) => f.fact)
  const rejectedFacts = human.filter((f) => f.status === 'vetoed').map((f) => f.fact)
  const size = endorsedFacts.length + rejectedFacts.length
  if (size < MIN_RUBRIC_FACTS) return { endorsedFacts, rejectedFacts, text: '', size }
  const parts: string[] = ['<operator_rulings>']
  if (endorsedFacts.length) {
    parts.push('The operator personally CONFIRMED these are true of them:')
    parts.push(...endorsedFacts.map((f) => `- ${f}`))
  }
  if (rejectedFacts.length) {
    parts.push('The operator personally REJECTED these as not true of them:')
    parts.push(...rejectedFacts.map((f) => `- ${f}`))
  }
  parts.push('</operator_rulings>')
  return { endorsedFacts, rejectedFacts, text: parts.join('\n'), size }
}

/** Live rubric for the current operator store. Thin wrapper over the pure selector. */
export function buildHumanRubric(): HumanRubric {
  try {
    return selectHumanRubric(getOperatorFacts())
  } catch (e) {
    console.debug('[transfer-ab] no operator facts for rubric:', messageOf(e))
    return { endorsedFacts: [], rejectedFacts: [], text: '', size: 0 }
  }
}

/** Drop the rubric's endorsed facts from a grounding block. buildOperatorBlock renders every fact
 *  as its own `- <fact>` line, so an exact line match removes it without disturbing the section
 *  headers or any other source. PURE. */
export function withoutFacts(grounding: string, facts: string[]): string {
  if (!facts.length || !grounding) return grounding
  const drop = new Set(facts.map((f) => `- ${f}`.trim()))
  return grounding
    .split('\n')
    .filter((line) => !drop.has(line.trim()))
    .join('\n')
}

// ──────────────────── injected-deps orchestrator ────────────────────

export interface TransferDeps {
  /** Operator-2's full grounding block (buildOperatorBlock + taste + calibration). Empty string
   *  ⇒ no accumulated brain (the grounded answer collapses to cold — an honest no-lift result).
   *  MAY THROW to ABSTAIN: the live adapter does when the corpus carries confidential-lane content.
   *  runTransferAB deliberately does not catch it, so the pass aborts and the caller records
   *  nothing — returning '' instead would be read as "no brain" and fabricate a ~0 lift. */
  grounding(): Promise<string> | string
  /** Model answer to a query, with the grounding injected (string) or COLD (null). */
  answer(query: string, grounding: string | null): Promise<string> | string
  /** Blind preference between two answers (a in slot A, b in slot B). MUST NOT be told which is
   *  grounded — the caller randomizes the slot. */
  judge(query: string, a: string, b: string): Promise<Preference> | Preference
  /** Deterministic slot coin for testability: true ⇒ grounded answer goes in slot A. Defaults to
   *  Math.random (position-randomized to defeat the grader's positional bias). */
  coin?(query: string, index: number): boolean
}

export interface TransferQueryVerdict {
  query: string
  groundedSlot: 'A' | 'B'
  preference: Preference
  verdict: FitVerdict
}

export interface TransferABResult extends FitLift {
  verdicts: TransferQueryVerdict[]
}

/** Run the whole-brain A/B litmus over a fixed query set. MEASUREMENT-ONLY — mutates no store.
 *  Best-effort per query (a throwing answer/judge drops that query rather than failing the run,
 *  mirroring measureFact). Returns per-query verdicts + the aggregate fitLift. */
export async function runTransferAB(
  queries: string[],
  deps: TransferDeps,
  policy: TransferPolicy = DEFAULT_TRANSFER_POLICY
): Promise<TransferABResult> {
  // OUTSIDE the per-query try, deliberately. A throwing grounding() is an ABSTAIN (the live
  // adapter's confidential-lane gate) and must abort the whole pass. Swallowed per-query it would
  // drop every query instead, and the caller would still record a 0-sample run — an abstain that
  // looks like a measurement is the failure this arrangement exists to prevent.
  const grounding = (await deps.grounding()) || ''
  const groundArg = grounding.length ? grounding : null
  const verdicts: TransferQueryVerdict[] = []
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i]
    try {
      const grounded = await deps.answer(q, groundArg)
      const cold = await deps.answer(q, null)
      const groundedInA = deps.coin ? deps.coin(q, i) : Math.random() < 0.5
      const groundedSlot: 'A' | 'B' = groundedInA ? 'A' : 'B'
      const a = groundedInA ? grounded : cold
      const b = groundedInA ? cold : grounded
      const preference = await deps.judge(q, a, b)
      verdicts.push({ query: q, groundedSlot, preference, verdict: resolveFit(preference, groundedSlot) })
    } catch (e) { console.debug('[transfer-ab] drop this query  best-effort:', messageOf(e)) }
  }
  return { ...aggregateFitLift(verdicts.map((v) => v.verdict), policy), verdicts }
}

// ──────────────────── live (key-gated) adapter ────────────────────

/** A representative operator-request set. Sized with HEADROOM over the n≥5 floor, not to it: the
 *  judge returns 'inconclusive' on any reply it can't parse, and each of those drops out of
 *  `decided`.
 *
 *  Widened 8 → 24 on 2026-08-01, alongside the held-out rubric. At eight, a single pass could not
 *  separate a real lift from grader noise: the aggregate reported a direction off ~8 decided
 *  comparisons, which is a floor against zero evidence, not power. These span the request shapes
 *  the operator actually issues — drafting, deciding, prioritising, critiquing, summarising,
 *  pushing back, delegating — so a lift cannot come from one lucky genre.
 *
 *  Known limit (property 5): these are hand-written and vault-independent, so they exercise voice
 *  and priorities but not recall of specific operator context. Sampling real thread openers from
 *  `.duin/_state/turn-beats.jsonl` would fix that and is the obvious next upgrade; it is not done
 *  here because it makes the query set non-deterministic across runs, which would confound a
 *  before/after comparison of this very change. */
export const DEFAULT_TRANSFER_QUERIES: string[] = [
  'Draft a short reply declining a meeting invite for next Tuesday.',
  'Summarize the main risks in the current project in three bullets.',
  'Rewrite this note to send to a partner: "the build slipped, we need another week".',
  'Suggest the next action on a stalled decision that has been open for two weeks.',
  'Give me a one-line status update I can post to the team channel.',
  'Draft a message asking a teammate for a document I need by end of day.',
  'Turn these rough notes into something I could forward to my manager.',
  'What should I push back on in a plan that just added two weeks of scope?',
  'I have four things due this week and time for two. How should I choose?',
  'Write the opening paragraph of an update to a partner who is losing confidence.',
  'Critique this plan: ship the beta first, fix the known crash after launch.',
  'A vendor missed a deadline for the second time. Draft what I send them.',
  'Give me three questions to ask in a review meeting tomorrow.',
  'Condense a long thread into what my manager actually needs to know.',
  'Someone on the team is blocked on me. Draft the unblocking reply.',
  'What is the strongest argument against the direction I have chosen?',
  'Draft an agenda for a 30-minute decision meeting on a contentious topic.',
  'Rewrite this to be more direct without being rude.',
  'I need to say no to a request from someone senior. Draft it.',
  'Summarize where a stalled project stands for someone joining it cold.',
  'What should I delegate this week, and how do I hand it over?',
  'Draft a note explaining a decision I made that others will dislike.',
  'Give me a checklist for reviewing work before it goes to a partner.',
  'Turn this complaint into a constructive piece of feedback I can send.'
]

function model(): string | null {
  try {
    return routeModel('extraction')
  } catch {
    return null
  }
}

/** Assemble operator-2's FULL grounding: the operator profile + a compact taste summary (leaned
 *  fingerprint axes) + earned calibration rates. Best-effort — each source degrades to nothing. */
export function buildOperatorGrounding(vaultDir: string | null): string {
  const parts: string[] = []
  try {
    const b = buildOperatorBlock()
    if (b) parts.push(b)
  } catch (e) { console.debug('[transfer-ab] no operator model:', messageOf(e)) }
  try {
    const fp = buildStyleFingerprint(vaultDir).fingerprint
    const leans = fp.axes
      .filter((a) => a.lean === 'A' || a.lean === 'B')
      .map((a) => `- ${a.label}: leans "${a.lean === 'A' ? a.poles[0] : a.poles[1]}"`)
    if (leans.length) parts.push(['<operator_taste>', ...leans, '</operator_taste>'].join('\n'))
  } catch (e) { console.debug('[transfer-ab] no fingerprint:', messageOf(e)) }
  try {
    const rates = [...loadKindRates(vaultDir).entries()]
      .filter(([, r]) => !r.gated && r.rate != null)
      .map(([kind, r]) => `- ${kind}: useful ~${Math.round((r.rate as number) * 100)}%`)
    if (rates.length) parts.push(['<operator_calibration>', ...rates, '</operator_calibration>'].join('\n'))
  } catch (e) { console.debug('[transfer-ab] no calibration:', messageOf(e)) }
  return parts.join('\n\n')
}

/** The live A/B deps for operator-2 at `vaultDir`. Every method degrades safely when no engine is
 *  available (empty answers, 'inconclusive' judgments) so the harness never fabricates a lift.
 *
 *  CONFIDENTIAL-LANE FIREWALL. Both payloads this adapter puts on the wire are the operator's own
 *  corpus: the grounded arm's system message carries the entire rendered <operator_profile> — every
 *  promoted, provisional and candidate fact verbatim — and the judge's carries the operator's own
 *  promote/veto rulings. routeModel('extraction') is NOT local-first (it resolves the operator's
 *  configured provider, usually cloud), and nothing here is operator-driven: main.ts starts the
 *  daily tick at boot. That is precisely the send confidential-firewall declares a HARD block on —
 *  "any cloud call the operator didn't explicitly drive". It ran unfiltered while the sibling A/B
 *  measurer over the SAME corpus (judgment-measure-live's runMeasurePass) redacted it, and that
 *  asymmetry is what made the leak invisible: every surface that REPORTS firewall activity was
 *  filtered, so watching them showed the firewall working.
 *
 *  ABSTAIN, DON'T SEND — and the abstain has to abort the whole pass, which is why grounding()
 *  THROWS rather than returning something safe. '' is this module's "no accumulated brain" signal,
 *  so degrading to it would run the grounded arm COLD and have runTransferAB report a fabricated
 *  ~0 lift into transfer-ab-store, which self-improve-bench.resolveNamedSkillLift then reads back
 *  as a real measurement (the same shape as the dropIds trap 8aa140b documents: the safe-looking
 *  degradation is itself the bug). A merely REDACTED profile is no better here: the operator's own
 *  chat — agui-grounding, the documented firewall exemption — grounds on the FULL block, so a lift
 *  measured on a subset is not a measurement of this brain. Losing the litmus is the cheap side. */
export function makeTransferDeps(vaultDir: string | null): TransferDeps {
  return {
    // The rubric's endorsed facts are withheld here — this is the held-out split. Recomputed per
    // call (not captured) so a promote/veto between runs is reflected on both sides at once.
    grounding: () => {
      const rubric = buildHumanRubric()
      const g = withoutFacts(buildOperatorGrounding(vaultDir), rubric.endorsedFacts)
      // Checked on the ASSEMBLED text, not fact-by-fact: the block also carries taste axes and
      // calibration lines, so a line-level filter could leave a denylisted term in a header.
      // The message names the side that tripped and never the term — an abstain log that prints
      // the secret defeats the point.
      if (!firewallClear(g))
        throw new Error(
          'transfer-ab abstained: the operator profile carries confidential-lane content — not sent to the external A/B model'
        )
      if (!firewallClear(rubric.text))
        throw new Error(
          'transfer-ab abstained: the held-out rubric carries confidential-lane content — not sent to the external A/B model'
        )
      return g
    },
    async answer(query, grounding) {
      const m = model()
      if (!m) return ''
      const sys = grounding
        ? `You are assisting a specific operator. Honor their profile, taste, and calibration when you answer:\n\n${grounding}`
        : 'Answer the request normally.'
      try {
        const r = await chatOnce([{ role: 'system', content: sys }, { role: 'user', content: query }], m, undefined, {
          purpose: 'other',
          role: 'transfer-ab-answer'
        })
        return r.content
      } catch {
        return ''
      }
    },
    async judge(query, a, b) {
      const m = model()
      if (!m || (!a && !b)) return 'inconclusive'
      // HELD OUT: grade against the operator's own rulings, never against the grounded arm's
      // prompt. No rubric ⇒ abstain. Falling back to buildOperatorGrounding() here is exactly the
      // circularity this function was fixed to remove, so there is no fallback.
      const rubric = buildHumanRubric()
      // Confidential-lane re-check, not just the pass-level gate in grounding(): the rubric is
      // rebuilt on EVERY judge call, so a human promoting a confidential fact DURING a pass (~3
      // model calls per query, minutes long) would otherwise ride onto the wire after the gate had
      // already passed. Abstaining lands as 'inconclusive', which is excluded from `decided`.
      if (!rubric.text || !firewallClear(rubric.text)) return 'inconclusive'
      try {
        const r = await chatOnce(
          [
            {
              role: 'system',
              content:
                'Two assistants answered the same operator request. Using the operator rulings below as the rubric, ' +
                'decide which answer FITS THIS OPERATOR better (their voice, priorities, and taste). ' +
                'Neither assistant was shown these rulings. ' +
                'Reply with exactly "A", "B", or "tie" — no explanation.\n\n' +
                rubric.text
            },
            { role: 'user', content: `REQUEST: ${query}\n\n--- ANSWER A ---\n${a}\n\n--- ANSWER B ---\n${b}` }
          ],
          m,
          undefined,
          { purpose: 'other', role: 'transfer-ab-judge' }
        )
        const t = r.content.trim().toLowerCase()
        if (/^a\b/.test(t)) return 'A'
        if (/^b\b/.test(t)) return 'B'
        if (/\btie\b/.test(t)) return 'tie'
        return 'inconclusive'
      } catch {
        return 'inconclusive'
      }
    }
  }
}

/** Default live deps (no vault context) — the route supplies a vault-scoped set via makeTransferDeps. */
export const defaultTransferDeps: TransferDeps = makeTransferDeps(null)
