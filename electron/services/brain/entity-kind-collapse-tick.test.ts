import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => { throw new Error('electron app not available in test environment') } },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { runKindCollapseTick, kindCollapseEnabled, aliasFilePath } from './entity-kind-collapse-tick'

// The IO half of the collapse had NO tests, and that is part of why the 2026-08-04 incident
// shipped: the pre-deploy review flagged that `dryRun` has no caller — filed LOW, as a missing
// convenience — so nothing could show what a full pass would do before it did it. It was the
// warning. These tests cover the gate and the dry run that gate exists to keep usable.

// A census where one label is recorded under two kinds — the exact thing the pass collapses.
const CONSTRUCTION = {
  entities: [
    { id: 'e1', label: 'Bilibili', kind: 'org' },
    { id: 'e2', label: 'Bilibili', kind: 'topic' },
    { id: 'e3', label: 'Solo', kind: 'topic' }
  ]
}

describe('entity-kind-collapse-tick — kill switch', () => {
  let vault: string

  // Created per-test, INSIDE the lifecycle rather than as a module-level condition: a
  // `skipIf` evaluated at collection time cannot see a directory a beforeEach makes, and a
  // test that silently skips is worse than one that fails.
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-collapse-'))
    delete process.env.DUIN_ENTITY_KIND_COLLAPSE
  })
  afterEach(() => {
    delete process.env.DUIN_ENTITY_KIND_COLLAPSE
    rmSync(vault, { recursive: true, force: true })
  })

  it('is default ON, and only an explicit "0" disables it', () => {
    expect(kindCollapseEnabled()).toBe(true) // unset ⇒ on
    process.env.DUIN_ENTITY_KIND_COLLAPSE = '0'
    expect(kindCollapseEnabled()).toBe(false)
    process.env.DUIN_ENTITY_KIND_COLLAPSE = '1'
    expect(kindCollapseEnabled()).toBe(true)
  })

  it('ON: collapses the cross-kind label onto the higher-precedence kind and persists it', () => {
    const res = runKindCollapseTick(vault, CONSTRUCTION)
    expect(res.merged).toBe(1)
    expect(res.groups[0].canonicalId).toBe('org:bilibili') // org outranks topic
    expect(existsSync(aliasFilePath(vault))).toBe(true)
    const written = JSON.parse(readFileSync(aliasFilePath(vault), 'utf-8')) as Array<{ source: string }>
    expect(written).toHaveLength(1)
    expect(written[0].source).toBe('auto-kind')
  })

  it('OFF: writes nothing and touches no file', () => {
    process.env.DUIN_ENTITY_KIND_COLLAPSE = '0'
    const res = runKindCollapseTick(vault, CONSTRUCTION)
    expect(res).toEqual({ proposed: 0, merged: 0, skipped: {}, groups: [] })
    expect(existsSync(aliasFilePath(vault))).toBe(false)
  })

  // The point of a targeted switch: an operator who has just turned the pass off after an
  // incident still needs to see what it wanted to do. A dry run writes nothing, so gating it
  // would buy no safety and cost the only inspection surface there is.
  it('OFF: a dry run still reports what it WOULD do, and still writes nothing', () => {
    process.env.DUIN_ENTITY_KIND_COLLAPSE = '0'
    const res = runKindCollapseTick(vault, CONSTRUCTION, { dryRun: true })
    expect(res.proposed).toBe(1)
    expect(res.merged).toBe(0) // proposed ≠ written
    expect(res.groups[0].canonicalId).toBe('org:bilibili')
    expect(existsSync(aliasFilePath(vault))).toBe(false)
  })

  it('ON: a dry run is also write-free, so the two differ only in persistence', () => {
    const dry = runKindCollapseTick(vault, CONSTRUCTION, { dryRun: true })
    expect(dry.merged).toBe(0)
    expect(existsSync(aliasFilePath(vault))).toBe(false)
    const wet = runKindCollapseTick(vault, CONSTRUCTION)
    expect(wet.merged).toBe(1)
    expect(wet.groups).toEqual(dry.groups) // the dry run told the truth
  })

  it('is idempotent: a second pass over the same census writes nothing new', () => {
    expect(runKindCollapseTick(vault, CONSTRUCTION).merged).toBe(1)
    const second = runKindCollapseTick(vault, CONSTRUCTION)
    expect(second.merged).toBe(0)
    expect(second.skipped['already-in-whitelist']).toBe(1)
    expect(JSON.parse(readFileSync(aliasFilePath(vault), 'utf-8'))).toHaveLength(1)
  })

  it('no vault dir ⇒ no work, regardless of the switch', () => {
    expect(runKindCollapseTick(null, CONSTRUCTION).merged).toBe(0)
    expect(runKindCollapseTick(undefined, CONSTRUCTION, { dryRun: true }).proposed).toBe(0)
  })

  // The append is `[...existing, ...groups]`, and `existing` comes from loadAliasGroups, which
  // returns [] for an unparseable file exactly as it does for an absent one. So a single hand-edit
  // typo turned the next tick's APPEND into a REPLACE, destroying every hand-authored group with
  // no sidecar and no log line (moat-backup snapshots the file, but only on reindex, 10 deep, and
  // only an operator who NOTICES can restore it). What made it invisible: both halves look right in
  // isolation — a best-effort loader that must not throw on a background tick, and an append that
  // is provably order-preserving. The defect only exists in the seam between them.
  it('does NOT overwrite a whitelist that exists but did not parse', () => {
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    // A trailing comma: the most ordinary way a human breaks a file the app pretty-prints
    // BECAUSE humans edit it.
    const corrupt =
      '[\n  {\n    "canonicalId": "person:mine",\n    "canonical": "Mine",\n    "aliases": ["mine"]\n  },\n]\n'
    writeFileSync(aliasFilePath(vault), corrupt, 'utf-8')

    const res = runKindCollapseTick(vault, CONSTRUCTION)

    expect(res.merged).toBe(0)
    expect(res.skipped['whitelist-unreadable']).toBe(1)
    // Byte-for-byte: abstaining means the operator still has the file they can repair.
    expect(readFileSync(aliasFilePath(vault), 'utf-8')).toBe(corrupt)
  })

  it('a dry run over an unreadable whitelist reports the abstention, not a phantom collapse', () => {
    // A dry run writes nothing, so this is not about safety: it is about not answering "what would
    // you do?" with a census-wide collapse computed from a whitelist that was never actually read.
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    writeFileSync(aliasFilePath(vault), '{ not an array }', 'utf-8')
    const res = runKindCollapseTick(vault, CONSTRUCTION, { dryRun: true })
    expect(res.proposed).toBe(0)
    expect(res.skipped['whitelist-unreadable']).toBe(1)
  })
})
