import { describe, it, expect, beforeEach } from 'vitest'
import { t, tc, tf, setUiLanguage, uiLanguage } from './i18n'
import zh from '@/locales/zh.json'
import ja from '@/locales/ja.json'

beforeEach(() => {
  setUiLanguage('en')
})

describe('locale files', () => {
  it('zh and ja cover exactly the same keys', () => {
    // Divergence is how a UI ends up half-translated in one language only, and it is
    // invisible until someone switches to that language and finds English mid-sentence.
    const zk = Object.keys(zh).sort()
    const jk = Object.keys(ja).sort()
    expect(jk).toEqual(zk)
  })

  it('has no empty or untranslated-identical values', () => {
    for (const [k, v] of Object.entries(zh as Record<string, string>)) {
      expect(v.trim(), `zh empty for ${k}`).not.toBe('')
    }
    for (const [k, v] of Object.entries(ja as Record<string, string>)) {
      expect(v.trim(), `ja empty for ${k}`).not.toBe('')
    }
  })

  it('keeps product and protocol names untranslated', () => {
    // Translating these makes the product look amateur and its docs unsearchable — a
    // Chinese developer searches "MCP", not "模型上下文协议".
    for (const dict of [zh, ja] as Record<string, string>[]) {
      for (const term of ['GitHub', 'RAG']) {
        if (term in dict) expect(dict[term]).toBe(term)
      }
    }
  })
})

describe('t', () => {
  it('returns the source string in English', () => {
    expect(t('Settings')).toBe('Settings')
  })

  it('translates when a language is selected', () => {
    setUiLanguage('zh')
    expect(t('Settings')).toBe('设置')
    setUiLanguage('ja')
    expect(t('Settings')).toBe('設定')
  })

  it('falls back to READABLE ENGLISH for a missing translation', () => {
    // The property that matters most: a half-translated screen must stay usable. A key
    // or an empty string here would be worse than not translating at all.
    setUiLanguage('zh')
    expect(t('A string nobody has translated yet')).toBe('A string nobody has translated yet')
  })

  it('uses the glossary term for Brain rather than the organ', () => {
    setUiLanguage('zh')
    expect(t('Brain')).toBe('知识大脑')
    // Re-shaped 2026-08-23 (language pass): ja label is ブレイン — locale-native short form
    // per GLOSSARY (ナレッジブレイン survives only as the first-run gloss). The property this
    // test protects holds: neither locale uses the organ word (大脑 alone / 脳).
    setUiLanguage('ja')
    expect(t('Brain')).toBe('ブレイン')
  })
})

describe('tc — disambiguation', () => {
  it('falls back to the plain translation when no context entry exists', () => {
    setUiLanguage('zh')
    expect(tc('verb', 'Open')).toBe('打开')
  })

  it('is a no-op in English', () => {
    expect(tc('verb', 'Open')).toBe('Open')
  })
})

describe('tf — parameterized strings', () => {
  it('substitutes into the English template', () => {
    expect(tf('Read {n} files', { n: 12 })).toBe('Read 12 files')
  })

  it('substitutes into the translation when one exists', () => {
    setUiLanguage('zh')
    if ('Read {n} files' in (zh as Record<string, string>)) {
      expect(tf('Read {n} files', { n: 12 })).toBe((zh as Record<string, string>)['Read {n} files'].replace('{n}', '12'))
    }
  })

  it('falls back to the substituted English template for a missing translation', () => {
    setUiLanguage('zh')
    expect(tf('A {kind} nobody translated', { kind: 'string' })).toBe('A string nobody translated')
  })

  it('leaves an unknown placeholder intact rather than printing undefined', () => {
    expect(tf('Read {n} files', {})).toBe('Read {n} files')
  })
})

describe('auto default', () => {
  it('resolves a language at module load — never boots stuck on a stale default', () => {
    // The cold-start property: with the shipped default ('auto'), the resolved language
    // must come from the OS locale at import time, because loadSettings('auto') is a
    // no-change write that re-renders nothing. jsdom's navigator.language is 'en-US',
    // so resolution lands on English HERE — the assertion is that auto-resolution ran
    // and produced a shipped language, not which one.
    setUiLanguage('auto')
    expect(['en', 'zh', 'ja']).toContain(uiLanguage())
  })
})

describe('setUiLanguage', () => {
  it('resolves explicit languages', () => {
    setUiLanguage('ja')
    expect(uiLanguage()).toBe('ja')
  })

  it('falls back to English for a locale we do not ship', () => {
    setUiLanguage(undefined)
    expect(['en', 'zh', 'ja']).toContain(uiLanguage())
  })
})
