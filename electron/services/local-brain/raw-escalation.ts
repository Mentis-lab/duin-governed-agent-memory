// raw-escalation.ts — Apply/Retrieval: cheap fact-index → raw-source escalation
// when recall is thin (TierMem). PURE decision + PURE render; the file reads live
// in the caller (agui-grounding) behind the same env switch.
//
// The index answers most turns from cheap chunk SNIPPETS. But when the top hits are
// weak (low score) the snippet is a lossy summary of a source that might actually
// hold the answer — TierMem's finding is to ESCALATE a thin cheap-tier recall to the
// raw source rather than answer from a weak snippet. This selects the top distinct
// hit files to pull raw, and only when recall is genuinely thin (so a confident turn
// pays no extra read). Complements uncertainty-gate.ts: that decides WHETHER to
// recall at all; this decides whether a thin recall should be DEEPENED to source.
//
// Wired behind DUIN_RECALL_ESCALATE (default OFF → no raw read, byte-identical as
// today, matching the file's other reversible env switches).

export interface RawEscalationInput {
  query: string
  /** This turn's retrieval hits. `score` is the retriever's RELATIVE rank score and
   *  is used ONLY for ordering; `rawScore` is the ABSOLUTE cosine-ish relevance and
   *  is the only field the escalate/confident decision may read. See the note on
   *  ESCALATE_MAX_SCORE for why conflating the two made this feature inert. */
  hits?: { file: string; score: number; rawScore?: number }[]
  /** Max distinct source files to escalate (bounds the extra read). Default 2. */
  maxFiles?: number
}

export interface RawEscalationDecision {
  /** true ⇒ pull the raw source for `files`. */
  escalate: boolean
  /** Distinct top-hit source files to read raw (highest score first, deduped). */
  files: string[]
  reason: 'thin-recall' | 'confident' | 'no-hits' | 'no-signal'
}

/** At/above this max ABSOLUTE hit relevance the snippets are strong enough — no raw
 *  read needed. Below it recall is thin and the top hits are deepened to source. Set
 *  above uncertainty-gate's THIN_RETRIEVAL_MAX (0.35): a turn can be worth recalling
 *  yet still weak enough to deepen. Both thresholds are calibrated against the
 *  cosine-ish [0,1] similarity the vector leg reports, NOT against SearchHit.score.
 *
 *  Why this was invisible: SearchHit.score reads like a relevance and the two legs
 *  DO produce absolute-ish scores, but fuseSearchHits scores by RRF rank index and
 *  then divides by the top score — so the best hit is exactly 1.0 on every turn,
 *  relevant or not. Comparing 1.0 >= 0.45 made escalateToRaw answer 'confident'
 *  unconditionally and the RAW SOURCE block was never emitted in production, while
 *  the unit tests passed because they hand-wrote plausible-looking scores that the
 *  real producer can never emit. Never reintroduce a `?? h.score` fallback here:
 *  that is precisely the conflation that killed the feature. */
const ESCALATE_MAX_SCORE = 0.45
const DEFAULT_MAX_FILES = 2

/**
 * Decide whether to escalate a thin recall to raw source, and which files. PURE.
 * Escalates only when there ARE hits (something to deepen) whose best score is weak.
 */
export function escalateToRaw(input: RawEscalationInput): RawEscalationDecision {
  const hits = (input.hits ?? []).filter((h) => h && typeof h.file === 'string' && h.file.trim())
  if (hits.length === 0) return { escalate: false, files: [], reason: 'no-hits' }

  // Decide on ABSOLUTE relevance only. Files matched lexically-only carry no rawScore
  // (BM25 has no absolute scale); they still compete for the read slots below, they
  // just don't get to vote on confidence.
  const absolute = hits.map((h) => h.rawScore).filter((s): s is number => Number.isFinite(s))
  // No absolute signal at all (vector search unavailable/cold) ⇒ we cannot tell a
  // thin recall from a strong one. Fail CLOSED: skip the extra read rather than
  // escalate blindly on every turn.
  if (absolute.length === 0) return { escalate: false, files: [], reason: 'no-signal' }

  const maxScore = Math.max(...absolute)
  if (maxScore >= ESCALATE_MAX_SCORE) return { escalate: false, files: [], reason: 'confident' }

  const cap = Number.isFinite(input.maxFiles as number) ? (input.maxFiles as number) : DEFAULT_MAX_FILES
  const seen = new Set<string>()
  const files: string[] = []
  for (const h of [...hits].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    if (seen.has(h.file)) continue
    seen.add(h.file)
    files.push(h.file)
    if (files.length >= cap) break
  }
  return { escalate: true, files, reason: 'thin-recall' }
}

/** PURE. Render the escalated raw-source block from already-read file contents.
 *  The caller reads the files (bounded) and passes {file, content}; empty input ⇒
 *  '' so a failed/blocked read simply adds nothing. */
export function renderRawEscalation(sources: { file: string; content: string }[]): string {
  const clean = sources.filter((s) => s && s.content && s.content.trim())
  if (clean.length === 0) return ''
  const blocks = clean.map((s) => `[raw: ${s.file}]\n${s.content.trim()}`)
  return (
    'RAW SOURCE (escalated — index recall was thin; read the source, not just the snippet):\n' +
    blocks.join('\n\n')
  )
}
