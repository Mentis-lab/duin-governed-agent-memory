import { describe, it, expect, beforeEach } from 'vitest'
import { entailmentPrompt, parseVerifyReply, type VerifyDeps } from './derivation-verify'
import { runSynthesis, type SynthCandidate, type SynthDeps } from './consolidation-synthesis'
import { runReflection, type PromotedRule, type ReflectDeps } from './reflection-rollup'
import {
  recordFacts,
  recordDerivedFact,
  buildGovernAudit,
  getAllOperatorFacts,
  supersedeFact,
  vetoFact,
  factReliability,
  buildOperatorBlock,
  __resetOperatorModel
} from './operator-model'

beforeEach(() => __resetOperatorModel())

describe('derivation-verify — the independent NLI verifier (faithfulness constraint)', () => {
  it('entailmentPrompt numbers the premises and labels the hypothesis', () => {
    expect(entailmentPrompt(['a', 'b'], 'c')).toBe('PREMISE 1. a\nPREMISE 2. b\n\nHYPOTHESIS. c')
  })
  it('parses a valid verdict; clamps a bad score to 0.5', () => {
    expect(parseVerifyReply('{"label":"entails","score":0.9,"rationale":"follows"}', 'm1'))
      .toEqual({ label: 'entails', score: 0.9, rationale: 'follows', verifier: 'm1' })
    expect(parseVerifyReply('junk {"label":"contradicts","score":5} tail', 'm1'))
      .toEqual({ label: 'contradicts', score: 0.5, rationale: '', verifier: 'm1' })
  })
  it('ABSTAINS (null) on junk / bad label — never a false positive', () => {
    expect(parseVerifyReply('not json at all', 'm1')).toBeNull()
    expect(parseVerifyReply('{"label":"maybe","score":0.9}', 'm1')).toBeNull() // invalid label → abstain
  })
})

describe('folds preserve the derivation (cluster → input-claim ids + verdict)', () => {
  const c = (id: string, text: string, ts: number): SynthCandidate => ({ id, text, ts })
  it('runSynthesis carries `from` (input ids) and the independent verify verdict', async () => {
    const batch = [c('x', 'cite your sources', 1), c('y', 'always cite sources', 2)]
    const deps: SynthDeps & VerifyDeps = {
      synthesize: async () => 'Cite your sources.',
      verify: async (premises, hyp) => ({ label: 'entails', score: 0.8, rationale: 'follows', verifier: 'judge-1' })
    }
    const r = await runSynthesis(batch, 0, deps, { minBatch: 2, maxBatch: 12, minCluster: 2 })
    expect(r.summaries).toHaveLength(1)
    expect(r.summaries[0].rule).toBe('Cite your sources.')
    expect(r.summaries[0].from.sort()).toEqual(['x', 'y']) // the DEPENDS_ON targets — previously discarded
    expect(r.summaries[0].verify).toEqual({ label: 'entails', score: 0.8, rationale: 'follows', verifier: 'judge-1' })
  })
  it('runReflection with NO verifier records the edge UNVERIFIED (keyless-safe)', async () => {
    const rules: PromotedRule[] = [
      { id: 'a', text: 'verify the diff before shipping', ts: 1 },
      { id: 'b', text: 'verify the diff before merge', ts: 2 }
    ]
    const deps: ReflectDeps = { reflect: async () => 'Verify before shipping.' } // no verify dep
    const r = await runReflection(rules, 0, deps, { minBatch: 2, maxBatch: 15, minCluster: 2 })
    expect(r.reflections[0].from.sort()).toEqual(['a', 'b'])
    expect(r.reflections[0].verify).toBeNull() // abstained → unverified
  })
})

describe('recordDerivedFact + buildGovernAudit (the walkable "why this rule exists")', () => {
  it('records a verified DEPENDS_ON edge and the audit JOINS ids → premise texts', () => {
    recordFacts([{ fact: 'Cite sources in reports' }, { fact: 'Always attribute quotes' }])
    const ids = getAllOperatorFacts().filter((f) => /Cite sources|attribute quotes/.test(f.fact)).map((f) => f.id)
    expect(ids).toHaveLength(2)
    const ruleId = recordDerivedFact('Attribute all claims to a source.', 'context', ids, {
      label: 'entails', score: 0.9, rationale: 'both premises demand attribution', verifier: 'judge-1'
    })
    expect(ruleId).toBeTruthy()
    const audit = buildGovernAudit()
    const row = audit.facts.find((f) => f.id === ruleId)!
    expect(row.dependsOn).toHaveLength(1)
    expect(row.dependsOn![0].verdict).toBe('entails')
    expect(row.dependsOn![0].verifier).toBe('judge-1')
    // the JOIN: depends_on ids resolved back to the input-claim TEXTS (walk WHY, not just ids)
    expect(row.dependsOn![0].premises.sort()).toEqual(['Always attribute quotes', 'Cite sources in reports'])
  })

  it('an UNVERIFIED derivation (null verify) records the edge but verifier stays null', () => {
    recordFacts([{ fact: 'Ship on Fridays' }])
    const pid = getAllOperatorFacts().find((f) => f.fact === 'Ship on Fridays')!.id
    const ruleId = recordDerivedFact('Prefer end-of-week releases.', 'context', [pid], null)
    const row = buildGovernAudit().facts.find((f) => f.id === ruleId)!
    expect(row.dependsOn![0].verifier).toBeNull() // abstained, not "verified false"
    expect(row.dependsOn![0].verdict).toBe('neutral')
  })

  it('dedups by normalized text — a re-fold attaches a 2nd edge to the SAME fact', () => {
    recordFacts([{ fact: 'premise one' }, { fact: 'premise two' }])
    const [p1, p2] = getAllOperatorFacts().filter((f) => /premise/.test(f.fact)).map((f) => f.id)
    const id1 = recordDerivedFact('Derived rule.', 'context', [p1], null)
    const id2 = recordDerivedFact('Derived rule.', 'context', [p2], null) // same text → same fact
    expect(id2).toBe(id1)
    const row = buildGovernAudit().facts.find((f) => f.id === id1)!
    expect(row.dependsOn).toHaveLength(2) // both derivations retained on the one fact
  })

  // ...but that dedup must NOT resolve onto one of the fold's OWN premises. The callers pass the
  // cluster's member ids as `dependsOn`, so a fold model that merely echoes an input claim back as the
  // "rule" used to land a self-referential edge on the operator's own capture — invisible, because the
  // fact's TEXT never changed. Both downstream consequences are asserted below.
  it('a fold that ECHOES one of its own premises records NO self-referential edge', () => {
    recordFacts([{ fact: 'Always attribute claims to a source' }, { fact: 'Cite the source when quoting' }])
    const c1 = getAllOperatorFacts().find((f) => /Always attribute/.test(f.fact))!.id
    const c2 = getAllOperatorFacts().find((f) => /Cite the source/.test(f.fact))!.id
    // norm() strips case + trailing punctuation, so this rule text matches c1's capture exactly.
    const id = recordDerivedFact('Always attribute claims to a source.', 'context', [c1, c2], {
      label: 'contradicts', score: 0.9, rationale: 'refuted', verifier: 'j1'
    })
    expect(id).toBe(c1) // the rule is already in the store — as the premise
    const kept = getAllOperatorFacts().filter((f) => /Always attribute/.test(f.fact))
    expect(kept).toHaveLength(1) // and it stays ONE node — no duplicate proposition minted either
    expect(kept[0].dependsOn ?? []).toHaveLength(0) // c1 is still a ROOT capture, not a derived rule
    // (b) the trust semiring no longer caps a human capture at the refuted edge's 0.1 (< TRUST_FLOOR)
    expect(factReliability(c1)).toBe(1)
    // (a) and retiring the SIBLING premise no longer cascades the operator's own fact out from under them
    vetoFact(c2)
    expect(getAllOperatorFacts().find((f) => f.id === c1)!.invalidatedAt).toBeUndefined()
  })
})

describe('Stage 2 — retracting a premise cascades over the DEPENDS_ON edges (operator-model)', () => {
  const liveById = (id: string) => getAllOperatorFacts().find((f) => f.id === id)
  it('supersedeFact retires a premise → the derived rule loses support and is invalidated', () => {
    recordFacts([{ fact: 'premise alpha' }, { fact: 'premise beta' }])
    const [pa, pb] = getAllOperatorFacts().filter((f) => /premise/.test(f.fact)).map((f) => f.id)
    const ruleId = recordDerivedFact('Alpha-beta rule.', 'context', [pa, pb], {
      label: 'entails', score: 0.9, rationale: 'ok', verifier: 'j1'
    })!
    expect(liveById(ruleId)!.invalidatedAt).toBeUndefined() // live before
    supersedeFact(pa, 'premise alpha, revised') // retire premise alpha
    const rule = liveById(ruleId)!
    expect(rule.invalidatedAt).toBeGreaterThan(0) // cascaded out — lost its last support
    expect(rule.invalidatedBy).toBe('cascade') // the walkable "why it fell"
  })

  it('a rule with an ALTERNATE derivation survives a premise retraction', () => {
    recordFacts([{ fact: 'prem one' }, { fact: 'prem two' }, { fact: 'prem three' }])
    const [p1, p2, p3] = getAllOperatorFacts().filter((f) => /prem /.test(f.fact)).map((f) => f.id)
    const ruleId = recordDerivedFact('Multi-support rule.', 'context', [p1, p2], null)!
    recordDerivedFact('Multi-support rule.', 'context', [p3], null) // 2nd derivation, same rule (dedup)
    vetoFact(p1) // retire one premise of the FIRST derivation
    expect(liveById(ruleId)!.invalidatedAt).toBeUndefined() // survives on the p3 derivation
  })

  it('vetoFact triggers the cascade too', () => {
    recordFacts([{ fact: 'sole premise' }])
    const p = getAllOperatorFacts().find((f) => f.fact === 'sole premise')!.id
    const ruleId = recordDerivedFact('Depends only on sole.', 'context', [p], null)!
    vetoFact(p)
    expect(liveById(ruleId)!.invalidatedAt).toBeGreaterThan(0)
  })
})

describe('Stage 3 — calibrated reliability surfaced in the audit (trust semiring)', () => {
  it('a verified derivation from operator premises gets a calibrated, source-capped reliability', () => {
    recordFacts([{ fact: 'operator premise A' }, { fact: 'operator premise B' }]) // source 'operator' by default
    const ids = getAllOperatorFacts().filter((f) => /operator premise/.test(f.fact)).map((f) => f.id)
    const ruleId = recordDerivedFact('A verified fold.', 'context', ids, {
      label: 'entails', score: 0.9, rationale: 'ok', verifier: 'j1'
    })! // recordDerivedFact tags the rule source 'machine'
    const row = buildGovernAudit().facts.find((f) => f.id === ruleId)!
    // 0.9 (entails) × 1.0 (operator premises) = 0.9, capped by own machine tier 0.7 → 0.7
    expect(row.reliability).toBe(0.7)
    expect(factReliability(ruleId)).toBe(0.7)
  })
  it('an UNVERIFIED fold is only neutral trust (verification is what earns confidence)', () => {
    recordFacts([{ fact: 'a premise here' }])
    const p = getAllOperatorFacts().find((f) => f.fact === 'a premise here')!.id
    const ruleId = recordDerivedFact('An unverified fold.', 'context', [p], null)! // no verifier
    // 0.5 (unverified) × 1.0 = 0.5 — below a verified fold, so the audit down-ranks the unchecked "why"
    expect(factReliability(ruleId)).toBe(0.5)
  })

  it('CONSUMER: buildOperatorBlock suppresses a fold that laundered EXTERNAL content (poisoning defense)', () => {
    recordFacts([{ fact: 'external injected claim', source: 'external' }, { fact: 'operator normal claim' }])
    const ext = getAllOperatorFacts().find((f) => f.fact === 'external injected claim')!.id
    const op = getAllOperatorFacts().find((f) => f.fact === 'operator normal claim')!.id
    recordDerivedFact('Laundered rule from external.', 'context', [ext], null) // reliability ≈0.15 < 0.35
    recordDerivedFact('Sound rule from operator.', 'context', [op], null) // reliability 0.5 > 0.35
    const block = buildOperatorBlock()
    // the laundered fold is a MACHINE-sourced rule, so isQuarantinedExternal can't see the external
    // premise underneath — but the trust semiring caps it at ≤0.3, so the reliability gate suppresses it
    expect(block).not.toContain('Laundered rule from external')
    expect(block).toContain('Sound rule from operator') // an ordinary operator-premise fold still grounds
  })
})
