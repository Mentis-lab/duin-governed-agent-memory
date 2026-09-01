// consolidation-lenses — the GC half of consolidation (legacy harness consolidate.py's
// corrections-decay + judgment re-abstraction lenses). Consolidation isn't only "merge
// duplicates"; a healthy long-term store also has to forget and re-tighten:
//
//   DECAY          an unpromoted candidate that has sat past its recency half-life is
//                  stale — surface it to drop or finally promote (forgetting = demotion,
//                  never silent loss; the operator decides).
//   RE-ABSTRACTION a fact that has grown over-general — long and bundling several clauses
//                  — is the "Funes surface": too specific-turned-sprawling to be reused.
//                  Flag it to be split/tightened.
//
// Both are SURFACING lenses — they return candidates for review, never mutate the store
// (pruning + re-abstraction stay human-gated, matching the harness). PURE + unit-tested.

export interface LensFact {
  id: string
  text: string
  status: string
  ts: number // ms epoch when captured
}

const DAY_MS = 86400000
const ageDays = (ts: number, now: number): number => Math.max(0, (now - ts) / DAY_MS)

// ── DECAY ─────────────────────────────────────────────────────────────────────
export interface DecayPolicy {
  halfLifeDays: number // recency half-life
  minAgeDays: number // don't surface anything younger than this (give it time to earn promotion)
}
export const DEFAULT_DECAY_POLICY: DecayPolicy = { halfLifeDays: 30, minAgeDays: 21 }

/** Recency weight: 1 fresh → 0.5 at one half-life → →0. PURE. */
export function decayWeight(days: number, halfLifeDays: number): number {
  return Math.pow(0.5, days / Math.max(1e-9, halfLifeDays))
}

/** Unpromoted candidates that have decayed past half strength — stale, for review. PURE.
 *  Only candidate/provisional facts (promoted/vetoed/reverted are already resolved). */
export function staleCandidates(
  facts: LensFact[],
  now: number,
  policy: DecayPolicy = DEFAULT_DECAY_POLICY
): LensFact[] {
  return facts.filter((f) => {
    if (f.status !== 'candidate' && f.status !== 'provisional') return false
    const d = ageDays(f.ts, now)
    return d >= policy.minAgeDays && decayWeight(d, policy.halfLifeDays) < 0.5
  })
}

// ── RE-ABSTRACTION ────────────────────────────────────────────────────────────
export interface ReAbstractionPolicy {
  maxChars: number // above this a fact is sprawling
  maxClauses: number // above this it is bundling too many directives
}
export const DEFAULT_REABSTRACTION_POLICY: ReAbstractionPolicy = { maxChars: 200, maxClauses: 3 }

// Clause separators: sentence enders + coordinating conjunctions (EN + CJK).
const CLAUSE_SPLIT = /[.;。；！?！？]|\band\b|\bbut\b|\balso\b|、|，|；/gi

/** How many distinct clauses a fact bundles. PURE. */
export function clauseCount(text: string): number {
  const parts = text
    .split(CLAUSE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3) // ignore fragments left by punctuation
  return Math.max(1, parts.length)
}

/** Facts that have grown over-general (too long OR too many bundled clauses) — flag to
 *  split/tighten. Skips vetoed/reverted (already dead). PURE. */
export function reAbstractionCandidates(
  facts: LensFact[],
  policy: ReAbstractionPolicy = DEFAULT_REABSTRACTION_POLICY
): LensFact[] {
  return facts.filter((f) => {
    if (f.status === 'vetoed' || f.status === 'reverted') return false
    return f.text.length > policy.maxChars || clauseCount(f.text) > policy.maxClauses
  })
}

export interface LensFindings {
  stale: LensFact[]
  overGeneral: LensFact[]
}

/** Run both GC lenses over the fact store. Surfacing only — never mutates. PURE. */
export function consolidationLenses(
  facts: LensFact[],
  now: number,
  decay: DecayPolicy = DEFAULT_DECAY_POLICY,
  reab: ReAbstractionPolicy = DEFAULT_REABSTRACTION_POLICY
): LensFindings {
  return {
    stale: staleCandidates(facts, now, decay),
    overGeneral: reAbstractionCandidates(facts, reab)
  }
}
