// content-language.ts — best-effort dominant-language detection, used to PIN the free-text OUTPUT of
// an extraction/synthesis pass to the language of the source content.
//
// WHY. The knowledge-extraction passes (notes-extract, contrast-extraction, consolidation-synthesis)
// run English system prompts. Fed Chinese or Japanese notes, a capable model still tends to emit the
// extracted rule/summary/label in ENGLISH. That is not merely cosmetic: the artifact it writes back
// is then in a different language from the notes it came from, so it no longer shares lexical tokens
// with them — and every lexical retrieval leg in this codebase is bigram/word overlap over exactly
// those tokens (see [[cjk-tokens]]). A CN/JP vault therefore accumulates English knowledge artifacts
// that are progressively harder to retrieve from the notes that produced them. Appending one line
// that pins free-text output to the source language closes that gap.
//
// SCOPE (deliberately narrow): only free-text OUTPUT (rules, summaries, labels) is pinned. Ids,
// dates, enum values, file paths and JSON keys stay exactly as the prompt specifies, because
// localizing those breaks parsing downstream. English/other content yields an EMPTY directive, so
// those prompts stay byte-identical and the existing English fixtures cannot move.

import { hasCjk } from './cjk-tokens'

// Kana is what marks Japanese unambiguously: hiragana (U+3041–309F) + katakana (U+30A1–30FA and
// U+30FC–30FF) + halfwidth katakana (U+FF66–FF9F). Kanji alone cannot separate CN from JP — the two
// share the script — so the presence of kana is the only cheap, dependency-free JP tell.
//
// U+30FB (・) and U+30A0 (゠) are EXCLUDED, and that exclusion is load-bearing rather than tidy: both
// are katakana-block PUNCTUATION, and ・ in particular is used freely in CHINESE to separate
// transliterated foreign names (维克多·雨果). A naive `゠-ヿ` span swallows it, so a pure-Chinese —
// or even pure-punctuation — string reports as Japanese and gets pinned to the wrong language. The
// tokenizer in [[cjk-tokens]] excludes U+30FB for the same reason.
const KANA_RE = /[ぁ-ゟァ-ヺー-ヿｦ-ﾟ]/

export type ContentLang = 'zh' | 'ja'

/**
 * Detect the content language for output-pinning: any kana → Japanese; else any CJK (kanji) →
 * Chinese; else null (English/other → no pin).
 *
 * A heuristic, and knowingly so. Kanji-only Japanese (rare outside headlines and proper nouns) reads
 * as `zh`; a Chinese note quoting a Japanese product name reads as `ja`. Both are acceptable: the
 * directive only nudges the OUTPUT language, never the structure, so a wrong guess costs a
 * mis-languaged summary, not a parse failure.
 */
export function detectContentLang(text: string): ContentLang | null {
  if (!text) return null
  if (KANA_RE.test(text)) return 'ja'
  if (hasCjk(text)) return 'zh'
  return null
}

const LABEL: Record<ContentLang, string> = {
  zh: '简体中文 (Simplified Chinese)',
  ja: '日本語 (Japanese)'
}

/**
 * A one-line directive pinning free-text output to the content's language, or `''` for
 * English/other. Callers append it to an extraction/synthesis prompt, and MUST treat `''` as "append
 * nothing" so the English path stays byte-identical.
 */
export function contentLanguageDirective(text: string): string {
  const lang = detectContentLang(text)
  if (!lang) return ''
  return (
    `Write all free-text output (rules, summaries, labels, short outcomes) in ${LABEL[lang]} — the ` +
    `language of the source content above — while keeping ids, dates, enum values, file paths, and ` +
    `JSON field names exactly as specified.`
  )
}
