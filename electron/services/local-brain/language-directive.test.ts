import { describe, it, expect } from 'vitest'
import { renderLanguageDirective } from './language-directive'

describe('renderLanguageDirective', () => {
  it('emits nothing for the absent/auto default (byte-identical prompt)', () => {
    // The whole default-off guarantee rests on this: no explicit language → empty string →
    // the grounding assemblers filter the empty unit out → prompt bytes unchanged.
    expect(renderLanguageDirective(undefined)).toBe('')
    expect(renderLanguageDirective(null)).toBe('')
    // A malformed value fails safe to the byte-identical default, not a broken block.
    expect(renderLanguageDirective('fr' as unknown as 'en')).toBe('')
    expect(renderLanguageDirective('auto' as unknown as 'en')).toBe('')
  })

  it('emits a directive for each explicit choice, naming the language', () => {
    expect(renderLanguageDirective('zh')).toContain('简体中文')
    expect(renderLanguageDirective('ja')).toContain('日本語')
    expect(renderLanguageDirective('en')).toContain('English')
  })

  it('carries the load-bearing "regardless of notes" clause and the code exemption', () => {
    const d = renderLanguageDirective('ja')
    // Without this clause the reply drifts into the language of the retrieved CONTEXT — the exact
    // failure on a mixed-language vault.
    expect(d).toMatch(/regardless of the language of the notes/i)
    expect(d).toMatch(/Keep code, file paths, identifiers, tool names/i)
  })

  it('is a single line, so it can be spliced into any prompt slot unchanged', () => {
    for (const l of ['en', 'zh', 'ja'] as const) {
      expect(renderLanguageDirective(l)).not.toContain('\n')
    }
  })
})
