// cjk-tokens — the ONE CJK-aware tokenizer the lexical retrieval legs share.
//
// WHY. Chinese/Japanese text has no word delimiters, and the two naive answers both destroy ranking:
//
//   • SINGLE CHARACTERS (the old wholenote-ground `_TOK`, `[a-z0-9]+|[一-鿿]`) — every CJK token is
//     one character, and a single character occurs in nearly every note of a 39%-CJK vault. df → N,
//     so IDF = log(1 + (N-df+0.5)/(df+0.5)) collapses toward 0 and BM25 ranks on noise. Measured on
//     the live 1,130-note index: the query 风暴模拟器的合作现在是什么状态 produced 15 tokens with
//     df = 66…535 of N=1130 (median 332 — a third of the vault); Chinese paraphrase probes scored
//     0.000 recall@5 in the whole-note and graph-expand arms.
//   • WHOLE RUNS (claim-recall's old `\p{L}+`) — the opposite failure. A run bounded only by
//     punctuation is a whole clause, so it matches nothing short of an exact clause repeat, while
//     the few runs that DO collide are long enough (≥5 chars) to trip a "strong token" shortcut.
//
// Overlapping character BIGRAMS are the standard fix that needs no dictionary or segmenter: they
// carry real IDF (the same query's bigrams have df = 0…257, median 41) and any shared ≥2-character
// term yields a shared token. Within-word pairs like 器的 are unavoidable and harmless — they are
// simply common, so IDF discounts them, which is exactly what BM25 is for.
//
// Runs are delimited by anything that is neither a letter nor a digit, so a bigram can never span
// punctuation or a sentence boundary (ProjectA。渠道 → ProjectA | 渠道, never 月渠).
//
// PURE — no imports, no observable state (the `nonAsciiClass` map is a memo). Kept dependency-free
// so `local-brain/*` (which pulls in better-sqlite3) and `brain/*` can both import it without a
// cycle or a native dependency.
//
// Hand-rolled scan rather than a `\p{L}`-based regex: the property-escape regex costs ~285ms to
// tokenize the 12,793-chunk corpus vs ~94ms for this (~65ms for the single-character tokenizer it
// replaces), and whole-note BM25 re-tokenizes the whole corpus on every query.

/** Character classes the scanner assigns. */
const SEP = 0
const WORD = 1
const CJK = 2

/**
 * The un-delimited (CJK/kana) code-point ranges, as inclusive [lo, hi] pairs. The SINGLE source of
 * truth: `isCjkCode` below open-codes these for speed (it is the hot path), and `CJK_CLASS` renders
 * them as a regex character-class body for the slug/detector sites that need a class rather than a
 * tokenizer. `cjk-tokens.test.ts` proves the two agree across the whole BMP, so the duplication
 * cannot drift.
 *
 * U+30FB (・, katakana MIDDLE DOT) is deliberately EXCLUDED — it is a separator, not part of a word.
 * Measured on the live vault: it occurs 134 times across 9 real JP/CN notes, and treating it as a
 * letter emits junk bigrams that straddle it (ソーシング・プラットフォーム → …ング, グ・, ・プ, プラ…),
 * polluting the index with tokens that can never match a query. Same reasoning excludes U+3040
 * (unassigned) and U+309B–309C (free-standing kana sound marks).
 *
 * BMP only: astral-plane letters (CJK Ext B, math alphanumerics) are treated as separators, exactly
 * as the tokenizers this replaces did.
 */
export const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x3041, 0x30fa], // hiragana + katakana
  [0x30fc, 0x30ff], // katakana marks, minus U+30FB
  [0x3400, 0x4dbf], // CJK Unified Ext A
  [0x4e00, 0x9fff], // CJK Unified
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xff66, 0xff9f] //  halfwidth katakana + its voiced/semi-voiced marks
] as const

/**
 * Un-delimited (CJK/kana) script. Open-coded from CJK_RANGES for speed — this runs once per
 * character over the whole corpus on every whole-note BM25 query.
 */
function isCjkCode(c: number): boolean {
  return (
    (c >= 0x3041 && c <= 0x30fa) || // hiragana + katakana
    (c >= 0x30fc && c <= 0x30ff) || // katakana marks, minus U+30FB
    (c >= 0x3400 && c <= 0x4dbf) || // CJK Unified Ext A
    (c >= 0x4e00 && c <= 0x9fff) || // CJK Unified
    (c >= 0xf900 && c <= 0xfaff) || // CJK Compatibility Ideographs
    (c >= 0xff66 && c <= 0xff9f) //   halfwidth katakana (ｦ-ﾟ) + voiced marks
  )
}

/**
 * CJK_RANGES rendered as a regex character-class BODY (no enclosing brackets) — splice it into a
 * positive `[a-z0-9${CJK_CLASS}]` or negated `[^a-z0-9${CJK_CLASS}]` class via `new RegExp`.
 *
 * WHY THIS EXISTS ALONGSIDE `cjkTokens`. Roughly fifteen call sites do not tokenize at all — they
 * build SLUGS/ids (`replace(/[^a-z0-9…]+/g, '-')`) or split on a non-word class. Those historically
 * hard-coded the bare kanji range `一-鿿`, which excludes hiragana/katakana, so a pure-kana Japanese
 * title (まとめ, レポート) stripped to '' and collapsed onto the shared fallback id — silent id
 * COLLISIONS, no error. They need a character class, not a bigram tokenizer; this gives them one
 * that agrees exactly with the tokenizer's notion of "CJK letter".
 */
export const CJK_CLASS: string = CJK_RANGES.map(
  ([lo, hi]) => `${String.fromCharCode(lo)}-${String.fromCharCode(hi)}`
).join('')

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u
// Memo for non-ASCII, non-CJK code points (accented Latin, Cyrillic, and — the common case in a
// Chinese vault — CJK punctuation like 。、《》). Bounded by the BMP; a pure cache.
const nonAsciiClass = new Map<number, number>()

function classOf(s: string, i: number): number {
  const c = s.charCodeAt(i)
  // ASCII fast path. `s` is already lowercased, so uppercase letters cannot appear.
  if (c < 128) return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ? WORD : SEP
  if (isCjkCode(c)) return CJK
  let v = nonAsciiClass.get(c)
  if (v === undefined) {
    v = LETTER_OR_DIGIT.test(s[i]) ? WORD : SEP
    nonAsciiClass.set(c, v)
  }
  return v
}

export interface CjkTokenizeOptions {
  /** Minimum length of a kept Latin/numeric run (default 2 — single letters carry no signal). */
  minLatin?: number
  /** Stopwords dropped after tokenization. Only ever hits Latin runs; CJK bigrams are 2 chars. */
  stop?: ReadonlySet<string>
}

/**
 * Tokenize for lexical matching. Latin/numeric runs → whole lowercased words (length ≥ `minLatin`,
 * minus `stop`); CJK/kana runs → OVERLAPPING character bigrams; a lone CJK character (a one-char run
 * between punctuation) → itself, since there is no pair to form. Order-preserving and duplicates are
 * KEPT — BM25 needs term frequencies; call sites that want a set wrap it themselves.
 */
export function cjkTokens(s: string, opts: CjkTokenizeOptions = {}): string[] {
  const minLatin = opts.minLatin ?? 2
  const stop = opts.stop
  const str = (s ?? '').toLowerCase()
  const n = str.length
  const out: string[] = []
  let i = 0
  while (i < n) {
    const k = classOf(str, i)
    if (k === SEP) {
      i++
      continue
    }
    let j = i + 1
    while (j < n && classOf(str, j) === k) j++
    if (k === CJK) {
      // Overlapping bigrams; a single-character run has no pair, so it stands alone.
      if (j - i === 1) out.push(str.slice(i, j))
      else for (let p = i; p < j - 1; p++) out.push(str.slice(p, p + 2))
    } else if (j - i >= minLatin) {
      const w = str.slice(i, j)
      if (!stop?.has(w)) out.push(w)
    }
    i = j
  }
  return out
}

/** True when `s` contains any un-delimited (CJK/kana) script. */
export function hasCjk(s: string): boolean {
  for (let i = 0; i < s?.length; i++) if (isCjkCode(s.charCodeAt(i))) return true
  return false
}
