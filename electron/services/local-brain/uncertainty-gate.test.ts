import { describe, it, expect } from 'vitest'
import { shouldInjectRecall } from './uncertainty-gate'
import { fuseSearchHits, type SearchHit } from './index-store'

// Apply/Retrieval — uncertainty-gated recall injection (ExpWeaver). Pure.
//
// Fixture note: confidence is read from `rawScore` (absolute cosine-ish relevance),
// never from `score` (an RRF rank, top-normalized to exactly 1.0 every turn). These
// fixtures therefore carry BOTH, shaped like real fuseSearchHits output — an earlier
// version supplied `score` alone and passed while the thin-retrieval arm was dead.

describe('shouldInjectRecall', () => {
  it('suppresses recall on an empty query', () => {
    expect(shouldInjectRecall({ query: '   ' })).toMatchObject({ inject: false, reason: 'empty-query' })
  })

  it('suppresses recall on a pleasantry with confident retrieval', () => {
    const d = shouldInjectRecall({ query: 'thanks!', hits: [{ score: 1, rawScore: 0.9 }] })
    expect(d).toMatchObject({ inject: false, reason: 'pleasantry' })
  })

  it('suppresses common acks (ok / got it / 👍)', () => {
    for (const q of ['ok', 'got it', 'okay.', '👍', 'yep']) {
      expect(shouldInjectRecall({ query: q, hits: [{ score: 1, rawScore: 0.8 }] }).inject).toBe(false)
    }
  })

  it('INJECTS on a substantive multi-word query even with confident retrieval', () => {
    const d = shouldInjectRecall({
      query: 'what did we decide about the 北澜 launch window',
      hits: [{ score: 1, rawScore: 0.95 }]
    })
    expect(d).toMatchObject({ inject: true, reason: 'substantive' })
  })

  it('does NOT mistake a real query that opens with a greeting for a pleasantry', () => {
    const d = shouldInjectRecall({ query: 'hey, remind me who owns the orbis biweekly', hits: [{ score: 1, rawScore: 0.9 }] })
    expect(d.inject).toBe(true)
  })

  it('INJECTS on a short query when retrieval is thin (uncertain)', () => {
    // "AIT?" is short + non-pleasantry, but retrieval is thin → uncertain → inject.
    const d = shouldInjectRecall({ query: 'AIT?', hits: [{ score: 1, rawScore: 0.1 }] })
    expect(d).toMatchObject({ inject: true, reason: 'thin-retrieval' })
  })

  it('INJECTS on a pleasantry when retrieval is thin (beneficial to disambiguate)', () => {
    const d = shouldInjectRecall({ query: 'ok', hits: [] })
    expect(d).toMatchObject({ inject: true, reason: 'thin-retrieval' })
  })

  it('suppresses a short confident lookup that needs no operator memory', () => {
    const d = shouldInjectRecall({ query: 'BW date', hits: [{ score: 1, rawScore: 0.9 }] })
    expect(d.inject).toBe(false)
  })

  it('INJECTS when hits carry no absolute signal (lexical-only) — fails OPEN', () => {
    // No rawScore ⇒ thin/confident is unknowable. Suppressing would cost the operator's
    // whole memory for the turn, so an unknown must resolve toward grounding.
    const d = shouldInjectRecall({ query: 'AIT?', hits: [{ score: 1 }, { score: 0.4 }] })
    expect(d).toMatchObject({ inject: true, reason: 'thin-retrieval' })
  })
})

// Scale-mismatch guard: drive the gate with the REAL producer's output instead of
// hand-written scores. fuseSearchHits top-normalizes, so `score` is 1.0 on EVERY turn
// with hits — reading it made `thinRetrieval` false unless the vault was empty, which
// silently collapsed a short question into the 'pleasantry' suppression arm.
describe('shouldInjectRecall ← fuseSearchHits (real producer)', () => {
  const v = (file: string, score: number): SearchHit => ({ file, snippet: `snip ${file}`, score })
  const l = (file: string, score: number): SearchHit => ({ file, snippet: `snip ${file}`, score })

  it('INJECTS on a short non-pleasantry question whose fused recall is weakly relevant', () => {
    const hits = fuseSearchHits([v('beacon.md', 0.12)], [l('beacon.md', 1)], 6)
    // The trap: the top hit's `score` is exactly 1.0 despite 0.12 true relevance.
    expect(hits[0].score).toBe(1)
    const d = shouldInjectRecall({ query: 'Beacon?', hits })
    expect(d).toMatchObject({ inject: true, reason: 'thin-retrieval' })
  })

  it('still suppresses a pleasantry whose fused recall is strongly relevant', () => {
    const hits = fuseSearchHits([v('beacon.md', 0.88)], [l('beacon.md', 1)], 6)
    expect(shouldInjectRecall({ query: 'thanks!', hits })).toMatchObject({
      inject: false,
      reason: 'pleasantry'
    })
  })
})
