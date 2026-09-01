// STAGE 6, the consuming half: support erosion GOVERNS grounding weight.
//
// supportErosion() has measured which SURVIVING rules quietly lost justification since Stage 6
// landed — and nothing consumed it. Its only reader was buildGovernAudit, a read surface. So a
// promoted rule that had lost most of the derivations it was minted from went on grounding the
// agent from "Rules the operator confirmed (follow these)" at exactly the authority it no longer
// earns. The graded cascade could see the erosion and the prompt could not.
//
// What this pins is the DECISION, not the measurement (derivation-polynomial.test.ts owns the
// arithmetic): a majority-eroded rule is demoted into the weigh-lightly treatment that measured
// no-lift already produces, and NOTHING is retracted. That boundary is the point — losing support
// is grounds to re-examine a belief, not to delete it, so the fact must still be `promoted` in the
// store, still audit-visible, still recoverable by the operator. Only the prompt's reliance moves.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordFacts,
  recordDerivedFact,
  getAllOperatorFacts,
  promoteFact,
  confirmFact,
  vetoFact,
  buildOperatorBlock,
  supportErosion,
  __resetOperatorModel
} from './operator-model'

beforeEach(() => __resetOperatorModel())

const CONFIRMED = 'Rules the operator confirmed (follow these):'
const ERODED = 'Support eroded — most of the evidence this was derived from has been retired, weigh lightly:'
const RULE = 'Attribute every claim to a source.'

const idOf = (re: RegExp): string => getAllOperatorFacts().find((f) => re.test(f.fact))!.id

/** A promoted rule resting on `n` INDEPENDENT derivations, one premise each.
 *  recordDerivedFact dedups by normalized text, so repeating the rule attaches another
 *  DEPENDS_ON edge to the same fact rather than minting a second rule. */
function promotedRuleWith(n: number): { rule: string; premises: string[] } {
  const premises: string[] = []
  for (let i = 0; i < n; i++) {
    const p = `premise number ${i} about sourcing`
    recordFacts([{ fact: p }])
    recordDerivedFact(RULE, 'context', [idOf(new RegExp(`premise number ${i}\\b`))], null)
    premises.push(p)
  }
  // The lifecycle is candidate → [promote] → provisional (probation) → [confirm] → promoted.
  // Drive it all the way to `promoted`, because the claim under test is specifically about a rule
  // the operator CONFIRMED still grounding at full authority after its evidence went away.
  const rid = idOf(/Attribute every claim/)
  promoteFact(rid)
  confirmFact(rid)
  return { rule: RULE, premises }
}

/** The block section a fact is rendered under, or null when it is absent entirely. */
function sectionOf(block: string, factText: string): string | null {
  const lines = block.split('\n')
  const i = lines.findIndex((l) => l === `- ${factText}`)
  if (i < 0) return null
  for (let j = i; j >= 0; j--) if (!lines[j].startsWith('- ')) return lines[j]
  return null
}

describe('support erosion governs grounding weight (the Stage 6 consumer)', () => {
  it('demotes a promoted rule out of "follow these" once half its derivations are retired', () => {
    const { premises } = promotedRuleWith(2)
    // Baseline: fully supported, and the prompt leans on it at full authority.
    expect(sectionOf(buildOperatorBlock(), RULE)).toBe(CONFIRMED)

    vetoFact(idOf(new RegExp(premises[0]))) // 2 derivations → 1: a majority loss

    // THE DECISION: the same rule now grounds as weigh-lightly, with the reason stated.
    expect(sectionOf(buildOperatorBlock(), RULE)).toBe(ERODED)
  })

  it('RETRACTS NOTHING — the demoted rule is still promoted, still present, still auditable', () => {
    const { premises } = promotedRuleWith(2)
    vetoFact(idOf(new RegExp(premises[0])))

    // The demotion really did fire — asserted here too, so this case detects a missing consumer
    // rather than passing vacuously when nothing is demoted at all.
    expect(sectionOf(buildOperatorBlock(), RULE)).toBe(ERODED)

    const rule = getAllOperatorFacts().find((f) => f.fact === RULE)!
    // The store is untouched: this governs the PROMPT's reliance, not the fact's standing.
    expect(rule.status).toBe('promoted')
    expect(rule.invalidatedAt).toBeUndefined()
    expect(rule.dependsOn?.length).toBe(2) // both edges retained — the history of why it exists
    // And it is still in the block at all: quieted, never silently dropped.
    expect(buildOperatorBlock()).toContain(RULE)
  })

  it('does NOT demote a minority loss — one of three is too weak a signal to quiet a confirmed rule', () => {
    const { premises } = promotedRuleWith(3)
    vetoFact(idOf(new RegExp(premises[0]))) // 3 → 2, retains 2/3 > the 0.5 floor

    expect(supportErosion().get(idOf(/Attribute every claim/))).toMatchObject({
      supportBefore: 3,
      supportAfter: 2
    }) // erosion IS measured...
    expect(sectionOf(buildOperatorBlock(), RULE)).toBe(CONFIRMED) // ...but does not govern here
  })

  it('does not fire at all while every derivation still stands', () => {
    promotedRuleWith(2)
    expect(sectionOf(buildOperatorBlock(), RULE)).toBe(CONFIRMED)
    expect(buildOperatorBlock()).not.toContain(ERODED)
  })

  // Guard-strength: without this the demotion could pass by firing on everything, and a rule with
  // no derivational history at all would be quieted for evidence it never claimed to have.
  it('never demotes a base fact — a rule with no premises has no support to lose', () => {
    recordFacts([{ fact: 'Operator prefers short summaries' }])
    const base = idOf(/short summaries/)
    promoteFact(base)
    confirmFact(base)
    recordFacts([{ fact: 'unrelated premise' }])
    vetoFact(idOf(/unrelated premise/)) // a retirement exists, so erosion runs

    expect(sectionOf(buildOperatorBlock(), 'Operator prefers short summaries')).toBe(CONFIRMED)
  })
})
