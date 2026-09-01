// grounding-eval.ts — Foundation 1: a deterministic, headless grounding-QUALITY eval, so a
// retrieval/memory change can be A/B'd honestly instead of scored by a flag-flip (the gaming trap
// the campaign forbids). DUIN's honest measurement stack (calibration wilson_lo, RSI held-out A/B,
// coherence-health) grades FORECAST outcomes + code-wiring liveness — nothing grades grounding
// precision. This closes that gap for the specific, load-bearing question behind
// store.implicit-conflict-live: "does the staleness fusion bury still-VALID operator preferences?"
//
// Honesty design (per the 4-agent measurement map): the corpus is REAL (the dogfood vault — the operator's
// actual PROMOTED facts + REAL resolved decisions); the gold is BY CONSTRUCTION, not author-judgment:
//   - an operator-PROMOTED fact IS valid (the operator endorsed it) → any staleness flag on it is a
//     FALSE POSITIVE (the fusion would down-weight a real preference).
//   - a fact templated from a resolved decision's still-open pre-state IS stale (obsolete) → a sanity
//     RECALL check that the signal fires at all.
// The headline metric is the FALSE-POSITIVE RATE on real promoted facts — the exact risk the
// implicit-conflict default-on flip carries. Low FP ⇒ default-on is honestly justified; high FP ⇒ it
// is not (and no flag-flip should claim the +15).
//
// PURE + electron-free (the caller injects the real matchStale + the real facts/decisions via the
// /debug/grounding-eval route) so it unit-tests headless.

export type EvalLabel = 'stale' | 'valid'
export interface EvalFact {
  id: string
  text: string
  label: EvalLabel
}

export interface StalenessScore {
  total: number
  stale: number
  valid: number
  tp: number // stale, flagged
  fp: number // valid, flagged  ← the buried-preference errors
  tn: number // valid, not flagged
  fn: number // stale, not flagged
  /** of FLAGGED facts, the fraction genuinely stale (tp/(tp+fp)); null if nothing flagged. */
  precision: number | null
  /** of STALE facts, the fraction flagged (tp/stale); null if no stale facts. */
  recall: number | null
  /** of VALID facts, the fraction WRONGLY flagged (fp/valid) — the headline risk metric; null if no valid. */
  fpRate: number | null
  /** the false positives themselves, for inspection (which real preferences would be buried). */
  flaggedValid: { id: string; text: string; topic: string }[]
}

/**
 * Score a staleness signal (`matchFn` returns the matched topic — flagged — or null) over a labeled
 * fact set. The load-bearing output is `fpRate`: how often the signal flags an operator-endorsed
 * (valid) fact. PURE.
 */
export function scoreStaleness(facts: EvalFact[], matchFn: (text: string) => { label: string } | null): StalenessScore {
  let tp = 0
  let fp = 0
  let tn = 0
  let fn = 0
  const flaggedValid: StalenessScore['flaggedValid'] = []
  for (const f of facts) {
    const hit = matchFn(f.text)
    const flagged = hit !== null
    if (f.label === 'stale') {
      if (flagged) tp++
      else fn++
    } else {
      if (flagged) {
        fp++
        flaggedValid.push({ id: f.id, text: f.text, topic: hit.label })
      } else tn++
    }
  }
  const stale = tp + fn
  const valid = fp + tn
  return {
    total: facts.length,
    stale,
    valid,
    tp,
    fp,
    tn,
    fn,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: stale ? tp / stale : null,
    fpRate: valid ? fp / valid : null,
    flaggedValid
  }
}

/**
 * Sanity-RECALL positives: for each resolved decision, a fact templated as the STILL-OPEN pre-decision
 * state (obsolete now that the decision resolved), carrying the decision title's entity tokens so it's
 * realistically matchable. By construction stale. PURE. (These test that the signal fires at all; the
 * real decision-driver is the fpRate on real valid facts.)
 */
export function templatedStaleFacts(decisions: { id: string; title?: string }[]): EvalFact[] {
  const out: EvalFact[] = []
  for (const d of decisions) {
    const title = (d.title || '').trim()
    if (!title) continue
    out.push({ id: `stale:${d.id}`, text: `Still deciding: ${title} — the plan is not yet settled.`, label: 'stale' })
  }
  return out
}
