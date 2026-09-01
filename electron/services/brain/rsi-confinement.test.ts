// rsi-confinement — the guard standing between an autonomously-generated targetPath and a durable
// write. It is enforced twice (propose-time in rsi-proposer, and again at the write sinks in
// self-improve-loop), so a hole here is a hole in the only thing bounding what the RSI can overwrite.
//
// Until 2026-08-03 it was purely lexical: `resolve()` + `startsWith`. That stops `../` traversal and
// absolute escapes, and does NOT stop a symlink or NTFS junction — the lexical path stays inside
// <vault>/.duin/ while the write lands wherever the link points. The sibling guard in
// ans/action-ledger.ts already did a realpath for exactly this reason.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isConfinedToDuin } from './rsi-confinement'

let base: string
let vault: string
let outside: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'rsi-confine-'))
  vault = join(base, 'vault')
  outside = join(base, 'outside')
  mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
  mkdirSync(outside, { recursive: true })
})

afterEach(() => {
  try {
    rmSync(base, { recursive: true, force: true })
  } catch {
    /* best-effort tmp cleanup */
  }
})

describe('isConfinedToDuin — lexical containment (unchanged behaviour)', () => {
  it('accepts a path inside <vault>/.duin/', () => {
    expect(isConfinedToDuin(vault, join(vault, '.duin', 'rsi-tunables.json'))).toBe(true)
    expect(isConfinedToDuin(vault, join(vault, '.duin', '_state', 'x.json'))).toBe(true)
  })

  it('refuses a sibling directory that merely shares a prefix', () => {
    expect(isConfinedToDuin(vault, join(vault, '.duinX', 'evil.json'))).toBe(false)
  })

  it('refuses ../ traversal and absolute escapes', () => {
    expect(isConfinedToDuin(vault, join(vault, '.duin', '..', '..', 'outside', 'evil.json'))).toBe(false)
    expect(isConfinedToDuin(vault, join(outside, 'evil.json'))).toBe(false)
  })

  it('accepts a target whose file does not exist yet (the first-write case)', () => {
    // rsi-tunables.json legitimately does not exist before the first RSI write, and neither may its
    // parent. Both must still be judged confined, or the loop can never make its first write.
    expect(isConfinedToDuin(vault, join(vault, '.duin', 'never-written.json'))).toBe(true)
    expect(isConfinedToDuin(vault, join(vault, '.duin', 'no', 'such', 'dir', 'x.json'))).toBe(true)
  })

  it('refuses a not-yet-existing target that is ALSO outside the root', () => {
    expect(isConfinedToDuin(vault, join(outside, 'no', 'such', 'dir', 'x.json'))).toBe(false)
  })
})

describe('isConfinedToDuin — symlink / junction traversal', () => {
  // Creating a directory symlink on Windows needs elevation or developer mode; a 'junction' does
  // not. Node maps type:'junction' to a real NTFS junction on win32 and to a plain dir symlink
  // elsewhere, so this runs on both. If the sandbox forbids it entirely we skip rather than pass
  // silently — a skipped guard test is honest, a vacuous one is not.
  function tryLink(target: string, path: string): boolean {
    try {
      symlinkSync(target, path, 'junction')
      return true
    } catch {
      return false
    }
  }

  it('refuses a path that leaves the vault through a junction UNDER .duin/', () => {
    const link = join(vault, '.duin', '_state', 'escape')
    if (!tryLink(outside, link)) return // cannot create links here; nothing to assert
    writeFileSync(join(outside, 'loot.json'), '{}', 'utf-8')
    // Lexically this is <vault>/.duin/_state/escape/loot.json — squarely inside the root, which is
    // exactly why the old guard passed it. The real path is outside the vault entirely.
    expect(isConfinedToDuin(vault, join(link, 'loot.json'))).toBe(false)
  })

  it('refuses a not-yet-existing file inside a junction that points out (first-write escape)', () => {
    const link = join(vault, '.duin', '_state', 'escape2')
    if (!tryLink(outside, link)) return
    // The tail does not exist, so the walk-to-nearest-ancestor path is what has to catch this.
    expect(isConfinedToDuin(vault, join(link, 'not-created-yet.json'))).toBe(false)
  })

  it('still accepts a junction that stays INSIDE the root (containment, not link-phobia)', () => {
    const real = join(vault, '.duin', 'real-dir')
    mkdirSync(real, { recursive: true })
    const link = join(vault, '.duin', '_state', 'inward')
    if (!tryLink(real, link)) return
    expect(isConfinedToDuin(vault, join(link, 'ok.json'))).toBe(true)
  })

  it('refuses when the VAULT ROOT itself is reached through a junction pointing elsewhere', () => {
    // The root gets realResolve'd too, so a caller handed a linked vault path cannot be tricked
    // into treating the link's target as the containment boundary in one direction only.
    const linkedVault = join(base, 'vault-link')
    if (!tryLink(vault, linkedVault)) return
    expect(isConfinedToDuin(linkedVault, join(vault, '.duin', 'rsi-tunables.json'))).toBe(true)
    expect(isConfinedToDuin(linkedVault, join(outside, 'evil.json'))).toBe(false)
  })
})
