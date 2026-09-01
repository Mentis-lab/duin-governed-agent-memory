import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const css = readFileSync(join(process.cwd(), 'src/styles/index.css'), 'utf-8')

/** The declaration block for a selector, so assertions cannot match the wrong rule. */
function block(selector: string): string {
  const i = css.indexOf(selector)
  if (i === -1) return ''
  return css.slice(i, css.indexOf('}', i))
}

describe('CJK font stacks are split per language (han unification)', () => {
  // WHY THIS TEST EXISTS. Chinese and Japanese share Unicode codepoints for many
  // characters and draw them differently — 直 骨 今 曜 令 all have distinct standard
  // forms. A single CJK stack means whichever family comes first decides how the shared
  // characters look for BOTH languages, and a Simplified-Chinese face rendering Japanese
  // is not subtle to a Japanese reader. Nothing about that failure is visible to anyone
  // who does not read Japanese, which is exactly why it needs pinning.

  it('has a Japanese-specific override', () => {
    expect(css).toMatch(/\[lang='ja'\]/)
  })

  it('leads the Japanese stack with the OS system faces, not Chinese ones', () => {
    const ja = block("[lang='ja']")
    expect(ja).toContain('Hiragino Sans') // macOS system UI face
    expect(ja).toContain('Yu Gothic UI') // Windows 10+ system UI face
    // The trap this guards: 'Hiragino Sans GB' is the CHINESE Hiragino. Listing it for
    // Japanese would reintroduce the exact wrong-forms problem the split exists to fix.
    expect(ja).not.toContain('Hiragino Sans GB')
    expect(ja).not.toContain('PingFang SC')
    expect(ja).not.toContain('Microsoft YaHei')
  })

  it('leads the Chinese stack with Chinese system faces', () => {
    const zh = block("[lang='zh']")
    expect(zh).toContain('PingFang SC') // macOS system face since El Capitan
    expect(zh).toContain('Microsoft YaHei') // Windows
    expect(zh).not.toContain('Yu Gothic')
  })

  it('does not fall back to bitmap-era faces in either language', () => {
    // SimSun and MS PGothic are what CJK lands on when nothing better is listed. Both
    // look broken at UI sizes; their presence would mean the stack had been gutted.
    for (const sel of ["[lang='ja']", "[lang='zh']"]) {
      expect(block(sel)).not.toContain('SimSun')
      expect(block(sel)).not.toContain('MS PGothic')
    }
  })

  it('gives Japanese its own fixed-width code stack', () => {
    // CJK in code blocks is double-width; a proportional fallback breaks column
    // alignment outright, and an SC mono draws Japanese with the wrong forms.
    expect(css).toContain('--font-code-ja')
    expect(css).toMatch(/--font-code-ja:[^;]*Sarasa Mono J/)
  })
})
