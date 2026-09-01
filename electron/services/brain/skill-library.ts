// skill-library — PROCEDURAL memory (DUIN's weakest dimension). The store already holds
// semantic memory (facts/rules) and episodic (captures); this adds "what worked" — the
// success traces success_miner captures on an operator endorsement become reusable
// exemplars. For a new request we retrieve the most relevant past successes and inject them
// as few-shot grounding, so DUIN does MORE of what earned a thumbs-up, not only less of
// what earned a correction.
//
// v1 relevance is token-overlap (no embedding dependency, fully testable); an embedding
// ranker can replace scoreOverlap later without touching the selection/render contract.

import { getSuccesses } from './success-miner'
import { cosine } from '../local-brain/personalization-recall'
import { CJK_CLASS } from './cjk-tokens'

export interface SkillExemplar {
  id: string
  query: string
  answer: string
  score: number
}

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'is', 'it', 'my', 'me', 'you', 'how', 'do', 'can', 'i'])

/** The split delimiter — everything that is NOT alphanumeric or CJK. The CJK side is the
 *  tokenizer's full class (kanji + KANA), not the bare ideograph range, which split ON kana
 *  and so dropped Japanese exemplar terms entirely. Non-global on purpose (`split`). */
const TOK_SPLIT_RE = new RegExp(`[^a-z0-9${CJK_CLASS}]+`)

/** Content tokens (>2 chars, non-stopword, lowercased). PURE. */
export function tokens(s: string): Set<string> {
  return new Set(
    (s ?? '')
      .toLowerCase()
      .split(TOK_SPLIT_RE)
      .filter((w) => w.length > 2 && !STOP.has(w))
  )
}

/** Overlap of a candidate exemplar's query with the request tokens, normalized by the
 *  request size (how much of what you're asking this exemplar covers). PURE. */
export function scoreOverlap(requestTokens: Set<string>, exemplarQuery: string): number {
  if (requestTokens.size === 0) return 0
  const et = tokens(exemplarQuery)
  let hit = 0
  for (const t of requestTokens) if (et.has(t)) hit++
  return hit / requestTokens.size
}

export interface SkillSelectPolicy {
  /** Max exemplars to inject. */
  topK: number
  /** Minimum overlap to be relevant at all. */
  floor: number
}
export const DEFAULT_SKILL_POLICY: SkillSelectPolicy = { topK: 2, floor: 0.34 }

/** Pick the most relevant past successes for a request. PURE. */
export function selectExemplars(
  query: string,
  traces: { id: string; query: string; answer: string }[],
  policy: SkillSelectPolicy = DEFAULT_SKILL_POLICY
): SkillExemplar[] {
  const rt = tokens(query)
  if (rt.size === 0) return []
  return traces
    .map((t) => ({ id: t.id, query: t.query, answer: t.answer, score: scoreOverlap(rt, t.query) }))
    .filter((e) => e.score >= policy.floor && e.answer.trim())
    .sort((a, b) => b.score - a.score)
    .slice(0, policy.topK)
}

/** Render exemplars as a compact few-shot grounding block, or '' if none. PURE. */
export function renderExemplarsBlock(exemplars: SkillExemplar[]): string {
  if (exemplars.length === 0) return ''
  const lines = exemplars.map((e) => {
    const a = e.answer.length > 400 ? e.answer.slice(0, 400) + '…' : e.answer
    return `- When asked "${e.query}", this worked:\n  ${a.replace(/\n/g, '\n  ')}`
  })
  return `WHAT HAS WORKED BEFORE (the operator endorsed these — lean this way):\n${lines.join('\n')}`
}

/** Live: retrieve the success exemplars relevant to a request, rendered as a grounding
 *  block. Best-effort — a missing store yields ''. */
export function getSkillGrounding(query: string, policy: SkillSelectPolicy = DEFAULT_SKILL_POLICY): string {
  try {
    const traces = getSuccesses().map((t) => ({ id: t.id, query: t.query, answer: t.answer }))
    return renderExemplarsBlock(selectExemplars(query, traces, policy))
  } catch {
    return ''
  }
}

// ──────────────────── embedding ranker (Voyager WS4.3) ────────────────────
// The v1 ranker is token-EXACT: "summarize" ≠ "summary" (see the test), so a semantically
// relevant past success with different wording is missed. This swaps the score for cosine over
// embeddings — same SkillExemplar / render contract — with graceful fallback to token-overlap
// when the embedder is unavailable, so grounding never breaks. `embed` is INJECTED for testability.

/** Cosine of a query embedding vs a candidate embedding. PURE. */
export function scoreEmbedded(queryEmb: number[], candEmb: number[]): number {
  return cosine(queryEmb, candEmb)
}

/** Embedding-ranked exemplar selection (semantic, vs token-overlap). Embeds [query, ...exemplar
 *  queries] in ONE call, cosine-ranks each vs the query, applies the same floor + topK. Returns []
 *  if the embedder is unavailable (empty/short matrix) so the caller can fall back. */
export async function selectExemplarsEmbedded(
  query: string,
  traces: { id: string; query: string; answer: string }[],
  embed: (texts: string[]) => Promise<number[][]>,
  policy: SkillSelectPolicy = DEFAULT_SKILL_POLICY
): Promise<SkillExemplar[]> {
  const withAnswer = traces.filter((t) => (t.answer ?? '').trim())
  if (!query.trim() || withAnswer.length === 0) return []
  let vecs: number[][]
  try {
    vecs = await embed([query, ...withAnswer.map((t) => t.query)])
  } catch {
    return []
  }
  // Need the query vector + one per exemplar; a short/empty matrix = embedder unavailable.
  if (!Array.isArray(vecs) || vecs.length < withAnswer.length + 1) return []
  const qv = vecs[0]
  if (!Array.isArray(qv) || qv.length === 0) return []
  return withAnswer
    .map((t, i) => ({ id: t.id, query: t.query, answer: t.answer, score: scoreEmbedded(qv, vecs[i + 1]) }))
    .filter((e) => e.score >= policy.floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, policy.topK)
}

/** Async embedding-ranked skill grounding, with graceful fallback to the sync token-overlap ranker
 *  when embeddings are unavailable (or find nothing). Never throws. */
export async function getSkillGroundingAsync(
  query: string,
  embed: (texts: string[]) => Promise<number[][]>,
  policy: SkillSelectPolicy = DEFAULT_SKILL_POLICY
): Promise<string> {
  try {
    const traces = getSuccesses().map((t) => ({ id: t.id, query: t.query, answer: t.answer }))
    const embedded = await selectExemplarsEmbedded(query, traces, embed, policy)
    if (embedded.length > 0) return renderExemplarsBlock(embedded)
    return getSkillGrounding(query, policy) // embedder unavailable / nothing above floor → token-overlap
  } catch {
    return getSkillGrounding(query, policy)
  }
}
