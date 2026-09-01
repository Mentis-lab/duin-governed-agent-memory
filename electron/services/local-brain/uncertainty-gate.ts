// uncertainty-gate.ts — Apply/Retrieval: inject operator-memory recall ONLY at
// uncertain or beneficial turns (ExpWeaver). PURE.
//
// The recall moat is not free: every injected recall block spends context and can
// distract the model on a turn that needed no memory at all (a bare "thanks", a
// one-word ack). ExpWeaver's finding is that recall helps precisely when the model
// is UNCERTAIN or the turn is BENEFICIAL to ground — and hurts when it isn't. This
// gate encodes that: it suppresses recall on trivial turns with confident/absent
// retrieval, and keeps it on for everything substantive or where retrieval is thin.
//
// Wired in agui-grounding behind DUIN_RECALL_UNCERTAINTY, default ON — this gate RUNS on a
// stock install. Set DUIN_RECALL_UNCERTAINTY=0 to revert to byte-identical grounding as
// before, matching the file's other reversible env switches. (This line read "default OFF"
// until 2026-08-03: the flag was flipped default-ON at the READ site in agui-grounding.ts
// and this header, one file away, was not touched — so the comment described the opposite of
// the shipped behaviour. flag-polarity-claims.test.ts now computes this polarity instead of
// trusting the prose.)
// When ON, a suppressed turn skips BOTH the query-relevant recall AND the whole-dump
// fallback, so a pleasantry gets minimal grounding instead of a full memory dump.

export interface UncertaintyGateInput {
  /** This turn's user query. */
  query: string
  /** Retrieval hits for this turn. `score` is the retriever's RELATIVE rank score and
   *  is NOT read here; `rawScore` is the ABSOLUTE cosine-ish relevance and is the only
   *  field the thin/confident decision may read. See THIN_RETRIEVAL_MAX for why
   *  conflating the two made the thin-retrieval arm unreachable. */
  hits?: { score?: number; rawScore?: number }[]
}

export interface UncertaintyDecision {
  /** true ⇒ inject recall (uncertain or beneficial turn). false ⇒ suppress it. */
  inject: boolean
  reason: 'empty-query' | 'pleasantry' | 'substantive' | 'thin-retrieval'
}

// Pleasantries / acknowledgements that carry no information need — recall on these
// is pure distraction. Anchored + whole-string so "hi there, about the ProjectA launch…"
// (a real query that merely opens with a greeting) is NOT caught.
//
// BILINGUAL by construction. A CJK ack of 1-2 codepoints ("好的") already reached the
// same verdict through the short-query arm below, but a 3+ codepoint one ("明白了",
// "わかりました") scored ≥3 estimated tokens and was mislabelled SUBSTANTIVE — while its
// latin twin ("got it") was caught here. That asymmetry is the defect class this lint-
// registered gate exists to prevent, so the alternation carries both scripts.
const TRIVIAL_RE =
  /^(hi|hello|hey|yo|hiya|thanks|thank you|thx|ty|ok|okay|k|kk|got it|gotcha|cool|nice|great|awesome|sure|yes|no|yep|nope|yeah|nah|np|done|perfect|谢谢|谢了|多谢|辛苦了|好|好的|好嘞|行|嗯|收到|明白|明白了|知道了|了解|懂了|可以|没问题|没事|不用了|ありがとう|ありがとうございます|了解です|はい|わかりました|大丈夫|감사합니다|알겠습니다|네|👍|🙏|😊)[\s!.,。！?？、～，．]*$/i

/** Below this max ABSOLUTE hit relevance, retrieval is "thin" — the model is likely
 *  uncertain and operator memory could disambiguate, so recall is beneficial even on
 *  a short turn. Calibrated against the cosine-ish similarity the vector leg reports
 *  (SearchHit.rawScore), NOT against SearchHit.score.
 *
 *  Why the score-vs-rawScore conflation was invisible: SearchHit.score reads like a
 *  relevance, but fuseSearchHits scores by RRF rank index and then divides by the top
 *  score — so the best hit is exactly 1.0 on every turn, relevant or not. Comparing
 *  1.0 < THIN_RETRIEVAL_MAX made thinRetrieval false whenever ANY hit existed, so the
 *  compensating "even a short turn injects when retrieval is thin" arm could only fire
 *  on an empty vault. A short non-pleasantry question ("Beacon?") was therefore
 *  labelled a pleasantry and lost BOTH the query-relevant recall AND the whole-dump
 *  fallback (agui-grounding gates the fallback on the same `uncertaintySkip`).
 *  Identical to the bug that made escalateToRaw inert; same remedy. Never reintroduce
 *  a `?? h.score` fallback here — that conflation IS the defect.
 *
 *  ── RECALIBRATED 2026-08-03: 0.35 → 0.432 (measured, not intuited) ──
 *  Fixing the conflation was necessary but NOT sufficient: 0.35 sits BELOW THE ENTIRE
 *  OBSERVED rawScore RANGE, so the arm stayed unfireable on any real input. The
 *  distribution is the one measured over this operator's real index (12,798 vectors,
 *  multilingual-e5-small) and written down in evidence-gate.ts — e5 similarity is
 *  COMPRESSED, so the usable band is ~[0.39, 0.74], not [0, 1]:
 *
 *      class          n    min    p25    med    p75    max
 *      on-corpus     90   0.436  0.505  0.538  0.577  0.744
 *      OFF-corpus    18   0.387  0.414  0.430  0.466  0.495
 *
 *  Read for THIS gate, whose false positive costs context and whose false negative
 *  costs the operator's memory for the turn (trip ⇒ INJECT):
 *
 *      t       spurious trips (on-corpus)   trips (off-corpus)
 *      0.35     0/90   (0.0%)               0/18   (0%)    <- BEFORE: arm cannot fire
 *      0.42     0/90   (0.0%)               6/18  (33%)
 *      0.432    0/90   (0.0%)              10/18  (56%)    <- AFTER: max zero-spurious
 *      0.46     3/90   (3.3%)              11/18  (61%)
 *
 *  0.432 is the LARGEST threshold at which no on-corpus turn is misread as thin, so it
 *  buys 10/18 off-corpus coverage for zero cost to confident turns. 0.46 would start
 *  injecting on genuinely well-retrieved turns, which is the spend this gate exists to
 *  avoid. Numerically equal to evidence-gate's EVIDENCE_FLOOR today because both are
 *  "max t with zero on-corpus crossings" over the SAME distribution — but the two are
 *  INDEPENDENTLY OWNED and deliberately not imported from each other: the gates have
 *  opposite error asymmetries, so re-deriving from the table beats copying a constant.
 *
 *  No embedder guard here (evidence-gate goes inert on an uncalibrated embedder; this
 *  file stays PURE and does not). That is safe in this direction only: a different
 *  embedding space shifts scores DOWN-looking, more turns read as thin, and the gate
 *  errs toward injecting recall — spending context, never losing grounding. */
const THIN_RETRIEVAL_MAX = 0.432

// ── Script-aware "is this a substantive question?" ───────────────────────────────
// The old test was `q.length >= 12 || q.split(/\s+/).length >= 3`. Both clauses are
// LATIN-SHAPED and both fail on Chinese/Japanese/Korean:
//
//   • CJK is written without word spaces, so `split(/\s+/).length` is 1 for a whole
//     sentence — "新作的发行档期定了吗" scores ONE "word".
//   • `q.length >= 12` counts CODEPOINTS, and a CJK codepoint carries roughly a whole
//     token, so 12 chars is a ~12-token sentence. For latin the same 12 chars is ~3
//     short words. The clause is therefore ~4× stricter in CJK than in latin.
//
// Net: a short Chinese question fell through to the short-query arm, and (before the
// recalibration above) the thin-retrieval arm could not fire either — so it lost BOTH
// the query-relevant recall AND the whole-dump fallback. Bilingual by construction now:
// count CJK codepoints as ~1 token each, whitespace-delimited runs as 1 token each, and
// make the raw-length backstop relative to the dominant script.

// language: structural — script CLASSIFICATION, not meaning. These match writing
// systems by Unicode property; there is nothing language-specific to enumerate, and a
// CJK alternation inside them would be meaningless.
const CJK_CODEPOINT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
// language: structural
const WORDLIKE_RE = /[\p{L}\p{N}]/u

/** Rough token count that does not assume spaces exist. PURE. Exported for the tests,
 *  which pin latin/CJK PAIRS of the same question against the same verdict. */
export function estimateTokens(q: string): number {
  const cjk = (q.match(CJK_CODEPOINT_RE) ?? []).length
  // Blank out the CJK we already counted, then take whitespace-delimited runs that
  // contain at least one letter/digit (so "?", "—" and stray punctuation don't count).
  const rest = q.replace(CJK_CODEPOINT_RE, ' ').trim()
  const words = rest ? rest.split(/\s+/).filter((w) => WORDLIKE_RE.test(w)).length : 0
  return cjk + words
}

/** Minimum raw codepoint length for the length backstop, RELATIVE to the script. 12 for
 *  latin (~3 short words); 4 for CJK-dominant text, where 4 codepoints already carry the
 *  same ~4 tokens. Deliberately NOT 3: a bare 2-3 char entity lookup ("新作?") should
 *  route to the thin-retrieval arm exactly as its latin twin ("Acme?") does. */
function minSubstantiveChars(q: string): number {
  const cjk = (q.match(CJK_CODEPOINT_RE) ?? []).length
  return cjk * 2 >= q.replace(/\s+/g, '').length ? 4 : 12
}

/** Does this query carry a real information need (as opposed to a bare lookup)? PURE. */
export function isSubstantive(q: string): boolean {
  return estimateTokens(q) >= 3 || q.length >= minSubstantiveChars(q)
}

/**
 * Decide whether to inject recall this turn. PURE. Suppresses only when the turn is
 * BOTH trivial (empty / pleasantry) — a substantive query always injects, and even a
 * short turn injects when retrieval is thin (uncertain).
 */
export function shouldInjectRecall(input: UncertaintyGateInput): UncertaintyDecision {
  const q = (input.query ?? '').trim()
  if (!q) return { inject: false, reason: 'empty-query' }

  const hits = input.hits ?? []
  // Decide on ABSOLUTE relevance only. Files matched lexically-only carry no rawScore
  // (BM25 has no absolute scale), as do synthetic hits (graph neighbours); they simply
  // don't vote on confidence.
  const absolute = hits.map((h) => h?.rawScore).filter((s): s is number => Number.isFinite(s))
  // No hits, or no absolute signal at all (vector search unavailable/cold, or a purely
  // lexical match) ⇒ we cannot tell a thin recall from a strong one. Fail OPEN: treat
  // it as thin and inject. This is the OPPOSITE posture to raw-escalation's fail-closed
  // and deliberately so — there an unknown costs a spare file read, here it costs the
  // operator's entire memory + the whole-dump fallback for the turn. Losing grounding
  // is the expensive error; spending context is the cheap one.
  const thinRetrieval = absolute.length === 0 || Math.max(...absolute) < THIN_RETRIEVAL_MAX

  if (TRIVIAL_RE.test(q)) {
    // A pleasantry is beneficial to ground ONLY if retrieval is thin (the model may
    // be about to answer something it's uncertain about). Confident retrieval on a
    // pleasantry ⇒ suppress.
    return thinRetrieval
      ? { inject: true, reason: 'thin-retrieval' }
      : { inject: false, reason: 'pleasantry' }
  }

  // Substantive query (enough tokens, or non-trivial length for its script) ⇒ always beneficial.
  if (isSubstantive(q)) return { inject: true, reason: 'substantive' }

  // Short, non-pleasantry query: inject when retrieval is thin (uncertain), else it's
  // a confident short lookup that needs no operator memory.
  return thinRetrieval
    ? { inject: true, reason: 'thin-retrieval' }
    : { inject: false, reason: 'pleasantry' }
}
