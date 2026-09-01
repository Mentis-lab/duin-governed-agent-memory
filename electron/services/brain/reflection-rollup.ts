// reflection-rollup — the SECOND-LEVEL ascent (Generative Agents reflection tree).
// consolidation-synthesis folds raw CAPTURES → one candidate rule (level 1). This folds
// several PROMOTED (confirmed) rules → one HIGHER-ORDER reflection: a principle that
// unifies rules the operator has already earned, re-entered as a fresh CANDIDATE so it
// must survive the SAME human/govern gate — reflection PROPOSES, never self-promotes.
//
// Guard against meta-noise: it rolls up only when several promoted rules exist (a higher
// minBatch than level 1), watermarks what it has already reflected on, and the model must
// reply "NONE" when the rules share no higher principle — a weak or forced meta-rule is
// worse than none. The selection + prompt are PURE (unit-tested); the model call is
// injected (key-gated, keyless-safe), exactly like consolidation-synthesis.

export interface PromotedRule {
  id: string
  text: string
  ts: number
}

export interface ReflectDeps {
  /** Fold several confirmed rules into ONE higher-order principle. null ⇒ no engine /
   *  declined / "NONE". */
  reflect(prompt: string): Promise<string | null>
  /** Optional INDEPENDENT NLI verifier for the derivation edge — do the confirmed rules jointly entail
   *  the higher-order principle? Absent/null ⇒ the DEPENDS_ON edge is recorded UNVERIFIED (keyless-safe). */
  verify?(premises: string[], hypothesis: string): Promise<VerifyVerdict | null>
}

export interface ReflectPolicy {
  /** Minimum promoted rules in the window to bother reflecting (higher than level 1 —
   *  a meta-rule needs several confirmed rules under it). */
  minBatch: number
  /** Cap the fold to the most recent N (a reflection can't be unbounded). */
  maxBatch: number
  /** Minimum confirmed rules in ONE thematic cluster to fold into a principle — a lone rule (or two
   *  unrelated ones) shares no higher principle worth abstracting. Mirrors consolidation's minCluster. */
  minCluster: number
}
export const DEFAULT_REFLECT_POLICY: ReflectPolicy = { minBatch: 4, maxBatch: 15, minCluster: 2 }

/** The promoted rules eligible to roll up: newer than the watermark, capped to the most
 *  recent maxBatch, oldest→newest. Returns [] below minBatch. PURE. */
export function rollupInsights(
  promoted: PromotedRule[],
  sinceTs: number,
  policy: ReflectPolicy = DEFAULT_REFLECT_POLICY
): PromotedRule[] {
  const fresh = promoted.filter((r) => r.ts > sinceTs && r.text.trim()).sort((a, b) => a.ts - b.ts)
  if (fresh.length < policy.minBatch) return []
  return fresh.slice(-policy.maxBatch)
}

/** Build the reflection prompt from a batch of confirmed rules. PURE. */
export function reflectionPrompt(texts: string[]): string {
  return (
    'These are rules the operator has ALREADY confirmed. Identify ONE higher-order ' +
    'PRINCIPLE that unifies several of them — a more general judgment they are each an ' +
    'instance of. One sentence, no preamble. If they share no genuine higher principle, ' +
    'reply exactly "NONE" (a forced abstraction is worse than none).\n\n' +
    texts.map((t, i) => `${i + 1}. ${t}`).join('\n')
  )
}

export interface ReflectResult {
  /** One higher-order reflection per THEMATIC cluster of confirmed rules that yielded a real (non-NONE)
   *  principle, EACH carrying its reasoning-trace provenance — the confirmed-rule ids it was folded from
   *  (`from`) + the independent NLI verdict (`verify`). Empty if none qualified. (Was `string[]` — the
   *  return dropped the cluster→id mapping the fold knows.) */
  reflections: DerivedFold[]
  consumed: number
  /** New watermark (ts of the newest rolled rule; unchanged if nothing folded). */
  watermark: number
}

/** Run one reflection pass over the promoted rules newer than `sinceTs`. The fresh batch is grouped
 *  into THEMATIC clusters (clusterByCohesion, the same level-1 machinery); each cluster of ≥ minCluster
 *  is folded into its OWN higher-order principle, so a window spanning several topics yields several
 *  coherent reflections instead of one topic-mixed fold the model rejects as "NONE". Best-effort per
 *  cluster (a declined/NONE/throwing cluster is skipped). Does NOT write — the caller records +
 *  advances the watermark (kept pure/testable). */
export async function runReflection(
  promoted: PromotedRule[],
  sinceTs: number,
  deps: ReflectDeps,
  policy: ReflectPolicy = DEFAULT_REFLECT_POLICY
): Promise<ReflectResult> {
  const batch = rollupInsights(promoted, sinceTs, policy)
  if (batch.length === 0) return { reflections: [], consumed: 0, watermark: sinceTs }
  const newWatermark = batch[batch.length - 1].ts
  const clusters = clusterByCohesion(batch).filter((cl) => cl.length >= policy.minCluster)
  const reflections: DerivedFold[] = []
  for (const cl of clusters) {
    try {
      const raw = await deps.reflect(reflectionPrompt(cl.map((r) => r.text)))
      const cleaned = (raw ?? '').trim()
      if (cleaned && !/^none\b/i.test(cleaned)) {
        // Independently verify the derivation (do these confirmed rules entail the principle?) — the
        // fold model's own "why" is testimony, not proof.
        const verify = deps.verify ? await deps.verify(cl.map((r) => r.text), cleaned) : null
        reflections.push({ rule: cleaned, from: cl.map((r) => r.id), verify })
      }
    } catch {
      // skip this cluster; the others still reflect
    }
  }
  return { reflections, consumed: batch.length, watermark: newWatermark }
}

// ── live pass (mirrors consolidation-synthesis) ──
import { chatOnce, routeModel } from '../providers/registry'
import { firewallClear } from '../governance/confidential-firewall'
import { getOperatorFacts, recordDerivedFact } from './operator-model'
import { clusterByCohesion } from './consolidation-synthesis'
import { defaultVerifyDeps, type VerifyVerdict, type DerivedFold } from './derivation-verify'
import { messageOf } from '../guarded'

/** The live, key-gated reflector. */
export const defaultReflectDeps: ReflectDeps = {
  async reflect(prompt) {
    let m: string | null
    try {
      m = routeModel('extraction')
    } catch {
      return null
    }
    if (!m) return null
    try {
      const r = await chatOnce(
        [
          { role: 'system', content: 'You fold an operator\'s confirmed rules into ONE higher-order principle.' },
          { role: 'user', content: prompt }
        ],
        m,
        undefined,
        { purpose: 'other', role: 'reflection-rollup' }
      )
      return r.content
    } catch {
      return null
    }
  },
  // Independent NLI verifier for the derivation edge (key-gated; abstains → unverified edge).
  verify: (premises, hypothesis) => defaultVerifyDeps.verify(premises, hypothesis)
}

// Per-process watermark — the ts of the last rolled-up promoted rule. A restart resets it,
// but recordFacts dedups by normalized text so a re-roll can't create a duplicate reflection.
let reflectWatermark = 0

/** Live pass: fold PROMOTED rules newer than the watermark into one higher-order
 *  reflection CANDIDATE (human/govern still gates promotion). Best-effort, keyless-safe. */
export async function runReflectionRollup(
  deps: ReflectDeps = defaultReflectDeps
): Promise<{ reflected: boolean; consumed: number }> {
  let promoted: PromotedRule[]
  try {
    // BITEMPORAL liveness: read through getOperatorFacts() (= `!isInvalidated`) rather than
    // listByStatus(), which keys on STATUS ALONE. Every semantic retirement in operator-model
    // (supersedeFact, cascadeInvalidateDerived) soft-deletes — it stamps `invalidatedAt` and
    // deliberately LEAVES `status: 'promoted'` so the audit can still walk why a rule fell — so a
    // rule the operator has already corrected away stays in listByStatus('promoted') FOREVER, and
    // every reader must apply the liveness predicate itself (as buildOperatorBlock's `active`,
    // verifyPool and the level-1 twin in consolidation-synthesis all do).
    //
    // Reading by status alone let a DEAD instruction back into grounding, laundered: the retired
    // rule clustered with its live siblings, the model folded it into a higher-order principle, and
    // recordDerivedFact re-entered that principle as a fresh candidate (reliability 0.5, above
    // TRUST_FLOOR) which autoPromoteCandidates then lifts to provisional. Stage 2 cannot catch it —
    // cascadeInvalidateDerived only runs on the retraction path, and this derived fact did not exist
    // yet at that moment. It also inflated the batch toward minBatch, so a store with too few LIVE
    // promoted rules could trigger a rollup at all.
    //
    // What made it invisible: retirement never touches the field this reader consulted, and the row
    // disappears from every operator-visible surface (grounding, the review queue) the instant it is
    // retired — so from anywhere a human can look, the rule was already gone.
    //
    // CONFIDENTIAL-LANE FIREWALL. 'promoted' is not a confidentiality guarantee: operator-govern's
    // keyless survival path (juryPass === null when firewallClear rejects a fact, operator-govern.ts's
    // governDecision) confirms a confidential fact straight to 'promoted' once it has merely SURVIVED
    // minSessionsKeyless sessions — the firewall there only keeps it off the external JURY call, it
    // never blocks the promotion itself. This pass then hands the promoted pool to TWO external hops
    // below (deps.reflect's prompt, deps.verify's premises — both routeModel('extraction') calls in
    // defaultReflectDeps) with no gate of its own, unlike the structurally identical level-1 pool in
    // consolidation-synthesis.ts, which already filters through firewallClear before its own fold.
    // Withhold-only, like that sibling: a denylisted fact just sits out this pass (nothing is deleted
    // or invalidated), so it folds normally once the operator clears the term from the denylist.
    promoted = getOperatorFacts()
      .filter((f) => f.status === 'promoted' && firewallClear(f.fact))
      .map((f) => ({ id: f.id, text: f.fact, ts: f.ts }))
  } catch {
    return { reflected: false, consumed: 0 }
  }
  const r = await runReflection(promoted, reflectWatermark, deps)
  if (r.consumed > 0) reflectWatermark = r.watermark
  if (r.reflections.length > 0) {
    try {
      // Each cluster's principle is its own candidate, recorded WITH its reasoning-trace provenance —
      // the confirmed-rule ids it was folded from + the independent NLI verdict (recordDerivedFact dedups
      // by normalized text, so a re-roll attaches the edge instead of duplicating).
      for (const s of r.reflections) recordDerivedFact(s.rule, 'reflection', s.from, s.verify)
    } catch (e) { console.debug('[reflection-rollup] best-effort:', messageOf(e)) }
    return { reflected: true, consumed: r.consumed }
  }
  return { reflected: false, consumed: r.consumed }
}

export function __resetReflectWatermark(): void {
  reflectWatermark = 0
}
