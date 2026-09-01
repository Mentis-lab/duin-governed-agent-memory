import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { fuseSearchHits, type SearchHit } from './index-store'
import {
  aggregateProbes,
  compareRuns,
  matchesGold,
  runRetrievalProbes,
  scoreProbe,
  type RetrievalProbe,
  type RetrievedItem
} from './retrieval-probe'
import {
  RETRIEVAL_TUNABLE_BOUNDS,
  RETRIEVAL_TUNABLE_DEFAULTS,
  clampRetrievalTunables,
  isDefaultRetrievalConfig,
  readRetrievalTunables,
  retrievalConfigFingerprint,
  retrievalTunablesPath
} from './retrieval-tunables'

describe('retrieval-tunables — clamp-on-read is the safety floor', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-ras-'))
    mkdirSync(join(dir, '.duin', '_state'), { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('missing file ⇒ defaults (byte-identical to pre-change behavior)', () => {
    expect(readRetrievalTunables(dir)).toEqual(RETRIEVAL_TUNABLE_DEFAULTS)
    expect(readRetrievalTunables(null)).toEqual(RETRIEVAL_TUNABLE_DEFAULTS)
    expect(isDefaultRetrievalConfig(readRetrievalTunables(dir))).toBe(true)
  })

  it('corrupt JSON ⇒ defaults, never throws', () => {
    writeFileSync(retrievalTunablesPath(dir), '{not json')
    expect(readRetrievalTunables(dir)).toEqual(RETRIEVAL_TUNABLE_DEFAULTS)
  })

  it('out-of-range values are clamped into the envelope, not rejected', () => {
    writeFileSync(
      retrievalTunablesPath(dir),
      JSON.stringify({ searchK: 9999, fuseWLex: -50, recencyMaxBoost: 42, poolFloor: 0 })
    )
    const t = readRetrievalTunables(dir)
    expect(t.searchK).toBe(RETRIEVAL_TUNABLE_BOUNDS.searchK.max)
    expect(t.fuseWLex).toBe(RETRIEVAL_TUNABLE_BOUNDS.fuseWLex.min)
    expect(t.recencyMaxBoost).toBe(RETRIEVAL_TUNABLE_BOUNDS.recencyMaxBoost.max)
    expect(t.poolFloor).toBe(RETRIEVAL_TUNABLE_BOUNDS.poolFloor.min)
  })

  it('hostile / non-numeric values fall back to the default for that key only', () => {
    const t = clampRetrievalTunables({
      searchK: 'twelve' as unknown as number,
      fuseWVec: NaN,
      poolMultiplier: 8
    })
    expect(t.searchK).toBe(RETRIEVAL_TUNABLE_DEFAULTS.searchK)
    expect(t.fuseWVec).toBe(RETRIEVAL_TUNABLE_DEFAULTS.fuseWVec)
    expect(t.poolMultiplier).toBe(8)
  })

  it('integral knobs round; float knobs keep precision', () => {
    const t = clampRetrievalTunables({ searchK: 7.6, fuseWLex: 1.75 })
    expect(t.searchK).toBe(8)
    expect(t.fuseWLex).toBe(1.75)
  })

  it('a partial file leaves every unspecified dimension at its default', () => {
    writeFileSync(retrievalTunablesPath(dir), JSON.stringify({ searchK: 20 }))
    const t = readRetrievalTunables(dir)
    expect(t.searchK).toBe(20)
    expect(t.fuseWLex).toBe(RETRIEVAL_TUNABLE_DEFAULTS.fuseWLex)
    expect(isDefaultRetrievalConfig(t)).toBe(false)
  })

  it('fingerprint is stable under key order and distinguishes configs', () => {
    const a = retrievalConfigFingerprint(RETRIEVAL_TUNABLE_DEFAULTS)
    const b = retrievalConfigFingerprint({ ...RETRIEVAL_TUNABLE_DEFAULTS })
    expect(a).toBe(b)
    expect(a).not.toBe(retrievalConfigFingerprint({ ...RETRIEVAL_TUNABLE_DEFAULTS, searchK: 20 }))
    expect(a).toContain('searchK=6')
  })
})

describe('fuseSearchHits — omitting the new opts must change nothing', () => {
  const vec: SearchHit[] = [
    { file: 'a.md', snippet: 'a', score: 0.9 },
    { file: 'b.md', snippet: 'b', score: 0.8 }
  ]
  const lex: SearchHit[] = [
    { file: 'b.md', snippet: 'b-lex', score: 5 },
    { file: 'c.md', snippet: 'c', score: 4 }
  ]

  it('no opts === explicitly passing the historical constants', () => {
    const bare = fuseSearchHits(vec, lex, 5)
    const explicit = fuseSearchHits(vec, lex, 5, { wLex: 2.0, wVec: 1.0, fuseK: 60 })
    expect(bare).toEqual(explicit)
  })

  it('weights actually move the ranking — the knob is real, not decorative', () => {
    // a.md is vector-only, c.md is lexical-only, b.md is in BOTH legs. Leaning the weights must
    // flip the two single-leg notes relative to each other. (b.md legitimately stays on top under
    // either lean — a note strong in both legs outranking either alone is the documented intent
    // of weighted RRF, not a bug, so it is not the discriminating assertion.)
    const rank = (hits: SearchHit[], f: string): number => hits.findIndex((h) => h.file === f)
    const lexHeavy = fuseSearchHits(vec, lex, 5, { wLex: 5, wVec: 0.1 })
    const vecHeavy = fuseSearchHits(vec, lex, 5, { wLex: 0.1, wVec: 5 })
    expect(rank(lexHeavy, 'c.md')).toBeLessThan(rank(lexHeavy, 'a.md'))
    expect(rank(vecHeavy, 'a.md')).toBeLessThan(rank(vecHeavy, 'c.md'))
  })
})

describe('matchesGold — labels need not encode the corpus layout', () => {
  it('matches exact, basename, stem, and suffix forms', () => {
    expect(matchesGold('sessions/D2.md', 'sessions/D2.md')).toBe(true)
    expect(matchesGold('sessions/D2.md', 'D2.md')).toBe(true)
    expect(matchesGold('sessions/D2.md', 'D2')).toBe(true)
    expect(matchesGold('D2.md', 'sessions/D2.md')).toBe(true)
    expect(matchesGold('SESSIONS\\D2.MD', 'd2')).toBe(true)
  })
  it('does not match a different note', () => {
    expect(matchesGold('sessions/D2.md', 'D20')).toBe(false)
    expect(matchesGold('sessions/D2.md', '')).toBe(false)
    expect(matchesGold('notes/alpha.md', 'notes/beta.md')).toBe(false)
  })
})

describe('scoreProbe — partial recall is visible, which is the whole point', () => {
  const hit = (file: string): RetrievedItem => ({ file, score: 1 })

  it('reports partial recall and names the missed gold items', () => {
    const probe: RetrievalProbe = { id: 'q1', query: 'who?', gold: ['a.md', 'b.md', 'c.md'] }
    const r = scoreProbe(probe, [hit('a.md'), hit('z.md'), hit('b.md')], 6)
    expect(r.recallAtK).toBeCloseTo(2 / 3)
    expect(r.hitAtK).toBe(true)
    expect(r.reciprocalRank).toBe(1)
    expect(r.missed).toEqual(['c.md'])
  })

  it('truncates at k — a gold item below the cut is a miss', () => {
    const probe: RetrievalProbe = { id: 'q2', query: 'q', gold: ['deep.md'] }
    const retrieved = [hit('x.md'), hit('y.md'), hit('deep.md')]
    expect(scoreProbe(probe, retrieved, 2).hitAtK).toBe(false)
    expect(scoreProbe(probe, retrieved, 3).hitAtK).toBe(true)
    expect(scoreProbe(probe, retrieved, 3).reciprocalRank).toBeCloseTo(1 / 3)
  })

  it('empty retrieval scores zero rather than throwing', () => {
    const r = scoreProbe({ id: 'q3', query: 'q', gold: ['a.md'] }, [], 6)
    expect(r).toMatchObject({ recallAtK: 0, hitAtK: false, reciprocalRank: 0, missed: ['a.md'] })
  })

  it('an unlabelled probe scores 0, so it cannot inflate an aggregate', () => {
    expect(scoreProbe({ id: 'q4', query: 'q', gold: [] }, [hit('a.md')], 6).recallAtK).toBe(0)
  })
})

describe('runRetrievalProbes — records R(q;theta) and stamps theta', () => {
  const probes: RetrievalProbe[] = [
    { id: 'p1', query: 'alpha', gold: ['alpha.md'] },
    { id: 'p2', query: 'beta', gold: ['beta.md'] }
  ]

  it('carries the config stamp and the retrieved set into the result', async () => {
    const run = await runRetrievalProbes(probes, async (q) => [
      { file: `${q}.md`, score: 1, rawScore: 0.7 }
    ])
    expect(run.recallAtK).toBe(1)
    expect(run.hitRate).toBe(1)
    expect(run.mrr).toBe(1)
    expect(run.k).toBe(RETRIEVAL_TUNABLE_DEFAULTS.searchK)
    expect(run.configFingerprint).toContain('searchK=6')
    // the previously-discarded retrieval trace is present
    expect(run.results[0].retrieved).toEqual([{ file: 'alpha.md', score: 1, rawScore: 0.7 }])
  })

  it('passes the config through to the search fn', async () => {
    const seen: number[] = []
    await runRetrievalProbes(
      probes,
      async (_q, k) => {
        seen.push(k)
        return []
      },
      { ...RETRIEVAL_TUNABLE_DEFAULTS, searchK: 20 }
    )
    expect(seen).toEqual([20, 20])
  })

  it('a throwing probe scores as a miss instead of aborting the run', async () => {
    const run = await runRetrievalProbes(probes, async (q) => {
      if (q === 'alpha') throw new Error('index unavailable')
      return [{ file: 'beta.md', score: 1 }]
    })
    expect(run.n).toBe(2)
    expect(run.empty).toBe(1)
    expect(run.hitRate).toBe(0.5)
  })
})

describe('compareRuns — refuses to compare incomparable runs', () => {
  const mk = (n: number, recall: number): ReturnType<typeof aggregateProbes> =>
    aggregateProbes(
      Array.from({ length: n }, (_, i) => ({
        id: `p${i}`,
        query: 'q',
        gold: ['g.md'],
        retrieved: [],
        recallAtK: recall,
        hitAtK: recall > 0,
        reciprocalRank: recall,
        missed: []
      })),
      RETRIEVAL_TUNABLE_DEFAULTS,
      6
    )

  it('reports a positive delta when the after-run retrieves better', () => {
    const c = compareRuns(mk(4, 0.5), mk(4, 0.75))
    expect(c.recallDelta).toBeCloseTo(0.25)
    expect(c.comparable).toBe(true)
  })

  it('flags different probe-set sizes as not comparable', () => {
    expect(compareRuns(mk(4, 0.5), mk(9, 0.9)).comparable).toBe(false)
    expect(compareRuns(mk(0, 0), mk(0, 0)).comparable).toBe(false)
  })
})
