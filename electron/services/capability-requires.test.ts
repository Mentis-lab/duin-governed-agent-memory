import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: { getAllWindows: () => [] }
}))

import {
  clearRequirementCache,
  coerceRequirements,
  describeMissing,
  effectiveRequirements,
  impliedCommandRequirement,
  probeRequirement,
  probeRequirements,
  requirementLabel,
  resolveBinary,
  type Requirement
} from './capability-requires'

// What a capability needs, and whether it is here.
//
// The behaviour that matters most in this file is the pair of asymmetries: an
// EMPTY requirements list is satisfied (silence is not a warning), and a MALFORMED
// entry is dropped rather than fatal (a typo must not be worse than omitting the
// block). Both exist so the mechanism is safe to adopt — a check that cried wolf on
// every connector, or that bricked a plugin over a misspelt key, would simply not
// get used.

beforeEach(() => {
  clearRequirementCache()
})

const scratch = (): string => mkdtempSync(join(tmpdir(), 'duin-requires-'))

describe('resolveBinary', () => {
  it('finds a file that is actually on the supplied PATH', () => {
    const dir = scratch()
    const exe = process.platform === 'win32' ? 'mytool.CMD' : 'mytool'
    writeFileSync(join(dir, exe), '')
    const found = resolveBinary('mytool', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' })
    expect(found).toBeTruthy()
    expect(found).toContain('mytool')
  })

  // The Windows trap. `npx` on disk is npx.cmd; PATHEXT is what makes the bare name
  // spawn. A probe that only tried the literal name would report every npx-based
  // connector missing on the one platform DUIN actually ships on.
  // resolveBinary walks PATHEXT only when process.platform is win32, so this case is
  // win32-only (CI's windows job runs it; on ubuntu it is skipped, not failed).
  it.skipIf(process.platform !== 'win32')('walks PATHEXT so a bare name matches the .CMD on disk', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'faketool.CMD'), '')
    expect(resolveBinary('faketool', { PATH: dir, PATHEXT: '.EXE;.CMD' })).toBeTruthy()
    // …and without the extension in PATHEXT it must NOT claim a hit.
    expect(resolveBinary('faketool', { PATH: dir, PATHEXT: '.EXE' })).toBeNull()
  })

  it('checks the npm global bin, where `npm i -g` actually lands', () => {
    const home = scratch()
    mkdirSync(join(home, 'npm'))
    const exe = process.platform === 'win32' ? 'globaltool.CMD' : 'globaltool'
    writeFileSync(join(home, 'npm', exe), '')
    const found = resolveBinary('globaltool', {
      PATH: '',
      PATHEXT: '.CMD',
      APPDATA: home
    })
    expect(found).toBeTruthy()
  })

  it('honours an explicit path instead of searching PATH', () => {
    const dir = scratch()
    const p = join(dir, 'thing.txt')
    writeFileSync(p, '')
    expect(resolveBinary(p, { PATH: '' })).toBe(p)
    expect(resolveBinary(join(dir, 'absent.txt'), { PATH: '' })).toBeNull()
  })

  it('returns null rather than throwing on an unreadable PATH entry', () => {
    expect(resolveBinary('nothing-here', { PATH: join(scratch(), 'no', 'such', 'dir') })).toBeNull()
  })
})

describe('probeRequirements', () => {
  it('an EMPTY list is satisfied — silence is not a warning', () => {
    expect(probeRequirements(undefined).satisfied).toBe(true)
    expect(probeRequirements([]).satisfied).toBe(true)
    expect(probeRequirements([]).missing).toEqual([])
  })

  it('resolves a relative file requirement against baseDir', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'model.bin'), 'x')
    const req: Requirement = { kind: 'file', path: 'model.bin' }
    expect(probeRequirements([req], { baseDir: dir }).satisfied).toBe(true)
    expect(probeRequirements([req], { baseDir: scratch() }).satisfied).toBe(false)
  })

  // The distinction the `env` kind exists for. An MCP stdio child receives
  // {...SAFE_ENV_KEYS, ...config.env}, so a connector's token lives in its OWN env
  // block. Probing process.env would answer a different question in both directions.
  it('reads the env the CHILD will see, not this process', () => {
    const req: Requirement = { kind: 'env', name: 'DUIN_TEST_TOKEN_XYZ' }
    expect(probeRequirements([req], { env: {} }).satisfied).toBe(false)
    clearRequirementCache()
    expect(probeRequirements([req], { env: { DUIN_TEST_TOKEN_XYZ: 'abc' } }).satisfied).toBe(true)
  })

  it('treats an empty-string env var as absent — the catalog ships them blank', () => {
    // github/slack catalog entries seed `env: { GITHUB_TOKEN: '' }`. A present-but-
    // empty key must read as "not set", or every such connector would preflight as
    // ready and then fail at connect exactly as before.
    const req: Requirement = { kind: 'env', name: 'GITHUB_TOKEN' }
    expect(probeRequirements([req], { env: { GITHUB_TOKEN: '' } }).satisfied).toBe(false)
    clearRequirementCache()
    expect(probeRequirements([req], { env: { GITHUB_TOKEN: '   ' } }).satisfied).toBe(false)
  })

  it('does not let one connector’s token satisfy another’s', () => {
    const req: Requirement = { kind: 'env', name: 'SHARED_NAME' }
    const a = probeRequirements([req], { env: { SHARED_NAME: 'set' } })
    const b = probeRequirements([req], { env: {} })
    expect(a.satisfied).toBe(true)
    expect(b.satisfied).toBe(false)
  })

  it('never returns the value of an env var, only that it was set', () => {
    const result = probeRequirement(
      { kind: 'env', name: 'SECRET_THING' },
      { env: { SECRET_THING: 'super-secret-value' } }
    )
    expect(JSON.stringify(result)).not.toContain('super-secret-value')
    expect(result.resolvedPath).toBeUndefined()
  })

  it('carries the author’s hint into the failure, because that is the how-to-fix', () => {
    const report = probeRequirements([
      { kind: 'binary', name: 'definitely-not-installed-xyz', hint: 'Install Node.js.' }
    ])
    expect(report.satisfied).toBe(false)
    expect(describeMissing(report)).toContain('Install Node.js.')
    expect(describeMissing(report)).toContain('definitely-not-installed-xyz')
  })

  it('describeMissing is empty when nothing is missing', () => {
    expect(describeMissing(probeRequirements([]))).toBe('')
  })

  it('reports every failure, not just the first', () => {
    const report = probeRequirements([
      { kind: 'binary', name: 'absent-one-xyz' },
      { kind: 'env', name: 'ABSENT_TWO_XYZ' }
    ], { env: {} })
    expect(report.missing).toHaveLength(2)
  })
})

describe('coerceRequirements — untrusted JSON must never be fatal', () => {
  it('keeps the good entries and drops the malformed ones', () => {
    const out = coerceRequirements([
      { kind: 'binary', name: 'git' },
      { kind: 'binary' }, // no name
      { kind: 'nonsense', name: 'x' }, // unknown kind
      'not an object',
      null,
      { kind: 'file', path: './thing' },
      { kind: 'env', name: 'TOKEN', hint: 'set it' }
    ])
    expect(out).toHaveLength(3)
    expect(out?.map((r) => r.kind)).toEqual(['binary', 'file', 'env'])
  })

  it('returns undefined for a non-array or an all-junk list, so callers keep one empty case', () => {
    expect(coerceRequirements(undefined)).toBeUndefined()
    expect(coerceRequirements('nope')).toBeUndefined()
    expect(coerceRequirements({ kind: 'binary', name: 'git' })).toBeUndefined()
    expect(coerceRequirements([{ kind: 'bogus' }])).toBeUndefined()
  })

  it('trims, and drops entries that are whitespace-only', () => {
    expect(coerceRequirements([{ kind: 'binary', name: '  git  ' }])).toEqual([
      { kind: 'binary', name: 'git', hint: undefined }
    ])
    expect(coerceRequirements([{ kind: 'binary', name: '   ' }])).toBeUndefined()
  })
})

describe('cache', () => {
  it('re-probes after the cache is cleared, so installing the tool takes effect', () => {
    const dir = scratch()
    const req: Requirement = { kind: 'file', path: 'appears-later.txt' }
    expect(probeRequirements([req], { baseDir: dir }).satisfied).toBe(false)

    writeFileSync(join(dir, 'appears-later.txt'), 'x')
    // Still false: within the TTL the negative is cached, which is the deliberate
    // trade for probing on every connect and every list.
    expect(probeRequirements([req], { baseDir: dir }).satisfied).toBe(false)

    clearRequirementCache()
    expect(probeRequirements([req], { baseDir: dir }).satisfied).toBe(true)
  })
})

// A DECLARED requirement only reaches a connector that was added after the field
// existed. Live diagnostics on 2026-08-26 showed every configured server reporting
// `requires: null` — so the whole mechanism was inert on the machine it shipped to,
// and Slack still failed the old way while the code that would have explained it sat
// unreachable. The command line is a dependency statement nobody has to write.
describe('impliedCommandRequirement — the dependency already on the command line', () => {
  it('derives the binary a stdio connector runs', () => {
    const req = impliedCommandRequirement('stdio', 'npx')
    expect(req).toEqual({ kind: 'binary', name: 'npx', hint: expect.any(String) })
  })

  it('derives NOTHING for remote transports — they spawn no process', () => {
    expect(impliedCommandRequirement('http', 'npx')).toBeNull()
    expect(impliedCommandRequirement('sse', 'npx')).toBeNull()
  })

  it('derives nothing when there is no command to run', () => {
    expect(impliedCommandRequirement('stdio', undefined)).toBeNull()
    expect(impliedCommandRequirement('stdio', '   ')).toBeNull()
  })
})

describe('effectiveRequirements', () => {
  it('appends the implied binary to whatever was declared', () => {
    const out = effectiveRequirements([{ kind: 'env', name: 'TOKEN' }], 'stdio', 'npx')
    expect(out?.map((r) => r.kind)).toEqual(['env', 'binary'])
  })

  it('covers a connector that declares NOTHING — the case that was inert', () => {
    const out = effectiveRequirements(undefined, 'stdio', 'npx')
    expect(out).toHaveLength(1)
    expect(out?.[0]).toMatchObject({ kind: 'binary', name: 'npx' })
  })

  // The author's own hint says how to install the thing; the generic one cannot.
  it('an explicit declaration for the same binary WINS, and is not duplicated', () => {
    const declared: Requirement[] = [
      { kind: 'binary', name: 'npx', hint: 'Install Node.js (nodejs.org).' }
    ]
    const out = effectiveRequirements(declared, 'stdio', 'npx')
    expect(out).toHaveLength(1)
    expect(out?.[0].hint).toBe('Install Node.js (nodejs.org).')
  })

  it('leaves a remote connector exactly as declared', () => {
    const declared: Requirement[] = [{ kind: 'env', name: 'TOKEN' }]
    expect(effectiveRequirements(declared, 'http', undefined)).toBe(declared)
  })

  // THE SPLIT THAT MATTERS, pinned here because it is a judgement call that would
  // otherwise be easy to "tidy" into a single code path.
  //
  // DECLARED requirements GATE the spawn (mcp-manager connectServer probes
  // `config.requires` alone). DERIVED ones only INFORM the row (getServers probes
  // the effective set for display). A declaration is an author opting in and saying
  // "this cannot work without X"; a derivation is this module GUESSING from a command
  // string. A wrong guess that gates takes a working connector dark, which is far
  // worse than the confusing error message the guess was meant to improve — and the
  // first version of resolveBinary already had exactly such a bug (it ignored a
  // connector's own PATH override). If a future change makes connectServer probe the
  // effective set, this test is the tripwire.
  it('the derived requirement is ADDITIVE — the declared list is never mutated', () => {
    const declared: Requirement[] = [{ kind: 'env', name: 'TOKEN' }]
    const before = JSON.stringify(declared)
    const out = effectiveRequirements(declared, 'stdio', 'npx')
    expect(JSON.stringify(declared)).toBe(before)
    expect(out).not.toBe(declared)
    expect(out).toHaveLength(2)
  })

  // node-repl and feishu spawn `process.execPath` — an absolute path to DUIN.exe.
  // If the derived requirement failed on that shape, this change would take the two
  // bundled servers offline on every machine, which is a far worse outcome than the
  // gap it fixes.
  it('an ABSOLUTE path that exists stays satisfied — the bundled-server shape', () => {
    const dir = scratch()
    const exe = join(dir, 'DUIN.exe')
    writeFileSync(exe, '')
    const out = effectiveRequirements(undefined, 'stdio', exe)
    expect(probeRequirements(out).satisfied).toBe(true)
  })

  it('an absolute path that does NOT exist is correctly reported missing', () => {
    const out = effectiveRequirements(undefined, 'stdio', join(scratch(), 'gone.exe'))
    expect(probeRequirements(out).satisfied).toBe(false)
  })
})

describe('requirementLabel', () => {
  it('names the subject without the caller re-switching on kind', () => {
    expect(requirementLabel({ kind: 'binary', name: 'npx' })).toBe('npx')
    expect(requirementLabel({ kind: 'env', name: 'TOKEN' })).toBe('TOKEN')
    expect(requirementLabel({ kind: 'file', path: './x' })).toBe('./x')
  })
})
