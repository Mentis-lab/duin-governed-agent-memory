import { describe, it, expect, beforeEach } from 'vitest'
import {
  cosine,
  selectRecall,
  renderRecallBlock,
  operatorCandidates,
  tasteCandidates,
  failureCandidates,
  rankRecall,
  confirmedJudgmentTexts,
  applyTasteRerank,
  tasteRerank,
  __resetRecallCache,
  calFactor,
  CAL_SPAN,
  RECALL_FLOOR,
  BETA_CONFIRMED,
  type RecallCandidate,
  type EmbedFn
} from './personalization-recall'
import type { KindRate } from '../brain/calibration-weight'
import type { OperatorFact } from '../brain/operator-model'
import type { Taste } from '../brain/learn-native'
import type { FailureLedgerRecord } from '../failure-ledger'

const cand = (over: Partial<RecallCandidate>): RecallCandidate => ({
  text: 't',
  kind: 'operator-rule',
  referent: 'r',
  betaConf: 1,
  line: '- t',
  ...over
})

describe('operatorCandidates — item 12 recall-path efficacy demotion', () => {
  const mk = (over: Partial<OperatorFact>): OperatorFact => ({
    id: 'x',
    fact: 'Lead with the risk',
    kind: 'context',
    status: 'promoted',
    ts: 0,
    ...over
  })
  it('demotes a measured no-lift promoted fact out of operator-rule/BETA_CONFIRMED', () => {
    const strong = operatorCandidates([mk({})])[0]
    expect(strong.kind).toBe('operator-rule')
    expect(strong.betaConf).toBe(BETA_CONFIRMED)
    const noLift = operatorCandidates([
      mk({ efficacy: { flipRate: 0, flips: 0, regressions: 2, trials: 4, verdict: 'prune-candidate', measuredAt: 0 } })
    ])[0]
    expect(noLift.kind).toBe('operator-noticed') // demoted, not full-trust
    expect(noLift.betaConf).toBeLessThan(BETA_CONFIRMED)
  })
  it('a keep-measured promoted fact stays a full-trust operator-rule', () => {
    const keep = operatorCandidates([
      mk({ efficacy: { flipRate: 0.8, flips: 3, regressions: 0, trials: 4, verdict: 'keep', measuredAt: 0 } })
    ])[0]
    expect(keep.kind).toBe('operator-rule')
    expect(keep.betaConf).toBe(BETA_CONFIRMED)
  })
})

describe('cosine', () => {
  it('is 1 for identical, 0 for orthogonal, 0 for mismatch/empty', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1) // self-normalizing
    expect(cosine([1, 0], [1, 0, 0])).toBe(0) // length mismatch
    expect(cosine([], [])).toBe(0)
  })
})

describe('selectRecall', () => {
  it('floors out low-similarity items', () => {
    const cands = [cand({ referent: 'a', text: 'hit' }), cand({ referent: 'b', text: 'miss' })]
    const vecs = [
      [1, 0],
      [0, 1]
    ]
    const out = selectRecall([1, 0], cands, vecs, { floor: 0.5 })
    expect(out.map((c) => c.referent)).toEqual(['a'])
  })

  it('β_conf can lift a slightly-less-similar item above a more-similar one', () => {
    // item A cosine ~0.71, β 1.06 -> 0.75 ; item B cosine ~0.80, β 0.70 -> 0.56
    const cands = [
      cand({ referent: 'a', betaConf: 1.06 }),
      cand({ referent: 'b', betaConf: 0.7 })
    ]
    const vecs = [
      [1, 1],
      [4, 3]
    ]
    const out = selectRecall([1, 0], cands, vecs, { floor: 0.1 })
    expect(out[0].referent).toBe('a')
  })

  it('conflict-suppresses: one survivor per referent (highest score)', () => {
    const cands = [
      cand({ referent: 'same', line: '- weak', betaConf: 1 }),
      cand({ referent: 'same', line: '- strong', betaConf: 1.06 })
    ]
    const vecs = [
      [1, 0],
      [1, 0]
    ]
    const out = selectRecall([1, 0], cands, vecs, { floor: 0.1 })
    expect(out).toHaveLength(1)
    expect(out[0].line).toBe('- strong')
  })

  it('respects topK', () => {
    const cands = [cand({ referent: 'a' }), cand({ referent: 'b' }), cand({ referent: 'c' })]
    const vecs = [
      [1, 0],
      [1, 0],
      [1, 0]
    ]
    expect(selectRecall([1, 0], cands, vecs, { floor: 0.1, topK: 2 })).toHaveLength(2)
  })
})

describe('renderRecallBlock', () => {
  it('empty selection -> empty string', () => {
    expect(renderRecallBlock([])).toBe('')
  })

  it('groups by kind under headers', () => {
    const out = renderRecallBlock([
      cand({ kind: 'operator-rule', line: '- rule1' }),
      cand({ kind: 'taste', line: '- taste1' }),
      cand({ kind: 'failure', line: '- fail1' })
    ])
    expect(out).toContain('RELEVANT TO THIS TURN')
    expect(out).toContain('Rules you confirmed')
    expect(out).toContain('- rule1')
    expect(out).toContain('How you\'ve corrected me')
    expect(out).toContain('Failure modes to avoid')
  })
})

describe('operatorCandidates', () => {
  const f = (over: Partial<OperatorFact>): OperatorFact =>
    ({ id: 'i', fact: 'a fact', kind: 'context', status: 'candidate', ts: 0, ...over }) as OperatorFact

  it('excludes vetoed facts (veto memory)', () => {
    const out = operatorCandidates([f({ status: 'vetoed', fact: 'nope' }), f({ fact: 'yes' })])
    expect(out.map((c) => c.text)).toEqual(['yes'])
  })

  it('promoted -> operator-rule with confirmed β; candidate -> operator-noticed', () => {
    const out = operatorCandidates([f({ status: 'promoted', fact: 'P' }), f({ status: 'candidate', fact: 'C' })])
    const p = out.find((c) => c.text === 'P')!
    const c = out.find((c) => c.text === 'C')!
    expect(p.kind).toBe('operator-rule')
    expect(p.betaConf).toBe(BETA_CONFIRMED)
    expect(c.kind).toBe('operator-noticed')
    expect(c.betaConf).toBe(1)
  })

  it('tags each candidate with its recallKind (the efficacy join key)', () => {
    const out = operatorCandidates([f({ fact: 'P', kind: 'preference' })])
    expect(out[0].recallKind).toBe('preference')
  })
})

// ── WS1 Item 3a — β_conf calibration ────────────────────────────────────────────────
const kr = (over: Partial<KindRate>): KindRate => ({ rate: 0.5, observed: 30, gated: false, ...over })

describe('calFactor (Item 3a)', () => {
  it('is NEUTRAL 1.0 for undefined / null-rate / gated (the non-negotiable guard)', () => {
    expect(calFactor(undefined)).toBe(1.0)
    expect(calFactor(null)).toBe(1.0)
    expect(calFactor(kr({ rate: null }))).toBe(1.0)
    expect(calFactor(kr({ rate: 0.9, observed: 5, gated: true }))).toBe(1.0) // gated wins over a high rate
  })

  it('is 1.0 at rate 0.5, and spans ±CAL_SPAN at the extremes', () => {
    expect(calFactor(kr({ rate: 0.5 }))).toBeCloseTo(1.0)
    expect(calFactor(kr({ rate: 1 }))).toBeCloseTo(1 + CAL_SPAN)
    expect(calFactor(kr({ rate: 0 }))).toBeCloseTo(1 - CAL_SPAN)
  })

  it('is bounded to [1-CAL_SPAN, 1+CAL_SPAN] even for out-of-range rates', () => {
    expect(calFactor(kr({ rate: 5 }))).toBeCloseTo(1 + CAL_SPAN)
    expect(calFactor(kr({ rate: -5 }))).toBeCloseTo(1 - CAL_SPAN)
  })
})

describe('operatorCandidates × calibration (Item 3a wiring)', () => {
  const f = (over: Partial<OperatorFact>): OperatorFact =>
    ({ id: 'i', fact: 'a fact', kind: 'context', status: 'promoted', ts: 0, ...over }) as OperatorFact

  it('REGRESSION GUARD: ON==OFF when the map is empty (default-safe)', () => {
    const facts = [f({ fact: 'P', kind: 'preference' })]
    const off = operatorCandidates(facts)
    const on = operatorCandidates(facts, { kindRates: new Map() })
    expect(on[0].betaConf).toBe(off[0].betaConf)
  })

  it('REGRESSION GUARD: ON==OFF when every relevant kind is gated', () => {
    const facts = [f({ fact: 'P', kind: 'preference' })]
    const gatedMap = new Map<string, KindRate>([['preference', kr({ rate: 0.95, observed: 3, gated: true })]])
    const off = operatorCandidates(facts)
    const on = operatorCandidates(facts, { kindRates: gatedMap })
    expect(on[0].betaConf).toBe(off[0].betaConf)
  })

  it('a confirmed-useful kind lifts β_conf above a gated kind (real teeth)', () => {
    const facts = [f({ fact: 'P', kind: 'preference' })]
    const usefulMap = new Map<string, KindRate>([['preference', kr({ rate: 1, observed: 30, gated: false })]])
    const on = operatorCandidates(facts, { kindRates: usefulMap })
    const off = operatorCandidates(facts)
    expect(on[0].betaConf).toBeGreaterThan(off[0].betaConf)
  })

  it('a confirmed-useful kind OUTRANKS a gated kind at EQUAL cosine', () => {
    const facts = [
      f({ fact: 'useful fact', kind: 'preference' }), // will be non-gated, high rate
      f({ fact: 'gated fact', kind: 'context' }) //      gated → neutral
    ]
    const rates = new Map<string, KindRate>([
      ['preference', kr({ rate: 1, observed: 30, gated: false })],
      ['context', kr({ rate: 0.99, observed: 4, gated: true })]
    ])
    const cands = operatorCandidates(facts, { kindRates: rates })
    // Equal cosine for both: identical query + candidate vectors.
    const vec = [1, 0]
    const kept = selectRecall(vec, cands, [vec, vec], { floor: 0 })
    expect(kept[0].text).toBe('useful fact') // calibration breaks the tie toward the earned kind
  })
})

describe('tasteCandidates', () => {
  const taste = (rules: Record<string, unknown>[]): Taste => ({ values: [], frameworks: [], correction_rules: rules })
  it('bound rules get the confirmed β; new rules 1.0', () => {
    const out = tasteCandidates(taste([
      { candidate_rule: 'bound one', status: 'bound' },
      { correction: 'new one', status: 'new' }
    ]))
    expect(out.find((c) => c.line.includes('bound one'))!.betaConf).toBe(BETA_CONFIRMED)
    expect(out.find((c) => c.line.includes('new one'))!.betaConf).toBe(1)
  })
  it('null taste -> []', () => {
    expect(tasteCandidates(null)).toEqual([])
  })
  // Phase 0.1 — veto-leak guard: a veto forwards a correction-polarity row whose `correction`
  // holds the REJECTED inference (empty candidate_rule); it must not become a recall candidate.
  it('drops a vetoed inference but keeps distilled rules', () => {
    const out = tasteCandidates(taste([
      { correction: 'operator wants emoji everywhere', candidate_rule: '', polarity: 'correction', status: 'new' },
      { candidate_rule: 'lead with outcome', polarity: 'positive', status: 'new' }
    ]))
    expect(out.some((c) => c.line.includes('emoji everywhere'))).toBe(false)
    expect(out.some((c) => c.line.includes('lead with outcome'))).toBe(true)
  })
  // Phase 1b — a bound rule now grounds as an operator fact; its taste duplicate is excluded
  // so it can't double-inject / take a second top-k slot. Match is case/whitespace-insensitive.
  it('excludes a rule already grounded as an operator fact', () => {
    const out = tasteCandidates(
      taste([
        { candidate_rule: 'Lead with the outcome', polarity: 'positive', status: 'new' },
        { candidate_rule: 'Cite sources', polarity: 'positive', status: 'new' }
      ]),
      { excludeRules: new Set(['lead with the outcome']) }
    )
    expect(out.some((c) => c.line.includes('Lead with the outcome'))).toBe(false)
    expect(out.some((c) => c.line.includes('Cite sources'))).toBe(true)
  })
})

describe('failureCandidates', () => {
  const fail = (over: Partial<FailureLedgerRecord>): FailureLedgerRecord =>
    ({
      id: 'f',
      fingerprint: 'fp',
      kind: 'command_failed',
      message: 'boom',
      count: 1,
      replaySeed: {},
      firstSeenAt: 0,
      lastSeenAt: 0,
      createdAt: 0,
      updatedAt: 0,
      ...over
    })
  it('recurrence nudges β up but caps it', () => {
    expect(failureCandidates([fail({ count: 1 })])[0].betaConf).toBeCloseTo(1.0)
    expect(failureCandidates([fail({ count: 100 })])[0].betaConf).toBeCloseTo(1.06) // capped
  })
})

describe('rankRecall', () => {
  beforeEach(() => __resetRecallCache())
  // Mock embedder: KEEP-tagged texts point one way, others orthogonal.
  const embed: EmbedFn = async (texts) =>
    texts.map((t) => (t.includes('KEEP') ? [1, 0, 0] : [0, 1, 0]))

  it('selects only query-relevant candidates above the floor', async () => {
    const cands = [
      cand({ referent: 'a', text: 'KEEP this', line: '- keep' }),
      cand({ referent: 'b', text: 'unrelated', line: '- drop' })
    ]
    const out = await rankRecall('KEEP', cands, embed, { floor: RECALL_FLOOR })
    expect(out).not.toBeNull()
    expect(out!.map((c) => c.line)).toEqual(['- keep'])
  })

  it('returns null on empty query or no candidates (caller falls back)', async () => {
    expect(await rankRecall('', [cand({})], embed)).toBeNull()
    expect(await rankRecall('q', [], embed)).toBeNull()
  })

  it('returns null when the embedder yields a wrong-length result', async () => {
    const bad: EmbedFn = async () => [[1, 0, 0]] // fewer than query+candidates
    expect(await rankRecall('q', [cand({ text: 'x' }), cand({ text: 'y' })], bad)).toBeNull()
  })
})

describe('confirmedJudgmentTexts', () => {
  it('collects promoted operator facts + bound taste rules only', () => {
    const facts = [
      { id: '1', fact: 'confirmed rule', kind: 'context', status: 'promoted', ts: 0 },
      { id: '2', fact: 'unconfirmed', kind: 'context', status: 'candidate', ts: 0 }
    ] as never
    const taste = {
      values: [],
      frameworks: [],
      correction_rules: [
        { candidate_rule: 'bound taste', status: 'bound' },
        { correction: 'new taste', status: 'new' }
      ]
    } as never
    const out = confirmedJudgmentTexts(facts, taste)
    expect(out).toContain('confirmed rule')
    expect(out).toContain('bound taste')
    expect(out).not.toContain('unconfirmed')
    expect(out).not.toContain('new taste')
  })

  // Phase 0.1 — veto-leak guard on the THIRD reader (retrieval-rerank path). Even at
  // bound/confirmed status, a correction-polarity row's raw `correction` (a rejected
  // inference) must never become judgment that retrieval is reranked toward.
  it('does not rerank toward a vetoed inference even at bound/confirmed status', () => {
    const taste = {
      values: [],
      frameworks: [],
      correction_rules: [
        { correction: 'operator wants emoji everywhere', candidate_rule: '', polarity: 'correction', status: 'confirmed' },
        { candidate_rule: 'cite sources', polarity: 'positive', status: 'bound' }
      ]
    } as never
    const out = confirmedJudgmentTexts([] as never, taste)
    expect(out).not.toContain('emoji everywhere') // the rejected inference is suppressed
    expect(out).toContain('cite sources') // genuine confirmed judgment still reranked toward
  })
})

describe('applyTasteRerank', () => {
  const hit = (file: string, score: number) => ({ file, snippet: `s:${file}`, score })

  it('boosts a hit with high taste affinity above a higher-base-score hit', () => {
    const hits = [hit('a', 1.0), hit('b', 0.9)]
    // b's affinity (1.0) lifts it to 0.9*(1+0.5) = 1.35 > a's 1.0*(1+0.5*0) = 1.0
    const out = applyTasteRerank(hits, [0, 1.0])
    expect(out.map((h) => h.file)).toEqual(['b', 'a'])
  })

  it('is a no-op ordering when affinities are equal', () => {
    const hits = [hit('a', 1.0), hit('b', 0.9)]
    expect(applyTasteRerank(hits, [0.5, 0.5]).map((h) => h.file)).toEqual(['a', 'b'])
  })

  it('returns hits unchanged on length mismatch', () => {
    const hits = [hit('a', 1), hit('b', 1)]
    expect(applyTasteRerank(hits, [0.5])).toEqual(hits)
  })
})

describe('tasteRerank', () => {
  beforeEach(() => __resetRecallCache())
  // Judgment "J-KEEP" and any hit snippet containing KEEP align on axis 0.
  const embed: EmbedFn = async (texts) => texts.map((t) => (t.includes('KEEP') ? [1, 0] : [0, 1]))

  it('reorders hits toward the query-relevant judgment', async () => {
    const hits = [
      { file: 'a', snippet: 'unrelated', score: 1.0 },
      { file: 'b', snippet: 'this KEEP matches judgment', score: 0.8 }
    ]
    const out = await tasteRerank('KEEP', hits, ['J-KEEP judgment'], embed)
    expect(out).not.toBeNull()
    expect(out!.map((h) => h.file)).toEqual(['b', 'a']) // b lifted by taste affinity
  })

  it('no-ops (null) with no judgments or <2 hits', async () => {
    expect(await tasteRerank('q', [{ file: 'a', snippet: 'x', score: 1 }], ['j'], embed)).toBeNull()
    expect(await tasteRerank('q', [{ file: 'a', snippet: 'x', score: 1 }, { file: 'b', snippet: 'y', score: 1 }], [], embed)).toBeNull()
  })
})
