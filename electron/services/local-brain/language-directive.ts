// language-directive.ts — PURE rendering of the per-turn response-language directive.
//
// Kept in its own module (not inside agui-grounding) for the same reason active-skills.ts is:
// agui-grounding transitively imports server.ts → electron's `app`, so anything living there is
// untestable without an electron runtime. This is a pure string function with a real unit test.
//
// The directive is injected as a FLOOR-tier unit (never evicted by the context compiler) near the
// TOP of the grounding prompt, and its last clause is load-bearing: without "regardless of the
// language of the notes" the reply drifts into whatever language the RETRIEVED CONTEXT happens to be
// in — which, on a 39%-CJK vault, means an English question about Chinese notes gets answered in
// Chinese, and vice versa.
//
// SCOPE (deliberate): the directive governs the VISIBLE REPLY only. It does not try to force the
// model's reasoning channel into the target language, and it explicitly exempts code, paths,
// identifiers, tool names and JSON keys — localizing those degrades tool-calling.

import type { LanguageChoice } from '../../shared/chat-send-contract'

/** Human-facing name of each language, as it appears inside the directive. */
const LANGUAGE_LABEL: Record<LanguageChoice, string> = {
  en: 'English',
  zh: '简体中文 (Simplified Chinese)',
  ja: '日本語 (Japanese)'
}

/**
 * Render the response-language directive body for one turn.
 *
 * Returns `''` when no explicit language is chosen (`undefined`/`null` — the settings-level 'auto'
 * resolves to absent on the wire), so the default path emits nothing and the prompt is
 * byte-identical to today's. The three explicit choices each emit the directive; an unrecognized
 * value is treated as absent, failing safe to the byte-identical default rather than a malformed
 * block.
 */
export function renderLanguageDirective(lang?: LanguageChoice | null): string {
  if (!lang || !(lang in LANGUAGE_LABEL)) return ''
  const label = LANGUAGE_LABEL[lang]
  return (
    `RESPONSE LANGUAGE: reply in ${label}. Write ALL user-visible prose in this language ` +
    `regardless of the language of the notes, retrieved context, or instructions above. ` +
    `Keep code, file paths, identifiers, tool names, and JSON field names in their original form.`
  )
}
