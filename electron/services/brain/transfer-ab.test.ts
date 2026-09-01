import { describe, it, expect } from 'vitest'
import {
  resolveFit,
  aggregateFitLift,
  runTransferAB,
  selectHumanRubric,
  withoutFacts,
  MIN_RUBRIC_FACTS,
  DEFAULT_TRANSFER_POLICY,
  DEFAULT_TRANSFER_QUERIES,
  type TransferDeps,
  type FitVerdict
} from './transfer-ab'
import type { OperatorFact } from './operator-model'

describe('resolveFit', () => {
  it('maps a blind slot preference back onto the moat', () => {
    // grounded answer sat in slot A → a preference for A means the moat won
    expect(resolveFit('A', 'A')).toBe('with-moat')
    expect(resolveFit('B', 'A')).toBe('cold')
    // grounded answer sat in slot B → the mapping flips
    expect(resolveFit('B', 'B')).toBe('with-moat')
    expect(resolveFit('A', 'B')).toBe('cold')
  })
  it('passes ties and inconclusive through unchanged', () => {
    expect(resolveFit('tie', 'A')).toBe('tie')
    expect(resolveFit('inconclusive', 'B')).toBe('inconclusive')
  })
})

describe('aggregateFitLift', () => {
  const v = (withMoat: number, cold: number, ties = 0, inc = 0): FitVerdict[] => [
    ...Array<FitVerdict>(withMoat).fill('with-moat'),
    ...Array<FitVerdict>(cold).fill('cold'),
    ...Array<FitVerdict>(ties).fill('tie'),
    ...Array<FitVerdict>(inc).fill('inconclusive')
  ]

  it('is honest-null below the sample floor (never claims a lift on thin data)', () => {
    const r = aggregateFitLift(v(3, 0)) // only 3 decided < 5
    expect(r.fitLift).toBeNull()
    expect(r.verdict).toBe('inconclusive')
  })

  it('reports a positive lift when the moat wins more, past the floor', () => {
    const r = aggregateFitLift(v(4, 1)) // 5 decided, +3
    expect(r.fitLift).toBe(3)
    expect(r.verdict).toBe('moat-fits-better')
  })

  it('reports a negative lift when cold wins more', () => {
    const r = aggregateFitLift(v(1, 4))
    expect(r.fitLift).toBe(-3)
    expect(r.verdict).toBe('cold-fits-better')
  })

  it('reports no-difference on an even split at/above the floor', () => {
    const r = aggregateFitLift(v(3, 3))
    expect(r.fitLift).toBe(0)
    expect(r.verdict).toBe('no-difference')
  })

  it('ties count toward the decided floor but not toward the lift', () => {
    const r = aggregateFitLift(v(2, 1, 2)) // 5 decided, lift +1
    expect(r.decided).toBe(5)
    expect(r.fitLift).toBe(1)
    expect(r.verdict).toBe('moat-fits-better')
  })

  it('excludes inconclusive comparisons from the decided floor', () => {
    const r = aggregateFitLift(v(4, 0, 0, 3)) // 4 decided (< 5), 3 inconclusive
    expect(r.decided).toBe(4)
    expect(r.inconclusive).toBe(3)
    expect(r.fitLift).toBeNull()
    expect(r.verdict).toBe('inconclusive')
  })
})

describe('runTransferAB (injected A/B, deterministic slotting)', () => {
  const queries = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']
  // Alternate the grounded slot per query so a slot-blind grader can't win on position.
  const coin: TransferDeps['coin'] = (_q, i) => i % 2 === 0

  it('detects a real fit-lift when grounded answers win the blind preference', async () => {
    // The grader (blind to slot) always prefers the GROUNDED answer's marker.
    const deps: TransferDeps = {
      grounding: () => 'OPERATOR-2 BRAIN',
      answer: (_q, g) => (g ? 'GROUNDED' : 'COLD'),
      judge: (_q, a, b) => (a === 'GROUNDED' ? 'A' : b === 'GROUNDED' ? 'B' : 'tie'),
      coin
    }
    const r = await runTransferAB(queries, deps)
    expect(r.withMoatWins).toBe(6)
    expect(r.coldWins).toBe(0)
    expect(r.fitLift).toBe(6)
    expect(r.verdict).toBe('moat-fits-better')
  })

  it('collapses to an honest no-lift when there is no accumulated brain', async () => {
    // Empty grounding ⇒ grounded arg is null ⇒ both answers identical ⇒ grader ties.
    const deps: TransferDeps = {
      grounding: () => '',
      answer: (_q, g) => (g ? 'GROUNDED' : 'COLD'),
      judge: () => 'tie',
      coin
    }
    const r = await runTransferAB(queries, deps)
    expect(r.withMoatWins).toBe(0)
    expect(r.coldWins).toBe(0)
    expect(r.ties).toBe(6)
    expect(r.fitLift).toBe(0)
    expect(r.verdict).toBe('no-difference')
  })

  it('stays inconclusive (null lift) when the grader cannot decide — e.g. keyless', async () => {
    const deps: TransferDeps = {
      grounding: () => 'OPERATOR-2 BRAIN',
      answer: () => '',
      judge: () => 'inconclusive',
      coin
    }
    const r = await runTransferAB(queries, deps)
    expect(r.inconclusive).toBe(6)
    expect(r.decided).toBe(0)
    expect(r.fitLift).toBeNull()
    expect(r.verdict).toBe('inconclusive')
  })

  it('drops a query that throws rather than failing the whole run', async () => {
    let n = 0
    const deps: TransferDeps = {
      grounding: () => 'OPERATOR-2 BRAIN',
      answer: (_q, g) => {
        if (++n === 3) throw new Error('model hiccup')
        return g ? 'GROUNDED' : 'COLD'
      },
      judge: (_q, a, b) => (a === 'GROUNDED' ? 'A' : b === 'GROUNDED' ? 'B' : 'tie'),
      coin
    }
    const r = await runTransferAB(queries, deps)
    expect(r.samples).toBeLessThan(queries.length) // the throwing query was dropped
    expect(r.samples).toBeGreaterThan(0)
  })

  it('records per-query verdicts with the grounded slot', async () => {
    const deps: TransferDeps = {
      grounding: () => 'BRAIN',
      answer: (_q, g) => (g ? 'GROUNDED' : 'COLD'),
      judge: (_q, a) => (a === 'GROUNDED' ? 'A' : 'B'),
      coin
    }
    const r = await runTransferAB(['q1', 'q2'], deps)
    expect(r.verdicts[0].groundedSlot).toBe('A') // i=0 → coin true
    expect(r.verdicts[1].groundedSlot).toBe('B') // i=1 → coin false
    expect(r.verdicts.every((x) => x.verdict === 'with-moat')).toBe(true)
  })
})

// The DEFAULT policy floor is the documented n<5 honesty gate.
describe('DEFAULT_TRANSFER_POLICY', () => {
  it('floors at 5 decided comparisons', () => {
    expect(DEFAULT_TRANSFER_POLICY.minSamples).toBe(5)
  })
})

// ──────────────────── the held-out rubric ────────────────────
// Guards the 2026-08-01 fix: the judge must never be scored against the grounded arm's own prompt.

const fact = (over: Partial<OperatorFact> & { fact: string }): OperatorFact =>
  ({ id: over.fact, kind: 'context', status: 'candidate', ts: 0, ...over }) as OperatorFact

/** Enough unambiguous human rulings to clear MIN_RUBRIC_FACTS. */
const humanRulings = (): OperatorFact[] => [
  fact({ fact: 'e1', status: 'promoted', adjudicatedBy: 'human' }),
  fact({ fact: 'e2', status: 'promoted', adjudicatedBy: 'human' }),
  fact({ fact: 'e3', status: 'promoted', adjudicatedBy: 'human' }),
  fact({ fact: 'r1', status: 'vetoed', adjudicatedBy: 'human' }),
  fact({ fact: 'r2', status: 'vetoed', adjudicatedBy: 'human' }),
  fact({ fact: 'r3', status: 'vetoed', adjudicatedBy: 'human' })
]

describe('selectHumanRubric', () => {
  it('keeps only unambiguous human rulings — promoted endorse, vetoed reject', () => {
    const r = selectHumanRubric(humanRulings())
    expect(r.endorsedFacts).toEqual(['e1', 'e2', 'e3'])
    expect(r.rejectedFacts).toEqual(['r1', 'r2', 'r3'])
    expect(r.size).toBe(6)
    expect(r.text).toContain('e1')
    expect(r.text).toContain('r1')
  })

  it('EXCLUDES reverted+human — the human and the machine disagree, so it is not a ruling', () => {
    // revertFact does not stamp adjudicatedBy, so this combination means "a human endorsed it and
    // something later reverted it". Counting it as a rejection would invert 14 live rows.
    const facts = [...humanRulings(), fact({ fact: 'contested', status: 'reverted', adjudicatedBy: 'human' })]
    const r = selectHumanRubric(facts)
    expect(r.rejectedFacts).not.toContain('contested')
    expect(r.endorsedFacts).not.toContain('contested')
    expect(r.text).not.toContain('contested')
  })

  it('ignores machine-adjudicated and unadjudicated rows entirely', () => {
    const facts = [
      ...humanRulings(),
      fact({ fact: 'auto-promoted', status: 'promoted', adjudicatedBy: 'auto' }),
      fact({ fact: 'legacy-vetoed', status: 'vetoed' })
    ]
    const r = selectHumanRubric(facts)
    expect(r.size).toBe(6)
    expect(r.text).not.toContain('auto-promoted')
    expect(r.text).not.toContain('legacy-vetoed')
  })

  it('abstains (empty text) below the evidence floor rather than grading on noise', () => {
    const thin = humanRulings().slice(0, MIN_RUBRIC_FACTS - 1)
    const r = selectHumanRubric(thin)
    expect(r.size).toBe(MIN_RUBRIC_FACTS - 1)
    expect(r.text).toBe('') // '' is the judge's abstain signal — never a fallback to the profile
  })

  it('abstains on an empty store', () => {
    expect(selectHumanRubric([]).text).toBe('')
  })
})

describe('withoutFacts', () => {
  it('removes exactly the rubric fact lines and keeps headers and other facts', () => {
    const block = [
      '<operator_profile>',
      'Rules the operator confirmed (follow these):',
      '- e1',
      '- kept',
      '</operator_profile>'
    ].join('\n')
    const out = withoutFacts(block, ['e1'])
    expect(out).not.toContain('- e1')
    expect(out).toContain('- kept')
    expect(out).toContain('Rules the operator confirmed (follow these):')
    expect(out).toContain('<operator_profile>')
  })

  it('is a no-op with no facts to drop', () => {
    expect(withoutFacts('- a\n- b', [])).toBe('- a\n- b')
  })

  it('does not drop a line that merely CONTAINS a rubric fact as a substring', () => {
    // exact-line match only — a longer fact that happens to contain a shorter one must survive
    const out = withoutFacts('- e1\n- e1 and more', ['e1'])
    expect(out).toBe('- e1 and more')
  })
})

// The held-out split is what makes the measurement valid: whatever the judge is shown must be
// absent from what the grounded arm is told. This asserts the invariant on the pure pieces.
describe('the rubric is disjoint from grounding', () => {
  it('every endorsed rubric fact is withheld from the grounded prompt', () => {
    const r = selectHumanRubric(humanRulings())
    const grounding = ['<operator_profile>', ...r.endorsedFacts.map((f) => `- ${f}`), '- other', '</operator_profile>'].join('\n')
    const heldOut = withoutFacts(grounding, r.endorsedFacts)
    for (const f of r.endorsedFacts) expect(heldOut).not.toContain(`- ${f}`)
    expect(heldOut).toContain('- other')
  })

  it('rejected facts are absent from grounding by construction (vetoed never renders)', () => {
    const r = selectHumanRubric(humanRulings())
    // buildOperatorBlock renders promoted/provisional/candidate only — vetoed rows cannot appear.
    const grounding = ['<operator_profile>', '- other', '</operator_profile>'].join('\n')
    for (const f of r.rejectedFacts) expect(grounding).not.toContain(f)
  })
})

describe('DEFAULT_TRANSFER_QUERIES', () => {
  it('carries enough queries for the aggregate floor to mean something', () => {
    // Widened 8 → 24 on 2026-08-01: at 8, the verdict rode on ~8 decided comparisons.
    expect(DEFAULT_TRANSFER_QUERIES.length).toBeGreaterThanOrEqual(24)
  })
  it('has no duplicates', () => {
    expect(new Set(DEFAULT_TRANSFER_QUERIES).size).toBe(DEFAULT_TRANSFER_QUERIES.length)
  })
})
