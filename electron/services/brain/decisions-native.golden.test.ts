// GOLDEN output lock for parseDecision (the decisions port's pure parse fn).
// Freezes the EXACT dashboard-row shape for a fully-populated decision and a
// bare one — locks frontmatter parsing, title fallback, one-way classification,
// wikilink count, and layer/domain lowercasing so a refactor can't silently drift
// it. Deterministic, no fs, no live Python (WS0 parity net).
import { describe, it, expect } from 'vitest'
import { parseDecision } from './decisions-native'

describe('decisions-native — parseDecision golden locks (parity net)', () => {
  it('full frontmatter — exact row (one-way, links=2, layer/domain lowercased)', () => {
    const text =
      '---\ndate: 2026-06-20\nstatus: decided\nreversibility: one-way\nowner: TQ\nreview_on: 2026-09-01\nlayer: Strategy\ndomain: Product\n---\n# Commit to the TS brain\n\nWe will [[unify]] and [[retire python]].\n'
    expect(JSON.stringify(parseDecision(text, '2026-06-20-commit-ts-brain.md'))).toBe(
      '{"id":"2026-06-20-commit-ts-brain.md","title":"Commit to the TS brain","date":"2026-06-20","status":"decided","oneWay":true,"reversibility":"one-way","owner":"TQ","reviewOn":"2026-09-01","links":2,"layer":"strategy","domain":"product"}'
    )
  })

  it('no frontmatter — title from H1, defaults (status=decided, reversibility=—)', () => {
    expect(JSON.stringify(parseDecision('# No frontmatter decision\nbody [[link]]', 'plain.md'))).toBe(
      '{"id":"plain.md","title":"No frontmatter decision","date":"","status":"decided","oneWay":false,"reversibility":"—","owner":"","reviewOn":"","links":1,"layer":"","domain":""}'
    )
  })
})
