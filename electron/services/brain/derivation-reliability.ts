// derivation-reliability.ts — reasoning-trace provenance STAGE 3: the trust semiring.
//
// Stages 1–2 gave verified DEPENDS_ON edges (capture) + a boolean cascade (contraction). This is the
// third thing the frontier prescribes: reinterpret the SAME derivation graph under a TRUST semiring
// (Green–Karvounarakis–Tannen, Provenance Semirings, PODS 2007 — swap the counting semiring for a
// confidence one) to compute a calibrated `reliability` per fact, CAPPED by source trust so a fluent
// rule over a junk premise cannot launder itself into high confidence: reliability = min(provenance_tier,
// content_score) (arXiv:2606.22030 — the memory-poisoning defense). This makes the faithfulness
// constraint QUANTITATIVE: a verified 'entails' edge earns its score; an UNVERIFIED edge (verifier null)
// is only neutral; a 'contradicts' edge is near-zero — so trust flows only through checked derivations.
// PURE: no store, no clock, no model. Additive — it scores the graph, it does NOT change the cascade's
// binary safety floor (Stage 2). See PLANNING/DUIN_SIA_REASONING_TRACE_FRONTIER.md.

export interface RelEdge {
  depends_on: string[]
  verdict?: string
  score?: number
  verifier?: string | null
}
export interface RelFact {
  id: string
  source?: string
  dependsOn?: RelEdge[]
}

/** Source-tier trust — the provenance cap. operator (the person stated it) > machine (model-inferred) >
 *  external (de-privileged inbound, already grounding-quarantined). A fact's reliability can never exceed
 *  its own tier, and a derivation can never exceed its weakest premise's tier. */
export function tierScore(source?: string): number {
  return source === 'operator' ? 1.0 : source === 'external' ? 0.3 : 0.7 // machine / undefined → 0.7
}

/** Trust carried by ONE derivation edge. An UNVERIFIED edge (verifier null — no key / abstained) is only
 *  NEUTRAL (0.5): we could not check it, so it must not confer full trust (the faithfulness constraint —
 *  the fold model's say-so is not proof). A verified 'entails' earns its NLI score; 'neutral' is capped
 *  low; 'contradicts' is near-zero (trust must not flow through a refuted derivation). */
export function edgeTrust(e: RelEdge): number {
  const s = typeof e.score === 'number' && e.score >= 0 && e.score <= 1 ? e.score : 0.5
  if (e.verifier == null) return 0.5 // unverified → neutral, never full trust
  return e.verdict === 'entails' ? s : e.verdict === 'neutral' ? Math.min(s, 0.4) : 0.1 // contradicts → 0.1
}

/** PURE — calibrated reliability per fact over the derivation graph (min/product trust semiring).
 *  Root fact (no edges) = its source tier. Derived fact = min(own source tier, best derivation), where a
 *  derivation's trust = edgeTrust × the MIN reliability among its premises (product-min: a chain is only
 *  as strong as its weakest verified link). Cycle-safe (a fact being computed contributes its tier floor,
 *  breaking the cycle); a missing/evicted premise is NEUTRAL (0.5, unknown — not zero). Deterministic. */
export function reliabilityByFact(facts: RelFact[]): Map<string, number> {
  const byId = new Map(facts.map((f) => [f.id, f]))
  const memo = new Map<string, number>()
  const visiting = new Set<string>()
  const rel = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!
    const f = byId.get(id)
    if (!f) return 0.5 // missing/evicted premise — unknown, neutral (never a false 0)
    if (visiting.has(id)) return tierScore(f.source) // cycle floor — break without infinite recursion
    visiting.add(id)
    let r: number
    if (!f.dependsOn || f.dependsOn.length === 0) {
      r = tierScore(f.source)
    } else {
      let best = 0
      for (const e of f.dependsOn) {
        const premMin = e.depends_on.length ? Math.min(...e.depends_on.map(rel)) : 0
        best = Math.max(best, edgeTrust(e) * premMin)
      }
      r = Math.min(tierScore(f.source), best) // the trust-cap: min(own provenance tier, derivation trust)
    }
    visiting.delete(id)
    memo.set(id, Math.round(r * 1000) / 1000)
    return memo.get(id)!
  }
  const out = new Map<string, number>()
  for (const f of facts) out.set(f.id, rel(f.id))
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 5 — DISTRIBUTIONAL BOUNDS + LEARNED VERIFIER WEIGHT
//
// Stage 3 scores each fact with a POINT reliability. That point silently assumes the NLI verifier is
// INFALLIBLE: a verified 'entails' edge contributes its raw score as if the check itself were certain.
// The literature says the opposite — entailment verifiers lean on lexical-overlap heuristics and carry
// real error (PLANNING/DUIN_SIA_REASONING_TRACE_FRONTIER.md §3: "NLI is strong-but-fallible — budget for
// verifier error"). A single number cannot express "0.7, and we have measured this verifier 200 times"
// versus "0.7, and we have never checked whether it is right."
//
// So the same derivation graph is evaluated a second time over an INTERVAL semiring: every quantity
// becomes [lo, hi], and the verifier's own MEASURED precision — a Wilson-95 interval over live human
// promote/veto outcomes, the learned weight — sets how far the interval spreads. All the semiring's
// operators (min, max, ×) are monotone, so intervals propagate endpoint-wise and stay sound.
//
// THE SAFETY INVARIANT that makes this riskless to consume: `hi <= point` for every fact. The Stage-3
// point IS the optimistic ceiling (it is what you get from a perfect verifier); evidence about verifier
// fallibility can only pull the bound DOWN, never up. A cold/unmeasured verifier reproduces the point
// exactly as its upper bound. Therefore any gate or ordering driven by these bounds is TIGHTEN-ONLY by
// construction — it can never admit a fact the Stage-3 gate suppresses. Additive: the binary
// TRUST_FLOOR safety gate keeps running on the point value, unchanged.
import { wilson } from './calibration-resolve-native'

/** A reliability INTERVAL — the distributional replacement for Stage 3's scalar. `lo` is the
 *  conservative (95% lower) bound used for ranking; `hi` is the optimistic ceiling. */
export interface RelBound {
  lo: number
  hi: number
}

/** Observed verifier outcomes — the LEARNED WEIGHT input. `correct` = derivations the verifier called
 *  'entails' that a human subsequently PROMOTED (the verifier was right); `observed` = those a human
 *  adjudicated either way (promoted or vetoed). Unadjudicated folds are not evidence and are excluded. */
export interface VerifierCalibration {
  correct: number
  observed: number
}

/** Minimum adjudications before the measured verifier precision is trusted — the same honesty gate the
 *  calibration core uses (CAL_MIN_N). Below it we do NOT pretend to know the verifier's error rate. */
export const VERIFIER_MIN_N = 20

/** The cold prior: precision is unmeasured, so it could be anything from coin-flip to perfect. `hi = 1`
 *  is what makes an unmeasured verifier reproduce the Stage-3 point exactly as the upper bound. */
export const COLD_VERIFIER: RelBound = { lo: 0.5, hi: 1.0 }

/** An UNVERIFIED edge's trust interval. Stage 3 scores it at the neutral 0.5 (we could not check it);
 *  the width states honestly that the true value is unknown. Note the band is ONE-SIDED — it runs DOWN
 *  from the neutral point, never above it. Uncertainty about a derivation is not a reason to trust it
 *  more: an unchecked edge is at BEST neutral and possibly worse, which is the same doctrine Stage 3's
 *  `edgeTrust` already applies when it caps an unverified edge at neutral instead of letting it claim its
 *  asserted score. Symmetric widening would let an unchecked derivation outrank a checked one and would
 *  break the `hi <= point` guarantee that makes every consumer tighten-only. */
export const UNVERIFIED_BOUND: RelBound = { lo: 0.3, hi: 0.5 }

const r3 = (n: number): number => Math.round(n * 1000) / 1000

/** Wilson-95 bounds on the verifier's precision; cold or under-sampled ⇒ the honest wide prior. This is
 *  the LEARNED WEIGHT: the hardcoded trust constants stop being assumptions and become measurements. */
export function verifierBounds(cal?: VerifierCalibration): RelBound {
  if (!cal || cal.observed < VERIFIER_MIN_N || cal.correct < 0 || cal.correct > cal.observed) return COLD_VERIFIER
  const [lo, hi] = wilson(cal.correct, cal.observed)
  if (lo == null || hi == null) return COLD_VERIFIER
  return { lo: Math.max(0, lo), hi: Math.min(1, hi) }
}

/** Trust carried by ONE derivation edge, as an interval. An unverified edge is genuinely unknown
 *  (fixed width around the neutral point). A VERIFIED edge's trust is its NLI score DISCOUNTED by how
 *  reliable that verifier has actually proven to be — so `hi <= edgeTrust(e)` always, with equality
 *  exactly when the verifier is unmeasured (cold `hi = 1`) or measured perfect. */
/*  Deliberately UNROUNDED. The point path rounds exactly once, at the fact (`reliabilityByFact`); if we
 *  rounded here too, the extra grid step could round an endpoint UP past the point it must never exceed
 *  — e.g. an edge score of 0.9005 over a machine root yields point 0.63 but a twice-rounded hi of 0.631,
 *  breaking the tighten-only guarantee by one grid unit. Rounding stays where the point path puts it. */
export function edgeTrustBounds(e: RelEdge, vb: RelBound = COLD_VERIFIER): RelBound {
  const p = edgeTrust(e)
  if (e.verifier == null) return UNVERIFIED_BOUND
  return { lo: p * vb.lo, hi: p * Math.min(1, vb.hi) }
}

/** PURE — reliability INTERVALS per fact over the same derivation graph, under the interval semiring.
 *  Structurally mirrors reliabilityByFact (min/product/max, cycle floor, missing-premise neutrality) with
 *  every operator lifted to endpoints. Guarantees `lo <= hi` and `hi <= reliabilityByFact(...)`. */
export function reliabilityBoundsByFact(facts: RelFact[], cal?: VerifierCalibration): Map<string, RelBound> {
  const vb = verifierBounds(cal)
  const byId = new Map(facts.map((f) => [f.id, f]))
  const memo = new Map<string, RelBound>()
  const visiting = new Set<string>()
  const rel = (id: string): RelBound => {
    const hit = memo.get(id)
    if (hit) return hit
    const f = byId.get(id)
    if (!f) return UNVERIFIED_BOUND // missing/evicted premise — unknown, brackets the point's 0.5
    const tier = tierScore(f.source)
    if (visiting.has(id)) return { lo: tier, hi: tier } // cycle floor — the tier is known, not estimated
    visiting.add(id)
    let out: RelBound
    if (!f.dependsOn || f.dependsOn.length === 0) {
      out = { lo: tier, hi: tier } // a root fact's trust IS its source tier — no verifier involved
    } else {
      let bestLo = 0
      let bestHi = 0
      for (const e of f.dependsOn) {
        const prem = e.depends_on.map(rel)
        const premLo = prem.length ? Math.min(...prem.map((b) => b.lo)) : 0
        const premHi = prem.length ? Math.min(...prem.map((b) => b.hi)) : 0
        const et = edgeTrustBounds(e, vb)
        bestLo = Math.max(bestLo, et.lo * premLo)
        bestHi = Math.max(bestHi, et.hi * premHi)
      }
      out = { lo: Math.min(tier, bestLo), hi: Math.min(tier, bestHi) }
    }
    visiting.delete(id)
    // lo <= hi is structural, but clamp defensively so no consumer can ever see an inverted interval.
    const norm = { lo: r3(Math.min(out.lo, out.hi)), hi: r3(Math.max(out.lo, out.hi)) }
    memo.set(id, norm)
    return norm
  }
  const out = new Map<string, RelBound>()
  for (const f of facts) out.set(f.id, rel(f.id))
  return out
}

/** EVIDENCE-RANKED TRUNCATION — the load-bearing consumer of the bounds (Stage 5).
 *
 *  Grounding blocks are capped (MAX_BLOCK_LINES), so when more facts are eligible than fit, something is
 *  dropped. Stage 3 drops by list position — whichever happened to be enumerated last — which is
 *  arbitrary with respect to trustworthiness. Here the scarce slots go to the facts whose reliability is
 *  best ESTABLISHED, ranking on the conservative lower bound: the same lower-confidence-bound discipline
 *  the calibration gates already use, where a wide interval (little evidence) loses to a narrow one at
 *  equal central estimate.
 *
 *  Deliberately a no-op unless the cap actually binds, so grounding is byte-identical on every store that
 *  fits — the behavior change is confined to the case where a fact was going to be dropped anyway. The
 *  sort is stable, so facts with equal bounds (e.g. all root operator facts at their tier) keep their
 *  existing relative order. It cannot ADMIT anything: the caller has already applied the TRUST_FLOOR
 *  suppression, so this only reorders within an already-gated set. */
export function rankByEstablishedTrust<T extends { id: string }>(
  items: T[],
  cap: number,
  bounds: Map<string, RelBound>
): T[] {
  if (items.length <= cap) return items
  const lo = (id: string): number => bounds.get(id)?.lo ?? 1 // unknown ⇒ ungated root, sorts first
  return [...items].sort((a, b) => lo(b.id) - lo(a.id)).slice(0, cap)
}
