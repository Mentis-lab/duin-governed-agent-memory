import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { resolve } from 'path'
import { resolveOperatorWritePaths } from './operator-write-paths'

describe('resolveOperatorWritePaths', () => {
  it('accepts an absolute path', () => {
    const p = process.platform === 'win32' ? 'C:/work/code' : '/Users/x/code'
    expect(resolveOperatorWritePaths([p])).toEqual([resolve(p)])
  })

  it('expands ~ so an operator can type what they say', () => {
    const out = resolveOperatorWritePaths(['~/code'])
    expect(out).toEqual([resolve(homedir(), 'code')])
  })

  it('drops relative paths — a sandbox profile needs absolutes', () => {
    expect(resolveOperatorWritePaths(['code', './code', '../code'])).toEqual([])
  })

  it('refuses the home directory itself', () => {
    // Granting all of ~ is indistinguishable from having no sandbox, and someone
    // reaching for it almost certainly meant one project directory inside it.
    expect(resolveOperatorWritePaths([homedir()])).toEqual([])
    expect(resolveOperatorWritePaths(['~'])).toEqual([])
  })

  it('refuses machine roots whatever the settings file says', () => {
    // Enforced HERE rather than trusted upstream: a settings file is editable by
    // anything that already has the disk.
    const roots =
      process.platform === 'win32'
        ? ['C:/', 'C:/Windows', 'C:/Program Files']
        : ['/', '/System', '/usr', '/bin', '/etc', '/var', '/Library', '/Applications']
    expect(resolveOperatorWritePaths(roots)).toEqual([])
  })

  it('ignores junk instead of throwing', () => {
    // A broken settings file must narrow the sandbox to its default, never widen it
    // and never break the shell.
    expect(resolveOperatorWritePaths(null)).toEqual([])
    expect(resolveOperatorWritePaths('not-an-array')).toEqual([])
    expect(resolveOperatorWritePaths([1, {}, '', '   ', null])).toEqual([])
  })

  it('de-duplicates', () => {
    const p = process.platform === 'win32' ? 'C:/work' : '/work'
    expect(resolveOperatorWritePaths([p, p, `${p}/`])).toEqual([resolve(p)])
  })

  it('keeps a subdirectory of home — that is the whole point', () => {
    const out = resolveOperatorWritePaths(['~/projects/duin-scratch'])
    expect(out).toEqual([resolve(homedir(), 'projects/duin-scratch')])
  })
})
