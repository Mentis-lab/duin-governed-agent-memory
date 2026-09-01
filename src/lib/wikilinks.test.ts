import { describe, expect, it } from 'vitest'
import { linkifyWikilinks, wikilinkTarget, WIKILINK_SCHEME } from './wikilinks'

describe('linkifyWikilinks', () => {
  it('rewrites a plain wikilink', () => {
    expect(linkifyWikilinks('see [[Beacon]] today')).toBe(
      'see [Beacon](wikilink:Beacon) today'
    )
  })

  it('uses the alias as the visible label', () => {
    expect(linkifyWikilinks('[[2026-05-14-风暴模拟器合作终止|the LD call]]')).toContain(
      '[the LD call](wikilink:'
    )
  })

  it('keeps the section in the target so the resolver can strip it', () => {
    const out = linkifyWikilinks('[[Plan#Decision]]')
    expect(wikilinkTarget(/\((wikilink:[^)]+)\)/.exec(out)![1])).toBe('Plan#Decision')
  })

  it('encodes spaces and CJK so the href survives the round trip', () => {
    const out = linkifyWikilinks('[[北澜 发行]]')
    const href = /\((wikilink:[^)]+)\)/.exec(out)![1]
    expect(href).not.toContain(' ')
    expect(wikilinkTarget(href)).toBe('北澜 发行')
  })

  it('leaves a fenced code block alone — [[x]] in code is code', () => {
    const md = 'text [[Real]]\n\n```py\nm = [[1,2],[3,4]]\n```\n\nmore [[Also]]'
    const out = linkifyWikilinks(md)
    expect(out).toContain('m = [[1,2],[3,4]]')
    expect(out).toContain('[Real](wikilink:Real)')
    expect(out).toContain('[Also](wikilink:Also)')
  })

  it('leaves inline code alone', () => {
    expect(linkifyWikilinks('use `[[notALink]]` here')).toBe('use `[[notALink]]` here')
  })

  it('leaves a tilde-fenced block alone', () => {
    const md = '~~~\n[[x]]\n~~~'
    expect(linkifyWikilinks(md)).toBe(md)
  })

  it('handles several links on one line', () => {
    const out = linkifyWikilinks('[[A]] and [[B]]')
    expect(out).toBe('[A](wikilink:A) and [B](wikilink:B)')
  })

  it('ignores an unclosed bracket rather than swallowing the rest of the note', () => {
    const md = '[[unclosed and then a lot of text\nsecond line'
    expect(linkifyWikilinks(md)).toBe(md)
  })

  it('ignores an empty target', () => {
    expect(linkifyWikilinks('[[]]')).toBe('[[]]')
  })

  it('is a no-op on text with no wikilinks (fast path)', () => {
    const md = '# Title\n\nordinary [link](https://example.com) here'
    expect(linkifyWikilinks(md)).toBe(md)
  })
})

describe('wikilinkTarget', () => {
  it('returns null for an ordinary link', () => {
    expect(wikilinkTarget('https://example.com')).toBeNull()
    expect(wikilinkTarget(undefined)).toBeNull()
  })

  it('decodes the target', () => {
    expect(wikilinkTarget(`${WIKILINK_SCHEME}${encodeURIComponent('A B')}`)).toBe('A B')
  })

  it('falls back to the raw value when the encoding is broken', () => {
    expect(wikilinkTarget(`${WIKILINK_SCHEME}%E0%A4%A`)).toBe('%E0%A4%A')
  })
})
