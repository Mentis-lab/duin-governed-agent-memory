// GOLDEN lock for the _goals_context loader. Pins frontmatter-strip, the fixed-
// file ordering + prefixes, and — critically — CODE-POINT slicing (Python s[:n]
// counts code points; a naive JS slice would split emoji and diverge).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { goalsContext, sliceCp, splitLines, splitlinesPy, loadJsonl } from './futures-pool-native'

describe('futures-pool-native — golden (_goals_context parity)', () => {
  let dir: string
  const write = (rel: string, text: string): void => {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text, 'utf-8')
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-goals-'))
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('strips frontmatter from me.md, appends GOALS files with prefixes', () => {
    write('me.md', '---\nkey: v\n---\n# Me\n\nMission text here.\n')
    write('GOALS.md', 'Goal one\nGoal two\n')
    expect(goalsContext(dir)).toBe(
      '### Identity & mission (me.md)\n# Me\n\nMission text here.' + '\n\n' + '### GOALS.md\nGoal one\nGoal two\n'
    )
  })

  it('omits missing files; returns "" for an empty vault', () => {
    write('GOALS.md', 'only goals\n')
    expect(goalsContext(dir)).toBe('### GOALS.md\nonly goals\n')
    const empty = mkdtempSync(join(tmpdir(), 'duin-goals-empty-'))
    try {
      expect(goalsContext(empty)).toBe('')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('slices me.md body by CODE POINT (emoji-safe), matching Python s[:900]', () => {
    write('me.md', '😀'.repeat(950)) // no frontmatter; 950 astral code points
    const out = goalsContext(dir)
    const body = out.slice('### Identity & mission (me.md)\n'.length)
    expect([...body].length).toBe(900) // 900 code points, NOT 450 emoji from a UTF-16 slice
    expect(body).toBe('😀'.repeat(900))
  })

  it('sliceCp helper counts code points', () => {
    expect(sliceCp('😀😀😀', 2)).toBe('😀😀')
    expect(sliceCp('abc', 5)).toBe('abc')
  })

  it('splitlinesPy matches Python str.splitlines (no trailing empty; keeps middle empties)', () => {
    expect(splitlinesPy('a\nb')).toEqual(['a', 'b'])
    expect(splitlinesPy('a\nb\n')).toEqual(['a', 'b']) // trailing newline → no trailing ''
    expect(splitlinesPy('a\n\nb')).toEqual(['a', '', 'b']) // middle empty kept
    expect(splitlinesPy('a\r\nb')).toEqual(['a', 'b']) // CRLF is one boundary
    expect(splitlinesPy('')).toEqual([])
  })

  it('splitLines keeps stripped lines >6 code points, drops --- rules', () => {
    expect(splitLines('short\nthis is long enough\n---\n   padded line here   ')).toEqual([
      'this is long enough',
      'padded line here'
    ])
    expect(splitLines('tiny\nabc')).toEqual([]) // both <=6 after strip
  })

  it('loadJsonl parses valid rows, skips blanks and bad JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duin-jsonl-'))
    try {
      const fp = join(dir, 'x.jsonl')
      writeFileSync(fp, '{"a":1}\n\nnot json\n{"b":2}\n', 'utf-8')
      expect(loadJsonl(fp)).toEqual([{ a: 1 }, { b: 2 }])
      expect(loadJsonl(join(dir, 'missing.jsonl'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
