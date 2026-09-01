// entity-automerge-tick — the IO half of the unattended duplicate-entity merge.
//
// This file had NO test until 2026-08-03, which is notable given what it does: it is the only code
// path in DUIN that mutates entity identity without a human in the loop, writing
// <vault>/.duin/_state/entity-aliases.json on the claim-metabolism tick. The pure policy half
// (entity-automerge.ts) was well covered; the part that actually touches the operator's disk was
// not. A wrong merge here is the one class the repo calls not-cleanly-recoverable — two real people
// collapsed into one identity — so the write path deserves at least as much coverage as the policy.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as atomic from '../atomic-write'
import {
  runEntityAutoMergeTick,
  writeAliasGroups,
  candidatesFromReport,
  aliasFilePath,
  reloadAliasGroups
} from './entity-automerge-tick'
import { aliasWhitelistUnreadable, loadAliasGroups } from './entity-resolver'

// Spy that still performs the real crash-safe write, so the behavioural assertions above stay
// honest while we can also prove the rewrite goes through it at all.
const atomicSpy = vi.spyOn(atomic, 'atomicWriteFileSync')

let vault = ''

/** A candidate pair the containment-spine policy will accept: one member lexically contains the
 *  other, cosine is above the 0.9 auto bar, and the group is small. */
const acceptableReport = () => ({
  candidates: [
    {
      suggestedCanonicalLabel: 'Theo Quill',
      members: ['Theo Quill', 'Theo Quill '],
      cosineMin: 0.97
    }
  ]
})

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'duin-automerge-'))
})

afterEach(() => {
  try {
    rmSync(vault, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('candidatesFromReport — defensive narrowing of an untyped route payload', () => {
  it('returns nothing for malformed input rather than throwing on a background tick', () => {
    expect(candidatesFromReport(null)).toEqual([])
    expect(candidatesFromReport(undefined)).toEqual([])
    expect(candidatesFromReport({})).toEqual([])
    expect(candidatesFromReport({ candidates: 'nope' as unknown })).toEqual([])
    expect(candidatesFromReport({ candidates: [null, 3, 'x'] })).toEqual([])
  })

  it('drops a candidate with fewer than two members (a group of one is not a duplicate)', () => {
    expect(candidatesFromReport({ candidates: [{ canonical: 'Solo', members: ['Solo'] }] })).toEqual([])
  })

  it('accepts both the label-object and bare-string member shapes', () => {
    const out = candidatesFromReport({
      candidates: [{ canonical: 'A', members: ['A', { label: 'A Inc' }] }]
    })
    expect(out).toHaveLength(1)
    expect(out[0].candidate.members).toEqual(['A', 'A Inc'])
  })
})

describe('writeAliasGroups — the file a human still has to be able to read', () => {
  it('creates the _state directory and writes pretty-printed JSON', () => {
    writeAliasGroups(vault, [{ canonicalId: 'person:x', canonical: 'X', aliases: ['x'] }])
    const raw = readFileSync(aliasFilePath(vault), 'utf-8')
    // Pretty-printed on purpose: an auto-merge must not turn a hand-edited file into a blob.
    expect(raw).toContain('\n  ')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toHaveLength(1)
  })
})

describe('runEntityAutoMergeTick — the unattended write', () => {
  it('stamps source:"auto" so a machine merge is never mistaken for a confirmed one', () => {
    const res = runEntityAutoMergeTick(vault, acceptableReport())
    expect(res.merged).toBe(1)
    const rows = JSON.parse(readFileSync(aliasFilePath(vault), 'utf-8'))
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('auto')
  })

  it('is idempotent — a repeat tick writes nothing and does not churn the file mtime', () => {
    runEntityAutoMergeTick(vault, acceptableReport())
    const before = statSync(aliasFilePath(vault)).mtimeMs
    const again = runEntityAutoMergeTick(vault, acceptableReport())
    expect(again.merged).toBe(0)
    expect(statSync(aliasFilePath(vault)).mtimeMs).toBe(before)
  })

  it('does not create the file at all when nothing is approved', () => {
    // A tick that merges nothing must leave no trace — the operator should not find a file they
    // never asked for appearing in their vault.
    const res = runEntityAutoMergeTick(vault, { candidates: [] })
    expect(res).toEqual({ proposed: 0, merged: 0, refused: {} })
    expect(existsSync(aliasFilePath(vault))).toBe(false)
  })

  it('refuses a low-cosine pair and reports WHY, so a skipped duplicate is explainable', () => {
    const res = runEntityAutoMergeTick(vault, {
      candidates: [{ suggestedCanonicalLabel: 'Theo Quill', members: ['Theo Quill', 'Theo Quill '], cosineMin: 0.5 }]
    })
    expect(res.merged).toBe(0)
    expect(Object.keys(res.refused).length).toBeGreaterThan(0)
    expect(existsSync(aliasFilePath(vault))).toBe(false)
  })

  it('returns zeros instead of throwing when there is no vault', () => {
    expect(runEntityAutoMergeTick(null, acceptableReport())).toEqual({ proposed: 0, merged: 0, refused: {} })
  })

  it('preserves an operator-written row it did not create', () => {
    // The tick rewrites the file WHOLE, so a hand-confirmed row must survive an auto-merge pass.
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    writeFileSync(
      aliasFilePath(vault),
      JSON.stringify([{ canonicalId: 'person:mine', canonical: 'Mine', aliases: ['mine'] }], null, 2) + '\n'
    )
    runEntityAutoMergeTick(vault, acceptableReport())
    const rows = JSON.parse(readFileSync(aliasFilePath(vault), 'utf-8'))
    const mine = rows.find((r: { canonicalId: string }) => r.canonicalId === 'person:mine')
    expect(mine).toBeDefined()
    // Untouched means untouched: no back-inferred provenance on a row we know nothing about.
    expect(mine.source).toBeUndefined()
  })
})

// The whitelist is rewritten WHOLE by two background passes on the same tick, and loadAliasGroups
// reports an unparseable file and an absent one identically (`[]`). That made "append" silently
// mean "replace" whenever the file was broken — and this function is what broke it, since a bare
// writeFileSync truncates in place. Both halves are pinned here.
describe('an unreadable whitelist is never treated as an empty one', () => {
  const corrupt = '[\n  { "canonicalId": "person:mine", "canonical": "Mine", "aliases": ["mine"] },\n]\n'

  function writeCorrupt(): void {
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    writeFileSync(aliasFilePath(vault), corrupt, 'utf-8')
  }

  it('aliasWhitelistUnreadable tells absent apart from unparseable', () => {
    expect(aliasWhitelistUnreadable(vault)).toBe(false) // absent — nothing to protect
    expect(aliasWhitelistUnreadable(null)).toBe(false)
    writeAliasGroups(vault, [{ canonicalId: 'person:x', canonical: 'X', aliases: ['x'] }])
    expect(aliasWhitelistUnreadable(vault)).toBe(false) // present and fine
    writeCorrupt()
    expect(aliasWhitelistUnreadable(vault)).toBe(true)
    writeFileSync(aliasFilePath(vault), '{"canonicalId":"person:mine"}', 'utf-8')
    expect(aliasWhitelistUnreadable(vault)).toBe(true) // parses, but not into a whitelist
  })

  it('runEntityAutoMergeTick abstains instead of writing its rows over the file', () => {
    writeCorrupt()
    const res = runEntityAutoMergeTick(vault, acceptableReport())
    expect(res.merged).toBe(0)
    expect(res.refused['whitelist-unreadable']).toBe(1)
    // Byte-for-byte — the operator keeps the file they can still repair by hand.
    expect(readFileSync(aliasFilePath(vault), 'utf-8')).toBe(corrupt)
  })

  it('writeAliasGroups goes through atomicWriteFileSync, not a bare writeFileSync', () => {
    // The truncated file the guards above defend against was manufactured HERE: a whole-file
    // writeFileSync that crashes mid-write leaves half a JSON array on disk.
    atomicSpy.mockClear()
    writeAliasGroups(vault, [{ canonicalId: 'person:x', canonical: 'X', aliases: ['x'] }])
    expect(atomicSpy).toHaveBeenCalledTimes(1)
    expect(loadAliasGroups(vault)).toHaveLength(1)
  })
})

describe('backward compatibility — files written before `source` existed', () => {
  it('still loads, and reads back as unknown rather than being inferred as human', () => {
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    writeFileSync(
      aliasFilePath(vault),
      JSON.stringify([{ canonicalId: 'person:legacy', canonical: 'Legacy', aliases: ['legacy', 'leg'] }]) + '\n'
    )
    const groups = loadAliasGroups(vault)
    expect(groups).toHaveLength(1)
    expect(groups[0].canonical).toBe('Legacy')
    // Property 3 — provenance is recorded, never inferred. We do not know who merged this.
    expect(groups[0].source).toBeUndefined()
    expect(reloadAliasGroups(vault)).toHaveLength(1)
  })
})
