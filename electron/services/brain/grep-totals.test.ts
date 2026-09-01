// grep's truncation used to be silent: it returned at most `cap` hits and then RETURNED, so
// "12 matches exist" and "12 shown of 553" were the same value. A model asked "how many notes
// mention X" could only count what it was shown, and would be confidently wrong — property 8 in
// the retriever's most-used tool.
//
// It also made "you need code execution to count" look true when the cheap mechanism had simply
// never been given a total. Property 7 says try the crude thing first; this is the crude thing.
import { describe, it, expect } from 'vitest'
import { grep, grepTotals, type NoteText } from './retrieve-agent'

const note = (id: string, text: string): NoteText => ({ id, text, lines: text.split('\n') })

/** 40 notes; every 4th mentions Atlas twice ⇒ 10 notes, 20 matching lines. */
const CORPUS: NoteText[] = Array.from({ length: 40 }, (_, i) =>
  i % 4 === 0 ? note(`n${i}.md`, 'Atlas here\nfiller\nAtlas again') : note(`n${i}.md`, 'nothing relevant')
)

describe('grepTotals counts the WHOLE corpus, past any preview cap', () => {
  it('reports lines and notes independently — they are different questions', () => {
    expect(grepTotals(CORPUS, 'Atlas')).toEqual({ lines: 20, notes: 10 })
  })

  it('is not bounded by the preview cap that bounds grep()', () => {
    const preview = grep(CORPUS, 'Atlas') // default cap
    expect(preview.length).toBeLessThan(20) // the preview truncates …
    expect(grepTotals(CORPUS, 'Atlas').lines).toBe(20) // … the total does not
  })

  it('counts a note ONCE however many times it matches', () => {
    const c = [note('a.md', 'x\nx\nx\nx')]
    expect(grepTotals(c, 'x')).toEqual({ lines: 4, notes: 1 })
  })

  it('is zero for no match and for an empty term', () => {
    expect(grepTotals(CORPUS, 'nonexistent-token')).toEqual({ lines: 0, notes: 0 })
    expect(grepTotals(CORPUS, '   ')).toEqual({ lines: 0, notes: 0 })
  })

  it('uses the SAME pattern semantics as grep — case-insensitive, regex, literal fallback', () => {
    const c = [note('a.md', 'ATLAS'), note('b.md', 'atlas'), note('c.md', 'a+b')]
    expect(grepTotals(c, 'atlas').notes).toBe(2) // case-insensitive
    expect(grepTotals(c, '(atlas|zzz)').notes).toBe(2) // real regex
    // An invalid regex must not throw; it falls back to a literal match, same as grep().
    expect(() => grepTotals(c, 'a+b(')).not.toThrow()
    expect(grepTotals(c, 'a+b(').notes).toBe(0)
    expect(grepTotals(c, 'a\\+b').notes).toBe(1)
  })

  it('agrees with grep() whenever the result is NOT truncated', () => {
    const c = [note('a.md', 'one Atlas'), note('b.md', 'two Atlas')]
    const hits = grep(c, 'Atlas')
    const totals = grepTotals(c, 'Atlas')
    expect(hits.length).toBe(totals.lines)
    expect(new Set(hits.map((h) => h.note)).size).toBe(totals.notes)
  })
})
