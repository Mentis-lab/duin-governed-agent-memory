// personalization-recall — the "Retrieve-pull" verb (DUIN Memory Architecture §2)
// applied to the OPERATOR memory (the moat: accumulated per-operator judgment).
//
// Ports the legacy harness `forward_brief.py` pattern into DUIN: instead of whole-dumping
// every operator fact / taste rule / failure into the prompt, embed the turn and
// inject ONLY what's relevant to it, re-ranked by CONFIDENCE (β_conf) and with
// CONFLICT SUPPRESSION (a confirmed memory drops a weaker one on the same referent).
//
//   score = cosine(query, item) × β_conf     (multiplicative, per GAM/ConMem)
//   keep  = score ≥ FLOOR                     (confidence NEVER overrides a semantic gap)
//   suppress = one survivor per referent (highest score wins)
//
// Pure core (cosine / selectRecall / renderRecallBlock) is unit-tested; the async
// orchestrator injects the embedder so it stays testable + falls back cleanly.
import type { OperatorFact } from '../brain/operator-model'
import type { Taste } from '../brain/learn-native'
import type { FailureLedgerRecord } from '../failure-ledger'
import type { KindRate } from '../brain/calibration-weight'

// Tunable constants (DUIN Memory Architecture §7.2 / §8 — calibrate, keep a kill switch).
export const RECALL_FLOOR = 0.28 // cosine floor, from forward_brief.py
export const BETA_CONFIRMED = 1.06 // a confirmed/bound memory re-orders UP
export const RECALL_TOPK = 10 // hard cap on injected items

export interface RecallCandidate {
  /** Text embedded for query-relevance. */
  text: string
  kind: 'operator-rule' | 'operator-noticed' | 'taste' | 'failure'
  /** Conflict-suppression key: one survivor per referent (kind-scoped). */
  referent: string
  /** Confidence multiplier (β_conf). */
  betaConf: number
  /** The bullet rendered if this candidate is selected. */
  line: string
  /** The RECALL-namespace kind this candidate attributes to (WS1 Item 3b): operator
   *  facts → `f.kind` (context/preference/correction/principle); taste → 'taste';
   *  failure → 'failure'. The join key for the recall-efficacy ledger + `calFactor`. */
  recallKind?: string
  /** W2 (causal survival credit): the operator-model fact id behind this candidate, when it
   *  IS a fact (taste/failure candidates carry none). Threads through staging so the next
   *  turn's endorsement can credit the SPECIFIC facts that were injected — the per-fact
   *  attribution the recall-efficacy header reserves as its RICHER-SIGNAL upgrade. */
  factId?: string
}

// ── β_conf calibration factor (WS1 Item 3a) ──────────────────────────────────────────
/** How far the calibrated rate may nudge β_conf (rate 1.0 → ×1.15, 0.0 → ×0.85). */
export const CAL_SPAN = 0.15

/**
 * Bounded calibration multiplier for a recall-kind's empirical rate. NEUTRAL 1.0 whenever
 * the kind is gated / unobserved / unjoined — the NON-NEGOTIABLE guard so a thinly- or
 * un-observed kind can NEVER reorder recall (calibration can only re-rank kinds that have
 * genuinely earned an observed rate; the semantic floor still governs whether an item
 * survives at all). `1 + 0.15·(2·rate − 1)`, clamped to [0.85, 1.15]. PURE.
 */
export function calFactor(kr: KindRate | undefined | null): number {
  if (!kr || kr.gated || kr.rate == null) return 1.0
  const raw = 1 + CAL_SPAN * (2 * kr.rate - 1)
  return Math.min(1 + CAL_SPAN, Math.max(1 - CAL_SPAN, raw))
}

/** Options threading calibrated per-kind rates into candidate assembly (WS1 Item 3a).
 *  Absent `kindRates` → `calFactor` never applies → byte-identical to pre-Item-3 β_conf. */
export interface CalibrationOpts {
  /** recall-kind → empirical rate (from the recall-efficacy ledger). */
  kindRates?: Map<string, KindRate>
  /** Join fn: fact → its recall-kind. Default `f.kind` (falls back to 'context'). */
  kindOf?: (fact: OperatorFact) => string
}

/** Cosine similarity, self-normalizing (bge vectors may or may not be unit-length). */
export function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Score, floor, conflict-suppress, and top-k the recall candidates against the query.
 * PURE — `candVecs[i]` is the embedding of `candidates[i]`.
 */
export function selectRecall(
  queryVec: number[],
  candidates: RecallCandidate[],
  candVecs: number[][],
  opts: { floor?: number; topK?: number } = {}
): RecallCandidate[] {
  const floor = opts.floor ?? RECALL_FLOOR
  const topK = opts.topK ?? RECALL_TOPK
  const scored = candidates
    .map((c, i) => ({ c, score: cosine(queryVec, candVecs[i] ?? []) * c.betaConf }))
    .filter((s) => s.score >= floor)
    .sort((a, b) => b.score - a.score)

  // Conflict suppression: keep only the highest-scoring survivor per referent, so a
  // confirmed memory (higher β_conf) drops a weaker/superseded one on the same topic.
  const seenRef = new Set<string>()
  const kept: RecallCandidate[] = []
  for (const s of scored) {
    if (kept.length >= topK) break
    if (s.c.referent && seenRef.has(s.c.referent)) continue
    if (s.c.referent) seenRef.add(s.c.referent)
    kept.push(s.c)
  }
  return kept
}

/** Render the selected candidates as a compact, grouped "relevant to this turn" block.
 *  Empty selection → '' (caller falls back to the whole-dump renderers). PURE. */
export function renderRecallBlock(selected: RecallCandidate[]): string {
  if (selected.length === 0) return ''
  const groups: { kind: RecallCandidate['kind']; header: string }[] = [
    { kind: 'operator-rule', header: 'Rules you confirmed that bear on this' },
    { kind: 'operator-noticed', header: 'Noticed about you (unconfirmed — soft signal)' },
    { kind: 'taste', header: 'How you\'ve corrected me on things like this' },
    { kind: 'failure', header: 'Failure modes to avoid here' }
  ]
  const sections: string[] = [
    'RELEVANT TO THIS TURN (retrieved from what you\'ve taught me, ranked by how much it\'s ' +
      'earned trust — apply the confirmed items; treat the rest as softer):'
  ]
  for (const g of groups) {
    const lines = selected.filter((s) => s.kind === g.kind).map((s) => s.line)
    if (lines.length) sections.push(`${g.header}:\n${lines.join('\n')}`)
  }
  return sections.length > 1 ? sections.join('\n') : ''
}

// ──────────────────── candidate assembly (source → RecallCandidate) ────────────────────

const clip = (s: string, n = 160): string => s.replace(/\s+/g, ' ').trim().slice(0, n)

/** Operator facts → candidates. Vetoed are EXCLUDED (veto memory); promoted get the
 *  confirmed β, candidates the neutral one. Referent = fact kind so a promoted rule
 *  drops a weaker candidate on the same theme. */
export function operatorCandidates(facts: OperatorFact[], opts: CalibrationOpts = {}): RecallCandidate[] {
  const out: RecallCandidate[] = []
  const kindOf = opts.kindOf ?? ((f: OperatorFact) => String(f.kind ?? 'context'))
  for (const f of facts) {
    // Vetoed (human reject) and reverted (failed the govern verifier) are excluded —
    // veto/revert memory. Confirmed = strong; provisional = a touch above candidate.
    if (f.status === 'vetoed' || f.status === 'reverted') continue
    const text = clip(String(f.fact ?? ''))
    if (!text) continue
    const confirmed = f.status === 'promoted'
    const provisional = f.status === 'provisional'
    const recallKind = kindOf(f)
    // WS1 Item 3a: fold the calibrated per-kind rate into β_conf. When `kindRates` is
    // absent (flag OFF) calFactor is never consulted → βConf is byte-identical to today;
    // a gated/unobserved kind yields calFactor 1.0, so calibration only ever re-ranks
    // kinds that have genuinely earned an observed rate.
    const cal = opts.kindRates ? calFactor(opts.kindRates.get(recallKind)) : 1.0
    // Item 12 (recall path): a fact MEASURED no-lift (efficacy.verdict='prune-candidate') is
    // demoted out of the strong 'operator-rule'/BETA_CONFIRMED slot into the soft 'operator-noticed'
    // weight — measurement governs weighting on the recall path too, not just buildOperatorBlock.
    // Demotion-only (prune stays human-gated, per operator decision); unmeasured facts unchanged.
    const noLift = f.efficacy?.verdict === 'prune-candidate'
    out.push({
      text,
      kind: !noLift && confirmed ? 'operator-rule' : 'operator-noticed',
      referent: `operator:${recallKind}:${text.slice(0, 40)}`,
      betaConf: (noLift ? 1.0 : confirmed ? BETA_CONFIRMED : provisional ? 1.03 : 1.0) * cal,
      line: `- ${text}`,
      recallKind,
      factId: f.id
    })
  }
  return out
}

/** Normalize a rule/fact string for cross-source dedup (case + whitespace insensitive).
 *  Shared with the caller so the exclusion set and the per-rule check agree. */
export function normalizeRuleText(s: string): string {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Taste correction-rules → candidates. bound/confirmed get the confirmed β. `excludeRules`
 *  (Phase 1b) drops any rule already grounded via the operator-model store — a bound rule now
 *  lands as an operator fact, so without this it would double-inject (once via operatorCandidates,
 *  once here) and could take two of the limited top-k slots. */
export function tasteCandidates(taste: Taste | null | undefined, opts: { excludeRules?: Set<string> } = {}): RecallCandidate[] {
  if (!taste || !Array.isArray(taste.correction_rules)) return []
  const exclude = opts.excludeRules
  const out: RecallCandidate[] = []
  for (const r of taste.correction_rules) {
    const rr = r as Record<string, unknown>
    // Veto-leak guard (Phase 0.1): only a distilled `candidate_rule` is guidance. A veto
    // forwards a correction-polarity row whose `correction` holds the REJECTED inference
    // (empty candidate_rule); surfacing that as a recall candidate re-injects the very
    // thing the operator rejected. Fall back to `correction` only for non-correction rows.
    const isCorrection = String(rr.polarity ?? '') === 'correction'
    const rule = clip(String(rr.candidate_rule || (isCorrection ? '' : rr.correction) || ''))
    if (!rule) continue
    if (exclude && exclude.has(normalizeRuleText(rule))) continue // already grounded as an operator fact
    const status = String(rr.status ?? '')
    const bound = status === 'bound' || status === 'confirmed'
    const why = clip(String(rr.why ?? ''), 80)
    out.push({
      text: `${rule} ${why}`,
      kind: 'taste',
      referent: `taste:${rule.slice(0, 40)}`,
      betaConf: bound ? BETA_CONFIRMED : 1.0,
      line: `- ${rule}${why ? ` (why: ${why})` : ''}`,
      recallKind: 'taste'
    })
  }
  return out
}

/** Failure-ledger records → candidates (higher count = a touch more weight). */
export function failureCandidates(failures: FailureLedgerRecord[] | null | undefined): RecallCandidate[] {
  if (!failures) return []
  const out: RecallCandidate[] = []
  for (const f of failures) {
    const msg = clip(String(f.message ?? ''))
    if (!msg) continue
    const cmd = f.command ? ` [${clip(f.command, 60)}]` : ''
    out.push({
      text: `${f.kind} ${msg}${cmd}`,
      kind: 'failure',
      referent: `failure:${f.fingerprint || msg.slice(0, 40)}`,
      // A failure that recurs is slightly more worth surfacing; cap the boost.
      betaConf: 1.0 + Math.min(0.06, (Math.max(1, f.count) - 1) * 0.02),
      line: `- (${f.kind}${f.count > 1 ? `×${f.count}` : ''}) ${msg}${cmd}`,
      recallKind: 'failure'
    })
  }
  return out
}

// ──────────────────── async orchestrator ────────────────────

// Content-hash embedding cache: memory items are stable across turns, so we embed
// each distinct text once per process. The query is embedded fresh every turn.
const vecCache = new Map<string, number[]>()

export type EmbedFn = (texts: string[]) => Promise<number[][]>

/**
 * Embed the query + (uncached) candidates, then select. Returns the selected
 * candidates, or null when there's nothing to recall or the embedder is unavailable
 * (the caller then falls back to the whole-dump blocks — zero regression on failure).
 */
export async function rankRecall(
  query: string,
  candidates: RecallCandidate[],
  embed: EmbedFn,
  opts: { floor?: number; topK?: number } = {}
): Promise<RecallCandidate[] | null> {
  const q = (query ?? '').trim()
  if (!q || candidates.length === 0) return null
  try {
    // Embed the query + any candidate texts not already cached, in one batch.
    const missing = candidates.map((c) => c.text).filter((t) => !vecCache.has(t))
    const toEmbed = [q, ...missing]
    const vecs = await embed(toEmbed)
    if (!Array.isArray(vecs) || vecs.length !== toEmbed.length) return null
    const queryVec = vecs[0]
    missing.forEach((t, i) => vecCache.set(t, vecs[i + 1]))
    const candVecs = candidates.map((c) => vecCache.get(c.text) ?? [])
    return selectRecall(queryVec, candidates, candVecs, opts)
  } catch {
    return null
  }
}

// ──────────────────── taste_rerank ────────────────────
// Ports the legacy harness `deep_retrieve.taste_rerank`: reshape note-retrieval ranking
// toward the operator's CONFIRMED judgment, so retrieval bends to what they've
// decided matters — "retrieval shaped by the operator's evolving judgment graph".
// Cold-start safe: no confirmed judgment yet → no-op.

export const TASTE_LAMBDA = 0.5 // how much taste affinity can boost a hit's rank

/** The operator's CONFIRMED judgment corpus: promoted operator facts + bound taste
 *  rules. This is the "judgment graph" retrieval is re-ranked against. */
export function confirmedJudgmentTexts(facts: OperatorFact[], taste: Taste | null | undefined): string[] {
  const out: string[] = []
  for (const f of facts) {
    if (f.status === 'promoted' && f.fact) out.push(clip(String(f.fact)))
  }
  const rules = taste && Array.isArray(taste.correction_rules) ? taste.correction_rules : []
  for (const r of rules) {
    const rr = r as Record<string, unknown>
    const status = String(rr.status ?? '')
    if (status === 'bound' || status === 'confirmed') {
      // Veto-leak guard (Phase 0.1): only a distilled candidate_rule is judgment to rerank
      // toward. A veto forwards a correction-polarity row whose `correction` holds the
      // REJECTED inference (empty candidate_rule) — biasing retrieval toward it would pull
      // hits toward the very thing the operator rejected. (Latent while the TS store only
      // writes 'new', but taste-engine.json is shared with the Python build_taste path.)
      const isCorrection = String(rr.polarity ?? '') === 'correction'
      const rule = clip(String(rr.candidate_rule || (isCorrection ? '' : rr.correction) || ''))
      if (rule) out.push(rule)
    }
  }
  return out
}

/** Reorder hits by `score × (1 + λ × tasteAffinity)`. Taste SHAPES the ranking without
 *  overriding semantic relevance (affinity is a bounded multiplier on the base score).
 *  Length mismatch → hits unchanged. PURE. */
export function applyTasteRerank<T extends { score: number }>(
  hits: T[],
  affinities: number[],
  lambda: number = TASTE_LAMBDA
): T[] {
  if (affinities.length !== hits.length) return hits
  return hits
    .map((h, i) => ({ h, i, blended: h.score * (1 + lambda * Math.max(0, affinities[i] ?? 0)) }))
    .sort((a, b) => b.blended - a.blended || a.i - b.i)
    .map((x) => x.h)
}

/**
 * Re-rank retrieval hits by affinity to the query-relevant subset of the operator's
 * confirmed judgment. Embeds the query + judgments (cached) to pick the top-K judgments
 * for THIS turn, embeds the hit snippets, scores each hit by its max cosine to those
 * judgments, and blends. Returns null on empty/failure so the caller keeps the original
 * order (zero regression).
 */
export async function tasteRerank<T extends { snippet?: string; score: number }>(
  query: string,
  hits: T[],
  judgmentTexts: string[],
  embed: EmbedFn,
  opts: { topJudgments?: number; lambda?: number } = {}
): Promise<T[] | null> {
  const q = (query ?? '').trim()
  if (!q || hits.length < 2 || judgmentTexts.length === 0) return null
  try {
    const topJ = opts.topJudgments ?? 3
    const missing = judgmentTexts.filter((t) => !vecCache.has(t))
    const jBatch = [q, ...missing]
    const jVecs = await embed(jBatch)
    if (!Array.isArray(jVecs) || jVecs.length !== jBatch.length) return null
    const queryVec = jVecs[0]
    missing.forEach((t, i) => vecCache.set(t, jVecs[i + 1]))
    // The judgments most relevant to THIS turn (taste is query-scoped, not global).
    const topJudgmentVecs = judgmentTexts
      .map((t) => ({ v: vecCache.get(t) ?? [], s: cosine(queryVec, vecCache.get(t) ?? []) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, topJ)
      .map((x) => x.v)
    if (topJudgmentVecs.length === 0) return null
    // Hit snippets vary per turn → embed fresh (not cached).
    const hitVecs = await embed(hits.map((h) => (h.snippet ?? '').slice(0, 400)))
    if (!Array.isArray(hitVecs) || hitVecs.length !== hits.length) return null
    const affinities = hitVecs.map((hv) =>
      topJudgmentVecs.reduce((max, jv) => Math.max(max, cosine(hv, jv)), 0)
    )
    return applyTasteRerank(hits, affinities, opts.lambda)
  } catch {
    return null
  }
}

/** Test seam — clear the module embedding cache. */
export function __resetRecallCache(): void {
  vecCache.clear()
}
