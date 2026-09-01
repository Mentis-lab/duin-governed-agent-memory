// Backlog finding 32. Git C-quotes any path byte outside ASCII by default, so a file
// named with a CJK character, an accent or an emoji arrives from `status --porcelain`
// as "\346\226\207.md" — a string that matches nothing on disk. parsePorcelain took it
// verbatim, so every follow-up git call in the Review panel (stage, unstage, discard,
// diff) was handed that quoted form as its pathspec and did nothing.
//
// Fixed at both ends: git-runner now passes `-c core.quotePath=false` on EVERY
// invocation so git stops quoting, and the parser unquotes defensively for any path
// that arrives quoted anyway (older git, repo-local config, a caller bypassing the
// runner).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { unquoteGitPath } from './review'

// Build the quoted forms from char codes: a literal backslash-digit sequence in an ESM
// source is a legacy octal escape and will not compile.
const BS = String.fromCharCode(92)
const q = (inner: string): string => '"' + inner + '"'

describe('unquoteGitPath', () => {
  it('decodes the octal escapes of a CJK filename as ONE character, not three', () => {
    // 文 is three UTF-8 bytes and therefore three separate escapes. Decoding them one
    // at a time yields three mojibake characters; they have to be decoded together.
    expect(unquoteGitPath(q(BS + '346' + BS + '226' + BS + '207.md'))).toBe('文.md')
  })

  it('decodes an accented name', () => {
    expect(unquoteGitPath(q('caf' + BS + '303' + BS + '251.txt'))).toBe('café.txt')
  })

  it('leaves an ordinary unquoted path completely alone', () => {
    expect(unquoteGitPath('src/app.ts')).toBe('src/app.ts')
    expect(unquoteGitPath('a b/c.ts')).toBe('a b/c.ts')
  })

  it('does not treat a path that merely contains a quote as quoted', () => {
    expect(unquoteGitPath('we"ird.txt')).toBe('we"ird.txt')
  })

  it('handles the escaped quote and backslash forms', () => {
    expect(unquoteGitPath(q('a' + BS + '"b.txt'))).toBe('a"b.txt')
    expect(unquoteGitPath(q('a' + BS + BS + 'b.txt'))).toBe('a' + BS + 'b.txt')
  })

  it('handles a newline escape', () => {
    expect(unquoteGitPath(q('a' + BS + 'nb.txt'))).toBe('a' + String.fromCharCode(10) + 'b.txt')
  })
})

describe('git-runner passes core.quotePath=false', () => {
  it('sets it on EVERY invocation, at the runner rather than per call site', () => {
    // Asserted against the source: spawning real git in a unit test would depend on the
    // host's git config, which is the opposite of what this pins.
    const src = readFileSync(join(__dirname, '..', 'services', 'git-runner.ts'), 'utf-8')
    expect(src).toMatch(/'-c',\s*'core\.quotePath=false'/)
  })

  it('decodes stdout with a stateful decoder, not per-chunk toString', () => {
    // A multi-byte character split across two chunks decodes to replacement characters
    // when each chunk is converted independently — and a non-ASCII path is precisely
    // the case this change is about.
    const src = readFileSync(join(__dirname, '..', 'services', 'git-runner.ts'), 'utf-8')
    expect(src).toMatch(/StringDecoder/)
    expect(src).not.toMatch(/stdout \+= b\.toString\('utf8'\)/)
  })
})
