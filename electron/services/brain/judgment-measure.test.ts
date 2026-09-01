import { describe, it, expect } from 'vitest'
import {
  scoreFlip,
  measureVerdict,
  measureFact,
  measureFacts,
  DEFAULT_MEASURE_POLICY,
  type MeasureDeps
} from './judgment-measure'

describe('scoreFlip', () => {
  it('classifies the four A/B quadrants', () => {
    expect(scoreFlip(true, false)).toBe('flip') // fact made the difference
    expect(scoreFlip(true, true)).toBe('both-pass') // redundant
    expect(scoreFlip(false, false)).toBe('both-fail') // ineffective
    expect(scoreFlip(false, true)).toBe('regression') // fact hurt
  })
})

describe('measureVerdict', () => {
  const f = (n: number) => Array<'flip'>(n).fill('flip')
  it('is inconclusive below minTrials', () => {
    expect(measureVerdict(f(2)).verdict).toBe('inconclusive') // 2 < 3
  })
  it('keeps a fact that flips often enough', () => {
    // 2 flips of 3 informative trials ≥ 0.5. minTrials counts trials that actually
    // discriminated, so a keep needs three of those too — not three attempts.
    expect(measureVerdict(['flip', 'flip', 'both-fail']).verdict).toBe('keep')
  })
  it('prunes a fact that was inert every time it had room to act', () => {
    expect(measureVerdict(['both-fail', 'both-fail', 'both-fail']).verdict).toBe('prune-candidate')
  })
  it('does NOT prune when the probes could not tell the arms apart', () => {
    // both-pass = the WITHOUT arm already satisfied the rule, so that trial measured
    // nothing. Two failed probes plus one inert trial is one piece of evidence, not three.
    // Treating this as "proven inert" is what retired facts that were demonstrably working.
    expect(measureVerdict(['both-pass', 'both-pass', 'both-fail']).verdict).toBe('inconclusive')
  })
  it('never prunes when every trial was undiscriminating', () => {
    expect(measureVerdict(['both-pass', 'both-pass', 'both-pass']).verdict).toBe('inconclusive')
  })
  it('scores the flip rate over informative trials only', () => {
    // 1 flip, 1 inert, 2 probes that proved nothing → 1/2, not 1/4.
    const v = measureVerdict(['flip', 'both-fail', 'both-pass', 'both-pass'])
    expect(v.flipRate).toBe(0.5)
    expect(v.trials).toBe(4)
  })
  it('prunes on ANY regression, even amid flips', () => {
    const v = measureVerdict(['flip', 'flip', 'flip', 'regression'])
    expect(v.verdict).toBe('prune-candidate')
    expect(v.regressions).toBe(1)
  })
  it('is inconclusive with weak-but-nonzero signal', () => {
    expect(measureVerdict(['flip', 'both-pass', 'both-pass', 'both-pass']).verdict).toBe('inconclusive') // 0.25
  })
})

describe('measureFact (injected A/B)', () => {
  // A fact the model only honors WHEN injected → every trial flips → KEEP.
  const keepDeps: MeasureDeps = {
    probes: () => ['q1', 'q2', 'q3'],
    answer: (_q, factText) => (factText ? 'honored' : 'ignored'),
    grade: (_f, ans) => ans === 'honored'
  }
  // The model honors the rule with or without it. A binary grader cannot separate "the fact
  // is redundant" from "the probe never created a case where the fact mattered", so this
  // reads as INCONCLUSIVE rather than prune-candidate. Deliberate under-pruning: a redundant
  // fact costs a little context, a wrongly retired one costs a learned rule. Telling the two
  // apart needs a comparative grader ("which answer follows the rule better, A or B?").
  const undiscriminatingDeps: MeasureDeps = {
    probes: () => ['q1', 'q2', 'q3'],
    answer: () => 'honored',
    grade: () => true
  }
  // A fact that had room to act on every probe and changed nothing → real inert evidence.
  const inertDeps: MeasureDeps = {
    probes: () => ['q1', 'q2', 'q3'],
    answer: () => 'ignored',
    grade: () => false
  }

  it('keeps a behavior-changing fact', async () => {
    const v = await measureFact('always answer concisely', keepDeps)
    expect(v.verdict).toBe('keep')
    expect(v.flips).toBe(3)
    expect(v.flipRate).toBe(1)
  })

  it('will not prune when no probe could tell the arms apart', async () => {
    const v = await measureFact('the sky is up', undiscriminatingDeps)
    expect(v.verdict).toBe('inconclusive')
    expect(v.flips).toBe(0)
  })

  it('flags a fact that stayed inert with room to act', async () => {
    const v = await measureFact('always answer concisely', inertDeps)
    expect(v.verdict).toBe('prune-candidate')
    expect(v.flips).toBe(0)
  })

  // THE regression that motivated property 8. The live adapter used to swallow its own throws and
  // return ''/false, so a provider outage produced withPass=false + withoutPass=false on every
  // trial → 'both-fail' → flips 0 → 'prune-candidate': "proven inert, never changed an answer".
  // That verdict is PERSISTED and four callers demote the fact on it, so a transient 429
  // permanently mislabelled real operator facts as useless. The trial-drop below only works when
  // failure THROWS instead of dressing itself as evidence.
  it('a provider outage yields INCONCLUSIVE, never prune-candidate', async () => {
    const outage: MeasureDeps = {
      probes: () => ['q1', 'q2', 'q3'],
      answer: () => {
        throw new Error('429 rate limited')
      },
      grade: () => true
    }

    const v = await measureFact('a genuinely useful rule', outage)

    expect(v.verdict).not.toBe('prune-candidate') // the fact must NOT be demoted on an outage
    expect(v.verdict).toBe('inconclusive')
    expect(v.trials).toBe(0) // every trial dropped, none scored
  })

  it('a grader outage also drops the trial rather than scoring a false negative', async () => {
    const gradeOutage: MeasureDeps = {
      probes: () => ['q1', 'q2', 'q3'],
      answer: (_q, factText) => (factText ? 'honored' : 'ignored'),
      grade: () => {
        throw new Error('grader unavailable')
      }
    }

    const v = await measureFact('a genuinely useful rule', gradeOutage)

    expect(v.verdict).toBe('inconclusive')
    expect(v.trials).toBe(0)
  })

  it('drops a trial that throws rather than failing the whole measurement', async () => {
    let n = 0
    const flakyDeps: MeasureDeps = {
      probes: () => ['q1', 'q2', 'q3', 'q4'],
      answer: (_q, factText) => {
        if (++n === 3) throw new Error('model hiccup') // one answer call throws
        return factText ? 'honored' : 'ignored'
      },
      grade: (_f, ans) => ans === 'honored'
    }
    const v = await measureFact('x', flakyDeps)
    expect(v.trials).toBeLessThan(4) // the throwing trial was dropped
    expect(v.trials).toBeGreaterThan(0)
  })
})

describe('measureFacts', () => {
  it('measures a set without mutating anything, tagging each with id + verdict', async () => {
    const deps: MeasureDeps = {
      probes: () => ['q1', 'q2', 'q3'],
      answer: (_q, factText) => (factText ? 'honored' : 'ignored'),
      grade: (_f, ans) => ans === 'honored'
    }
    const out = await measureFacts([{ id: 'a', text: 'fact a' }], deps, DEFAULT_MEASURE_POLICY)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('a')
    expect(out[0].verdict).toBe('keep')
  })
})
