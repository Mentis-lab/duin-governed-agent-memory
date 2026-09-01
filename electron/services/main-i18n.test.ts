import { describe, it, expect, vi, beforeEach } from 'vitest'

// Main-process localization. What this closes: a zh/ja operator got a fully localized app that
// then notified them in English ("Your calibration is drifting"), because the renderer's t()
// cannot reach the main process — where notification titles, the digest and the tray are built.

const settings: Record<string, unknown> = {}
vi.mock('./settings-helper', () => ({
  readSettings: (): Record<string, unknown> => {
    if (settings.__throw) throw new Error('settings unreadable')
    return settings
  }
}))

const { mt, mtf, mainLanguage } = await import('./main-i18n')

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k]
})

describe('mainLanguage', () => {
  it('honours the `language` setting the renderer actually persists', () => {
    settings.language = 'ja'
    expect(mainLanguage()).toBe('ja')
    settings.language = 'zh'
    expect(mainLanguage()).toBe('zh')
    settings.language = 'en'
    expect(mainLanguage()).toBe('en')
  })

  it('ignores the phantom `uiLanguage` key nothing writes (the A6 F13 mismatch)', () => {
    // Pinning the OS-fallback here would make the test OS-dependent; pin instead that the
    // phantom key cannot override an explicit `language`.
    settings.uiLanguage = 'ja'
    settings.language = 'zh'
    expect(mainLanguage()).toBe('zh')
  })

  it('degrades to English when settings cannot be read — a notification must never throw', () => {
    settings.__throw = true
    expect(mainLanguage()).toBe('en')
  })
})

describe('mt', () => {
  it('translates a real notification title into both languages', () => {
    // These exact strings are what watchers.ts and notifications-service.ts push.
    expect(mt('Your calibration is drifting', 'zh')).toBe('你的判断校准正在偏移')
    expect(mt('Your calibration is drifting', 'ja')).toBe('判断の精度がずれてきています')
    expect(mt('Your daily brain digest', 'ja')).toBe('今日のブレインダイジェスト')
  })

  it('returns the English source for en, and for an unknown key — never a blank', () => {
    expect(mt('High-priority task', 'en')).toBe('High-priority task')
    expect(mt('a string no dictionary has', 'ja')).toBe('a string no dictionary has')
  })

  it('shares the renderer dictionaries, so one translation serves both processes', async () => {
    const zh = (await import('../../src/locales/zh.json')).default as Record<string, string>
    expect(mt('A scheduled job failed', 'zh')).toBe(zh['A scheduled job failed'])
  })
})

describe('mtf', () => {
  it('substitutes AFTER lookup, so a translation may reorder placeholders', () => {
    expect(mtf('Read {n} files', { n: 12 }, 'en')).toBe('Read 12 files')
  })

  it('leaves an unknown placeholder as-is rather than rendering "undefined"', () => {
    expect(mtf('Read {n} files', {}, 'en')).toBe('Read {n} files')
  })
})
