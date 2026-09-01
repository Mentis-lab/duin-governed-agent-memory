// Brain API — native read/write memory (spec: PLANNING/DUIN_BRAIN_API_NATIVE_MEMORY_SPEC.md).
//
// Behaviour lives where it can be RUN: the tools are driven end-to-end over the real mount in
// exec-endpoint.test.ts, quota accounting against a real store file in principal-store.test.ts,
// and the D1 bypass through syncExecTokenFile below. What is left here is the pure scope
// predicate and one structural invariant that no amount of running can express.
//
// An earlier draft of this file asserted on the SOURCE TEXT of exec-endpoint.ts and server.ts,
// including a check that matched a COMMENT. Those tests were exactly backwards: they failed
// when someone reworded a remark and passed when the behaviour was deleted. They are gone.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathInScope, ALL_PLANES, DEFAULT_PLANES } from './principal-store'
import { syncExecTokenFile } from './exec-token-file'

// ──────────────────────── A2 · read scope (pure) ────────────────────────

describe('pathInScope', () => {
  it('absent or empty scope means the whole vault — the prior behaviour, now stated', () => {
    expect(pathInScope(undefined, '03 Projects/DUIN/x.md')).toBe(true)
    expect(pathInScope([], 'anything.md')).toBe(true)
  })

  it('grants a subtree and everything under it', () => {
    expect(pathInScope(['03 Projects/DUIN'], '03 Projects/DUIN')).toBe(true)
    expect(pathInScope(['03 Projects/DUIN'], '03 Projects/DUIN/x.md')).toBe(true)
    expect(pathInScope(['03 Projects/DUIN'], '03 Projects/DUIN/deep/y.md')).toBe(true)
  })

  it('refuses a sibling that merely shares a prefix', () => {
    // Segment boundary, not string prefix: without it, granting "03 Projects/DUIN" would
    // silently also grant "03 Projects/DUIN-secrets" — the classic prefix-match escape.
    expect(pathInScope(['03 Projects/DUIN'], '03 Projects/DUIN-secrets/x.md')).toBe(false)
    expect(pathInScope(['notes'], 'notes-private/x.md')).toBe(false)
  })

  it('refuses anything outside the grant, and refuses an empty path', () => {
    expect(pathInScope(['03 Projects/DUIN'], '05 People/salaries.md')).toBe(false)
    expect(pathInScope(['03 Projects/DUIN'], '')).toBe(false)
    expect(pathInScope(['03 Projects/DUIN'], null)).toBe(false)
    expect(pathInScope(['03 Projects/DUIN'], undefined)).toBe(false)
  })

  it('normalizes separators, case, and leading ./ so a path cannot slip on formatting', () => {
    // The index stores forward slashes; Windows callers and hand-typed grants do not.
    expect(pathInScope(['03 Projects/DUIN'], '03 Projects\\DUIN\\x.md')).toBe(true)
    expect(pathInScope(['03 Projects\\DUIN'], '03 Projects/DUIN/x.md')).toBe(true)
    expect(pathInScope(['03 projects/duin'], '03 Projects/DUIN/x.md')).toBe(true)
    expect(pathInScope(['03 Projects/DUIN/'], './03 Projects/DUIN/x.md')).toBe(true)
  })

  it('honours any one of several granted subtrees', () => {
    const scope = ['03 Projects/DUIN', '01 Wiki']
    expect(pathInScope(scope, '01 Wiki/a.md')).toBe(true)
    expect(pathInScope(scope, '03 Projects/DUIN/b.md')).toBe(true)
    expect(pathInScope(scope, '05 People/c.md')).toBe(false)
  })
})

// ──────────────────────── structural · the default grant ────────────────────────

describe('the default grant', () => {
  it('contains no write plane — writes are always asked for by name', () => {
    // Not expressible behaviourally: it is a claim about what a pairing requests when the
    // agent says nothing, and it is the reason a write grant is visible on the approval card
    // instead of arriving as part of a bundle.
    for (const plane of ALL_PLANES.filter((p) => /\.(write|submit)$/.test(p))) {
      expect(DEFAULT_PLANES, `${plane} must not be a default`).not.toContain(plane)
    }
    expect(DEFAULT_PLANES.length).toBeLessThan(ALL_PLANES.length)
  })
})

// ──────────────────────── D1 · the legacy bypass ────────────────────────

describe('D1 — syncExecTokenFile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exec-token-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the token only when DUIN_EXEC_TOKEN_FILE=1', () => {
    expect(syncExecTokenFile(dir, 'tok-abc', { DUIN_EXEC_TOKEN_FILE: '1' })).toBe('written')
    expect(readFileSync(join(dir, 'exec-token'), 'utf-8')).toBe('tok-abc')
  })

  it('writes nothing when the flag is unset, or set to anything other than 1', () => {
    // Truthiness would be the wrong test here: `DUIN_EXEC_TOKEN_FILE=0` must not arm a
    // full-privilege bypass, and neither must the empty string a cleared `set` leaves behind.
    for (const env of [{}, { DUIN_EXEC_TOKEN_FILE: '' }, { DUIN_EXEC_TOKEN_FILE: '0' }, { DUIN_EXEC_TOKEN_FILE: 'true' }]) {
      expect(syncExecTokenFile(dir, 'tok-abc', env)).toBe('absent')
      expect(existsSync(join(dir, 'exec-token'))).toBe(false)
    }
  })

  it('REVOKES a token a previous launch left behind when the flag goes off', () => {
    // The whole point of the off-path. Without it, "off" would mean only "not refreshed",
    // and a still-valid token would sit readable on disk while the operator believed the
    // door was shut.
    expect(syncExecTokenFile(dir, 'tok-abc', { DUIN_EXEC_TOKEN_FILE: '1' })).toBe('written')
    expect(syncExecTokenFile(dir, 'tok-abc', {})).toBe('removed')
    expect(existsSync(join(dir, 'exec-token'))).toBe(false)
  })

  it('refreshes the token rather than appending, so the file holds exactly one credential', () => {
    syncExecTokenFile(dir, 'tok-old', { DUIN_EXEC_TOKEN_FILE: '1' })
    syncExecTokenFile(dir, 'tok-new', { DUIN_EXEC_TOKEN_FILE: '1' })
    expect(readFileSync(join(dir, 'exec-token'), 'utf-8')).toBe('tok-new')
  })

  it('never throws into startup — a bad path reports failure instead', () => {
    // Called during brain boot; an exception here would take the whole server down over a
    // file that is, by design, optional.
    const missing = join(dir, 'no', 'such', 'dir')
    expect(syncExecTokenFile(missing, 'tok', { DUIN_EXEC_TOKEN_FILE: '1' })).toBe('failed')
    expect(syncExecTokenFile(missing, 'tok', {})).toBe('absent')
  })

  it('leaves an unrelated file in the directory alone', () => {
    writeFileSync(join(dir, 'settings.json'), '{}', 'utf-8')
    syncExecTokenFile(dir, 'tok', {})
    expect(existsSync(join(dir, 'settings.json'))).toBe(true)
  })
})
