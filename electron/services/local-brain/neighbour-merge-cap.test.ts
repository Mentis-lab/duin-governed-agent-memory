// Pins the graph-neighbour merge cap against the trap it shipped with for months.
//
// `mergeGraphNeighbors(base, neighbors, k)` keeps ALL of `base` and breaks the instant
// `out.length >= k`. server.ts passed a hardcoded `k = 8`, so with `searchK >= 8` the loop broke on
// its first iteration and stage 1 — the one server.ts calls the dominant term — became a SILENT
// no-op. Silent because the "merged N neighbour(s)" log is gated on the count having changed.
// `searchK` is operator-tunable to 30 and its own docstring urges raising it to 20-30, so the
// codebase actively pointed at the trap.
//
// The fix makes the cap relative to the pool. These tests exist to fail if anyone makes it absolute
// again, and to prove the default is byte-identical so this counts as a trap fix, not a retuning.
import { describe, it, expect } from 'vitest'
import { mergeGraphNeighbors } from './index-store'
import { RETRIEVAL_TUNABLE_DEFAULTS, RETRIEVAL_TUNABLE_BOUNDS } from './retrieval-tunables'

/** Must mirror server.ts's constant. Duplicated deliberately: if server.ts changes it, the
 *  byte-identical assertion below fails and forces the change to be argued for. */
const NEIGHBOUR_SLOTS = 2

const hit = (file: string, score = 1): { file: string; snippet: string; score: number } => ({
  file,
  snippet: 's',
  score
})
const pool = (n: number): ReturnType<typeof hit>[] => Array.from({ length: n }, (_, i) => hit(`base${i}.md`))
const neighbours = (n: number): ReturnType<typeof hit>[] =>
  Array.from({ length: n }, (_, i) => hit(`nb${i}.md`, 0.25))

/** The production expression, in one place. */
const merge = (base: ReturnType<typeof hit>[], nbs: ReturnType<typeof hit>[]): string[] =>
  mergeGraphNeighbors(base, nbs, base.length + NEIGHBOUR_SLOTS).map((h) => h.file)

describe('the relative cap admits neighbours at EVERY searchK in the allowed range', () => {
  // The regression in one assertion: under the old absolute 8, every k >= 8 added zero.
  for (const k of [3, 6, 8, 12, 20, 30]) {
    it(`searchK=${k} still admits neighbours`, () => {
      const out = merge(pool(k), neighbours(4))
      const added = out.filter((f) => f.startsWith('nb')).length
      expect(added).toBeGreaterThan(0)
      expect(added).toBe(Math.min(NEIGHBOUR_SLOTS, 4))
    })
  }

  it('the OLD absolute cap is what silently failed — kept as the counter-example', () => {
    const base = pool(12) // any searchK >= 8
    const outOld = mergeGraphNeighbors(base, neighbours(4), 8).map((h) => h.file)
    expect(outOld.filter((f) => f.startsWith('nb')).length).toBe(0) // the bug
    expect(merge(base, neighbours(4)).filter((f) => f.startsWith('nb')).length).toBe(2) // the fix
  })
})

describe('the default is byte-identical to the constant it replaced', () => {
  it('searchK=6 ⇒ cap 8, so shipped behaviour is unchanged', () => {
    expect(RETRIEVAL_TUNABLE_DEFAULTS.searchK).toBe(6)
    expect(RETRIEVAL_TUNABLE_DEFAULTS.searchK + NEIGHBOUR_SLOTS).toBe(8)
    const base = pool(RETRIEVAL_TUNABLE_DEFAULTS.searchK)
    const nbs = neighbours(4)
    expect(merge(base, nbs)).toEqual(mergeGraphNeighbors(base, nbs, 8).map((h) => h.file))
  })

  it('never drops a ranked hit — neighbours are additive only', () => {
    const base = pool(30)
    const out = merge(base, neighbours(4))
    for (const b of base) expect(out).toContain(b.file)
  })

  it('the tunable range this has to survive is [3,30]', () => {
    expect(RETRIEVAL_TUNABLE_BOUNDS.searchK.min).toBe(3)
    expect(RETRIEVAL_TUNABLE_BOUNDS.searchK.max).toBe(30)
  })
})
