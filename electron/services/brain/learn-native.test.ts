import { describe, it, expect } from 'vitest'
import {
  toks,
  loadCorrections,
  computeTaste,
  reflect,
  MIN_BIND,
  BIND_OVERLAP_MIN,
  type Correction
} from './learn-native'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('learn-native', () => {
  it('toks: alnum + CJK, drops stopwords + len-1', () => {
    const t = toks('The 北澜 release ok a')
    expect(t.has('北澜')).toBe(true)
    expect(t.has('release')).toBe(true)
    expect(t.has('the')).toBe(false) // stopword
    expect(t.has('a')).toBe(false) // len 1
  })

  it('loadCorrections skips machine (source) + dropped rows', () => {
    const sd = mkdtempSync(join(tmpdir(), 'duin-ln-'))
    writeFileSync(
      join(sd, 'corrections.jsonl'),
      [
        JSON.stringify({ ts: '2026-06-01', why: 'a', correction: 'b' }),
        JSON.stringify({ ts: '2026-06-02', why: 'c', source: 'machine' }), // excluded
        JSON.stringify({ ts: '2026-06-03', why: 'd', status: 'dropped' }) // excluded
      ].join('\n')
    )
    expect(loadCorrections(sd).length).toBe(1)
    rmSync(sd, { recursive: true, force: true })
  })

  it('computeTaste refolds reusable corrections into correction_rules + counts', () => {
    const corr: Correction[] = [
      { ts: '2026-06-01', skill: 'feishu', why: 'w1', candidate_rule: 'r1', polarity: 'correction', status: 'new' },
      { ts: '2026-06-02', ai_output: 'x' } // no why/correction/candidate_rule → not a rule
    ]
    const taste = computeTaste(corr, { values: [1], frameworks: [] })
    expect(taste.correction_rules.length).toBe(1)
    expect(taste.correction_rules[0]).toMatchObject({ skill: 'feishu', candidate_rule: 'r1', source_path: 'corrections.jsonl:1' })
    expect(taste.counts).toEqual({ values: 1, frameworks: 0, correction_rules: 1 })
  })

  it('reflect surfaces a binding candidate when ≥MIN_BIND corrections cluster (BIND_JACCARD_MIN, BIND_OVERLAP_MIN)', () => {
    const shared = 'feishu reply format bullet markdown'
    const corr: Correction[] = Array.from({ length: MIN_BIND }, (_, i) => ({ ts: '2026-06-0' + (i + 1), why: `${shared} case${i}` }))
    const r = reflect(corr, new Date('2026-07-01T00:00:00Z'))
    expect(r.stream_size).toBe(MIN_BIND)
    expect(r.binding_candidates.length).toBeGreaterThanOrEqual(1)
    expect(r.binding_candidates[0].count).toBe(MIN_BIND)
    expect(r.binding_candidates[0].theme).toContain('feishu')
  })

  // Negative control for the absolute overlap floor. The fixture above shares a FIVE-token phrase,
  // which is not what the live stream looks like — the median real correction carries 4 tokens. These
  // rows are shaped like real ones (4 tokens each, sharing 2) and must cluster. Restoring
  // BIND_OVERLAP_MIN to 3 fails this test, which is exactly the point: at 3 the gate produced 0
  // binding candidates across 166 real corrections and no test noticed, because every fixture was
  // shaped to the constant.
  it('reflect clusters realistically-short corrections (regression: unfireable at overlap floor 3)', () => {
    const corr: Correction[] = [
      { ts: '2026-06-01', correction: 'final qa short line' },
      { ts: '2026-06-02', correction: 'final qa fewer words' },
      { ts: '2026-06-03', correction: 'final qa terse reply' }
    ]
    const r = reflect(corr, new Date('2026-07-01T00:00:00Z'))
    expect(BIND_OVERLAP_MIN).toBeLessThanOrEqual(2)
    expect(r.binding_candidates.length).toBeGreaterThanOrEqual(1)
    expect(r.binding_candidates[0].count).toBe(MIN_BIND)
    expect(r.binding_candidates[0].theme).toContain('final')
  })

  it('no cluster when corrections are unrelated', () => {
    const corr: Correction[] = [{ why: 'alpha beta gamma' }, { why: 'delta epsilon zeta' }, { why: 'eta theta iota' }]
    expect(reflect(corr).binding_candidates.length).toBe(0)
  })

  it('reflect themes surface recurring BIGRAMS, not bare stopwords', () => {
    // "lead with risks" ×3 → "with" is a stopword, so the adjacent bigram is "lead risks".
    const corr: Correction[] = Array.from({ length: 3 }, (_, i) => ({
      ts: '2026-06-0' + (i + 1),
      why: 'lead with risks',
      correction: `case ${i} has no clear signal`
    }))
    const themes = reflect(corr, new Date('2026-07-01T00:00:00Z')).themes
    expect(themes).toContain('lead risks')
    // stopwords must never surface as themes
    for (const sw of ['no', 'not', 'has', 'with']) expect(themes).not.toContain(sw)
  })
})
