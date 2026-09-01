// main-i18n — the main process's half of localization.
//
// WHY A SECOND ONE. `src/lib/i18n.ts` lives in the renderer and cannot be imported here: it
// touches `document`, and its language state is set by the renderer at boot. But a good deal of
// what the operator READS is produced in main — desktop notification titles and bodies, the
// tray, dialogs, the daily digest. Before this, a zh or ja operator got a fully localized app
// that pinged them in English ("Your calibration is drifting"), which is the kind of seam that
// makes localization feel bolted on rather than done.
//
// Same contract as the renderer's t(), deliberately: the English source IS the key, and a
// missing translation returns it unchanged. Same dictionaries too — src/locales/{zh,ja}.json are
// imported directly, so one translation serves both processes and the two can never disagree
// about what a string means.

import zh from '../../src/locales/zh.json'
import ja from '../../src/locales/ja.json'
import { readSettings } from './settings-helper'

export type MainLanguage = 'en' | 'zh' | 'ja'

const DICTS: Record<'zh' | 'ja', Record<string, string>> = {
  zh: zh as Record<string, string>,
  ja: ja as Record<string, string>
}

/** Resolve 'auto' the way the renderer does — against the OS locale — so both processes land on
 *  the same language without main having to observe the renderer. */
function resolveAuto(): MainLanguage {
  const locale = (process.env.LC_ALL || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase()
  if (locale.startsWith('zh')) return 'zh'
  if (locale.startsWith('ja')) return 'ja'
  return 'en'
}

/** The operator's UI language, from the same setting the renderer reads — `language`
 *  (settings-store.ts persists that key; DEFAULT_APP_SETTINGS.language). This used to read
 *  `uiLanguage`, a key nothing ever wrote, so a pinned 中文/日本語 never reached notifications or
 *  the tray (A6 F13). Best-effort: a settings read that throws must never break a notification,
 *  so it degrades to English. */
export function mainLanguage(): MainLanguage {
  try {
    const raw = readSettings().language
    const pref = typeof raw === 'string' ? raw : 'auto'
    if (pref === 'zh' || pref === 'ja' || pref === 'en') return pref
    return resolveAuto()
  } catch {
    return 'en'
  }
}

/** Translate a main-process string. English source in, operator's language out. */
export function mt(text: string, lang: MainLanguage = mainLanguage()): string {
  if (lang === 'en') return text
  return DICTS[lang]?.[text] ?? text
}

/** Parameterized form, mirroring the renderer's tf(): the template is the key, placeholders in
 *  `{name}` form, substitution AFTER lookup so a translation can reorder them freely. */
export function mtf(
  template: string,
  params: Record<string, string | number>,
  lang: MainLanguage = mainLanguage()
): string {
  const base = lang === 'en' ? template : (DICTS[lang]?.[template] ?? template)
  return base.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
}
