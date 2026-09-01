import { describe, expect, it } from 'vitest'
import { stripWikilinks } from '@/components/artifacts/MarkdownRenderer'
import { isMarkdownLang } from '@/components/artifacts/CodeBlock'
import { shortcutParts } from '@/components/ui/ShortcutKeys'

// QA over the chat RENDER pipeline touched in this stretch: wikilink stripping,
// fenced-markdown-doc detection, and shortcut key-cap parsing. Node-only env, so
// these exercise the pure helpers across many input patterns.

describe('stripWikilinks', () => {
  it('strips a single wikilink to its label', () => {
    expect(stripWikilinks('[[personality]]')).toBe('personality')
  })
  it('preserves case', () => {
    expect(stripWikilinks('[[GOALS]]')).toBe('GOALS')
  })
  it('uses the alias in [[target|alias]]', () => {
    expect(stripWikilinks('[[target|alias]]')).toBe('alias')
  })
  it('handles the exact reported case', () => {
    expect(stripWikilinks('personality live in [[personality]] and [[GOALS]]')).toBe(
      'personality live in personality and GOALS'
    )
  })
  it('strips multiple links in one line', () => {
    expect(stripWikilinks('see [[a]] and [[b]] plus [[c]]')).toBe('see a and b plus c')
  })
  it('strips adjacent links', () => {
    expect(stripWikilinks('[[a]][[b]]')).toBe('ab')
  })
  it('keeps folder paths in the label', () => {
    expect(stripWikilinks('[[folder/sub/note]]')).toBe('folder/sub/note')
  })
  it('trims inner whitespace', () => {
    expect(stripWikilinks('[[  spaced  ]]')).toBe('spaced')
  })
  it('works across newlines', () => {
    expect(stripWikilinks('[[a]]\ntext [[b|c]]')).toBe('a\ntext c')
  })
  it('leaves prose without links unchanged', () => {
    expect(stripWikilinks('just normal prose, no links here')).toBe(
      'just normal prose, no links here'
    )
  })
  it('leaves a lone single bracket alone', () => {
    expect(stripWikilinks('array[0] and obj[key]')).toBe('array[0] and obj[key]')
  })
  it('does not choke on an empty bracket pair', () => {
    // [[]] has no inner content -> regex requires 1+ char, so it is left as-is.
    expect(stripWikilinks('[[]]')).toBe('[[]]')
  })
  it('handles the last-pipe segment for multi-pipe links', () => {
    expect(stripWikilinks('[[a|b|c]]')).toBe('c')
  })
})

describe('isMarkdownLang', () => {
  it.each([
    ['markdown', true],
    ['md', true],
    ['MD', true],
    ['Markdown', true],
    ['MARKDOWN', true],
    ['js', false],
    ['javascript', false],
    ['html', false],
    ['', false]
  ])('%s -> %s', (lang, expected) => {
    expect(isMarkdownLang(lang)).toBe(expected)
  })
  it('is false for undefined', () => {
    expect(isMarkdownLang(undefined)).toBe(false)
  })
})

describe('shortcutParts', () => {
  it('splits the near-invisible Ctrl+backtick into visible caps', () => {
    expect(shortcutParts('Ctrl+`')).toEqual(['Ctrl', '`'])
  })
  it('splits three-key combos', () => {
    expect(shortcutParts('Ctrl+Shift+G')).toEqual(['Ctrl', 'Shift', 'G'])
  })
  it('keeps a bare comma visible', () => {
    expect(shortcutParts('Ctrl+,')).toEqual(['Ctrl', ','])
  })
  it('maps arrow keys to glyphs', () => {
    expect(shortcutParts('ArrowUp')).toEqual(['↑'])
    expect(shortcutParts('ArrowDown')).toEqual(['↓'])
  })
  it('uppercases single letters', () => {
    expect(shortcutParts('Ctrl+n')).toEqual(['Ctrl', 'N'])
  })
  it('labels named keys', () => {
    expect(shortcutParts('Shift+Enter')).toEqual(['Shift', 'Enter'])
    expect(shortcutParts('Esc')).toEqual(['Esc'])
  })
  it('is robust to spaces around the plus', () => {
    expect(shortcutParts('Ctrl + P')).toEqual(['Ctrl', 'P'])
  })
  it('returns empty for an empty string', () => {
    expect(shortcutParts('')).toEqual([])
  })
  it('covers every shortcut listed in the reference pane', () => {
    // Each must yield at least one cap and no empty caps (the original bug: an
    // empty key rendered as "Ctrl +" with nothing after it).
    const combos = [
      'Ctrl+N', 'Ctrl+K', 'Ctrl+B', 'Ctrl+,', 'Ctrl+P', 'Ctrl+T', 'Ctrl+`',
      'Ctrl+Shift+G', 'Ctrl+Shift+M', 'Ctrl+Shift+E', 'Ctrl+Shift+S',
      'Enter', 'Shift+Enter', 'Ctrl+U', 'ArrowUp', 'ArrowDown', 'Shift+Tab', 'Ctrl+G', 'Esc'
    ]
    for (const c of combos) {
      const parts = shortcutParts(c)
      expect(parts.length).toBeGreaterThan(0)
      expect(parts.every((p) => p.length > 0)).toBe(true)
    }
  })
})
