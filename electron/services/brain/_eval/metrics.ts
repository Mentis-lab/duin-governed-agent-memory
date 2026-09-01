// Factorized multi-hop retrieval metrics (L6). PURE metric core — mirrors the
// rag/embeddings/_eval/scoring.ts idiom (pure scorers + unit tests; the live run
// is wired by the harness). The retriever change is only measurable if the three
// factors are reported SEPARATELY, never blended:
//   (1) supporting-fact recall@k — did retrieval surface the gold notes/sentences,
//   (2) answer EM / F1           — SQuAD-normalized, via an INJECTED reader,
//   (3) ALCE citation recall/precision — via an INJECTED support scorer (NLI in
//       prod, a token-overlap mock in tests): id-existence ≠ support.
//
// Design ref: PLANNING/DUIN_RETRIEVAL_MULTIHOP_FRONTIER_2026-07-14.md (lever L6):
// report sp-recall@k · answer-F1 · ALCE recall/precision, ablate 1/2/4 turns. The
// citation bar (:40) is the 57%-of-citations-don't-support gap — so the support
// judgement is a swappable head, never hardcoded here.

import { readNote, type Citation, type NoteText } from '../retrieve-agent'

// ──────────────────── factor 1: supporting-fact recall@k ────────────────────

/** A gold supporting fact: a note, optionally pinned to a 1-based sentence line. */
export interface SupportFact {
  note: string
  line?: number
}

/** 1-based rank of `gold` in `retrieved` (exact note-id match), 0 if absent.
 *  Mirrors scoring.ts:rankOf so the two eval modules read the same. */
export function rankOf(retrieved: string[], gold: string): number {
  const i = retrieved.indexOf(gold)
  return i < 0 ? 0 : i + 1
}

/**
 * Supporting-note recall@k: fraction of gold support notes present in the top-k
 * of the ranked retrieved list. `retrieved` is the citation array order (the
 * retriever's own confidence order). Total + pure: empty gold → 1 (nothing to
 * recall), empty retrieved → 0. Report at k ∈ {gold.length, 5, 10} so a plateau
 * is visible.
 */
export function supportingFactRecallAtK(retrieved: string[], gold: string[], k: number): number {
  if (gold.length === 0) return 1
  if (k <= 0) return 0
  const topK = new Set(retrieved.slice(0, k))
  const hit = gold.filter((g) => topK.has(g)).length
  return hit / gold.length
}

/** Alias kept for readers who think in "notes" — same function. */
export const supportNoteRecallAtK = supportingFactRecallAtK

/**
 * Sentence-level supporting-fact recall@k. A gold {note,line} is covered iff some
 * citation among the top-k is on that note AND its clamped [from,to] range spans
 * the gold line (a citation with NO line range is treated as covering the whole
 * note — a coarse hit, kept forgiving on purpose). Needs the Citation[] (which
 * carries `lines`), not just the id list.
 */
export function supportSentenceRecallAtK(citations: Citation[], gold: SupportFact[], k: number): number {
  if (gold.length === 0) return 1
  if (k <= 0) return 0
  const top = citations.slice(0, k)
  const covered = gold.filter((g) =>
    top.some(
      (c) => c.note === g.note && (g.line == null || !c.lines || (c.lines[0] <= g.line && g.line <= c.lines[1]))
    )
  ).length
  return covered / gold.length
}

// ──────────────────── factor 2: answer EM / F1 (SQuAD normalization) ────────────────────

/** SQuAD normalization: lowercase, strip punctuation, drop a/an/the, collapse ws. */
export function normalizeAnswer(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/\b(a|an|the)\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function asGoldList(golds: string | string[]): string[] {
  return Array.isArray(golds) ? golds : [golds]
}

/** Exact match: 1 iff the normalized prediction equals ANY normalized gold/alias. */
export function answerEM(pred: string, golds: string | string[]): number {
  const p = normalizeAnswer(pred)
  return asGoldList(golds).some((g) => normalizeAnswer(g) === p) ? 1 : 0
}

/** Multiset token overlap of two normalized strings → the count of shared tokens. */
function overlap(a: string[], b: string[]): number {
  const counts = new Map<string, number>()
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1)
  let common = 0
  for (const t of b) {
    const c = counts.get(t) ?? 0
    if (c > 0) {
      common++
      counts.set(t, c - 1)
    }
  }
  return common
}

function f1One(pred: string, gold: string): number {
  const pt = normalizeAnswer(pred).split(' ').filter(Boolean)
  const gt = normalizeAnswer(gold).split(' ').filter(Boolean)
  // SQuAD convention: if either side is empty, F1 is 1 only when BOTH are empty.
  if (pt.length === 0 || gt.length === 0) return pt.length === 0 && gt.length === 0 ? 1 : 0
  const common = overlap(pt, gt)
  if (common === 0) return 0
  const precision = common / pt.length
  const recall = common / gt.length
  return (2 * precision * recall) / (precision + recall)
}

/** Max token-overlap F1 of the prediction over all gold aliases. */
export function answerF1(pred: string, golds: string | string[]): number {
  return Math.max(0, ...asGoldList(golds).map((g) => f1One(pred, g)))
}

// ──────────────────── factor 3: ALCE citation recall / precision ────────────────────

/** The support judgement, INJECTED. premise = cited note text, claim = a statement.
 *  Prod: a MiniCheck-class NLI head. Tests: a token-overlap mock. Kept synchronous
 *  so the metric core is pure; an async NLI head is awaited by the harness before
 *  calling in (or wrap it — the type is the seam, not the model). */
export type SupportScorer = (premise: string, claim: string) => boolean

/** One answer statement + the cited premises resolved to their text. */
export interface CitedStatement {
  statement: string
  premises: { note: string; text: string }[]
}

const joinPremises = (ps: { text: string }[]): string => ps.map((p) => p.text).join('\n')

/**
 * ALCE citation recall (Gao et al., EMNLP 2023): a statement is supported iff the
 * CONCATENATION of all its cited premises entails it. recall = mean over
 * statements. A statement with no premises is unsupported (0).
 */
export function citationRecallStmts(stmts: CitedStatement[], scorer: SupportScorer): number {
  if (stmts.length === 0) return 0
  let supported = 0
  for (const s of stmts) {
    if (s.premises.length > 0 && scorer(joinPremises(s.premises), s.statement)) supported++
  }
  return supported / stmts.length
}

/**
 * ALCE citation precision: a citation c on statement s earns credit unless it is
 * IRRELEVANT/REDUNDANT — i.e. c alone does not support s AND s is still supported
 * after removing c. Precise iff (c alone supports s) OR (the full set supports s
 * AND removing c breaks that support). precision = precise citations / total.
 */
export function citationPrecisionStmts(stmts: CitedStatement[], scorer: SupportScorer): number {
  let total = 0
  let good = 0
  for (const s of stmts) {
    const full = joinPremises(s.premises)
    const fullSupports = s.premises.length > 0 && scorer(full, s.statement)
    for (const p of s.premises) {
      total++
      const alone = scorer(p.text, s.statement)
      const without = s.premises.filter((q) => q !== p)
      const stillWithout = without.length > 0 && scorer(joinPremises(without), s.statement)
      const precise = alone || (fullSupports && !stillWithout)
      if (precise) good++
    }
  }
  return total === 0 ? 0 : good / total
}

/**
 * Build one ALCE statement PER citation: the claim is the agent's own rationale
 * (`why`, falling back to `snippet`) and the premise is the cited span resolved
 * via readNote (clamped lines) — so precision measures exactly "does the cited
 * span support the claim the agent attached to it", the :40 gap. Keep the
 * statement source injectable via `statementOf` for the attended run (swap in a
 * reader's sentence).
 */
export function citationsToStatements(
  citations: Citation[],
  notes: NoteText[],
  statementOf: (c: Citation) => string = (c) => c.why || c.snippet
): CitedStatement[] {
  return citations.map((c) => ({
    statement: statementOf(c),
    premises: [{ note: c.note, text: readNote(notes, c.note, c.lines) }]
  }))
}

/** Convenience wrapper: ALCE recall over Citation[] with an injected scorer. */
export function citationRecall(citations: Citation[], notes: NoteText[], scorer: SupportScorer): number {
  return citationRecallStmts(citationsToStatements(citations, notes), scorer)
}

/** Convenience wrapper: ALCE precision over Citation[] with an injected scorer. */
export function citationPrecision(citations: Citation[], notes: NoteText[], scorer: SupportScorer): number {
  return citationPrecisionStmts(citationsToStatements(citations, notes), scorer)
}
