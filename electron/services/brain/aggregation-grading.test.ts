// Grading guards for the aggregation eval. These are in the BLOCKING suite, not the eval, because
// a grader bug does not announce itself — it silently changes a measurement in someone's favour and
// the run still looks green. Both cases below were REAL false positives observed on 2026-08-02.
//
// The grader is exercised against a SYNTHETIC probe set defined here, not the eval's own probes:
// those are written against one operator's corpus and do not ship, and the grading rules do not
// depend on them.
import { describe, it, expect } from 'vitest'
import { gradeAnswer, extractAnswer, isPlaceholder, type AggContext, type AggProbe } from './aggregation-grading'

const probe = (over: Partial<AggProbe>): AggProbe =>
  ({ id: 'T', type: 'agg', kind: 'text', q: '', gold: () => '', ...over }) as AggProbe

/** A probe set with the same SHAPE as the eval's (agg probes + lookup controls), over a fictional corpus. */
const SYNTHETIC_PROBES: AggProbe[] = [
  { id: 'A1', type: 'agg', kind: 'count', q: 'How many notes mention the Northwind launch?', gold: (c) => Object.values(c.notes).filter((t) => t.includes('Northwind')).length },
  { id: 'A2', type: 'agg', kind: 'text', q: 'Which note mentions Northwind most often?', gold: (c) => Object.entries(c.notes).sort((a, b) => b[1].split('Northwind').length - a[1].split('Northwind').length)[0][0] },
  { id: 'A3', type: 'agg', kind: 'count', q: 'How many claims are there in total?', gold: (c) => c.claims.length },
  { id: 'L1', type: 'lookup', kind: 'text', q: 'Which folder holds the launch plan?', gold: () => 'Northwind' },
  { id: 'L2', type: 'lookup', kind: 'count', q: 'How many halls does the venue have?', gold: () => 4 }
]

const CORPUS: AggContext = {
  notes: {
    'Northwind/plan.md': 'Northwind launch plan. Northwind ships in Q3.',
    'Northwind/retro.md': 'Retro: the Northwind playtest slipped a week.',
    'Other/unrelated.md': 'Nothing to see here.'
  },
  claims: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
  turnBeats: [],
  corrections: []
}

describe('gradeAnswer — text', () => {
  const t = probe({ kind: 'text' })

  it('does NOT accept a longer string that merely CONTAINS the gold', () => {
    // The bug: gold "DUIN" scored a hit for "partner-DUIN" — a different folder — and that was the
    // D30 arm's only aggregation win in the 2026-08-02 fair-subset run.
    expect(gradeAnswer(t, 'ANSWER: partner-DUIN', 'DUIN')).toBe(false)
    expect(gradeAnswer(t, 'ANSWER: DUIN-Docs', 'DUIN')).toBe(false)
    expect(gradeAnswer(t, 'ANSWER: DUIN', 'DUIN')).toBe(true)
  })

  it('is case- and whitespace-insensitive, and tolerates trailing punctuation', () => {
    expect(gradeAnswer(t, 'ANSWER:  duin ', 'DUIN')).toBe(true)
    expect(gradeAnswer(t, 'ANSWER: mentions.', 'mentions')).toBe(true)
  })

  it('accepts a longer PATH that ends in the gold path, but not a different path', () => {
    expect(gradeAnswer(t, 'ANSWER: vault/DUIN/Knowledge/a.md', 'DUIN/Knowledge/a.md')).toBe(true)
    expect(gradeAnswer(t, 'ANSWER: DUIN/Other/a.md', 'DUIN/Knowledge/a.md')).toBe(false)
  })
})

describe('gradeAnswer — count', () => {
  const c = probe({ kind: 'count' })

  it('takes the FIRST integer so a hedge cannot pass on its second number', () => {
    expect(gradeAnswer(c, 'ANSWER: 277', 277)).toBe(true)
    expect(gradeAnswer(c, 'ANSWER: 277 claims', 277)).toBe(true)
    expect(gradeAnswer(c, 'ANSWER: about 200 to 277', 277)).toBe(false)
  })

  it('does not accept a number that merely contains the gold digits', () => {
    // "4" must not be satisfied by 14 or 40 — the L2 hall-number probe depended on this.
    expect(gradeAnswer(c, 'ANSWER: 14', 4)).toBe(false)
    expect(gradeAnswer(c, 'ANSWER: 40', 4)).toBe(false)
    expect(gradeAnswer(c, 'ANSWER: 4号馆', 4)).toBe(true)
  })

  it('strips thousands separators', () => {
    expect(gradeAnswer(c, 'ANSWER: 1,079', 1079)).toBe(true)
  })
})

describe('placeholder answers count as NO ANSWER, not as a wrong answer', () => {
  it('rejects an echoed template', () => {
    // The prompt used to say `ANSWER: <the value>` and arm D echoed it verbatim in 8 of 15 runs,
    // which made a non-answering arm look like a confabulating one.
    expect(isPlaceholder('<the value>')).toBe(true)
    expect(isPlaceholder('[number]')).toBe(true)
    expect(isPlaceholder('108')).toBe(false)
    expect(gradeAnswer(probe({ kind: 'count' }), 'ANSWER: <the value>', 108)).toBe(false)
  })

  it('prefers a real ANSWER line over a placeholder one earlier in the reply', () => {
    expect(extractAnswer('ANSWER: <the value>\nthinking...\nANSWER: 108')).toBe('108')
  })

  it('"unknown" is an abstention, and must not be graded as correct', () => {
    expect(gradeAnswer(probe({ kind: 'count' }), 'ANSWER: unknown', 108)).toBe(false)
    expect(gradeAnswer(probe({ kind: 'text' }), 'ANSWER: unknown', 'DUIN')).toBe(false)
  })
})

describe('a probe set of the eval\'s shape (synthetic)', () => {
  it('every probe id is unique', () => {
    const ids = SYNTHETIC_PROBES.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('keeps lookup controls, so "cannot compute" stays separable from "arm is broken"', () => {
    expect(SYNTHETIC_PROBES.filter((p) => p.type === 'lookup').length).toBeGreaterThanOrEqual(2)
  })
  it('gold is COMPUTED from the corpus the arms see, and grades its own answer', () => {
    for (const p of SYNTHETIC_PROBES) {
      const gold = p.gold(CORPUS)
      expect(gradeAnswer(p, `ANSWER: ${gold}`, gold)).toBe(true)
    }
    expect(SYNTHETIC_PROBES[0].gold(CORPUS)).toBe(2)
    expect(SYNTHETIC_PROBES[1].gold(CORPUS)).toBe('Northwind/plan.md')
    expect(SYNTHETIC_PROBES[2].gold(CORPUS)).toBe(3)
  })
})
