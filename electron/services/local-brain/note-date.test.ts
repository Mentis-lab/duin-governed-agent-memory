// note-date — "when is this note ABOUT", the value a period-scoped question filters on.
//
// Retrieval previously had only a recency BOOST over mtime, which ranks a note higher for being
// recently TOUCHED. That is a different question, and no amount of boosting answers the one an
// operator actually asks ("what did I do in the last two weeks") — ranking cannot express
// ineligibility. These rules decide which notes a window admits, so getting the precedence wrong
// silently changes what a report is built from.

import { describe, it, expect } from 'vitest'
import { parseDateFromName, parseDateFromFrontmatter, resolveNoteDate } from './note-date'

const utc = (s: string): number => Date.parse(`${s}T00:00:00Z`)

describe('parseDateFromName', () => {
  it('reads the three separators daily notes actually use', () => {
    expect(parseDateFromName('2026-07-01-standup.md')).toBe(utc('2026-07-01'))
    expect(parseDateFromName('2026_07_01.md')).toBe(utc('2026-07-01'))
    expect(parseDateFromName('2026.07.01 review.md')).toBe(utc('2026-07-01'))
  })

  it('looks at the basename only, so a dated FOLDER does not date every note inside it', () => {
    // '2026-01-01/notes.md' must not inherit the folder's date — the note is not about that day.
    expect(parseDateFromName('2026-01-01/notes.md')).toBeNull()
    expect(parseDateFromName('archive/2026-01-01/2026-07-01-real.md')).toBe(utc('2026-07-01'))
  })

  it('returns null rather than guessing', () => {
    expect(parseDateFromName('meeting notes.md')).toBeNull()
    expect(parseDateFromName('v2026.md')).toBeNull()
  })

  it('rejects an impossible date instead of letting Date.parse roll it over', () => {
    expect(parseDateFromName('2026-13-45-nope.md')).toBeNull()
  })
})

describe('parseDateFromFrontmatter', () => {
  it('reads date: and created: from a leading block', () => {
    expect(parseDateFromFrontmatter('---\ndate: 2026-07-01\n---\n# hi')).toBe(utc('2026-07-01'))
    expect(parseDateFromFrontmatter('---\ncreated: 2026-07-01\n---\n')).toBe(utc('2026-07-01'))
  })

  it('tolerates quoting, padding and alternate separators', () => {
    expect(parseDateFromFrontmatter('---\ndate: "2026-7-1"\n---\n')).toBe(utc('2026-07-01'))
    expect(parseDateFromFrontmatter("---\ndate:   '2026/07/01'\n---\n")).toBe(utc('2026-07-01'))
  })

  it('ignores a date-looking line that is not in the frontmatter block', () => {
    // Body prose mentioning a date is not the note declaring its own date.
    expect(parseDateFromFrontmatter('# Notes\n\ndate: 2026-07-01\n')).toBeNull()
    expect(parseDateFromFrontmatter('---\ntitle: x\n---\ndate: 2026-07-01\n')).toBeNull()
  })

  it('returns null on an unterminated block rather than scanning the whole file', () => {
    expect(parseDateFromFrontmatter('---\ndate: 2026-07-01\nstill going...')).toBeNull()
  })
})

describe('resolveNoteDate — precedence, and recording which rule won', () => {
  const MTIME = utc('2026-01-15')

  it('frontmatter beats a dated filename: the operator SAID what it is about', () => {
    const r = resolveNoteDate('---\ndate: 2026-07-01\n---\n', '2026-03-03-standup.md', MTIME)
    expect(r).toEqual({ date: utc('2026-07-01'), src: 'frontmatter' })
  })

  it('a dated filename beats mtime', () => {
    const r = resolveNoteDate('# no frontmatter\n', '2026-03-03-standup.md', MTIME)
    expect(r).toEqual({ date: utc('2026-03-03'), src: 'filename' })
  })

  it('falls back to mtime and SAYS it is a fallback', () => {
    // A bulk reformat moves mtime on hundreds of notes and says nothing about their subject, so a
    // consumer has to be able to tell a declared date from a guessed one.
    const r = resolveNoteDate('# plain\n', 'notes/thoughts.md', MTIME)
    expect(r).toEqual({ date: MTIME, src: 'mtime' })
  })

  it('returns null when there is nothing to go on — never "now"', () => {
    // Defaulting to now would silently pull every undated note into every recent window.
    expect(resolveNoteDate('# plain\n', 'notes/thoughts.md', 0)).toBeNull()
    expect(resolveNoteDate('# plain\n', 'notes/thoughts.md', NaN)).toBeNull()
  })

  it('does not treat a half-parsed frontmatter date as a declaration', () => {
    // A shape richer than `date: YYYY-MM-DD` falls THROUGH to the next rung rather than being
    // half-understood — a wrong date is worse than no date, because a window silently excludes.
    const r = resolveNoteDate('---\ndate:\n  - 2026-07-01\n---\n', '2026-03-03-x.md', MTIME)
    expect(r).toEqual({ date: utc('2026-03-03'), src: 'filename' })
  })
})
