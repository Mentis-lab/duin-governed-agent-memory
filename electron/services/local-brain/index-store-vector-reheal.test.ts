// Regression: the vector self-heal decision. A reindex commits chunk text + the
// hash ledger BEFORE the best-effort embed pass, so an embed that fails/times out
// (or a notes_vec rebuild without a ledger clear) strands the index with text
// chunks but ZERO vectors — and because embedder_id is unchanged, nothing counts
// as "changed" and vectors never backfill, silently degrading hybrid search to
// lexical-only. needsVectorReheal detects exactly that state.
import { describe, it, expect } from 'vitest'
import { needsVectorReheal } from './index-store'

describe('needsVectorReheal — vector-desync self-heal decision', () => {
  it('chunks + ledger present but ZERO vectors → re-heal (the silent lexical-only bug)', () => {
    expect(needsVectorReheal(14526, 1474, 0)).toBe(true)
  })

  it('vectors present → healthy, no re-heal', () => {
    expect(needsVectorReheal(14526, 1474, 14526)).toBe(false)
    expect(needsVectorReheal(14526, 1474, 1)).toBe(false)
  })

  it('empty index (no chunks) → chunks-empty self-heal owns this, not us', () => {
    expect(needsVectorReheal(0, 1474, 0)).toBe(false)
  })

  it('fresh index (no ledger) → normal full embed, not a desync', () => {
    expect(needsVectorReheal(0, 0, 0)).toBe(false)
    expect(needsVectorReheal(10, 0, 0)).toBe(false)
  })
})
