// Whole-note grounding — replicate & BEAT the naive-RAG baseline INSIDE DUIN, keyless/on-device.
//
// WHY: on LongMemEval_S the /agui grounding funnels the strong answer model through a weak
// cheap-driver agentic loop + chunk snippets (~hundreds of tokens of citations), while the naive
// baseline feeds the SAME model ~32k tokens of BM25-ranked WHOLE sessions — and wins by +14
// (DUIN 74 vs naive-RAG 88, 2026-07-12). DUIN was starving its best asset. Since one note == one
// session here, ranking WHOLE notes by BM25 + semantic fusion and handing them to the answer model
// reproduces the baseline's context quality with DUIN's own on-device index — no API key.
//
// PURE core (BM25 / RRF / context assembly are deterministic + unit-tested); the live seam (corpus +
// semantic hits) is injected by the caller. Gated by the caller (DUIN_WHOLENOTE_GROUND); OFF ⇒ never
// called ⇒ contextOverride byte-identical to today.

import { cjkTokens } from './cjk-tokens'

export interface WNNote {
  /** Note id (relpath). */
  id: string
  /** Full reassembled note text (frontmatter included; stripped at assembly). */
  text: string
}

/** A semantic ranking entry from the live index (higher score = better), injected by the caller. */
export interface WNSemHit {
  note: string
  score: number
}

// Minimal stopword set — high-frequency English function words add noise to BM25 on short queries.
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'were', 'be',
  'been', 'it', 'this', 'that', 'i', 'you', 'me', 'my', 'your', 'we', 'what', 'which', 'who', 'how',
  'when', 'where', 'do', 'did', 'does', 'can', 'could', 'would', 'should', 'with', 'about', 'at', 'as'
])

/**
 * Words + CJK BIGRAMS. Latin behaviour is unchanged from the harness's `_TOK` (any-length
 * alphanumeric run, stopwords dropped unless `keepStop`); CJK runs now yield overlapping character
 * bigrams instead of single characters. Single CJK characters are near-stopwords in a 39%-CJK vault
 * — they appear almost everywhere, IDF collapses, and BM25 ranked Chinese queries as noise (0.000
 * recall@5 on the CJK-paraphrase probes). See [[cjk-tokens]] for the full rationale.
 */
export function tokenize(s: string, keepStop = false): string[] {
  return cjkTokens(s, { minLatin: 1, stop: keepStop ? undefined : STOP })
}

/**
 * Compact BM25 over WHOLE notes. Returns note ids ranked best-first. Deterministic; mirrors the
 * pure-Python `bm25_topk` the naive baseline uses (same tokenizer, k1/b), so DUIN's lexical signal
 * is at least as strong as the baseline that beats it. Documents are the full note bodies.
 */
export function bm25Rank(query: string, notes: WNNote[], k1 = 1.5, b = 0.75): { id: string; score: number }[] {
  const q = tokenize(query)
  if (q.length === 0 || notes.length === 0) return []
  const docTok = notes.map((n) => tokenize(n.text, true))
  const N = notes.length
  const avgdl = docTok.reduce((s, t) => s + t.length, 0) / N || 1
  const df = new Map<string, number>()
  for (const toks of docTok) for (const w of new Set(toks)) df.set(w, (df.get(w) ?? 0) + 1)
  const idf = (w: string): number => {
    const n = df.get(w) ?? 0
    return Math.log(1 + (N - n + 0.5) / (n + 0.5))
  }
  const scored = notes.map((note, i) => {
    const toks = docTok[i]
    const tf = new Map<string, number>()
    for (const w of toks) tf.set(w, (tf.get(w) ?? 0) + 1)
    const dl = toks.length || 1
    let s = 0
    for (const w of q) {
      const f = tf.get(w)
      if (!f) continue
      s += idf(w) * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / avgdl))
    }
    return { id: note.id, score: s }
  })
  return scored.filter((r) => r.score > 0).sort((a, b2) => b2.score - a.score)
}

/**
 * Reciprocal-rank fusion of several best-first id rankings into one. RRF is robust to the two
 * rankers being on different score scales (BM25 magnitudes vs cosine), which is exactly our case.
 * Ids present in only one ranking still surface; ids in both are boosted.
 */
export function rrfFuse(rankings: string[][], k = 60): string[] {
  const score = new Map<string, number>()
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1))
    })
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

/** Strip a leading YAML frontmatter block (matches the server's tool-card cleaner). */
export function stripFrontmatter(text: string): string {
  return (text ?? '').replace(/^\s*---[\s\S]*?---\s*/, '').trim()
}

/**
 * Matched-region window: for a note too large to include whole, return the region around its
 * best query-term match plus surrounding context, bounded to ~budget chars. Keeps the evidence the
 * note was retrieved FOR while dropping the bloat (a 900KB DEVLOG → the ~few-KB relevant section),
 * so the answer model gets the same signal at a fraction of the context cost. Line-granular: scores
 * each line by distinct query-token hits, centers on the best, expands toward higher-scoring
 * neighbors until the budget is spent. Ellipsis markers show where text was elided. Deterministic.
 */
export function windowAroundMatch(text: string, queryTokens: string[], budget: number): string {
  if (text.length <= budget) return text
  const qset = new Set(queryTokens.filter((t) => t.length >= 2))
  // Best-matching line (by distinct query-token hits), and its char offset in the text.
  const lines = text.split('\n')
  let best = 0
  let bestScore = -1
  let bestOff = 0
  let off = 0
  for (let i = 0; i < lines.length; i++) {
    const lt = new Set(tokenize(lines[i], true))
    let s = 0
    for (const w of qset) if (lt.has(w)) s++
    if (s > bestScore) {
      bestScore = s
      best = i
      bestOff = off
    }
    off += lines[i].length + 1
  }
  // Char window of ~budget centered on the match (line-centered when we have one; else the head).
  // Char-based so a single very long line can't blow the budget.
  const center = bestScore > 0 ? bestOff + Math.floor(lines[best].length / 2) : Math.floor(budget / 2)
  let lo = Math.max(0, center - Math.floor(budget / 2))
  let hi = Math.min(text.length, lo + budget)
  lo = Math.max(0, hi - budget) // pin the window to exactly ~budget width
  // Snap edges to nearby whitespace so we don't cut mid-word (bounded nudge).
  if (lo > 0) {
    const sp = text.indexOf(' ', lo)
    if (sp !== -1 && sp - lo < 40) lo = sp + 1
  }
  if (hi < text.length) {
    const sp = text.lastIndexOf(' ', hi)
    if (sp !== -1 && hi - sp < 40) hi = sp
  }
  return (lo > 0 ? '…' : '') + text.slice(lo, hi).trim() + (hi < text.length ? '…' : '')
}

export interface WholeNoteContext {
  /** The assembled context block (empty string if nothing usable). */
  context: string
  /** Note ids actually included, in ranked order. */
  used: string[]
}

/**
 * Assemble the whole-note CONTEXT block the answer model grounds on: fuse BM25 + the injected
 * semantic ranking (RRF) → take the top-K notes → concatenate their FULL bodies (frontmatter
 * stripped) up to a char budget (~the baseline's 32k-token context). Deterministic. When
 * `demote` is supplied, notes it returns true for are pushed to the end BEFORE the top-K cut
 * (the claim-recall / supersession seam — a note backed by a retired fact loses its slot).
 */
export function buildWholeNoteContext(
  query: string,
  notes: WNNote[],
  semantic: WNSemHit[],
  opts: {
    topK?: number
    charBudget?: number
    perNoteBudget?: number
    demote?: (id: string) => boolean
    /** Ids hoisted to the FRONT of the fused ranking (stable among themselves and for the rest).
     *  Used to guarantee that a note which SUPERSEDES a retrieved note is itself in context — the
     *  ranking scores topical similarity, so a brief update loses to the long stale note it corrects
     *  (measured on bench/stale: in 2 of 4 read failures the superseder never reached the top-8).
     *  This is a targeted co-retrieval, NOT a reordering of general search: ids not already in the
     *  fused list are ignored, and nothing is dropped. */
    pin?: readonly string[]
  } = {}
): WholeNoteContext {
  const byId = new Map(notes.map((n) => [n.id, n]))
  const lexOrder = bm25Rank(query, notes).map((r) => r.id)
  const semOrder = [...semantic].sort((a, b) => b.score - a.score).map((h) => h.note)
  let fused = rrfFuse([lexOrder, semOrder]).filter((id) => byId.has(id))
  if (opts.demote) {
    // Stable partition: keep fused order within each group, retired-backed notes last.
    const keep = fused.filter((id) => !opts.demote!(id))
    const drop = fused.filter((id) => opts.demote!(id))
    fused = [...keep, ...drop]
  }
  if (opts.pin && opts.pin.length > 0) {
    const pinned = new Set(opts.pin)
    fused = [...fused.filter((id) => pinned.has(id)), ...fused.filter((id) => !pinned.has(id))]
  }
  // Hand the fused ranking to the shared assembler (factored out so an ALTERNATIVE ranker — e.g. the
  // model-free graph-expand retriever — assembles its context through the SAME budgeted concatenation
  // instead of duplicating it). topK/charBudget/perNoteBudget defaults live in the assembler.
  return assembleWholeNoteContext(fused, notes, query, {
    topK: opts.topK,
    charBudget: opts.charBudget,
    perNoteBudget: opts.perNoteBudget
  })
}

/**
 * Assemble the whole-note CONTEXT block from an ALREADY-RANKED note-id list: take the top-K, strip
 * frontmatter, window notes larger than `perNoteBudget` to their matched region, and concatenate the
 * bodies up to `charBudget`. The ranker-agnostic half of buildWholeNoteContext — the BM25 branch and
 * the graph-expand branch share it so their context format is byte-identical. Deterministic; unknown
 * ids are skipped. Always includes at least one note before honoring the char budget.
 */
export function assembleWholeNoteContext(
  rankedIds: string[],
  notes: WNNote[],
  query: string,
  opts: { topK?: number; charBudget?: number; perNoteBudget?: number } = {}
): WholeNoteContext {
  const topK = opts.topK ?? 12
  const charBudget = opts.charBudget ?? 120_000
  const perNoteBudget = opts.perNoteBudget ?? 0
  const qtok = tokenize(query)
  const byId = new Map(notes.map((n) => [n.id, n]))
  const ordered = rankedIds.filter((id) => byId.has(id)).slice(0, topK)

  const blocks: string[] = []
  const used: string[] = []
  let budget = charBudget
  for (const id of ordered) {
    let body = stripFrontmatter(byId.get(id)!.text)
    if (!body) continue
    if (perNoteBudget > 0 && body.length > perNoteBudget) body = windowAroundMatch(body, qtok, perNoteBudget)
    const block = `[Note: ${id}]\n${body}`
    // Always include at least one note; then stop once the budget is spent.
    if (block.length > budget && blocks.length > 0) break
    blocks.push(block.length > budget ? block.slice(0, budget) : block)
    used.push(id)
    budget -= block.length
    if (budget <= 0) break
  }
  return { context: blocks.join('\n\n---\n\n'), used }
}
