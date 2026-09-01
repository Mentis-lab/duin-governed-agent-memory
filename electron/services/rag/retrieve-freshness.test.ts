import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('electron app not available in test environment')
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { fuseRRF, rrfFreshnessEnabled } from './retrieve'

const DAY_MS = 86_400_000

// Toggle the freshness flag for a single test, always restoring afterwards so
// the default-OFF contract (and every OTHER test in the suite) is untouched.
function withFreshness(on: boolean, fn: () => void): void {
  const prev = process.env.DUIN_RRF_FRESHNESS
  if (on) process.env.DUIN_RRF_FRESHNESS = '1'
  else delete process.env.DUIN_RRF_FRESHNESS
  try {
    fn()
  } finally {
    if (prev === undefined) delete process.env.DUIN_RRF_FRESHNESS
    else process.env.DUIN_RRF_FRESHNESS = prev
  }
}

afterEach(() => {
  delete process.env.DUIN_RRF_FRESHNESS
})

describe('rrfFreshnessEnabled', () => {
  it('is false by default when the env flag is unset', () => {
    delete process.env.DUIN_RRF_FRESHNESS
    expect(rrfFreshnessEnabled()).toBe(false)
  })

  it('is true only for the exact string "1"', () => {
    process.env.DUIN_RRF_FRESHNESS = '1'
    expect(rrfFreshnessEnabled()).toBe(true)
    process.env.DUIN_RRF_FRESHNESS = 'true'
    expect(rrfFreshnessEnabled()).toBe(false)
    process.env.DUIN_RRF_FRESHNESS = '0'
    expect(rrfFreshnessEnabled()).toBe(false)
  })
})

describe('fuseRRF freshness — flag OFF (regression lock)', () => {
  // A fixed input whose pure-RRF fused order + values are locked here. If the
  // freshness flag-OFF path is ever not byte-identical, this test breaks.
  const now = Date.now()
  const lex = [
    { rowid: 1, chunk_id: 'A', score: -3, mtimeMs: now },
    { rowid: 2, chunk_id: 'B', score: -2, mtimeMs: now },
    { rowid: 3, chunk_id: 'C', score: -1, mtimeMs: now }
  ]
  const vec = [
    { rowid: 1, chunk_id: 'B', distance: 0.1, mtimeMs: now },
    { rowid: 2, chunk_id: 'D', distance: 0.2, mtimeMs: now }
  ]

  it('produces the pure-RRF order even when rows carry mtimeMs', () => {
    delete process.env.DUIN_RRF_FRESHNESS
    const fused = fuseRRF(lex, vec, 8)
    expect(fused.map((f) => f.chunkId)).toEqual(['B', 'A', 'D', 'C'])
  })

  it('produces the exact pure-RRF fused scores (no factor applied)', () => {
    delete process.env.DUIN_RRF_FRESHNESS
    const fused = fuseRRF(lex, vec, 8)
    const byId = new Map(fused.map((f) => [f.chunkId, f.scores.fused]))
    // Exact RRF math, k = 60.
    expect(byId.get('A')).toBe(1 / 61)
    expect(byId.get('B')).toBe(1 / 62 + 1 / 61)
    expect(byId.get('C')).toBe(1 / 63)
    expect(byId.get('D')).toBe(1 / 62)
    // No mtimeMs leaks into the returned shape.
    expect(fused[0]).not.toHaveProperty('mtimeMs')
  })
})

describe('fuseRRF freshness — flag ON', () => {
  it('breaks an equal-base tie in favor of the newer mtime', () => {
    const now = Date.now()
    // NEW and OLD each rank #1 in their own leg ⇒ identical base fused score.
    const lex = [{ rowid: 1, chunk_id: 'NEW', score: -1, mtimeMs: now }]
    const vec = [
      { rowid: 1, chunk_id: 'OLD', distance: 0.1, mtimeMs: now - 400 * DAY_MS }
    ]
    withFreshness(true, () => {
      const fused = fuseRRF(lex, vec, 8)
      expect(fused[0].chunkId).toBe('NEW')
      const newScore = fused.find((f) => f.chunkId === 'NEW')!.scores.fused
      const oldScore = fused.find((f) => f.chunkId === 'OLD')!.scores.fused
      expect(newScore).toBeGreaterThan(oldScore)
    })
  })

  it('bounded boost does NOT overtake a higher-fused older hit', () => {
    const now = Date.now()
    // OLD at rank 1 (base 1/61); NEW at rank 15 (base 1/75). The base gap
    // (~23%) is intentionally just beyond the 15% max boost, so even the
    // freshest possible NEW cannot overtake the older-but-higher OLD.
    const filler = Array.from({ length: 13 }, (_, i) => ({
      rowid: i + 2,
      chunk_id: `F${i}`,
      score: -1
      // no mtimeMs ⇒ factor 1
    }))
    const lex = [
      { rowid: 1, chunk_id: 'OLD', score: -1, mtimeMs: now - 1000 * DAY_MS },
      ...filler,
      { rowid: 15, chunk_id: 'NEW', score: -1, mtimeMs: now }
    ]
    withFreshness(true, () => {
      const fused = fuseRRF(lex, [], 20)
      const idxOld = fused.findIndex((f) => f.chunkId === 'OLD')
      const idxNew = fused.findIndex((f) => f.chunkId === 'NEW')
      expect(idxOld).toBeLessThan(idxNew)
      // The boost DID apply to NEW (its fused rose above the raw 1/75 base)…
      const newScore = fused.find((f) => f.chunkId === 'NEW')!.scores.fused
      expect(newScore).toBeGreaterThan(1 / 75)
      // …but stayed below OLD's fused score (boundedness).
      const oldScore = fused.find((f) => f.chunkId === 'OLD')!.scores.fused
      expect(newScore).toBeLessThan(oldScore)
    })
  })

  it('leaves an unknown-mtime hit unchanged (factor 1)', () => {
    const now = Date.now()
    const lex = [
      { rowid: 1, chunk_id: 'KNOWN', score: -1, mtimeMs: now },
      { rowid: 2, chunk_id: 'UNKNOWN', score: -1 } // no mtimeMs
    ]
    withFreshness(true, () => {
      const fused = fuseRRF(lex, [], 8)
      // UNKNOWN keeps its exact pure-RRF base score (rank 2 ⇒ 1/62).
      const unknown = fused.find((f) => f.chunkId === 'UNKNOWN')!
      expect(unknown.scores.fused).toBe(1 / 62)
      // KNOWN (freshest) got boosted above its base (rank 1 ⇒ 1/61).
      const known = fused.find((f) => f.chunkId === 'KNOWN')!
      expect(known.scores.fused).toBeGreaterThan(1 / 61)
    })
  })
})
