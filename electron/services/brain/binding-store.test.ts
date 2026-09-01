import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as atomic from '../atomic-write'
import { loadBindings, loadBindingEntries, appendBinding, writeBindings } from './binding-store'
import { bindCandidate, correctionFailsBindings } from './binding-ledger'
import type { BindingRow } from './binding-ledger'

// A bind row is minted ONLY by an explicit human confirm (POST /state/bind-candidate 400s without
// a `rule` + `candidate.theme[]`; nothing auto-binds). binding-ledger.jsonl is also absent from
// moat-backup's SOURCES allowlist — no snapshot, no .trash tombstone. So a row dropped from a
// rewrite is gone for good. These tests pin that a line the parser cannot read still survives.

// Spy that still performs the real crash-safe write, so behavioural assertions stay honest while
// we can also prove the rewrite goes through it at all.
const atomicSpy = vi.spyOn(atomic, 'atomicWriteFileSync')

let vault: string
let path: string

function stateDir(): string {
  return join(vault, '.duin', '_state')
}

function lines(): string[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
}

function row(id: string, theme: string[]): BindingRow {
  return bindCandidate({ theme, count: theme.length, sample: id }, `rule for ${id}`, 1_700_000_000_000, id)
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'binding-store-'))
  mkdirSync(stateDir(), { recursive: true })
  path = join(stateDir(), 'binding-ledger.jsonl')
  atomicSpy.mockClear()
})

afterEach(() => {
  rmSync(vault, { recursive: true, force: true })
})

describe('writeBindings — corrupt-line preservation', () => {
  it('carries a torn mid-file line through the rewrite verbatim, in position', () => {
    // The reported scenario: 5 human-confirmed rows, row 3 torn by a crash mid-append.
    const good = [row('b1', ['a', 'b']), row('b2', ['c', 'd']), row('b4', ['g', 'h']), row('b5', ['i', 'j'])]
    const torn = '{"id":"bind-b3","theme":["e","f"],"rule":"do not '
    writeFileSync(
      path,
      [JSON.stringify(good[0]), JSON.stringify(good[1]), torn, JSON.stringify(good[2]), JSON.stringify(good[3])].join(
        '\n'
      ) + '\n',
      'utf8'
    )

    const all = loadBindings(vault)
    expect(all).toHaveLength(4) // the parser still only interprets what it can read

    writeBindings(vault, all)

    const after = lines()
    // The whole point: row 3's bytes are still on disk, not deleted from the only copy.
    expect(after).toContain(torn)
    expect(after).toHaveLength(5)
    // And it landed back in its original slot, not shunted to the end.
    expect(after[2]).toBe(torn)
  })

  it('preserves a torn TRAILING line (the crash-mid-append shape)', () => {
    const torn = '{"id":"bind-b2","theme":["c"'
    writeFileSync(path, JSON.stringify(row('b1', ['a', 'b'])) + '\n' + torn + '\n', 'utf8')

    writeBindings(vault, loadBindings(vault))

    expect(lines()).toContain(torn)
    expect(lines()).toHaveLength(2)
  })

  it('preserves a LEADING unparseable line', () => {
    const junk = '<<<<<<< HEAD'
    writeFileSync(path, junk + '\n' + JSON.stringify(row('b1', ['a', 'b'])) + '\n', 'utf8')

    writeBindings(vault, loadBindings(vault))

    expect(lines()[0]).toBe(junk)
    expect(lines()).toHaveLength(2)
  })

  it('still applies the caller\'s intended mutation to the parseable rows', () => {
    // Preservation must not come at the cost of the write actually doing its job.
    const r = row('b1', ['alpha', 'beta'])
    writeFileSync(path, JSON.stringify(r) + '\n' + '{"id":"torn"' + '\n', 'utf8')

    const all = loadBindings(vault)
    all[0].prediction.status = 'failed'
    all[0].prediction.failedAt = 42
    writeBindings(vault, all)

    const reloaded = loadBindings(vault)
    expect(reloaded[0].prediction.status).toBe('failed')
    expect(reloaded[0].prediction.failedAt).toBe(42)
    expect(lines()).toContain('{"id":"torn"')
  })

  it('end-to-end: a healthy operator correction does not erase the torn row', () => {
    // brain-state-routes.ts:521-524 — loadBindings, correctionFailsBindings, writeBindings.
    // The detonator is a NORMAL, correct correction; the torn line is the precondition.
    const r1 = row('b1', ['deploy', 'staging'])
    const torn = '{"id":"bind-b2","theme":["invoice","late'
    writeFileSync(path, JSON.stringify(r1) + '\n' + torn + '\n', 'utf8')

    const all = loadBindings(vault)
    const tokenize = (s: string): Set<string> => new Set(s.toLowerCase().split(/\W+/).filter(Boolean))
    const failed = correctionFailsBindings(all, { why: 'deploy to staging broke again' }, tokenize, Date.now())
    expect(failed.length).toBeGreaterThan(0) // the branch that triggers the rewrite

    writeBindings(vault, all)

    expect(lines()).toContain(torn)
    expect(loadBindings(vault)[0].prediction.status).toBe('failed')
  })

  it('leaves a fully-parseable ledger byte-identical in content', () => {
    const rows = [row('b1', ['a', 'b']), row('b2', ['c', 'd'])]
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

    writeBindings(vault, loadBindings(vault))

    expect(lines()).toEqual(rows.map((r) => JSON.stringify(r)))
  })
})

describe('loadBindingEntries', () => {
  it('returns unparseable lines with parsed === null rather than discarding them', () => {
    writeFileSync(path, JSON.stringify(row('b1', ['a', 'b'])) + '\n' + 'not json\n', 'utf8')

    const entries = loadBindingEntries(vault)
    expect(entries).toHaveLength(2)
    expect(entries[1].parsed).toBeNull()
    expect(entries[1].raw).toBe('not json')
  })

  it('treats a JSON scalar / array line as unparseable rather than a row', () => {
    writeFileSync(path, '"just a string"\n[1,2,3]\n', 'utf8')

    expect(loadBindings(vault)).toEqual([])
    writeBindings(vault, [])
    // Not a BindingRow, but still bytes we did not author a deletion for.
    expect(lines()).toEqual(['"just a string"', '[1,2,3]'])
  })

  it('is null-safe and tolerates a missing file', () => {
    expect(loadBindings(null)).toEqual([])
    expect(loadBindingEntries(null)).toEqual([])
    rmSync(path, { force: true })
    expect(loadBindings(vault)).toEqual([])
  })
})

describe('writeBindings — atomic write', () => {
  it('routes the rewrite through atomicWriteFileSync, not a bare writeFileSync', () => {
    writeFileSync(path, JSON.stringify(row('b1', ['a', 'b'])) + '\n', 'utf8')

    expect(atomicSpy).toHaveBeenCalledTimes(0)
    writeBindings(vault, loadBindings(vault))
    expect(atomicSpy).toHaveBeenCalledTimes(1)
    expect(atomicSpy.mock.calls[0][0]).toBe(path)

    // The staging file is cleaned up by the rename.
    expect(readdirSync(stateDir())).toEqual(['binding-ledger.jsonl'])
  })

  it('refuses to act without a vault dir', () => {
    expect(writeBindings(null, [])).toBe(false)
    expect(atomicSpy).not.toHaveBeenCalled()
  })
})

describe('appendBinding', () => {
  it('appends a complete line and durably commits it', () => {
    expect(appendBinding(vault, row('b1', ['a', 'b']))).toBe(true)
    expect(appendBinding(vault, row('b2', ['c', 'd']))).toBe(true)

    const rows = loadBindings(vault)
    expect(rows.map((r) => r.id)).toEqual(['bind-b1', 'bind-b2'])
    // Exactly one line per append — an fsync retry must never duplicate a human-confirmed row.
    expect(lines()).toHaveLength(2)
  })

  it('appends after an unparseable line without disturbing it', () => {
    writeFileSync(path, '{"torn":\n', 'utf8')

    appendBinding(vault, row('b1', ['a', 'b']))

    expect(lines()[0]).toBe('{"torn":')
    expect(loadBindings(vault)).toHaveLength(1)
  })

  it('is null-safe', () => {
    expect(appendBinding(null, row('b1', ['a', 'b']))).toBe(false)
  })
})
