import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'

// `fs` is mocked as a pass-through so one test can make readFileSync fail for the
// ledger only — the EBUSY/EACCES a sync client or virus scanner produces while it
// holds a momentary exclusive handle. ESM namespaces are frozen, so a spy cannot
// reach the binding graph-history-store already imported; same pattern as
// settings-file-corrupt.test.ts and operator-model-corrupt-load.test.ts.
const failRead = vi.hoisted(() => ({ path: '' }))
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  return {
    ...real,
    default: real,
    readFileSync: (target: unknown, ...rest: unknown[]) => {
      if (failRead.path && target === failRead.path) {
        const err = new Error(`EBUSY: resource busy or locked, read '${String(target)}'`)
        ;(err as NodeJS.ErrnoException).code = 'EBUSY'
        throw err
      }
      return (real.readFileSync as (...a: unknown[]) => unknown)(target, ...rest)
    }
  }
})

import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import * as atomic from '../atomic-write'
import { recordGraphHistory, graphHistoryPath, MAX_HISTORY_DAYS } from './graph-history-store'

// Spy that still performs the real crash-safe write, so behavioural assertions
// stay honest while we can also prove the call site uses it at all.
const atomicSpy = vi.spyOn(atomic, 'atomicWriteFileSync')

// The ledger is one structural snapshot per day, is the ONLY copy of a past
// day's node/edge counts (buildGraphSnapshot only ever sees the live graph),
// and is absent from moat-backup's SOURCES. A read-modify-rewrite that drops
// lines it cannot parse, or that truncates the sole copy in place, erodes the
// series permanently.

let vault: string
let path: string

function stateDir(): string {
  return join(vault, '.duin', '_state')
}

function lines(): string[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'graph-hist-'))
  mkdirSync(stateDir(), { recursive: true })
  path = graphHistoryPath(vault)!
  atomicSpy.mockClear()
  failRead.path = ''
})

afterEach(() => {
  rmSync(vault, { recursive: true, force: true })
})

describe('recordGraphHistory — corrupt-line preservation', () => {
  it('carries a torn trailing record through the rewrite verbatim', () => {
    // A sync conflict or an interrupted prior write leaves a half-written line.
    const good = '{"date":"2026-07-16","notes":10,"edges":4}'
    const torn = '{"date":"2026-07-18","notes":12'
    writeFileSync(path, `${good}\n${torn}\n`, 'utf8')

    const res = recordGraphHistory(vault, { notes: 13, edges: 5 }, { today: '2026-07-19' })

    const after = lines()
    expect(after).toContain(torn) // the whole point: NOT deleted from the only copy
    expect(after).toContain(good)
    expect(res.preservedCorruptLines).toBe(1)
    // Nothing was silently lost: 2 prior lines + today's new row.
    expect(after).toHaveLength(3)
    // The panel still only sees interpretable rows.
    expect(res.rows.map((r) => r.date)).toEqual(['2026-07-16', '2026-07-19'])
  })

  it('preserves a sync-injected conflict marker rather than erasing it', () => {
    const marker = '<<<<<<< HEAD'
    writeFileSync(path, `{"date":"2026-07-16","notes":10}\n${marker}\n`, 'utf8')

    recordGraphHistory(vault, { notes: 11 }, { today: '2026-07-19' })

    expect(lines()).toContain(marker)
  })

  it('never treats an unparseable line as today\'s row, so it is not superseded', () => {
    const torn = '{"date":"2026-07-19","notes":12'
    writeFileSync(path, `${torn}\n`, 'utf8')

    recordGraphHistory(vault, { notes: 13 }, { today: '2026-07-19' })

    const after = lines()
    expect(after).toContain(torn)
    expect(after).toHaveLength(2)
  })

  it('rewrites valid prior lines byte-for-byte', () => {
    const exotic = '{"notes":10,"date":"2026-07-16","extra":{"z":1,"a":2}}'
    writeFileSync(path, `${exotic}\n`, 'utf8')

    recordGraphHistory(vault, { notes: 11 }, { today: '2026-07-19' })

    expect(lines()[0]).toBe(exotic)
  })
})

describe('recordGraphHistory — upsert + retention', () => {
  it('replaces today\'s row rather than appending a duplicate', () => {
    writeFileSync(path, '{"date":"2026-07-19","notes":1}\n', 'utf8')

    const res = recordGraphHistory(vault, { notes: 99 }, { today: '2026-07-19' })

    expect(lines()).toHaveLength(1)
    expect(res.rows).toEqual([{ date: '2026-07-19', notes: 99 }])
  })

  it('caps the ledger at MAX_HISTORY_DAYS', () => {
    const prior = Array.from({ length: MAX_HISTORY_DAYS + 20 }, (_, i) =>
      JSON.stringify({ date: `d${i}`, notes: i })
    )
    writeFileSync(path, prior.join('\n') + '\n', 'utf8')

    recordGraphHistory(vault, { notes: 0 }, { today: '2026-07-19' })

    expect(lines()).toHaveLength(MAX_HISTORY_DAYS)
  })

  it('does not create the state dir when it is absent (cold-data-safe)', () => {
    rmSync(stateDir(), { recursive: true, force: true })

    const res = recordGraphHistory(vault, { notes: 1 }, { today: '2026-07-19' })

    expect(res.rows).toEqual([])
    expect(readdirSync(join(vault, '.duin'))).toEqual([])
  })
})

describe('recordGraphHistory — unreadable ledger', () => {
  // The third data-loss rule, and the one the first two hid. readRawLines used to
  // answer `[]` for BOTH "no ledger yet" and "the ledger is there but the read
  // threw" — indistinguishable to the caller, whose next act is a whole-file
  // rewrite. A vault in a synced folder is the documented deployment here, so one
  // momentary exclusive handle from a sync client / AV scanner during a panel open
  // was enough to replace a year of unrebuildable rows with today's single row,
  // atomically and with a successful-looking return.
  it('abstains from the rewrite when the ledger exists but cannot be read', () => {
    const prior = Array.from({ length: 200 }, (_, i) => JSON.stringify({ date: `d${i}`, nodes: i }))
    writeFileSync(path, prior.join('\n') + '\n', 'utf8')
    const before = readFileSync(path, 'utf8')

    failRead.path = path
    const res = recordGraphHistory(vault, { nodes: 999 }, { today: '2026-07-19' })
    failRead.path = ''

    // The only assertion that matters: the year of history is still on disk.
    expect(readFileSync(path, 'utf8')).toBe(before)
    // And it survived because nothing was written — not because a write happened
    // to be harmless. Pre-fix this was 1 call, with a 1-line body.
    expect(atomicSpy).not.toHaveBeenCalled()
    expect(res.rows).toEqual([])
    expect(res.preservedCorruptLines).toBe(0)
  })

  it('still creates the ledger on the genuine first run (absent != unreadable)', () => {
    // The abstain must not swallow the case it is distinguished FROM: with no file
    // at all there is no history to lose, so today's row is recorded as before.
    const res = recordGraphHistory(vault, { nodes: 7 }, { today: '2026-07-19' })

    expect(atomicSpy).toHaveBeenCalledTimes(1)
    expect(lines()).toHaveLength(1)
    expect(res.rows).toEqual([{ date: '2026-07-19', nodes: 7 }])
  })

  it('reports the skipped snapshot instead of failing silently', () => {
    writeFileSync(path, '{"date":"2026-07-16","nodes":10}\n', 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    failRead.path = path
    recordGraphHistory(vault, { nodes: 11 }, { today: '2026-07-19' })
    failRead.path = ''

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('[graph-history-store]')
    warn.mockRestore()
  })
})

describe('recordGraphHistory — atomic write', () => {
  it('routes the rewrite through atomicWriteFileSync, not a bare writeFileSync', () => {
    writeFileSync(path, '{"date":"2026-07-16","notes":10}\n', 'utf8')

    // A bare writeFileSync truncates the sole copy in place, so an interrupted
    // or ENOSPC write shreds VALID records — and manufactures exactly the torn
    // line the parser above then has to preserve. The tmp+fsync+rename in
    // atomic-write.ts (already used by settings-file / action-ledger /
    // moat-backup for this class of file) closes that window.
    expect(atomicSpy).toHaveBeenCalledTimes(0)
    recordGraphHistory(vault, { notes: 11 }, { today: '2026-07-19' })
    expect(atomicSpy).toHaveBeenCalledTimes(1)
    expect(atomicSpy.mock.calls[0][0]).toBe(path)

    // And the staging file is cleaned up by the rename.
    expect(readdirSync(stateDir())).toEqual(['graph-history.jsonl'])
    expect(lines()).toHaveLength(2)
  })
})
