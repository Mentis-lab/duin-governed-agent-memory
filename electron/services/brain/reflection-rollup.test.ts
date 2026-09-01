import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  rollupInsights,
  reflectionPrompt,
  runReflection,
  runReflectionRollup,
  __resetReflectWatermark,
  DEFAULT_REFLECT_POLICY,
  type PromotedRule,
  type ReflectDeps
} from './reflection-rollup'
import {
  setOperatorModelPath,
  recordFacts,
  promoteFact,
  confirmFact,
  supersedeFact,
  getAllOperatorFacts,
  __resetOperatorModel
} from './operator-model'
import { setActiveDenylist } from '../governance/confidential-firewall'

// Store — second-level reflection rollup (Generative Agents). Pure core.

const rule = (id: string, ts: number, text = `rule ${id}`): PromotedRule => ({ id, text, ts })

describe('rollupInsights', () => {
  it('selects promoted rules newer than the watermark, oldest→newest', () => {
    const rules = [rule('a', 10), rule('b', 30), rule('c', 20), rule('d', 40), rule('e', 50)]
    const sel = rollupInsights(rules, 15)
    expect(sel.map((r) => r.id)).toEqual(['c', 'b', 'd', 'e']) // >15, sorted by ts
  })

  it('returns [] below minBatch (guard against meta-noise on too few rules)', () => {
    expect(rollupInsights([rule('a', 1), rule('b', 2), rule('c', 3)], 0)).toEqual([]) // 3 < 4
  })

  it('caps to the most recent maxBatch', () => {
    const many = Array.from({ length: 20 }, (_, i) => rule(`r${i}`, i + 1))
    expect(rollupInsights(many, 0).length).toBe(DEFAULT_REFLECT_POLICY.maxBatch)
  })

  it('ignores blank-text rules', () => {
    const rules = [rule('a', 1), rule('b', 2), rule('c', 3, '  '), rule('d', 4), rule('e', 5)]
    expect(rollupInsights(rules, 0).map((r) => r.id)).toEqual(['a', 'b', 'd', 'e'])
  })
})

describe('reflectionPrompt', () => {
  it('frames a higher-order principle over CONFIRMED rules with a NONE escape', () => {
    const p = reflectionPrompt(['always verify before shipping', 'never trust an unread diff'])
    expect(p).toMatch(/ALREADY confirmed/)
    expect(p).toMatch(/higher-order PRINCIPLE/)
    expect(p).toMatch(/reply exactly "NONE"/)
    expect(p).toMatch(/1\. always verify/)
  })
})

describe('runReflection', () => {
  // 5 confirmed rules on ONE theme — they share ≥2 significant tokens (verify/diff/before), so
  // clusterByCohesion folds them into a single cohesive cluster.
  const rules = [
    rule('r0', 1, 'verify the diff before shipping'),
    rule('r1', 2, 'verify the diff before merge'),
    rule('r2', 3, 'verify the diff before review'),
    rule('r3', 4, 'verify the diff before release'),
    rule('r4', 5, 'verify the diff before deploy'),
  ]

  it('folds a thematic cluster into a reflection + advances the watermark', async () => {
    const deps: ReflectDeps = { reflect: async () => 'Verification discipline: never trust unverified work.' }
    const r = await runReflection(rules, 0, deps)
    expect(r.reflections.map((x) => x.rule)).toEqual(['Verification discipline: never trust unverified work.'])
    expect(r.consumed).toBe(5)
    expect(r.watermark).toBe(5)
  })

  it('a "NONE" reply yields no reflection (forced abstraction refused)', async () => {
    const deps: ReflectDeps = { reflect: async () => 'NONE' }
    const r = await runReflection(rules, 0, deps)
    expect(r.reflections).toEqual([])
    expect(r.consumed).toBe(5)
  })

  it('emits ONE reflection PER thematic cluster (a multi-topic batch no longer burns as NONE)', async () => {
    const multi = [
      rule('a', 1, 'verify the diff before shipping'),
      rule('b', 2, 'verify the diff before merge'),
      rule('c', 3, 'document every endpoint clearly'),
      rule('d', 4, 'document every endpoint fully'),
    ]
    const deps: ReflectDeps = { reflect: async (p) => (/verify/.test(p) ? 'Verify before shipping.' : 'Document every endpoint.') }
    const r = await runReflection(multi, 0, deps, { minBatch: 4, maxBatch: 15, minCluster: 2 })
    expect(r.reflections.map((x) => x.rule).sort()).toEqual(['Document every endpoint.', 'Verify before shipping.'])
    expect(r.consumed).toBe(4)
  })

  it('too few promoted rules → no model call, no reflection', async () => {
    let called = false
    const deps: ReflectDeps = { reflect: async () => { called = true; return 'x' } }
    const r = await runReflection([rule('a', 1), rule('b', 2)], 0, deps)
    expect(called).toBe(false)
    expect(r).toMatchObject({ reflections: [], consumed: 0, watermark: 0 })
  })

  it('a throwing/declined engine is best-effort (no reflection, watermark still advances)', async () => {
    const deps: ReflectDeps = { reflect: async () => { throw new Error('no key') } }
    const r = await runReflection(rules, 0, deps)
    expect(r.reflections).toEqual([])
    expect(r.consumed).toBe(5)
  })
})

// The LIVE pass against the real store. runReflectionRollup read listByStatus('promoted'), which keys
// on STATUS ALONE — but supersedeFact retires a rule by stamping `invalidatedAt` and LEAVING
// status 'promoted' (soft-delete, so the audit survives). A rule the operator had already corrected
// away therefore kept qualifying for the fold, and its dead instruction re-entered grounding
// laundered inside a machine reflection.
describe('runReflectionRollup — bitemporal liveness of the promoted batch', () => {
  const LIVE = [
    'always review the release checklist before deploy',
    'always review the release notes before deploy',
    'always review the release owners before deploy',
    'always review the release tags before deploy'
  ]
  const RETIRED = 'always review the release branch before deploy'
  const PRINCIPLE = 'Nothing reaches a release unreviewed.'

  const idOf = (text: string): string => getAllOperatorFacts().find((f) => f.fact === text)!.id
  /** candidate → provisional (human gate) → promoted (govern confirm), the only real route to 'promoted'. */
  const confirmAll = (texts: string[]): void => {
    for (const t of texts) {
      const id = idOf(t)
      promoteFact(id)
      confirmFact(id)
    }
  }

  beforeEach(() => {
    setOperatorModelPath(mkdtempSync(join(tmpdir(), 'duin-rr-')))
    __resetOperatorModel()
    __resetReflectWatermark()
  })

  it('never folds a superseded rule into the higher-order principle', async () => {
    recordFacts([...LIVE, RETIRED].map((fact) => ({ fact, kind: 'context' })))
    confirmAll([...LIVE, RETIRED])
    const retiredId = idOf(RETIRED)
    // The operator corrects that one rule away. Status stays 'promoted'; only `invalidatedAt` is set.
    expect(supersedeFact(retiredId, 'always review the staging branch before deploy').superseded).toBe(true)

    const prompts: string[] = []
    const r = await runReflectionRollup({ reflect: async (p) => { prompts.push(p); return PRINCIPLE } })

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toContain('release branch') // the retired instruction never reaches the fold
    expect(prompts[0]).toContain('release checklist') // …while its live siblings still do
    expect(r).toMatchObject({ reflected: true, consumed: LIVE.length })
    // …and the derived candidate's DEPENDS_ON edge rests on live premises only.
    const derived = getAllOperatorFacts().find((f) => f.fact === PRINCIPLE)
    expect(derived?.dependsOn?.flatMap((e) => e.depends_on) ?? []).not.toContain(retiredId)
  })

  it('a retired rule no longer inflates the batch to minBatch (no rollup on 3 live rules)', async () => {
    const four = [...LIVE.slice(0, 3), RETIRED] // exactly minBatch, one of them already corrected away
    recordFacts(four.map((fact) => ({ fact, kind: 'context' })))
    confirmAll(four)
    supersedeFact(idOf(RETIRED), 'always review the staging branch before deploy')

    let called = false
    const r = await runReflectionRollup({ reflect: async () => { called = true; return PRINCIPLE } })

    expect(called).toBe(false) // 3 live promoted rules < minBatch 4 → no fold, no model call
    expect(r).toEqual({ reflected: false, consumed: 0 })
  })
})

// 'promoted' is not a confidentiality guarantee — operator-govern's keyless survival path can confirm
// a confidential fact straight to 'promoted' without it ever reaching the external jury. This must be
// filtered the same way the structurally identical level-1 pool in consolidation-synthesis.ts is.
describe('runReflectionRollup — confidential-lane firewall: denylisted promoted rules never reach the external fold', () => {
  // The fixture term is invented, never a real one — a test that hardcoded the operator's secrets
  // would re-create the leak this guard exists to close (same convention as confidential-firewall.test.ts).
  const CONFIDENTIAL = [
    'nightjar rollout timeline stays internal',
    'nightjar rollout budget stays internal',
    'nightjar rollout roster stays internal'
  ]
  const CLEAN = [
    'always review the release checklist before deploy',
    'always review the release notes before deploy',
    'always review the release owners before deploy',
    'always review the release tags before deploy'
  ]
  const PRINCIPLE = 'Nothing reaches a release unreviewed.'

  const idOf = (text: string): string => getAllOperatorFacts().find((f) => f.fact === text)!.id
  const confirmAll = (texts: string[]): void => {
    for (const t of texts) {
      const id = idOf(t)
      promoteFact(id)
      confirmFact(id)
    }
  }

  beforeEach(() => {
    setOperatorModelPath(mkdtempSync(join(tmpdir(), 'duin-rr-fw-')))
    __resetOperatorModel()
    __resetReflectWatermark()
  })
  afterEach(() => setActiveDenylist(null))

  it('withholds denylisted promoted rules from BOTH external hops (the reflect prompt and the NLI premises)', async () => {
    setActiveDenylist(['nightjar'])
    // Before the firewall, a promoted confidential cluster folded like any other and its full text
    // went on the wire twice — once inside reflectionPrompt, once as deps.verify's premises.
    recordFacts([...CONFIDENTIAL, ...CLEAN].map((fact) => ({ fact, kind: 'context' })))
    confirmAll([...CONFIDENTIAL, ...CLEAN])

    const seenPrompts: string[] = []
    const seenPremises: string[] = []
    const deps: ReflectDeps = {
      reflect: async (prompt) => { seenPrompts.push(prompt); return PRINCIPLE },
      verify: async (premises) => { seenPremises.push(...premises); return null }
    }
    const r = await runReflectionRollup(deps)

    expect(r.reflected).toBe(true) // the CLEAN cluster still folds — this withholds, it doesn't disable
    expect(r.consumed).toBe(CLEAN.length)
    const sent = [...seenPrompts, ...seenPremises].join('\n').toLowerCase()
    expect(sent).toContain('release checklist') // clean content reached the fold
    expect(sent).not.toContain('nightjar') // confidential content never left the machine
  })

  it('an all-confidential promoted batch opens no external call at all', async () => {
    setActiveDenylist(['nightjar'])
    // 4 confidential rules on one theme — exactly minBatch, so an unfiltered read would have folded
    // this into a reflection. Proves the firewall actively excludes them, not an incidental short batch.
    const all = [...CONFIDENTIAL, 'nightjar rollout vendor stays internal']
    recordFacts(all.map((fact) => ({ fact, kind: 'context' })))
    confirmAll(all)

    let calls = 0
    const r = await runReflectionRollup({ reflect: async () => { calls++; return PRINCIPLE } })

    expect(calls).toBe(0)
    expect(r).toEqual({ reflected: false, consumed: 0 })
  })
})
