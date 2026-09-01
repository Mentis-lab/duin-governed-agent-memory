// evidence-gate.ts — answer-path evidence sufficiency. Does retrieval actually support answering
// this question, or is the model about to ground on noise? PURE.
//
// WHY THIS EXISTS. DUIN has never had an abstention path on the answer side. `search()` applies NO
// relevance threshold by design ("the caller wants the best available context injected regardless of
// absolute score"), so it always returns k hits however irrelevant, and the model always receives
// them formatted as relevant context. Measured consequence: across the 200-question LoCoMo run,
// 53 of 53 failures were CONFIDENTLY WRONG — not one abstention. On a personal knowledge base that
// is the expensive failure mode: a system that is confidently wrong about the operator's own notes,
// with no uncertainty signal, teaches uniform trust where uniform trust is not warranted.
//
// NOT to be confused with uncertainty-gate.ts, which decides whether to inject operator-MEMORY
// RECALL. That gate is about context spend; this one is about answer discipline. They read the same
// field and nothing else in common.
//
// ── CALIBRATION (2026-07-28, measured — do NOT change these numbers by intuition) ──
// Best-hit rawScore distribution over the real dogfood-vault index (12,798 vectors, multilingual-e5-small):
//
//     class          n    min    p25    med    p75    max
//     on-verbatim   45   0.451  0.502  0.543  0.588  0.744   (query is a phrase from the gold note)
//     on-title      45   0.436  0.507  0.534  0.566  0.646   (query is the note title — harder)
//     OFF-corpus    18   0.387  0.414  0.430  0.466  0.495   (answerable by nothing in the vault)
//
// Two things follow, both counter-intuitive enough that they must be written down:
//
//  1. e5 similarity is COMPRESSED. A perfect match scores ~0.74 and a totally unrelated query still
//     scores ~0.43. The usable band is roughly [0.39, 0.74], NOT [0, 1]. Any threshold chosen by
//     intuition on a 0-1 scale will be far too low to ever fire — which is exactly what happened to
//     uncertainty-gate's THIN_RETRIEVAL_MAX = 0.35: measured against this distribution it fires on
//     0/90 on-corpus AND 0/18 off-corpus queries. It is not merely mis-tuned, it is BELOW THE ENTIRE
//     OBSERVED RANGE and cannot fire on any input. (That is a second, independent defect from the
//     score-vs-rawScore conflation its own comments describe.)
//
//  2. The separation is REAL but NARROW (on-min 0.436 vs off-max 0.495 — the classes overlap). So
//     this gate hedges, it never refuses: a thin turn appends a caveat telling the model to say
//     plainly that it may not have the answer. A hard refusal on a signal this soft would trade
//     confident-wrong for confidently-unhelpful, which is not an improvement.
//
//     t       false-abstain (on-corpus)   caught (off-corpus)
//     0.42     0/90   (0.0%)               6/18  (33%)
//     0.432    0/90   (0.0%)              10/18  (56%)   <- EVIDENCE_FLOOR: max zero-false-abstain
//     0.46     3/90   (3.3%)              11/18  (61%)
//     0.50    18/90  (20.0%)              18/18 (100%)
//
// Calibrated at the maximum threshold with ZERO false abstentions on 90 real on-corpus queries.
// Deliberately conservative: a false abstention (refusing to use knowledge DUIN actually has) is
// worse than a missed abstention, because it degrades the thing the operator relies on.

/** Max best-hit rawScore at which evidence counts as too thin to answer confidently. See the
 *  calibration table above. EMBEDDER-SPECIFIC — see EVIDENCE_CALIBRATED_EMBEDDER. */
export const EVIDENCE_FLOOR = 0.432

/** The embedder this floor was calibrated against. A similarity threshold is only meaningful for the
 *  embedding space it was measured in: bge-m3 or bge-small produce a different distribution, so the
 *  same number would mean something else. The gate goes INERT rather than act on a stale constant —
 *  this guard is here because "constant tuned against one corpus/model, never rechecked" has already
 *  cost measured recall in this codebase more than once (see graph-expand-adapt.ts). */
export const EVIDENCE_CALIBRATED_EMBEDDER = 'multilingual-e5-small'

export interface EvidenceInput {
  /** This turn's retrieval hits. ONLY `rawScore` is read — `score` is the top-normalized RRF rank
   *  score, so the best hit is exactly 1.0 on every turn and a threshold on it can never fire.
   *  Never add a `?? h.score` fallback: that conflation is the defect, not a convenience. */
  hits?: { rawScore?: number }[]
  /** The embedder that produced the index. Mismatch/absent ⇒ the gate goes inert. */
  embedderId?: string | null
}

export interface EvidenceAssessment {
  /** false ⇒ retrieval does not support a confident answer this turn */
  sufficient: boolean
  /** best absolute relevance seen, or null when no absolute signal was available */
  bestAbsolute: number | null
  reason: 'ok' | 'thin' | 'no-hits' | 'no-absolute-signal' | 'uncalibrated-embedder'
}

/**
 * Assess whether retrieval supports answering. PURE.
 *
 * Posture is FAIL-OPEN on missing signal and fail-closed only on positive evidence of thinness:
 * abstention must be EARNED by seeing low relevance, never triggered by the absence of information.
 * A purely lexical match carries no rawScore (BM25 has no absolute scale) and must not be read as
 * "thin" — that would abstain on exactly the CJK exact-term hits the lexical leg exists to catch.
 */
export function assessEvidence(input: EvidenceInput): EvidenceAssessment {
  if (input.embedderId !== EVIDENCE_CALIBRATED_EMBEDDER) {
    return { sufficient: true, bestAbsolute: null, reason: 'uncalibrated-embedder' }
  }
  const hits = input.hits ?? []
  if (hits.length === 0) return { sufficient: false, bestAbsolute: null, reason: 'no-hits' }

  const absolute = hits.map((h) => h?.rawScore).filter((s): s is number => Number.isFinite(s))
  if (absolute.length === 0) {
    return { sufficient: true, bestAbsolute: null, reason: 'no-absolute-signal' }
  }
  const best = Math.max(...absolute)
  return best < EVIDENCE_FLOOR
    ? { sufficient: false, bestAbsolute: best, reason: 'thin' }
    : { sufficient: true, bestAbsolute: best, reason: 'ok' }
}

const THIN_CAVEAT =
  '\n\n[evidence check] The retrieved notes above are only weakly related to this question — the ' +
  'local index may not contain the answer. If the notes do not actually support an answer, say so ' +
  'plainly and briefly (e.g. "I don\'t have this in your notes") instead of inferring one from them. ' +
  'If they do support it, answer normally; do not hedge unnecessarily.'

const NO_HITS_CAVEAT =
  '\n\n[evidence check] Retrieval returned nothing from the local index for this question. Say ' +
  'plainly that it is not in the notes rather than answering from general knowledge as if it were.'

/**
 * The prompt fragment for a thin turn. Empty string when evidence is sufficient, so a confident turn
 * is byte-identical to today. Instructs the model to be honest about a gap — it does NOT forbid
 * answering, because the signal is too soft to justify a hard refusal (see calibration note).
 */
export function evidenceCaveat(a: EvidenceAssessment): string {
  if (a.sufficient) return ''
  return a.reason === 'no-hits' ? NO_HITS_CAVEAT : THIN_CAVEAT
}

/** Whether the answer-path evidence gate is enabled.
 *
 *  DEFAULT ON since 2026-07-28 (was opt-in). The polarity flipped on the operator's instruction
 *  that shipped work must not sit behind a default-off flag, and the risk profile supports it: on a
 *  well-grounded turn `evidenceCaveat` returns '' so the prompt is byte-identical to before, the
 *  caveat only ever ADDS a line asking for honesty about a gap, and it never refuses to answer.
 *  The thresholds are measured on the real vault (see the calibration block above), not guessed.
 *
 *  Set DUIN_EVIDENCE_GATE=0 to opt out. Staging flag, not a safety gate — it governs one prompt
 *  fragment, never enactment or permissions. Same polarity as entityGraphEnabled(). */
export function evidenceGateEnabled(): boolean {
  return process.env.DUIN_EVIDENCE_GATE !== '0'
}
