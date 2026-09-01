// label-sanity — refuse to mint a graph node whose label is byte-level corrupt.
//
// WHY THIS EXISTS (measured 2026-08-03, live vault, 8,582 entity nodes):
// three `project` nodes carried labels that are UTF-8 bytes decoded as GBK —
// `3DM骞冲彴`, `骞垮窞鍔ㄦ极娓告垙鐩涘吀`, `IP鍑虹増鍚堜綔鏂规璁ㄨ` — which decode cleanly back to
// `3DM平台`, `广州动漫游戏盛典`, `IP出版合作方案讨论`. Two more were the same corruption plus a cut
// mid-character, and one of those decoded to a partial form of the OPERATOR'S OWN person label —
// the identity the whole graph hangs off. (The corrupted forms are not reproduced here: this file
// is production source and the operator denylist rightly refuses operator PII in it. The live
// examples are in `label-sanity.test.ts`, which the leak scan excludes.)
//
// The corruption is NOT in the vault: all 2,056 files were scanned and it appears in no filename
// and no note body — only in `.brain/state/brain-construction.json` and the node table. So it was
// produced downstream, by the local extraction model, and persisted unvalidated.
//
// Why it matters more than five rows: each corrupt label is a DUPLICATE IDENTITY of a healthy
// node (`3DM平台` and `广州动漫游戏盛典` both exist correctly; the operator's own person node exists
// as `person:theo-quill` with degree 800). And the auto-merge can never clean them up, because it matches on
// embedding similarity and lexical containment — garbled bytes are near nothing. They accumulate
// on the rim forever.
//
// LIMITS (property 5): RECOVERY is best-effort and sometimes partial — the table is built from the
// 2-byte GBK space, so a label containing a character whose GB18030 form is 4 bytes (e.g. the
// Japanese kanji `増`) recovers only the runs around it. DETECTION is the contract; the recovered
// string is a diagnostic for the log and nothing branches on it.
// This catches exactly two shapes — UTF-8-read-as-GBK, and text carrying the
// Unicode replacement character or a lone surrogate. It is NOT a general encoding validator and
// it makes no claim about labels that are merely odd. It is deliberately high-precision: a
// legitimate Chinese label does not round-trip through GBK into DIFFERENT valid Chinese, which is
// what makes the test safe to act on rather than merely advisory.

/** char -> GBK byte pair, built once from the 2-byte GBK space using the platform decoder.
 *  `iconv-lite` is only a transitive dependency here, so it is deliberately not used. */
let CHAR_TO_GBK: Map<string, [number, number]> | null = null

function gbkTable(): Map<string, [number, number]> {
  if (CHAR_TO_GBK) return CHAR_TO_GBK
  const m = new Map<string, [number, number]>()
  try {
    const dec = new TextDecoder('gbk')
    for (let hi = 0x81; hi <= 0xfe; hi++) {
      for (let lo = 0x40; lo <= 0xfe; lo++) {
        if (lo === 0x7f) continue // not a valid GBK trail byte
        const ch = dec.decode(new Uint8Array([hi, lo]))
        // one char, and not the decoder's failure marker
        if (ch.length === 1 && ch !== '�' && !m.has(ch)) m.set(ch, [hi, lo])
      }
    }
  } catch {
    // no GBK decoder on this platform — the detector degrades to the replacement-char check only
  }
  CHAR_TO_GBK = m
  return m
}

const HAS_CJK = /[㐀-䶿一-鿿]/

/**
 * The precision gate, and the reason this file is not a one-way decode.
 *
 * A one-way test — "these characters, read as GBK bytes, happen to be shorter valid UTF-8 Chinese"
 * — FIRES ON ORDINARY CHINESE. Measured 2026-08-03 against the live graph: it flagged 96 of 8,582
 * labels — ordinary university, venue, product-version and studio names. Two GBK bytes per
 * char against three UTF-8 bytes per CJK char means a coincidental valid-and-shorter decode is
 * common, not rare. Acting on that would have deleted 96 real nodes.
 *
 * So the test is a BIJECTION instead: corrupt the recovered text the same way the pipeline did
 * (UTF-8 bytes read as GBK) and require it to reproduce the input EXACTLY. Real mojibake is the
 * image of a real string under that map; a coincidence is not, and does not survive the round trip.
 */
function recorrupts(recovered: string, original: string): boolean {
  try {
    const utf8 = new TextEncoder().encode(recovered)
    const asGbk = new TextDecoder('gbk').decode(utf8)
    return asGbk === original
  } catch {
    return false
  }
}

/**
 * If `label` is UTF-8 bytes that were decoded as GBK, return the recovered text; otherwise null.
 * PURE. The round-trip is the whole test: re-encode to the GBK bytes the characters came from,
 * then read those bytes as UTF-8. Real Chinese does not survive that into different valid Chinese.
 */
// Third and final gate, and the one that makes this safe to ACT on.
//
// The bijection test alone still flagged `ATE 自动测试设备`: the corruption map is a bijection, so
// any string that happens to sit in its image round-trips perfectly, coincidence or not. What
// actually separates the two is the ALPHABET. When UTF-8 Chinese (lead bytes E4–E9) is read as
// GBK, the characters produced land overwhelmingly in U+9200–U+9FFF — obscure variants that real
// modern Chinese effectively never uses (`鍑` U+9351, `鏂` U+93C2, `鐩` U+9429). Ordinary labels
// are built from common blocks (`自` U+81EA, `动` U+52A8, `测` U+6D4B) and contain none.
//
// It runs LAST, as a tiebreaker: the bijection above already eliminated 95 of the 96, and this
// settles the remainder. One band character is enough precisely because it is the last gate, not
// the first — `珠海长隆` contains `长` (U+957F, in band) and is kept because it fails the bijection.
// The asymmetry is deliberate throughout: a false negative leaves one bad node on the rim, a false
// positive destroys a real one. Those costs are not comparable.
const MOJIBAKE_BAND = /[鈀-鿿]/g
function hasMojibakeAlphabet(s: string): boolean {
  return (s.match(MOJIBAKE_BAND) ?? []).length >= 1
}

export function recoverMojibake(label: string): string | null {
  if (!label || !HAS_CJK.test(label)) return null
  if (!hasMojibakeAlphabet(label)) return null
  const table = gbkTable()
  if (table.size === 0) return null
  const bytes: number[] = []
  for (const ch of label) {
    const pair = table.get(ch)
    if (pair) { bytes.push(pair[0], pair[1]); continue }
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x80) { bytes.push(code); continue }
    return null // a character with no GBK byte pair — cannot be this corruption
  }
  const buf = new Uint8Array(bytes)
  // Clean case: the bytes are wholly valid UTF-8 and we recover the original exactly.
  try {
    const out = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    // A genuine recovery is shorter (3 UTF-8 bytes collapse to 1 char), still Chinese, and different.
    if (out !== label && out.length < label.length && HAS_CJK.test(out) && recorrupts(out, label)) return out
    return null
  } catch {
    // Not wholly valid UTF-8. That is NOT a clean bill of health: one of the three labels found in
    // production (`IP鍑虹増鍚堜綔鏂规璁ㄨ`) is mojibake AND cut mid-character — its byte stream ends on a
    // lone `e8`, the start of a `论` that never arrived. A strict decode refuses it and would have
    // reported the label clean, so detection must not depend on full recoverability.
    const lossy = new TextDecoder('utf-8').decode(buf) // non-fatal: bad tail becomes U+FFFD
    const solid = lossy.replace(/�/g, '')
    if (solid.length < 2 || solid.length >= label.length || !HAS_CJK.test(solid)) return null
    // A RECOVERY is coherent text; noise is not. Two live labels reached this point with
    // "recoveries" of `�麣��¡` and `��ʫҢ BW ����Ȩ���嵥` — Latin-1 rubble with a stray CJK char,
    // which is exactly what a non-recovery looks like. Require the surviving run to be
    // predominantly Chinese, which the genuine cases are (`广州动漫游戏盛典` 100%,
    // `IP出版合作方讨` 75%) and the coincidences are not (~12% and 50%).
    const cjkCount = (solid.match(/[㐀-䶿一-鿿]/g) ?? []).length
    if (cjkCount / solid.length < 0.6) return null
    // Same precision gate as the clean branch, adapted: bytes were genuinely lost here, so an exact
    // round trip is impossible. Require instead that re-corrupting the part that DID survive
    // reappears inside the input. A coincidence does not satisfy even this weaker form.
    try {
      const back = new TextDecoder('gbk').decode(new TextEncoder().encode(solid))
      if (!label.includes(back.slice(0, Math.min(4, back.length)))) return null
    } catch {
      return null
    }
    return lossy
  }
}

/** Text that lost bytes in transit: the replacement char, or an unpaired surrogate. */
export function hasLostBytes(label: string): boolean {
  if (label.includes('�')) return true
  for (let i = 0; i < label.length; i++) {
    const c = label.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) { // high surrogate must be followed by a low one
      const n = label.charCodeAt(i + 1)
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) return true // lone low surrogate
  }
  return false
}

export interface LabelVerdict {
  ok: boolean
  /** why it was refused — surfaced so a dropped node is explainable, never silent */
  reason?: 'mojibake' | 'lost-bytes' | 'not-a-name'
  /** the recovered text when the corruption was reversible (logged, not silently substituted) */
  recovered?: string
}

// ────────────────────────────────────────────────────────────────────────────
// Is this string a NAME, or is it a fragment of a sentence about a name?
//
// Measured on the live graph 2026-08-03: a large share of entity_nodes are not entities.
// "The goal for DUIN", "a memory upgrade for DUIN", "confidence signal to Bilibili",
// "a FRESH Claude session that did NOT build DUIN", "many organizations including
// playstation, xbox, bilibili", and one node that is a Windows filesystem path. Most carry
// one or two edges, so they add nothing but noise to every entity count, every dedup score,
// and the operator's own sense of how much is in their brain.
//
// PRECISION OVER RECALL, deliberately. A false positive here DELETES a real entity from the
// graph, so every rule below fires only on evidence no real name carries. When in doubt the
// label is minted — a junk node is cheap and reversible; a missing one is invisible.
//
// LIMITS THIS DOES NOT CATCH (property 5 — state them where the mechanism lives):
//   · CJK sentence fragments. Chinese has no inter-word spaces, so the space-delimited
//     signals below cannot see them. "与B站联合承办美林试玩会" is a clause, reads as a
//     13-character label, and passes. Catching those needs segmentation, not regex.
//   · Plausible-but-wrong names. "Bilibili Marketing Center" is well-formed whether or not
//     such a department exists; only the corpus can settle that.
//   · Duplicate spellings of one real entity (four transliterations of one person). That is
//     an ALIAS problem, not a shape problem, and belongs to the alias-verdict layer.
// ────────────────────────────────────────────────────────────────────────────

/** A path or URL is never an entity name. `C:\...\Programs\DUIN` was a real node. */
const PATH_LIKE = /^[a-zA-Z]:[\\/]|:\/\/|^\\\\/

/** Lowercase leading article. No real name begins "a " or "an " in lower case. */
const LEADING_ARTICLE = /^(?:a|an) [a-z]/

/**
 * Function words that join a CLAUSE. A proper noun may contain "of", "the" or "and"
 * ("Bank of China", "The Verge", "Marks and Spencer"), so those are absent here on purpose —
 * only words that require a surrounding sentence qualify.
 */
const CLAUSE_WORD = /\b(?:that|which|whether|because|including|instead of|rather than|did not|does not|do not)\b/i

/**
 * Three or more comma-separated items is an enumeration, not a name — but a comma between
 * digits is a thousands separator, and `USD 50,000,000` is a real label in this graph. Require
 * a non-digit on at least one side of each comma.
 */
const ENUMERATION = /(?<!\d),(?!\d)[^,]+(?<!\d),(?!\d)/

/** Longer than any real label observed in this graph; the longest legitimate one is ~40. */
const MAX_LABEL_CHARS = 80

/**
 * Prose signal of last resort: a LONG phrase carrying SEVERAL lowercase joiners.
 *
 * Either half alone is a bad rule — "Bank of China" has a joiner, "Bilibili Game Cooperation
 * Dept" is multi-word — so neither fires on its own. Together they describe a clause and not a
 * name: the longest real org label in this graph is four words, while the junk runs to seven
 * ("arena-first organization with cross-cutting material in DUIN/"). CJK is unaffected, since
 * it has no inter-word spaces to count.
 */
const JOINER = /^(?:of|for|with|in|on|to|at|from|and|the|a|an|by|about|into|as)$/
const MIN_PROSE_WORDS = 6
const MIN_PROSE_JOINERS = 2

function readsAsProse(s: string): boolean {
  const words = s.split(/\s+/).filter(Boolean)
  if (words.length < MIN_PROSE_WORDS) return false
  let joiners = 0
  let titled = 0
  let content = 0
  for (const w of words) {
    if (JOINER.test(w)) {
      joiners++
      continue
    }
    // Content words only: joiners are lowercase inside real names too ("Bank OF China").
    content++
    if (/^[A-Z一-鿿]/.test(w)) titled++
  }
  if (joiners < MIN_PROSE_JOINERS) return false
  // Title Case survives. "Embassy of P.R. China in Japan" is six words with two joiners and
  // would otherwise have been refused — a real 13-edge node deleted by a rule meant to remove
  // noise. Prose capitalises its first word and nothing else; a name capitalises throughout.
  return content > 0 && titled / content < 0.6
}

/** `true` when the string reads as prose about an entity rather than the entity's name. */
export function looksLikeSentence(label: string): boolean {
  const s = label.trim()
  if (!s) return false
  if (s.length > MAX_LABEL_CHARS) return true
  if (PATH_LIKE.test(s)) return true
  if (LEADING_ARTICLE.test(s)) return true
  if (CLAUSE_WORD.test(s)) return true
  if (ENUMERATION.test(s)) return true
  if (readsAsProse(s)) return true
  return false
}

/** The seam guard. `ok:false` means: do not mint this node. */
export function checkLabel(label: string | null | undefined): LabelVerdict {
  const s = String(label ?? '')
  if (!s) return { ok: true } // empty is someone else's problem
  if (hasLostBytes(s)) return { ok: false, reason: 'lost-bytes' }
  const rec = recoverMojibake(s)
  if (rec) return { ok: false, reason: 'mojibake', recovered: rec }
  if (looksLikeSentence(s)) return { ok: false, reason: 'not-a-name' }
  return { ok: true }
}
