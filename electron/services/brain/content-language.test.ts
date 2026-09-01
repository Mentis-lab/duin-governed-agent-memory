import { describe, it, expect } from 'vitest'
import { detectContentLang, contentLanguageDirective } from './content-language'

// Realistic strings from the operator's 39%-CJK vault (北澜 = the game, 风暴模拟器 = an emulator
// partner, 云帆泰克 = the semiconductor line) and from the real JP decks in it (企画書, 議事録,
// SEGA向け…), rather than toy input.
describe('detectContentLang', () => {
  it('kana → ja (the JP tell), even when mixed with kanji', () => {
    expect(detectContentLang('レポートを作成する')).toBe('ja') // katakana + kanji
    expect(detectContentLang('まとめてください')).toBe('ja') // hiragana
    expect(detectContentLang('ｶﾀｶﾅのメモ')).toBe('ja') // halfwidth katakana
    expect(detectContentLang('SEGA向けの企画書をまとめる')).toBe('ja') // real deck title
    expect(detectContentLang('ソーシング・プラットフォームの議事録')).toBe('ja')
  })

  it('kanji-only (no kana) → zh', () => {
    expect(detectContentLang('北澜发行渠道决策')).toBe('zh')
    expect(detectContentLang('风暴模拟器的合作现在是什么状态')).toBe('zh')
    expect(detectContentLang('云帆泰克董事长负责封测业务')).toBe('zh')
  })

  it('detects CJK embedded in otherwise-Latin prose', () => {
    expect(detectContentLang('Partner update: 风暴模拟器 renewal pending')).toBe('zh')
    expect(detectContentLang('Deck for SEGA — ご紹介 draft')).toBe('ja')
  })

  it('English / other → null (no pin)', () => {
    expect(detectContentLang('quarterly strategy report')).toBeNull()
    expect(detectContentLang('')).toBeNull()
    expect(detectContentLang('123 - v2.0')).toBeNull()
    // CJK *punctuation* is not a letter — it must not trip the detector on its own.
    expect(detectContentLang('「」、。・')).toBeNull()
  })

  it('does NOT read the katakana middle dot as Japanese — Chinese uses it too', () => {
    // ・ (U+30FB) lives in the katakana block but is punctuation, and Chinese uses it to separate
    // transliterated foreign names. A naive `゠-ヿ` kana span swallows it and mislabels pure
    // Chinese as Japanese, which would then pin CN extraction output to 日本語.
    expect(detectContentLang('维克多·雨果')).toBe('zh')
    expect(detectContentLang('云帆泰克・北澜')).toBe('zh')
    expect(detectContentLang('・')).toBeNull()
    // ゠ (U+30A0) is a katakana-block double hyphen — punctuation, not a kana letter, so it must not
    // read as Japanese. (The shared tokenizer does count it as a CJK letter, so a lone ゠ lands on
    // the kanji branch; what matters here is only that it is never mistaken for kana.)
    expect(detectContentLang('゠')).not.toBe('ja')
    // But a real katakana word alongside the dot is still Japanese.
    expect(detectContentLang('ソーシング・プラットフォーム')).toBe('ja')
  })
})

describe('contentLanguageDirective', () => {
  it('is empty for English — the byte-identical default that keeps existing prompts unchanged', () => {
    expect(contentLanguageDirective('plain english note')).toBe('')
    expect(contentLanguageDirective('')).toBe('')
  })

  it('names the language and exempts ids/dates/keys for CJK', () => {
    const zh = contentLanguageDirective('北澜发行的渠道战略方案')
    expect(zh).toContain('简体中文')
    expect(zh).toMatch(/keeping ids, dates, enum values/i)
    expect(zh).toMatch(/file paths, and JSON field names/i)

    const ja = contentLanguageDirective('企画書をまとめる')
    expect(ja).toContain('日本語')
    expect(ja).toMatch(/keeping ids, dates, enum values/i)
  })

  it('is a single line, so callers can append it without reshaping the prompt', () => {
    expect(contentLanguageDirective('北澜发行')).not.toContain('\n')
  })

  it('kanji-only JP words (no kana) fall back to zh — the documented heuristic limit', () => {
    // An isolated kanji-only token cannot be told apart from Chinese. Real JP notes carry kana in
    // particles and verb endings, so this only bites on bare headline nouns.
    expect(contentLanguageDirective('企画書')).toContain('简体中文')
  })
})
