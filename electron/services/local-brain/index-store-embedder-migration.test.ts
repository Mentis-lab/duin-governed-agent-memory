import { describe, it, expect } from 'vitest'
// NB: the index_meta read/write + the vec DDL migration are exercised LIVE (the
// deploy verify) — better-sqlite3 is built for Electron's ABI and won't load in
// vitest, so the DB-integration path can't run here (same constraint that keeps
// every index-store unit test pure). This file locks the pure migration DECISION.
import { vecMigrationNeeded } from './index-store'

describe('vecMigrationNeeded (pure decision)', () => {
  it('no change → false', () => {
    expect(vecMigrationNeeded('bge-small-en-v1.5', 384, 'bge-small-en-v1.5', 384)).toBe(false)
  })
  it('embedder id changed at the SAME width → true (vectors are model-specific)', () => {
    // the subtle case: 384→384 across models still needs a re-embed
    expect(vecMigrationNeeded('bge-small-en-v1.5', 384, 'multilingual-e5-small', 384)).toBe(true)
  })
  it('dimension changed → true (e.g. switch to bge-m3 1024)', () => {
    expect(vecMigrationNeeded('m', 384, 'm', 1024)).toBe(true)
  })
  it('fresh/unknown stored id → true', () => {
    expect(vecMigrationNeeded(null, 384, 'bge-small-en-v1.5', 384)).toBe(true)
  })
})
