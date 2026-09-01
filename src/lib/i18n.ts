// i18n — UI language for the renderer.
//
// KEYED BY THE ENGLISH SOURCE STRING, not by an invented key like `settings.general.title`.
// That is a deliberate trade. Invented keys are tidier in the abstract, but they require
// every one of 169 components to be refactored BEFORE a single word can be translated,
// which is how a localization effort stalls at "the scaffolding is in". Keying by source
// means a component adopts `t()` one line at a time, an untranslated string renders as
// English rather than as `settings.general.title`, and the extractor can compute what is
// left because the keys ARE the strings it finds.
//
// The cost is real and worth naming: two identical English strings in different contexts
// must share a translation. Where that breaks, disambiguate with `tc(context, text)`.
//
// `settings.language` has existed in the UI since long before this file and drove NOTHING
// — the picker offered 中文 and 日本語 and changed nothing on screen. This is what makes
// that setting true.

import zh from '@/locales/zh.json'
import ja from '@/locales/ja.json'

export type UiLanguage = 'auto' | 'en' | 'zh' | 'ja'

type Dict = Record<string, string>
const DICTS: Record<string, Dict> = { zh: zh as Dict, ja: ja as Dict }

let active: UiLanguage = 'auto'
// Eager OS-language resolution: 'auto' is the shipped default, and when the persisted
// value IS that default, loadSettings()'s setUiLanguage('auto') changes nothing in the
// settings store — no subscriber re-renders. With `resolved` initialized to 'en', a
// zh/ja-OS cold start painted English and STAYED English until some unrelated state
// change happened to re-render the tree. Resolving at module load makes the first
// paint (onboarding included) already match the OS.
let resolved: string = resolveAuto()
if (typeof document !== 'undefined') {
  // Same stamp setUiLanguage applies — fonts, line-breaking and screen readers must
  // not spend the first frames on `lang="en"` when the UI is about to be CJK.
  document.documentElement.lang = resolved
}

/** Map the host locale onto a language we ship. Anything else falls back to English. */
function resolveAuto(): string {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator.language : ''
    const tag = (nav || '').toLowerCase()
    if (tag.startsWith('zh')) return 'zh'
    if (tag.startsWith('ja')) return 'ja'
  } catch {
    /* no navigator (tests) — English */
  }
  return 'en'
}

/** Set the UI language. 'auto' follows the OS. */
export function setUiLanguage(lang: UiLanguage | undefined): void {
  active = lang ?? 'auto'
  resolved = active === 'auto' ? resolveAuto() : active
  if (typeof document !== 'undefined') {
    // Real `lang` on <html>: it drives font fallback, line-breaking and hyphenation, and
    // screen-reader pronunciation. CJK breaks badly without it.
    document.documentElement.lang = resolved === 'en' ? 'en' : resolved
  }
}

/** The language actually in effect ('en' | 'zh' | 'ja'). */
export function uiLanguage(): string {
  return resolved
}

/**
 * Translate a UI string.
 *
 * Falls back to the English source, ALWAYS. A missing translation must render as readable
 * English, never as an empty string or a key — a half-translated screen is usable and a
 * screen full of blanks is not.
 */
export function t(text: string): string {
  if (resolved === 'en') return text
  return DICTS[resolved]?.[text] ?? text
}

/**
 * Translate a parameterized UI string. The KEY is the template itself, placeholders in
 * `{name}` form — `tf('Read {n} files', { n: 12 })` — so a translation can reorder the
 * placeholder freely (CJK measure-words, verb-final word order). Substitution happens
 * AFTER lookup: in the translation when one exists, else in the English template. An
 * unknown placeholder is left as-is rather than rendered as "undefined".
 */
export function tf(template: string, params: Record<string, string | number>): string {
  const base = resolved === 'en' ? template : (DICTS[resolved]?.[template] ?? template)
  return base.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
}

/**
 * Translate with a disambiguating context, for the case the source-string keying cannot
 * cover: the same English word needing different translations in different places
 * (e.g. "Open" the verb vs "Open" the state).
 */
export function tc(context: string, text: string): string {
  if (resolved === 'en') return text
  const dict = DICTS[resolved]
  return dict?.[`${context}|${text}`] ?? dict?.[text] ?? text
}

/** How complete each shipped language is — surfaced in Settings rather than guessed at. */
export function translationCoverage(): { lang: string; strings: number }[] {
  return Object.entries(DICTS).map(([lang, d]) => ({ lang, strings: Object.keys(d).length }))
}
