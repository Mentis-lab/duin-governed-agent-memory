// claim-metabolism — Phase 1 (deterministic first slice) of the world-state-gated knowledge-
// graph metabolism (design: PLANNING/DUIN_GRAPH_METABOLISM.md; dynamics verified in
// PLANNING/metabolism_sim.py before this was written). The problem it solves: a note is
// retrieved because the embedder found it SIMILAR, not TRUE or CURRENT — and embeddings
// provably cannot separate a superseded claim from a paraphrase (MemStrata 0.59 AUROC), so
// pure vector RAG serves stale content 15–40% of the time ("called by mistake"). The fix is
// a mostly-DETERMINISTIC judge: the operator's world-state renders freshness verdicts on
// claims, and retrieval is scored by similarity × freshness × reinforcement.
//
// This module is the PURE verdict + freshness engine — no I/O, so it matches the simulation
// and is unit-tested against it. It is RETIRE-NOT-DELETE (a verdict sets validTo; the row is
// kept and reversible) and SHADOW-FIRST (it surfaces corrections; wiring the freshness term
// into the live retrieval score is a later, separately-gated step). Verdicts are:
//   contradicted — same (subject,relation) key, different object, newer observation supersedes
//   stale        — references a past anchor / resolved decision / passed stream, OR age-decayed
//   orphaned     — a claim this one was justified BY has been retired (JTMS propagation)
//   current      — none of the above

import { ENTITY_CLUSTER_THRESHOLD } from './claim-entities'

export type Verdict = 'current' | 'stale' | 'contradicted' | 'orphaned'
export type Mutability = 'evergreen' | 'mutable'

export interface Claim {
  id: string
  chunkId: string
  notePath: string
  subject: string
  relation: string
  object: string
  // bi-temporal
  validFrom: number
  validTo: number | null // null = current/active; set = retired (stale/contradicted/orphaned)
  observedAt: number
  supersededBy: string | null
  // metabolism
  mutability: Mutability
  justifications: string[] // claim ids this derives FROM (JTMS)
  lastUsefulAt?: number // clock the age-decay resets to on USEFUL access (MemoryBank)
  verdict: Verdict
  verdictBy: 'temporal' | 'supersession' | 'jtms' | 'model' | null
  // whether the operator authored this judgment (harmony: operator facts are evergreen —
  // the metabolism must never stale a deliberately-taught fact; see §11 of the design)
  operatorAuthored?: boolean
  // provenance: 'structured' = deterministically lifted from decisions/streams (authoritative);
  // 'prose' = an LLM-inferred triple from note text (see claim-extract constructionClaims). A prose
  // claim must never DURABLY supersede another claim (a wrong triple can't retire a real fact) — a
  // prose-driven supersession is emitted as a PROPOSAL (verdictBy 'model'), not persisted.
  source?: 'structured' | 'prose'
  // canonical entity for the subject — the CLUSTER label from semantic entity resolution
  // (claim-entities.ts), so supersession/reinforcement coalesce alias/paraphrase variants of the
  // same real thing. Unset ⇒ the raw subject is the key (exact-string fallback, no embedder).
  entityKey?: string
  // how strongly this subject belongs to its resolved entity cluster (cosine to the cluster head;
  // 1.0 when it IS the head). The supersession guard (applySupersessionGuards) reads this to REFUSE
  // an ambiguous cross-alias retirement — a weakly/transitively linked subject must not durably
  // retire a real claim. Unset ⇒ treated as 0 (no evidence ⇒ a model supersession is blocked).
  entityKeyConfidence?: number
  // confidence attached to a MODEL-proposed supersession retirement (runVerdicts stamps it on the
  // loser). The apply-guard keeps the retirement only when this clears the threshold. Unset for
  // deterministic verdicts (they don't pass through the confidence gate).
  supersedeConfidence?: number
  // TRUE iff this claim was retired by an APPLIED model supersession (guard-approved in
  // applySupersessionGuards). Distinct from verdictBy — a kept model retirement is re-tagged
  // verdictBy='supersession' (indistinguishable from a deterministic structured supersession), so we
  // carry a dedicated marker for the CUMULATIVE per-entity over-retirement bound (DEFECT 3): only
  // MODEL retirements count against an entity's across-tick retirement budget; deterministic
  // structured supersessions (a status legitimately changing) are trusted and uncapped. Cleared on
  // unretire (a human reversal frees the budget). Deterministic; carried forward by the ledger.
  modelRetired?: boolean
  // human review state — a govern/operator decision on this claim's verdict. Once set, the
  // deterministic verdict pass must NEVER auto-override it (that is the moat-reversibility
  // guarantee: a human reversal survives the next tick). 'reverted' = a retirement was undone
  // (unretire); 'confirmed' = the current state was human-accepted (pin whatever it is).
  reviewState?: 'confirmed' | 'reverted'
}

/** Current state of the operator's world the judge reads (ids of things that have moved on). */
export interface WorldState {
  pastAnchors: Set<string>
  resolvedDecisions: Set<string>
  passedStreams: Set<string>
}

export interface Correction {
  claimId: string
  verdict: Verdict
  reason: string
  supersededBy?: string
  /** W5: did the retirement stand after the guards? A model supersession may be blocked and reverted. */
  applied?: boolean
  /** W5: why a model supersession was NOT applied. */
  blockedBy?: SupersessionOutcome
  /** W5: a human ruling on this claim (`confirmed` / `reverted`), if any. */
  reviewState?: string
}

/** W5: what the supersession guards decided for one proposal. */
export type SupersessionOutcome = 'applied' | 'pinned' | 'missing-winner' | 'cross-alias' | 'confidence' | 'tripwire' | 'disabled'

/** W5: stamp each correction with what actually happened after the guards, so a surface can show the
 *  human which model retirements stood, which were blocked and why, and which they already ruled on. */
export function annotateCorrections(
  corrections: Correction[],
  claims: Claim[],
  outcomes: Map<string, SupersessionOutcome>
): Correction[] {
  const byId = new Map(claims.map((c) => [c.id, c]))
  return corrections.map((c) => {
    const cl = byId.get(c.claimId)
    const o = outcomes.get(c.claimId)
    return {
      ...c,
      ...(cl ? { applied: cl.validTo !== null } : {}),
      ...(o && o !== 'applied' ? { blockedBy: o } : {}),
      ...(cl?.reviewState ? { reviewState: String(cl.reviewState) } : {})
    }
  })
}

// Tuned to the simulation (PLANNING/metabolism_sim.py). A retired claim's freshness collapses;
// a current mutable claim floors well above it so no single sub-1 factor buries good content.
export const HARD_PENALTY = 0.05
export const FRESH_FLOOR = 0.3
const DAY = 86_400_000

// P7 supersession-apply tuning. A PROSE winner (possibly-hallucinated triple) is trusted only up to
// this ceiling — high enough that a clean same-subject prose contradiction applies by default, low
// enough that a stricter env threshold can gate prose out while keeping high-confidence entity
// supersessions. All model supersessions are REVERSIBLE (retire-not-delete + pins + human review).
export const PROSE_SUPERSEDE_CONF = 0.9

// Cross-alias apply bar (DEFECT 1). The confidence gate must sit strictly ABOVE the entity-clustering
// threshold, or it can NEVER fire on a direct two-member cluster: a pairwise merge unions on
// cosine ≥ ENTITY_CLUSTER_THRESHOLD (0.86), so the member's entityKeyConfidence == that cosine ≥ 0.86,
// and a gate at 0.85 lets EVERY bare-threshold merge through (correct AND incorrect). We DERIVE the
// bar from the threshold + a 0.06 margin so the two can never silently cross again if the threshold is
// retuned — a cross-alias durable retirement now requires membership meaningfully stronger (≥ 0.92)
// than the merge bar, so a bare-threshold cosine collision (腾讯视频 vs 腾讯音乐 at ~0.86) can't
// durably retire a real claim. The rounding lands it on a clean 0.92 despite float error in 0.86+0.06.
export const SUPERSEDE_MIN_CONFIDENCE = Math.round((ENTITY_CLUSTER_THRESHOLD + 0.06) * 1000) / 1000 // → 0.92

// INVARIANT (startup assert — the "can't silently cross" mechanism). If a future edit lowers the
// margin or raises the clustering threshold so the bar no longer dominates the merge bar, fail LOUD at
// module load rather than silently re-open DEFECT 1 (a gate that never fires on a direct merge).
if (!(SUPERSEDE_MIN_CONFIDENCE > ENTITY_CLUSTER_THRESHOLD)) {
  throw new Error(
    `[claim-metabolism] INVARIANT VIOLATED: SUPERSEDE_MIN_CONFIDENCE (${SUPERSEDE_MIN_CONFIDENCE}) must be ` +
      `strictly > ENTITY_CLUSTER_THRESHOLD (${ENTITY_CLUSTER_THRESHOLD}); otherwise the cross-alias confidence ` +
      `gate can never block a bare-threshold merge (DEFECT 1).`
  )
}

/**
 * RELATION CARDINALITY (DEFECT 4). Supersession assumes every relation is FUNCTIONAL — that a
 * subject holds at most one object at a time, so a newer different object must have replaced the
 * older one. That is true of `status is` / `deadline is`. It is false of the relations this vault
 * actually uses most: on the live ledger `the operator decided` carried **40 active claims with 40 different
 * objects** — forty distinct decisions, all simultaneously true — and the rule would have retired
 * thirty-nine of them as `contradicted`. Same shape for `has goal`, `has feature`, `provides`,
 * `includes`, `component`. Knowledge loss, not truth maintenance.
 *
 * We infer cardinality from EVIDENCE rather than a hardcoded relation list, because a list cannot
 * survive this corpus: relations are free-text LLM output and roughly a third of the vault is CJK,
 * so any English vocabulary would silently fail to match. The evidence: **if a SINGLE source note
 * asserts two different objects for the same (subject, relation), that pairing is demonstrably
 * multi-valued** — one document saying both is asserting both, not correcting itself. Generalise
 * that one observation to the whole group and the pairing never supersedes again.
 *
 * Why the naive alternative is wrong: "many distinct objects ⇒ multi-valued" would misclassify
 * genuinely functional relations, which accumulate many values *over time* precisely BECAUSE each
 * supersedes the last. `status` has 16 distinct objects on this vault and must keep superseding.
 * Simultaneity — co-assertion in one document — is the discriminator that separates the two, and
 * degree does not.
 *
 * Measured on the live ledger: 589 would-be retirements → 85, suppressing 504 (85.6%). It zeroes
 * `decided`, `feature`, `decision`, `component`, `provides` and `includes`, and leaves the
 * survivors — those with real cross-note temporal evidence and no single-note co-assertion.
 *
 * DIRECTION OF ERROR: this can only ever PREVENT a retirement, never cause one. A missed
 * supersession leaves a stale claim active (visible, correctable); a false supersession buries a
 * true one. Kill-switch `DUIN_CLAIM_RELATION_CARDINALITY=0` restores the prior behaviour exactly.
 *
 * This gates identity work. Merging fragmented subjects makes MORE claims share a key, so without
 * cardinality a subject merge multiplies exactly these false retirements — see the handoff §12.
 */
export function relationCardinalityEnabled(): boolean {
  return process.env.DUIN_CLAIM_RELATION_CARDINALITY !== '0'
}

/**
 * PURE: the set of `supersedeKey`s a single note has demonstrated to be multi-valued.
 *
 * Computed over ALL claims — active AND retired — deliberately. Reading only active claims would be
 * circular: the first pass retires the co-asserted objects, the evidence for multi-valuedness
 * disappears with them, and the next pass happily retires the rest. The corpus fact "this note
 * asserted two objects here" does not stop being true because a verdict was applied to it.
 */
export function inferMultiValuedKeys(claims: Claim[]): Set<string> {
  const perKeyNote = new Map<string, Map<string, Set<string>>>()
  const multi = new Set<string>()
  for (const c of claims) {
    const key = supersedeKey(entityKeyOf(c), c.relation)
    if (multi.has(key)) continue
    let byNote = perKeyNote.get(key)
    if (!byNote) { byNote = new Map(); perKeyNote.set(key, byNote) }
    // A claim with no notePath has no provenance to co-assert WITH, so it cannot witness anything.
    const note = c.notePath
    if (!note) continue
    let objs = byNote.get(note)
    if (!objs) { objs = new Set(); byNote.set(note, objs) }
    objs.add(c.object.trim().toLowerCase())
    if (objs.size >= 2) multi.add(key)
  }
  return multi
}

/** Guards on APPLYING a model-proposed supersession (the P7 tripwires against destroying real
 *  knowledge). All reversible; these bound the blast radius BEFORE anything persists. */
export interface SupersessionGuards {
  /** apply a cross-alias model supersession only when its entity-membership confidence ≥ this. MUST be
   *  > ENTITY_CLUSTER_THRESHOLD (enforced by the startup invariant above) so a bare-threshold merge
   *  can't clear it. Same-subject (entityConf==1) always clears it — this bar is the cross-alias gate. */
  minConfidence: number
  /** CUMULATIVE per-entity over-retirement cap: refuse if (already-model-retired + would-retire) /
   *  (active + already-model-retired + would-retire) > this fraction. Counting prior model retirements
   *  in BOTH numerator and denominator gives a bound across ticks, so slow 1-of-2-per-tick gutting is
   *  caught (DEFECT 3) — not just a single runaway pass. */
  maxRetireFraction: number
  /** …but only apply the fraction cap once an entity has at least this many claims counted (active +
   *  already-model-retired + would-retire), so a legitimate 1-of-2 on a tiny entity isn't tripped. */
  fractionFloor: number
}
export const DEFAULT_SUPERSESSION_GUARDS: SupersessionGuards = { minConfidence: SUPERSEDE_MIN_CONFIDENCE, maxRetireFraction: 0.5, fractionFloor: 4 }

// Per-relation half-life (ms). Evergreen-ish relations barely decay; volatile ones decay in
// weeks. Deterministic keyword match; refine from observed edit cadence later (HALO).
const EVERGREEN_RE = /(is-a|born|founded|defined|identity|name|birthday|located|type)/i
const VOLATILE_RE = /(status|current|plan|price|deadline|eta|schedule|owner|state|progress)/i
export function halfLifeFor(relation: string): number {
  if (EVERGREEN_RE.test(relation)) return Number.POSITIVE_INFINITY
  if (VOLATILE_RE.test(relation)) return 14 * DAY
  return 90 * DAY // default: a season
}

/** Deterministic mutability classification. Operator-authored judgment is always evergreen. */
export function classifyMutability(relation: string, operatorAuthored = false): Mutability {
  if (operatorAuthored) return 'evergreen'
  return halfLifeFor(relation) === Number.POSITIVE_INFINITY ? 'evergreen' : 'mutable'
}

// Relation-phrase canonicalization for the supersession key. Open-vocabulary prose relations are
// natural phrases ("has deadline", "deadline is", "deadline"), so two claims that CONTRADICT can
// key differently and never be compared. We fold morphology (lowercase, strip punctuation except
// hyphen, drop function words, sort tokens so order doesn't matter) so paraphrases coalesce.
// IMPORTANT: this is a NO-OP on the structured relation vocabulary — 'under-decision'/'stream-status'
// are single hyphenated tokens with no stopwords, so their key is byte-identical. Only multi-word
// PROSE relations fold, and a prose-driven supersession is proposal-only anyway (verdictBy 'model',
// un-applied before persist) — so richer coalescing improves DETECTION/surfacing without ever
// changing what durably retires. See runVerdicts.
const REL_STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'of', 'to', 'on', 'in', 'for', 'by', 'with', 'as', 'at', 'its', 'that', 'this'])
export function canonicalRelation(relation: string): string {
  const raw = relation.trim().toLowerCase()
  const toks = raw
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ') // strip punctuation, keep intra-word hyphens
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !REL_STOP.has(t))
    .sort()
  return toks.length ? toks.join(' ') : raw // never collapse to empty (all-stopword relation)
}

/** Composite supersession key: same key + different object ⇒ the newer supersedes the older.
 *  Relation is canonicalized so paraphrased prose relations coalesce (no-op on structured vocab). */
export function supersedeKey(subject: string, relation: string): string {
  return `${subject.trim().toLowerCase()}|${canonicalRelation(relation)}`
}

/**
 * Point-in-time ("as-of T") bitemporal query — the temporal-graph read the stored validFrom/validTo
 * interval exists to serve. Returns the claims whose VALID interval contains instant `t`
 * (validFrom ≤ t < validTo, with a null validTo meaning still-active). This is how a caller asks
 * "what was true about the world at time T", distinct from the freshness scalar used for live recall
 * — a born-retired temporal (past validUntil) is correctly excluded once t passes its validTo, and a
 * future-dated fact (validFrom > t) is excluded until it takes effect. Pure; no I/O.
 */
export function claimsAsOf(claims: Claim[], t: number): Claim[] {
  return claims.filter((c) => c.validFrom <= t && (c.validTo === null || t < c.validTo))
}

/** The subject key for supersession — the resolved canonical ENTITY when semantic resolution ran
 *  (claim-entities.ts stamped entityKey), else the raw subject (exact-string fallback). */
export function entityKeyOf(c: Claim): string {
  return c.entityKey && c.entityKey.trim() ? c.entityKey : c.subject
}

function isActive(c: Claim): boolean {
  return c.validTo === null
}

/**
 * A claim a human has ruled on (confirm/revert) is PINNED: the deterministic verdict pass must
 * never auto-retire it, and a rebuild must never reset its state (see mergeLedger). This is the
 * load-bearing guard for the moat-reversibility guarantee — without it every human reversal is
 * silently undone on the next tick.
 */
export function isPinned(c: Claim): boolean {
  return c.reviewState === 'confirmed' || c.reviewState === 'reverted'
}

/**
 * Freshness for the retrieval score — VERDICT-driven + use-refreshed, NOT raw age.
 * The v1 simulation proved blind age-decay buries CURRENT content along with stale; here a
 * retired claim collapses to HARD_PENALTY, an evergreen claim never decays, and a current
 * mutable claim gets a weak age prior floored at FRESH_FLOOR whose clock resets on useful use.
 */
export function freshness(c: Claim, now: number): number {
  if (!isActive(c)) return HARD_PENALTY // superseded / stale / orphaned
  if (c.mutability === 'evergreen') return 1.0
  const hl = halfLifeFor(c.relation)
  if (!isFinite(hl)) return 1.0
  const age = now - (c.lastUsefulAt ?? c.observedAt)
  const decayed = Math.pow(0.5, Math.max(0, age) / hl)
  return Math.max(FRESH_FLOOR, decayed)
}

/** The retrieval score change: similarity × freshness × reinforcement. Reinforcement floored so
 *  a mistakenly-buried claim can recover. (SHADOW in Phase 1 — computed, not yet wired live.) */
export function retrievalScore(similarity: number, c: Claim, now: number, affinity = 1, floorAffinity = 0.2): number {
  return similarity * freshness(c, now) * Math.max(floorAffinity, affinity)
}

/** Retire a claim (reversible): set validTo + verdict. Never deletes the row. `validAt` is the
 *  VALID-TIME end (when the fact stopped being true) — defaults to `now` (transaction time), but a
 *  supersession passes the winner's validFrom so point-in-time (as-of) reads are accurate. */
function retire(c: Claim, now: number, verdict: Verdict, by: Claim['verdictBy'], supersededBy: string | null = null, validAt: number = now): void {
  c.validTo = validAt
  c.verdict = verdict
  c.verdictBy = by
  if (supersededBy) c.supersededBy = supersededBy
}

/** Reverse a verdict (un-retire) — e.g. a supersession is itself retracted, or a decision reopens.
 *  Marks the claim `reviewState='reverted'` so the deterministic pass can't re-retire it next tick. */
export function unretire(c: Claim): void {
  c.validTo = null
  c.supersededBy = null
  c.verdict = 'current'
  c.verdictBy = null
  c.modelRetired = undefined // a reversed model retirement frees the entity's cumulative budget (DEFECT 3)
  c.reviewState = 'reverted'
}

/** Mark a claim as usefully accessed — resets the age-decay clock (spaced repetition). */
export function markUseful(c: Claim, now: number): void {
  c.lastUsefulAt = now
}

/**
 * The full deterministic verdict pass. Mutates claims in place (retire-not-delete) and returns
 * the corrections to SURFACE (not silently penalize). Order: supersession → world-state temporal
 * → JTMS orphaning, so an orphan can cascade from a just-superseded justification.
 */
export function runVerdicts(claims: Claim[], world: WorldState, now: number): { claims: Claim[]; corrections: Correction[] } {
  const corrections: Correction[] = []

  // 1. Supersession — within each (subject,relation) key, the newest-observed active object wins;
  //    older active claims with a DIFFERENT object are retired as contradicted.
  const byKey = new Map<string, Claim[]>()
  for (const c of claims) {
    if (!isActive(c)) continue
    // Key on the RESOLVED entity (claim-entities.ts) so alias/paraphrase subjects coalesce.
    const k = supersedeKey(entityKeyOf(c), c.relation)
    ;(byKey.get(k) ?? byKey.set(k, []).get(k)!).push(c)
  }
  // DEFECT 4: a relation a single note has shown to hold several objects at once is MULTI-VALUED,
  // and its members coexist — none supersedes another. Computed over ALL claims (see
  // inferMultiValuedKeys) so applying a verdict can't erase the evidence that justified it.
  const multiValued = relationCardinalityEnabled() ? inferMultiValuedKeys(claims) : new Set<string>()
  for (const [key, group] of byKey) {
    if (group.length < 2) continue
    if (multiValued.has(key)) continue // co-asserted objects: all true at once, nothing to retire
    const winner = group.reduce((a, b) => (b.observedAt > a.observedAt ? b : a))
    for (const c of group) {
      if (c === winner) continue
      if (isPinned(c)) continue // human-ruled: never auto-supersede a pinned claim
      if (c.object.trim().toLowerCase() === winner.object.trim().toLowerCase()) continue // same value = reinforce, not supersede
      // Only an EXACT same-subject structured supersession retires DURABLY. A supersession from a
      // prose winner OR across DIFFERENT raw subjects that merely EMBED-CLUSTERED into one entity
      // (entity resolution) is a PROPOSAL (verdictBy 'model', un-applied before persist) — so an
      // embedding over-merge (e.g. two distinct decisions that cosine-cluster) can never durably
      // bury a real claim; it's surfaced for review instead. Entity coalescing still powers recall +
      // proposal surfacing; it just can't author a persisted retirement across aliases.
      const sameSubject = c.subject.trim().toLowerCase() === winner.subject.trim().toLowerCase()
      const by: Claim['verdictBy'] = winner.source === 'prose' || !sameSubject ? 'model' : 'supersession'
      // A MODEL supersession carries a CONFIDENCE the apply-guard gates on. Two independent risks are
      // multiplied (min): (1) PROSE provenance — a possibly-hallucinated triple can't be fully
      // trusted, so a prose winner is capped at PROSE_SUPERSEDE_CONF; (2) ENTITY-COALESCING — a
      // cross-alias pairing is only as good as the WEAKER of the two subjects' cluster membership, so
      // an over-merged/ambiguous cluster (low entityKeyConfidence) yields a low score and is blocked.
      // Same-subject structured winners never reach here (by==='supersession', already durable).
      if (by === 'model') {
        const entityConf = sameSubject ? 1 : Math.min(winner.entityKeyConfidence ?? 0, c.entityKeyConfidence ?? 0)
        const proseConf = winner.source === 'prose' ? PROSE_SUPERSEDE_CONF : 1
        c.supersedeConfidence = Math.min(entityConf, proseConf)
      }
      // Valid-time end = when the winning fact took effect (winner.validFrom), when that's a sane
      // interval end (after the loser began, not after now); else fall back to now. This makes an
      // as-of query return the OLD fact for instants before the new one became true (Graphiti-style).
      const vtEnd = winner.validFrom > c.validFrom && winner.validFrom <= now ? winner.validFrom : now
      retire(c, now, 'contradicted', by, winner.id, vtEnd)
      corrections.push({ claimId: c.id, verdict: 'contradicted', reason: `superseded by newer value "${winner.object}"`, supersededBy: winner.id })
    }
  }

  // 2. World-state temporal — an active MUTABLE claim referencing a past anchor / resolved decision
  //    / passed stream is stale. (Operator-authored evergreen claims are exempt by construction.)
  for (const c of claims) {
    if (!isActive(c) || c.mutability !== 'mutable') continue
    if (isPinned(c)) continue // human-ruled: never auto-stale a pinned claim
    const refs = [c.subject, c.object, ...c.justifications]
    const hitAnchor = refs.some((r) => world.pastAnchors.has(r))
    const hitDecision = refs.some((r) => world.resolvedDecisions.has(r))
    const hitStream = refs.some((r) => world.passedStreams.has(r))
    if (hitAnchor || hitDecision || hitStream) {
      const why = hitDecision ? 'a resolved decision' : hitAnchor ? 'a past anchor' : 'a passed stream'
      retire(c, now, 'stale', 'temporal')
      corrections.push({ claimId: c.id, verdict: 'stale', reason: `references ${why}` })
    }
  }

  // 3. JTMS orphaning — an active claim justified BY a now-retired claim is orphaned (propagates).
  // Seed from DETERMINISTICALLY-retired claims only: a claim retired by a PROSE supersession is a
  // proposal (verdictBy 'model', un-applied before persist), so it must NOT cascade a durable
  // 'jtms' orphan onto a real claim (jtms IS deterministic and would persist otherwise).
  const retired = new Set(claims.filter((c) => !isActive(c) && c.verdictBy !== 'model').map((c) => c.id))
  let changed = true
  while (changed) {
    changed = false
    for (const c of claims) {
      if (!isActive(c) || c.justifications.length === 0) continue
      if (isPinned(c)) continue // human-ruled: never auto-orphan a pinned claim
      if (c.justifications.some((j) => retired.has(j))) {
        retire(c, now, 'orphaned', 'jtms')
        retired.add(c.id)
        corrections.push({ claimId: c.id, verdict: 'orphaned', reason: 'a claim it was justified by was retired' })
        changed = true
      }
    }
  }

  return { claims, corrections }
}

/** Revert a MODEL-proposed supersession that the guard refused: back to an active, un-judged claim
 *  (identical to metabolize's proposal-only un-apply). Knowledge is preserved, nothing persists. */
function revertModelSupersession(c: Claim): void {
  c.validTo = null
  c.verdict = 'current'
  c.verdictBy = null
  c.supersededBy = null
  c.supersedeConfidence = undefined
  c.modelRetired = undefined
}

/** Normalized subject equality — same rule runVerdicts uses to decide sameSubject vs cross-alias. */
function sameSubjectAs(a: Claim, b: Claim): boolean {
  return a.subject.trim().toLowerCase() === b.subject.trim().toLowerCase()
}

/**
 * P7: decide which MODEL-proposed supersessions (verdictBy 'model' from runVerdicts — prose winners
 * and cross-alias entity coalescings) are safe to APPLY, and un-apply the rest. Runs AFTER runVerdicts
 * (so it never influences the in-pass JTMS seed, which stays deterministic-only). Mutates in place.
 *
 * This is the phase that can lose data, so every applied retirement clears independent guards and
 * stays REVERSIBLE (retire-not-delete: only validTo/verdict/modelRetired are set; unretire + human
 * pins undo it). Each proposal's WINNER is looked up via supersededBy so the guard can re-derive
 * sameSubject and the winner's provenance itself. Guards, in order:
 *  1. FLAG — `enabled=false` (DUIN_CLAIM_SUPERSESSION=0) reverts ALL model supersessions (the prior
 *     proposal-only behavior, byte-for-byte). Instant conservative kill-switch.
 *  2. PIN — a human-ruled claim (reviewState set) is NEVER touched. (runVerdicts already skips pins,
 *     so a pinned claim is never a model loser here; this is belt-and-suspenders.)
 *  3. CROSS-ALIAS STRUCTURED↔STRUCTURED — the riskiest apply (two DISTINCT real entities that merely
 *     collided in a block). A cross-alias (different subject, same entityKey) supersession whose
 *     WINNER is `source:'structured'` is NEVER applied durably — it stays a PROPOSAL surfaced in
 *     `corrections` (reverted here, so nothing retires). Durable cross-alias apply is allowed ONLY
 *     when the winner is `source:'prose'` (already confidence-bounded) OR it's an EXACT-same-subject
 *     match (not a block merge). This closes the main false-loss vector (DEFECT 2).
 *  4. CONFIDENCE — the ENTITY-MEMBERSHIP confidence must be ≥ minConfidence (> ENTITY_CLUSTER_THRESHOLD
 *     by invariant). Same-subject scores 1 (no cross-alias risk) and always clears it; a cross-alias
 *     pairing scores the weaker of the two subjects' cluster membership, so a bare-threshold or
 *     ambiguous merge is BLOCKED (DEFECT 1). We gate on entity membership, NOT the prose-capped
 *     supersedeConfidence, so a legitimately-applying prose supersession (ceiling 0.9) is not spuriously
 *     blocked by the raised bar — prose safety is handled by guard 3's provenance branch instead.
 *  5. CUMULATIVE OVER-RETIREMENT TRIPWIRE — per resolved entity, count claims ALREADY retired by an
 *     applied model supersession (modelRetired, carried across ticks) in BOTH numerator and
 *     denominator: if (prior-model-retired + would-retire) / (active + prior-model-retired +
 *     would-retire) > `maxRetireFraction` AND the entity has ≥ `fractionFloor` claims counted, ALL of
 *     that entity's model retirements this pass are reverted. This bounds an entity's model-retirement
 *     budget ACROSS ticks, so a slow 1-of-2-per-tick gutting (which never trips a per-pass cap) is
 *     caught (DEFECT 3). Deterministic structured supersessions (modelRetired unset) are NOT counted.
 *
 * KEPT retirements are re-tagged verdictBy 'supersession' AND flagged modelRetired — they are now
 * first-class durable supersessions (they show in the verdict-diversity metric and carry forward via
 * mergeLedger), and the modelRetired flag lets a later tick's cumulative tripwire count them.
 */
export function applySupersessionGuards(
  claims: Claim[],
  guards: SupersessionGuards = DEFAULT_SUPERSESSION_GUARDS,
  enabled = true
): {
  applied: number
  blockedConfidence: number
  blockedCrossAliasStructured: number
  blockedTripwire: number
  /** W5: per-proposal outcome, keyed by the retired claim's id. */
  outcomes: Map<string, SupersessionOutcome>
} {
  const outcomes = new Map<string, SupersessionOutcome>()
  const proposals = claims.filter((c) => !isActive(c) && c.verdictBy === 'model' && c.verdict === 'contradicted')
  if (proposals.length === 0) return { applied: 0, blockedConfidence: 0, blockedCrossAliasStructured: 0, blockedTripwire: 0, outcomes }

  if (!enabled) {
    for (const c of proposals) {
      revertModelSupersession(c)
      outcomes.set(c.id, 'disabled')
    }
    return { applied: 0, blockedConfidence: proposals.length, blockedCrossAliasStructured: 0, blockedTripwire: 0, outcomes }
  }

  const byId = new Map(claims.map((c) => [c.id, c]))

  // Guards 2–4: drop pinned, cross-alias-structured, and sub-confidence proposals up front.
  let blockedConfidence = 0
  let blockedCrossAliasStructured = 0
  const passedConf: Claim[] = []
  for (const c of proposals) {
    if (isPinned(c)) {
      revertModelSupersession(c) // never auto-retire a human-ruled claim
      outcomes.set(c.id, 'pinned')
      continue
    }
    const winner = c.supersededBy ? byId.get(c.supersededBy) : undefined
    // Can't verify the winner ⇒ can't validate provenance/membership ⇒ refuse (conservative).
    if (!winner) {
      revertModelSupersession(c)
      blockedConfidence++
      outcomes.set(c.id, 'missing-winner')
      continue
    }
    const sameSubject = sameSubjectAs(c, winner)
    // Guard 3 (DEFECT 2): a cross-alias durable retirement is allowed only when the winner is prose;
    // a structured↔structured cross-alias (block collision of two distinct real entities) stays a
    // proposal-only correction, never retires. Same-subject is unaffected (not a cross-alias merge).
    if (!sameSubject && winner.source !== 'prose') {
      revertModelSupersession(c)
      blockedCrossAliasStructured++
      outcomes.set(c.id, 'cross-alias')
      continue
    }
    // Guard 4 (DEFECT 1): entity-membership confidence must clear the cross-alias bar. Same-subject ⇒
    // 1 (no coalescing risk); cross-alias ⇒ the weaker of the two subjects' cluster membership.
    const entityConf = sameSubject ? 1 : Math.min(winner.entityKeyConfidence ?? 0, c.entityKeyConfidence ?? 0)
    if (entityConf < guards.minConfidence) {
      revertModelSupersession(c)
      blockedConfidence++
      outcomes.set(c.id, 'confidence')
      continue
    }
    passedConf.push(c)
  }

  // Guard 5 (DEFECT 3): CUMULATIVE per-entity over-retirement tripwire. Numerator + denominator both
  // count prior APPLIED model retirements (modelRetired) so the bound spans ticks. active = still-in-
  // play claims; priorModelRetired = already-model-retired (carried on the ledger); wouldRetire = this
  // pass's approved proposals. Deterministic structured/temporal/jtms retirements are NOT counted
  // (modelRetired unset) — only model retirements are budgeted.
  const wouldRetire = new Map<string, number>()
  const activeInPlay = new Map<string, number>()
  const priorModelRetired = new Map<string, number>()
  for (const c of passedConf) wouldRetire.set(entityKeyOf(c), (wouldRetire.get(entityKeyOf(c)) ?? 0) + 1)
  for (const c of claims) {
    if (isActive(c)) activeInPlay.set(entityKeyOf(c), (activeInPlay.get(entityKeyOf(c)) ?? 0) + 1)
    else if (c.modelRetired) priorModelRetired.set(entityKeyOf(c), (priorModelRetired.get(entityKeyOf(c)) ?? 0) + 1)
  }

  const trippedEntities = new Set<string>()
  for (const [entity, retireN] of wouldRetire) {
    const prior = priorModelRetired.get(entity) ?? 0
    const counted = (activeInPlay.get(entity) ?? 0) + prior + retireN // active + already-model-retired + would-retire
    const cumulativeRetire = prior + retireN // ALL model retirements (across ticks) once this pass applies
    if (counted >= guards.fractionFloor && cumulativeRetire / counted > guards.maxRetireFraction) trippedEntities.add(entity)
  }

  let applied = 0
  let blockedTripwire = 0
  for (const c of passedConf) {
    if (trippedEntities.has(entityKeyOf(c))) {
      revertModelSupersession(c)
      blockedTripwire++
      outcomes.set(c.id, 'tripwire')
      continue
    }
    c.verdictBy = 'supersession' // guard-approved → first-class durable supersession
    c.supersedeConfidence = undefined
    c.modelRetired = true // count toward this entity's CUMULATIVE model-retirement budget on later ticks
    outcomes.set(c.id, 'applied')
    applied++
  }
  return { applied, blockedConfidence, blockedCrossAliasStructured, blockedTripwire, outcomes }
}
