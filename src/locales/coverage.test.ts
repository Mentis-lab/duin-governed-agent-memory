import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import zh from './zh.json'
import ja from './ja.json'

// Localization coverage, pinned.
//
// The failure this prevents is specific and has already happened: the dictionary was translated
// for the whole app while only 12 of 213 components ever called t(), so ~92% of visible strings
// rendered English no matter which language the operator chose — and 98 already-translated keys
// sat unused. Nothing caught it, because i18n.ts falls back to English by design. That fallback
// is correct (a half-translated screen beats a blank one) but it means the ONLY way a gap becomes
// visible is a test that goes looking for it.

const SRC = join(process.cwd(), 'src')
// The MAIN process localizes too, through `mt()` in electron/services/main-i18n.ts, which
// reads these same dictionaries. Both gates used to look only at `src/`, so every
// operator-facing string produced in main — notification bodies, the tray, and the
// channel setup guidance added 2026-08-26 — was invisible to them. That is how 63
// untranslated strings shipped past a scan reporting zero.
const MAIN = join(process.cwd(), 'electron')

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (/\.tsx?$/.test(e.name)) acc.push(p)
  }
  return acc
}

/** Every literal passed to t('…') across the renderer, with JS escapes resolved so the key
 *  matches what the RUNTIME looks up — `t('Let\'s go')` is the key `Let's go`, and comparing the
 *  raw source text instead reports a phantom miss. */
function usedKeys(): string[] {
  const keys = new Set<string>()
  const collect = (root: string, call: RegExp): void => {
    for (const file of walk(root)) {
      if (/\.test\.tsx?$/.test(file)) continue
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(call)) {
        const raw = m[1]
        const resolved = raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(['"\\])/g, '$1')
        keys.add(resolved)
      }
    }
  }
  collect(SRC, /\bt\(\s*'((?:[^'\\]|\\.)*)'/g)
  // `mt(` only — NOT a bare `t(` in electron/, which would match `expect(`, `emit(`,
  // `format(` and every other identifier ending in t. The main process's localizer has a
  // distinct name precisely because it is a different function; matching it exactly is
  // what keeps this from reporting hundreds of phantom keys.
  collect(MAIN, /\bmt\(\s*'((?:[^'\\]|\\.)*)'/g)
  return [...keys]
}

/** The channel setup text: description, setup steps, and credential label/help. These are
 *  DATA, not `mt('…')` call sites — the IPC maps them through mt() at the boundary (see
 *  ipc/settings.ts channels:listDefinitions), so a source scan for call sites cannot see
 *  them. Read from the definitions file directly, or they go untranslated silently, which
 *  is exactly what happened. */
function channelDefinitionKeys(): string[] {
  const file = join(process.cwd(), 'electron/services/channels/channel-definitions.ts')
  const src = readFileSync(file, 'utf8')
  const keys = new Set<string>()
  for (const m of src.matchAll(/\bdescription:\s*\n?\s*'([^']+)'/g)) keys.add(m[1])
  for (const b of src.matchAll(/setupSteps:\s*\[([\s\S]*?)\n {2}\]/g)) {
    for (const s of b[1].matchAll(/'([^']+)'/g)) keys.add(s[1])
  }
  for (const b of src.matchAll(/credentials:\s*\[([\s\S]*?)\n {2}\],/g)) {
    for (const s of b[1].matchAll(/\b(?:label|help):\s*\n?\s*'([^']+)'/g)) keys.add(s[1])
  }
  return [...keys]
}

describe('locale dictionaries', () => {
  it('zh and ja carry exactly the same keys', () => {
    const zhKeys = Object.keys(zh).sort()
    const jaKeys = Object.keys(ja).sort()
    const zhOnly = zhKeys.filter((k) => !(k in ja))
    const jaOnly = jaKeys.filter((k) => !(k in zh))
    expect({ zhOnly, jaOnly }).toEqual({ zhOnly: [], jaOnly: [] })
  })

  it('no value is left as an empty string', () => {
    const blank = [...Object.entries(zh), ...Object.entries(ja)].filter(([, v]) => !String(v).trim())
    expect(blank).toEqual([])
  })
})

describe('coverage — every t() key is translated in BOTH languages', () => {
  // The one deliberate exception: i18n.test.ts asserts the English fallback, so its fixture must
  // NEVER be translated or that test would stop testing anything.
  const FALLBACK_FIXTURE = 'A string nobody has translated yet'

  it('has a zh translation for every key the code asks for', () => {
    const missing = usedKeys().filter((k) => k !== FALLBACK_FIXTURE && !(k in zh))
    expect(missing).toEqual([])
  })

  it('has a ja translation for every key the code asks for', () => {
    const missing = usedKeys().filter((k) => k !== FALLBACK_FIXTURE && !(k in ja))
    expect(missing).toEqual([])
  })

  // Channel setup guidance is the case both gates were blind to: it is DATA in a main-
  // process module, not a `t('…')` call in the renderer, so neither the l10n scan (which
  // walks src/ only) nor a call-site scan could see it. 63 strings shipped untranslated
  // behind a scan reporting zero.
  it('has zh and ja for every channel description, setup step and credential field', () => {
    const keys = channelDefinitionKeys()
    // A guard on the extractor itself: if the definitions file is refactored into a shape
    // these patterns no longer match, the assertions below would pass vacuously on an
    // empty list and this gate would go quietly dead.
    expect(keys.length).toBeGreaterThan(20)
    expect(keys.filter((k) => !(k in zh))).toEqual([])
    expect(keys.filter((k) => !(k in ja))).toEqual([])
  })
})
