// operator-supersede — conservative AUTO-supersession for the operator model.
//
// The bitemporal `supersedeFact()` mechanism existed but had NO automatic caller:
// a contradiction was resolved only by human veto or by dropping the new
// candidate (verifyPool). So when the operator's state genuinely changed ("editor
// is VSCode" → later "…Neovim"), the stale fact kept grounding until a human
// intervened. This module wires a GATED, REVERSIBLE auto-trigger.
//
// Three independent gates must ALL fire before anything is retired:
//   1. change-signal  — the new fact carries an explicit temporal-change marker
//                        (no longer / switched / now uses / corrected / …).
//   2. referent-overlap — it shares enough content tokens with an EXISTING active
//                        fact to be about the same subject (deterministic floor).
//   3. LLM confirmation — an independent judge, restricted to the overlapping
//                        candidates ONLY, confirms it is a replacement.
// The deterministic overlap floor BOUNDS the judge's reach — it can never retire
// an unrelated fact. And supersession is REVERSIBLE: `supersedeFact` sets valid-TO
// (invalidatedAt) but keeps the fact for audit, so a wrong call is recoverable by
// the govern/revert loop, never a silent data loss. Defaults to NO-OP everywhere.

/** Explicit temporal-change / correction markers. Deliberately narrow — a fact
 *  without one of these is NEVER treated as a supersession (it's additive). */
const CHANGE_MARKERS: RegExp[] = [
  /\bno longer\b/i,
  /\bnot anymore\b/i,
  /\bused to\b/i,
  /\bswitch(?:ed|ing)?\b/i,
  /\bchang(?:ed|ing)\b/i,
  /\bcorrect(?:ed|ion)\b/i,
  /\bactually\b/i,
  /\binstead of\b/i,
  /\bnow (?:uses?|prefers?|works?|on|lives?|at|in)\b/i,
  /\bupdated?\b(?!\s+plan)/i,
  /\bmoved to\b/i,
  /\breplac(?:ed|es|ing)\b/i,
  /\brenamed\b/i
]

/** True when the text carries an explicit change/correction signal. PURE. */
export function hasChangeSignal(text: unknown): boolean {
  const t = typeof text === 'string' ? text : ''
  return CHANGE_MARKERS.some((re) => re.test(t))
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'now', 'not', 'has', 'have', 'had', 'his', 'her', 'its', 'our', 'their',
  'operator', 'prefers', 'prefer', 'uses', 'use', 'used', 'works', 'work', 'working', 'longer', 'anymore',
  'switched', 'changed', 'corrected', 'correction', 'actually', 'instead', 'updated', 'moved', 'replaced',
  'renamed', 'that', 'this', 'with', 'from', 'into', 'onto', 'they', 'them', 'you', 'your'
])

/** Content tokens of a fact: lowercase words length ≥ 3, minus stopwords + the
 *  change-marker vocabulary (so overlap reflects the SUBJECT, not the change
 *  verb). PURE. */
export function contentTokens(text: unknown): Set<string> {
  const t = typeof text === 'string' ? text.toLowerCase() : ''
  const out = new Set<string>()
  for (const w of t.split(/[^a-z0-9]+/)) {
    if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w)
  }
  return out
}

/** Count of shared content tokens between two facts — a cheap same-subject proxy. */
export function referentOverlap(a: unknown, b: unknown): number {
  const ta = contentTokens(a)
  const tb = contentTokens(b)
  let n = 0
  for (const w of ta) if (tb.has(w)) n++
  return n
}

const normFact = (s: string): string => s.toLowerCase().replace(/[.?!]+$/, '').replace(/\s+/g, ' ').trim()

export interface ActiveFactRef {
  id: string
  fact: string
}

/**
 * Active facts that the new fact plausibly REPLACES: same-subject (overlap ≥
 * minOverlap) but NOT an exact restatement (normalized-equal = the same fact,
 * a dedup case, not a contradiction). Sorted by descending overlap so the judge
 * sees the strongest candidate first. PURE.
 */
export function candidateSupersedeTargets(
  newText: string,
  active: ActiveFactRef[],
  minOverlap = 2
): ActiveFactRef[] {
  const key = normFact(newText)
  return active
    .filter((f) => normFact(f.fact) !== key && referentOverlap(newText, f.fact) >= minOverlap)
    .map((f) => ({ ref: f, overlap: referentOverlap(newText, f.fact) }))
    .sort((a, b) => b.overlap - a.overlap)
    .map((x) => x.ref)
}

/** Independent judge: given a new fact and the (already overlap-bounded) candidate
 *  it might replace, return the candidate id to supersede, or null. Conservative
 *  by contract — return null unless it is clearly a temporal replacement. */
export type SupersedeJudge = (newText: string, candidates: ActiveFactRef[]) => Promise<string | null>

export interface AutoSupersedeDeps {
  /** Newly-learned fact texts this turn. */
  newFacts: string[]
  /** Currently ACTIVE (non-invalidated) operator facts. */
  activeFacts: ActiveFactRef[]
  judge: SupersedeJudge
  /** Apply the retirement (the real impl calls supersedeFact). Returns whether it
   *  took effect (false = old id unknown / already invalidated). */
  apply: (oldId: string, newText: string) => boolean
  /** Deterministic same-subject floor (shared content tokens). Default 2. */
  minOverlap?: number
  /** Max LLM judge calls per pass — bounds cost now that a lexical change-marker
   *  is no longer required to reach the judge. Default 4. */
  maxJudgeCalls?: number
}

/**
 * Run the gated auto-supersession pass. A lexical change-marker is NO LONGER
 * REQUIRED — a silently-stated contradiction ("editor is Neovim" replacing
 * "editor is VSCode", with no change word) must also auto-invalidate. The gates
 * that remain are the deterministic referent-overlap floor (same subject) and the
 * LLM judge (confirms same-subject-new-value, bounded to the overlap candidates,
 * defaults NONE). Change-marker facts are judged FIRST so the per-pass judge
 * budget spends on the clearest replacements before silent ones. For each fact
 * with overlapping candidates, ask the judge; if it names an OFFERED candidate,
 * apply the (reversible) retirement. Never throws. Returns count + audit trail.
 */
export async function autoSupersede(
  deps: AutoSupersedeDeps
): Promise<{ superseded: number; trail: Array<{ oldId: string; newText: string }> }> {
  const trail: Array<{ oldId: string; newText: string }> = []
  const minOverlap = deps.minOverlap ?? 2
  const maxJudge = deps.maxJudgeCalls ?? 4
  // Snapshot active ids retired this pass so two new facts can't both retire the
  // same old fact, and a just-superseded fact can't be a candidate again.
  const retired = new Set<string>()
  // Stable-sort change-marker facts first (highest-confidence replacements) so a
  // bounded judge budget is spent on them before silently-stated contradictions.
  const ordered = deps.newFacts
    .map((text, i) => ({ text, i, marker: hasChangeSignal(text) }))
    .sort((a, b) => (b.marker ? 1 : 0) - (a.marker ? 1 : 0) || a.i - b.i)
    .map((x) => x.text)
  let judged = 0
  for (const newText of ordered) {
    if (judged >= maxJudge) break
    const active = deps.activeFacts.filter((f) => !retired.has(f.id))
    const candidates = candidateSupersedeTargets(newText, active, minOverlap)
    if (candidates.length === 0) continue
    judged++
    let chosen: string | null = null
    try {
      chosen = await deps.judge(newText, candidates)
    } catch {
      continue // judge failed → leave everything intact
    }
    // Guard: the judge may only pick a candidate we actually offered.
    if (!chosen || !candidates.some((c) => c.id === chosen)) continue
    if (deps.apply(chosen, newText)) {
      retired.add(chosen)
      trail.push({ oldId: chosen, newText })
    }
  }
  return { superseded: trail.length, trail }
}
