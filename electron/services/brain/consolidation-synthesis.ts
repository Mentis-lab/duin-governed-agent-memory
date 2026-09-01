// consolidation-synthesis — the episodic→semantic ASCENT the consolidation trigger
// deferred. The trigger fires at a coherent topic-close and already dedups/prunes/GCs; this
// adds the missing step: fold the topic's raw captures into ONE durable, higher-order
// summary fact (the declarative node), so the store rises from "many specific captures" to
// "one reusable rule" instead of only accumulating specifics.
//
// A time watermark tracks what has already been synthesized, so each qualifying close only
// folds the NEW captures since the last synthesis. The selection + prompt are PURE
// (unit-tested); the model call is injected (key-gated, keyless-safe). The summary lands as
// a fresh CANDIDATE (human/govern still gates promotion) — synthesis proposes, never
// promotes.

export interface SynthCandidate {
  id: string
  text: string
  ts: number
}

export interface SynthDeps {
  /** Fold several captures into one durable summary rule. null ⇒ no engine / declined. */
  synthesize(prompt: string): Promise<string | null>
  /** Optional on-device embedder for SEMANTIC clustering (batch: texts → vectors). Absent/null/throwing
   *  ⇒ fail-open to the lexical clusterByCohesion. */
  embed?(texts: string[]): Promise<number[][] | null>
  /** Optional INDEPENDENT NLI verifier for the derivation edge — do the cluster's input claims jointly
   *  entail the folded rule? Absent/null ⇒ the DEPENDS_ON edge is recorded UNVERIFIED (keyless-safe). */
  verify?(premises: string[], hypothesis: string): Promise<VerifyVerdict | null>
}

export interface SynthPolicy {
  /** Minimum new captures in the window to bother synthesizing. */
  minBatch: number
  /** Above this, cap the fold to the most recent N (a topic can't be unbounded). */
  maxBatch: number
  /** Minimum captures in ONE thematic cluster to synthesize it into a rule — a lone capture
   *  (or two unrelated ones) isn't a pattern worth abstracting. */
  minCluster: number
}
export const DEFAULT_SYNTH_POLICY: SynthPolicy = { minBatch: 3, maxBatch: 12, minCluster: 2 }

// Significant-token stopwords (EN function words + the imperative shells teaching phrases share:
// "always/never/when/…"), stripped so cohesion keys on the TOPIC nouns, not the teaching frame.
const SYNTH_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'it',
  'that', 'this', 'my', 'your', 'you', 'we', 'they', 'when', 'if', 'always', 'never', 'prefer',
  'should', 'must', 'dont', "don't", 'do', 'not', 'from', 'into', 'over', 'about'
])

/** Significant tokens of a capture: lowercased words > 3 chars (or any CJK run), minus stopwords.
 *  The cohesion key — two captures are "about the same thing" when these overlap. PURE. */
// The split class is widened past the historical kanji-only range to the shared CJK class, so
// Japanese kana survives as a token instead of being treated as punctuation and dropped.
const SYNTH_SPLIT_RE = new RegExp(`[^a-z0-9${CJK_CLASS}]+`)
export function synthTokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().split(SYNTH_SPLIT_RE)) {
    if (!raw) continue
    const isCjk = hasCjk(raw)
    if ((isCjk || raw.length > 3) && !SYNTH_STOP.has(raw)) out.add(raw)
  }
  return out
}

/** Greedily group captures into THEMATIC clusters: each capture joins the first existing cluster it
 *  shares ≥2 significant tokens with (against the cluster's accumulated vocabulary), else seeds a new
 *  one. Order-stable (input order preserved within + across clusters). This is the frontier move the
 *  recency-only fold missed — synthesize memories that are actually ABOUT THE SAME THING, instead of
 *  folding a topic-mixed batch the model rejects as "NONE" (burning the whole window). PURE. */
export function clusterByCohesion(captures: SynthCandidate[], minOverlap = 2): SynthCandidate[][] {
  const clusters: { toks: Set<string>; items: SynthCandidate[] }[] = []
  for (const c of captures) {
    const toks = synthTokens(c.text)
    let shared = 0
    const hit = clusters.find((cl) => {
      shared = 0
      for (const t of toks) if (cl.toks.has(t) && ++shared >= minOverlap) return true
      return false
    })
    if (hit) {
      hit.items.push(c)
      for (const t of toks) hit.toks.add(t)
    } else {
      clusters.push({ toks: new Set(toks), items: [c] })
    }
  }
  return clusters.map((cl) => cl.items)
}

/** SEMANTIC cohesion clustering (frontier: synthesize memories that MEAN the same thing, not just
 *  share literal tokens — the lexical clusterByCohesion misses a paraphrase worded differently). Embeds
 *  the batch once, then greedily assigns each capture to the first cluster whose CENTROID cosine ≥
 *  threshold, else seeds a new one (order-stable, like the lexical clusterer). FAIL-OPEN: returns null
 *  if the embedder is absent/throws or returns a shape that doesn't match the batch — the caller then
 *  falls back to clusterByCohesion, so a cold embedder is byte-identical to the lexical path. */
export async function clusterBySemantic(
  captures: SynthCandidate[],
  embed: (texts: string[]) => Promise<number[][] | null>,
  threshold = 0.6
): Promise<SynthCandidate[][] | null> {
  let vecs: number[][] | null
  try {
    vecs = await embed(captures.map((c) => c.text))
  } catch {
    return null
  }
  if (!vecs || vecs.length !== captures.length || vecs.some((v) => !Array.isArray(v) || v.length === 0)) return null
  const clusters: { centroid: number[]; sum: number[]; items: SynthCandidate[] }[] = []
  for (let i = 0; i < captures.length; i++) {
    const v = vecs[i]
    const hit = clusters.find((cl) => cosine(cl.centroid, v) >= threshold)
    if (hit) {
      hit.items.push(captures[i])
      for (let d = 0; d < v.length && d < hit.sum.length; d++) hit.sum[d] += v[d]
      hit.centroid = hit.sum.map((s) => s / hit.items.length)
    } else {
      clusters.push({ centroid: v.slice(), sum: v.slice(), items: [captures[i]] })
    }
  }
  return clusters.map((cl) => cl.items)
}

/** The captures eligible to fold: newer than the watermark, capped to the most recent
 *  maxBatch, oldest→newest. PURE. */
export function selectForSynthesis(
  candidates: SynthCandidate[],
  sinceTs: number,
  policy: SynthPolicy = DEFAULT_SYNTH_POLICY
): SynthCandidate[] {
  const fresh = candidates.filter((c) => c.ts > sinceTs && c.text.trim()).sort((a, b) => a.ts - b.ts)
  if (fresh.length < policy.minBatch) return []
  return fresh.slice(-policy.maxBatch)
}

/** Build the synthesis prompt from a batch of captures. PURE. */
export function synthesisPrompt(texts: string[]): string {
  // Pin the folded rule to the teachings' language, so a CN/JP operator's durable rules stay in
  // their language — an English rule folded out of Chinese captures shares no lexical tokens with
  // them and stops being retrievable from the notes it came from. '' for English → unchanged.
  const langPin = contentLanguageDirective(texts.join(' '))
  return (
    'These are several things the operator taught across one topic. Fold them into ONE ' +
    'durable, general rule that captures the shared judgment — a single sentence, no ' +
    'preamble. If they are unrelated, reply exactly "NONE".\n\n' +
    texts.map((t, i) => `${i + 1}. ${t}`).join('\n') +
    (langPin ? '\n\n' + langPin : '')
  )
}

import { chatOnce, routeModel } from '../providers/registry'
import { firewallClear } from '../governance/confidential-firewall'
import { CJK_CLASS, hasCjk } from './cjk-tokens'
import { contentLanguageDirective } from './content-language'
import { getOperatorFacts, recordFacts, recordDerivedFact, isQuarantinedExternal, type OperatorFact } from './operator-model'
import { defaultVerifyDeps, type VerifyVerdict, type DerivedFold } from './derivation-verify'
import { cosine } from './claim-entities'
import { embedForRecall } from '../local-brain/index-store'
import { messageOf } from '../guarded'

/** The live, key-gated synthesizer. */
export const defaultSynthDeps: SynthDeps = {
  async synthesize(prompt) {
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
          { role: 'system', content: "You fold an operator's scattered teachings into ONE durable rule." },
          { role: 'user', content: prompt }
        ],
        m,
        undefined,
        { purpose: 'other', role: 'consolidation-synthesis' }
      )
      return r.content
    } catch {
      return null
    }
  },
  // On-device embedder for semantic clustering; fail-open (null) so a cold embedder falls back to lexical.
  async embed(texts) {
    try {
      return await embedForRecall(texts)
    } catch {
      return null
    }
  },
  // Independent NLI verifier for the derivation edge (key-gated; abstains → unverified edge).
  verify: (premises, hypothesis) => defaultVerifyDeps.verify(premises, hypothesis)
}

// Per-process watermark — the ts of the last synthesized capture. A restart resets it, but
// recordFacts dedups by normalized text so a re-fold can't create a duplicate summary.
let synthWatermark = 0

/** The UN-FOLDED capture pool: the episodic material this ascent exists to fold.
 *
 *  NOT `status === 'candidate'`. learnFromTurn ends EVERY capturing /agui turn with
 *  autoPromoteCandidates(), which walks the whole store and flips every non-external,
 *  non-poison-suspect candidate to `provisional` / `adjudicatedBy: 'auto'`. So by the time a topic
 *  CLOSES — ConsolidationTracker overflows at maxBatch 6 turns, several turns after the teaching
 *  began — the label this filter keyed on has already been rewritten on every capture the topic
 *  taught. A status-only read saw at most the in-flight turn's rows, fell below minBatch (3), and
 *  the episodic→semantic ascent folded NOTHING, session after session: exactly the "store held ZERO
 *  dependsOn edges across every session" end-state consolidation-trigger.ts documents from the last
 *  time this loop was silently un-triggered. Defining the fold's input by a status label that a
 *  same-turn automation rewrites is the defect; reading the pool by what the row IS fixes it.
 *
 *  What made it invisible: the integration test records captures with recordFacts() and calls
 *  runConsolidationSynthesis() directly, so the promoter never runs in between and the pool the test
 *  folds is a pool production never actually has.
 *
 *  An 'auto' promotion is a MACHINE endorsement of a raw capture — not a fold, not a human ruling —
 *  so those rows are still precisely the episodic material to fold. Deliberately excluded:
 *   - rows a HUMAN adjudicated ('human') or a bind lifted (no adjudicatedBy) — not this pass's pool;
 *   - rows already carrying a dependsOn edge: they ARE folds, and second-level ascent belongs to
 *     reflection-rollup, off PROMOTED rules (a strictly higher bar than machine probation).
 *  External stays quarantined either way — autoPromoteCandidates skips 'external' outright, so no
 *  external row can reach this tier, and isQuarantinedExternal still guards the candidate tier. */
function isUnfoldedCapture(f: OperatorFact): boolean {
  if (f.status === 'candidate') return true
  return f.status === 'provisional' && f.adjudicatedBy === 'auto' && !(f.dependsOn && f.dependsOn.length > 0)
}

/** Live pass: fold the candidate captures newer than the watermark into one durable
 *  summary CANDIDATE (human/govern still gates promotion). Best-effort, keyless-safe. */
export async function runConsolidationSynthesis(deps: SynthDeps = defaultSynthDeps): Promise<{ synthesized: boolean; consumed: number }> {
  let candidates: SynthCandidate[]
  try {
    // Ingestion-trust tiering: exclude un-promoted 'external' candidates so a de-privileged-turn
    // capture can't be LAUNDERED into an operator-sourced rule (recordFacts defaults new summaries to
    // source 'operator'). Same quarantine predicate as the grounding paths.
    //
    // BITEMPORAL liveness: read through getOperatorFacts() (= `!isInvalidated`) rather than
    // listByStatus(), which keys on STATUS ALONE. That distinction is what made this invisible:
    // reflect() and supersedeFact() retire a fact by stamping `invalidatedAt` and LEAVE
    // `status === 'candidate'`, so a superseded capture stays in listByStatus('candidate') forever
    // even though it no longer grounds anywhere else (buildOperatorBlock's active(), getPendingReview
    // and getOperatorFacts all apply the missing predicate). Without it, synthesis folds retired
    // operator state back into a fresh candidate — and worse, consolidation-trigger calls reflect()
    // immediately before this pass, so the invalidated original and the richer fact that just
    // absorbed it get counted as TWO independent captures toward the minCluster threshold that
    // exists precisely to reject a lone capture.
    //
    // CONFIDENTIAL-LANE FIREWALL. This is an AUTONOMOUS background send — the topic-close tick fires
    // runConsolidation() unattended, so the operator never chose this cloud call, which is exactly what
    // confidential-firewall exists to guard. Withheld here, a denylisted capture reaches NEITHER of the
    // two external hops a fold makes: it is absent from `synthesisPrompt` (posted to routeModel(
    // 'extraction')) AND from the premise list `deps.verify` re-posts as numbered PREMISES.
    //
    // What made it invisible: the SAME pass already firewalls the IDENTICAL corpus eighteen lines
    // earlier — consolidation-trigger's `await verifyPool()` filters both halves through firewallClear
    // (operator-model's `rules`/`sendable`) — and every surface that REPORTS firewall activity redacts
    // (the govern jury's confidentialIds, judgment-measure-live, transfer-ab). So an operator watching
    // those saw the firewall working while this sink, one call later in the same tick, shipped the rows
    // verbatim. "The guard exists in this pass" and "the guard covers this sink" are different claims.
    //
    // Unlike verifyPool there is no abstain-on-total-drop counterpart to add: omission from THIS list
    // only means "not folded this pass" (nothing is deleted, and the watermark never advances past a
    // capture that was never selected), so withholding is safe in the data-preserving direction.
    candidates = getOperatorFacts()
      .filter((f) => isUnfoldedCapture(f) && !isQuarantinedExternal(f) && firewallClear(f.fact))
      .map((f) => ({ id: f.id, text: f.fact, ts: f.ts }))
  } catch {
    return { synthesized: false, consumed: 0 }
  }
  const r = await runSynthesis(candidates, synthWatermark, deps)
  if (r.consumed > 0) synthWatermark = r.watermark
  if (r.summaries.length > 0) {
    try {
      // Each cluster's rule is its own candidate, recorded WITH its reasoning-trace provenance: the
      // input-claim ids it was folded from + the independent NLI verdict (recordDerivedFact dedups by
      // normalized text like recordFacts, so a re-fold attaches the edge instead of duplicating).
      for (const s of r.summaries) recordDerivedFact(s.rule, 'context', s.from, s.verify)
    } catch (e) { console.debug('[consolidation-synthesis] best-effort:', messageOf(e)) }
    return { synthesized: true, consumed: r.consumed }
  }
  return { synthesized: false, consumed: r.consumed }
}

export function __resetSynthWatermark(): void {
  synthWatermark = 0
}

export interface SynthResult {
  /** One durable rule per THEMATIC cluster that yielded a real (non-NONE) synthesis, EACH carrying its
   *  reasoning-trace provenance — the input-claim ids it was folded from (`from`) + the independent NLI
   *  verdict (`verify`). Empty if nothing qualified. (Was `string[]` — the return dropped the cluster→id
   *  mapping the fold knows, so the derivation could never be recorded.) */
  summaries: DerivedFold[]
  /** How many captures were folded (the whole selected batch; the watermark advances past all of
   *  them so an off-topic singleton isn't retried forever). */
  consumed: number
  /** New watermark (the ts of the newest folded capture; unchanged if nothing folded). */
  watermark: number
}

/** Run one synthesis pass over the captures newer than `sinceTs`. The fresh batch is grouped into
 *  THEMATIC clusters (clusterByCohesion); each cluster of ≥ minCluster is folded into its OWN durable
 *  rule, so a window spanning several topics yields several coherent rules instead of one topic-mixed
 *  fold the model rejects as "NONE". Best-effort per cluster (a declined/NONE/throwing cluster is
 *  skipped). Does NOT write — the caller records the summaries + advances the watermark. PURE-shaped
 *  (deps.synthesize injected), so unit-tested without a key. */
export async function runSynthesis(
  candidates: SynthCandidate[],
  sinceTs: number,
  deps: SynthDeps,
  policy: SynthPolicy = DEFAULT_SYNTH_POLICY
): Promise<SynthResult> {
  const batch = selectForSynthesis(candidates, sinceTs, policy)
  if (batch.length === 0) return { summaries: [], consumed: 0, watermark: sinceTs }
  const newWatermark = batch[batch.length - 1].ts
  // SEMANTIC clustering when an embedder is available (folds paraphrases the lexical clusterer misses);
  // fail-open to the lexical clusterByCohesion when the embedder is absent/cold (byte-identical to before).
  const semantic = deps.embed ? await clusterBySemantic(batch, deps.embed) : null
  const clusters = (semantic ?? clusterByCohesion(batch)).filter((cl) => cl.length >= policy.minCluster)
  const summaries: DerivedFold[] = []
  for (const cl of clusters) {
    try {
      const raw = await deps.synthesize(synthesisPrompt(cl.map((c) => c.text)))
      const cleaned = (raw ?? '').trim()
      if (cleaned && !/^none\b/i.test(cleaned)) {
        // INDEPENDENTLY verify the derivation (do these claims entail the folded rule?) — the fold
        // model's own "why" is testimony, not proof, so we re-check with the injected NLI verifier.
        const verify = deps.verify ? await deps.verify(cl.map((c) => c.text), cleaned) : null
        summaries.push({ rule: cleaned, from: cl.map((c) => c.id), verify })
      }
    } catch {
      // skip this cluster; the others still synthesize
    }
  }
  return { summaries, consumed: batch.length, watermark: newWatermark }
}
