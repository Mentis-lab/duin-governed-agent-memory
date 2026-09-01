// learning-metabolism — Phase 0+1 (shadow) of connecting the operator-learning store to the
// world-state metabolism substrate (design: PLANNING/DUIN_LEARNING_METABOLISM.md, composition
// verified in learning_metabolism_sim.py). Operator facts are free TEXT with a status lifecycle
// (candidate→provisional→promoted, + vetoed/reverted) — the govern loop's VALIDITY axis. This adds
// the orthogonal CURRENCY axis: a promoted belief that was right can become STALE when the
// operator's world moves (a decision resolves, a stream passes). Crucially, staleness must NEVER
// be conflated with `reverted` (the sim proved that poisons the revert-memory), so this only ever
// SURFACES stale candidates (shadow) — grounding is untouched until a later, separately-gated flip.
//
// Staleness signal (deterministic, conservative): a fact is a stale candidate if its text mentions
// the DISTINCTIVE entities of a resolved decision / passed stream (shared strong tokens — project
// codes / proper nouns / CJK terms — not embedding similarity, which can't tell stale from fresh).
// Precise semantic matching is the later model-residue enrichment.

import { getOperatorFacts, type OperatorFact } from './operator-model'
import { gatherWorldState } from './claim-ledger'
import { listDecisions } from './decisions-native'
import { loadFutures } from './causal-substrate'
import { runSemanticResidue, type ResidueDeps } from './semantic-residue'
import { CJK_CLASS, hasCjk } from './cjk-tokens'

const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'about', 'over', 'under', 'when', 'what', 'will', 'have', 'has', 'are', 'was', 'not', 'but', 'you', 'your', 'our', 'their'])
/** A "strong" token — a project code / proper-noun-ish / CJK term that carries entity identity.
 *  CJK-ness comes from the tokenizer's own detector (kanji + KANA); the bare ideograph range
 *  this used to test made a kana term look like a weak short Latin one. */
export function isStrong(t: string): boolean {
  return hasCjk(t) || /^\d/.test(t) || t.length >= 5
}
/** CJK runs are matched with the tokenizer's full class (kanji + KANA), not the bare
 *  ideograph range — kana was a delimiter, so a Japanese fact had no distinctive tokens
 *  and could never be judged stale. */
const DISTINCT_TOK_RE = new RegExp(`[${CJK_CLASS}]+|[a-z0-9]{3,}`, 'g')
/** Distinctive tokens of a string: CJK runs + alphanumeric tokens ≥3 chars, minus stopwords. */
export function distinctiveTokens(s: string): Set<string> {
  const out = new Set<string>()
  for (const m of s.toLowerCase().matchAll(DISTINCT_TOK_RE)) {
    const t = m[0]
    if (!STOP.has(t)) out.add(t)
  }
  return out
}

export interface Topic {
  id: string
  label: string
  tokens: Set<string>
}

/** Build the topics (resolved decisions + passed streams) the judge checks facts against. */
export function worldTopics(
  decisions: { id: string; title?: string; status?: string; reviewOn?: string }[],
  streams: { id?: string; title?: string; status?: string; decide_by?: string }[],
  now: number
): Topic[] {
  const world = gatherWorldState(
    decisions.map((d) => ({ id: d.id, status: d.status, reviewOn: d.reviewOn })),
    streams.map((s) => ({ id: s.id, status: s.status, decide_by: s.decide_by })),
    now
  )
  const topics: Topic[] = []
  for (const d of decisions) {
    if (world.resolvedDecisions.has(d.id)) {
      const label = (d.title || d.id).trim()
      topics.push({ id: d.id, label, tokens: distinctiveTokens(label) })
    }
  }
  for (const s of streams) {
    if (s.id && world.passedStreams.has(s.id)) {
      const label = (s.title || s.id).trim()
      topics.push({ id: s.id, label, tokens: distinctiveTokens(label) })
    }
  }
  return topics
}

/**
 * Match a fact against the resolved topics. Conservative: requires ≥2 shared distinctive tokens
 * with at least one STRONG (entity-bearing) token — so it fires on project/entity staleness, not
 * on incidental common-word overlap. Returns the matched topic, or null.
 */
export function matchStale(factText: string, topics: Topic[]): Topic | null {
  const ft = distinctiveTokens(factText)
  let best: Topic | null = null
  let bestOverlap = 0
  for (const topic of topics) {
    let shared = 0
    let strong = false
    for (const t of topic.tokens) {
      if (ft.has(t)) {
        shared++
        if (isStrong(t)) strong = true
      }
    }
    if (shared >= 2 && strong && shared > bestOverlap) {
      best = topic
      bestOverlap = shared
    }
  }
  return best
}

/** Read the live decisions/streams and build the resolved-topic set (shared by shadow + deep). */
export function gatherTopics(vaultDir: string, now: number): Topic[] {
  const decisions = (listDecisions(vaultDir)?.decisions ?? []).map((d) => ({ id: d.id, title: d.title, status: d.status, reviewOn: d.reviewOn }))
  const streams = (loadFutures(vaultDir) ?? []).map((s) => ({ id: s.id, title: s.title, status: s.status, decide_by: s.decide_by }))
  return worldTopics(decisions, streams, now)
}

export interface LearningShadow {
  activeFacts: number // promoted + provisional (the grounding set)
  byStatus: Record<string, number>
  resolvedTopics: number
  staleCandidates: { id: string; kind: string; fact: string; matchedTopic: string; reason: string }[]
}

/**
 * SHADOW run: which ACTIVE (promoted/provisional) facts WOULD archive as stale because they mention
 * a resolved decision / passed stream. Surfaces only — grounding (buildOperatorBlock) is untouched,
 * status/reverts untouched (currency ≠ validity). Reversible by construction (nothing is written).
 */
export function runLearningShadow(vaultDir: string | null, now = Date.now()): LearningShadow {
  const facts = getOperatorFacts()
  const byStatus: Record<string, number> = {}
  for (const f of facts) byStatus[f.status] = (byStatus[f.status] ?? 0) + 1
  const active = facts.filter((f: OperatorFact) => f.status === 'promoted' || f.status === 'provisional')

  const empty: LearningShadow = { activeFacts: active.length, byStatus, resolvedTopics: 0, staleCandidates: [] }
  if (!vaultDir) return empty

  const topics = gatherTopics(vaultDir, now)

  const staleCandidates: LearningShadow['staleCandidates'] = []
  for (const f of active) {
    const hit = matchStale(f.fact, topics)
    if (hit) {
      staleCandidates.push({
        id: f.id,
        kind: f.kind,
        fact: f.fact.length > 160 ? f.fact.slice(0, 160) + '…' : f.fact,
        matchedTopic: hit.label,
        reason: `mentions the resolved topic "${hit.label}"`
      })
    }
  }
  return { activeFacts: active.length, byStatus, resolvedTopics: topics.length, staleCandidates: staleCandidates.slice(0, 100) }
}

/**
 * DEEP shadow: the deterministic pass PLUS the model-residue pass over the active facts the
 * deterministic layer did NOT flag (catching paraphrased staleness with no shared tokens).
 * Model verdicts are tagged `model:` (lower trust). Still SHADOW — nothing written, grounding
 * untouched. Async + on-demand (POST `/state/learning-metabolism/deep`) so the
 * fast GET stays deterministic-only.
 */
export async function runLearningDeep(vaultDir: string | null, now = Date.now(), deps?: ResidueDeps): Promise<LearningShadow> {
  const shadow = runLearningShadow(vaultDir, now)
  if (!vaultDir || !shadow.resolvedTopics) return shadow
  const topics = gatherTopics(vaultDir, now)
  const flagged = new Set(shadow.staleCandidates.map((c) => c.id))
  const active = getOperatorFacts().filter(
    (f: OperatorFact) => (f.status === 'promoted' || f.status === 'provisional') && !flagged.has(f.id)
  )
  const verdicts = await runSemanticResidue(active.map((f) => ({ id: f.id, text: f.fact })), topics.map((t) => t.label), deps)
  const byId = new Map(active.map((f) => [f.id, f]))
  const modelCandidates: LearningShadow['staleCandidates'] = []
  for (const v of verdicts) {
    const f = byId.get(v.id)
    if (!f) continue
    modelCandidates.push({
      id: f.id,
      kind: f.kind,
      fact: f.fact.length > 160 ? f.fact.slice(0, 160) + '…' : f.fact,
      matchedTopic: v.topic,
      reason: `model: ${v.reason}`
    })
  }
  return { ...shadow, staleCandidates: [...shadow.staleCandidates, ...modelCandidates].slice(0, 100) }
}
