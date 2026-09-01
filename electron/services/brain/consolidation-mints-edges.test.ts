// THE integration nobody tested: does a fold actually mint a DEPENDS_ON edge into the store?
//
// The whole reasoning-trace line — Stage 1 (verified edges), Stage 2 (cascade), Stage 3 (trust
// semiring), Stage 5 (distributional bounds), Stage 6 (polynomials + graded cascade) — is built on
// derived facts carrying `dependsOn`. Every one of those stages is tested against SYNTHETIC RelFact
// fixtures. `consolidation-synthesis.test.ts` covers the pure helpers (selection, prompt, clustering)
// and contains ZERO references to `dependsOn` or `recordDerivedFact`.
//
// So the step that produces the input for all five stages had no end-to-end coverage: the benchmark
// probe only greps that a caller EXISTS. That is the same wiring gap the audit found elsewhere, sitting
// under the highest-scoring axis in the campaign — and it matters right now, because on the live store
// zero facts carry an edge and the honest question is whether the path works at all.
//
// These drive the REAL runConsolidationSynthesis against a real (temp-file) store.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../providers/registry', () => ({
  chatOnce: vi.fn(async () => ({ content: '' })),
  routeModel: () => null, // keyless: the fold must come from injected deps only
  routeDistinctModel: () => null,
  routeDistinctModels: () => [],
  getProviderForModel: () => null
}))

import { runConsolidationSynthesis } from './consolidation-synthesis'
import {
  setOperatorModelPath,
  recordFacts,
  listByStatus,
  getAllOperatorFacts,
  __resetOperatorModel
} from './operator-model'

// Three captures sharing ≥2 significant tokens so clusterByCohesion groups them (minCluster 2),
// and ≥ minBatch 3. Sentence-length, matching the live store's real candidate shape.
const CLUSTER = [
  'Operator wants the deployment checklist reviewed before every release candidate ships',
  'Operator asks that the release checklist be signed off by a second reviewer',
  'Operator treats an unreviewed release checklist as a blocker for shipping'
]

const FOLDED = 'Operator requires a reviewed, signed-off release checklist before shipping'

beforeEach(() => {
  setOperatorModelPath(join(mkdtempSync(join(tmpdir(), 'duin-fold-')), 'operator-model.json'))
  __resetOperatorModel()
  recordFacts(CLUSTER.map((fact) => ({ fact, kind: 'context' })))
  expect(listByStatus('candidate')).toHaveLength(3)
})

const withEdges = () => getAllOperatorFacts().filter((f) => f.dependsOn && f.dependsOn.length > 0)

describe('consolidation fold → DEPENDS_ON edge in the store', () => {
  it('MINTS an edge naming the input claims it was folded from', async () => {
    const r = await runConsolidationSynthesis({ synthesize: async () => FOLDED })
    expect(r.synthesized).toBe(true)

    const derived = withEdges()
    expect(derived, 'a fold must produce a fact carrying dependsOn').toHaveLength(1)
    const edge = derived[0].dependsOn![0]
    expect(edge.depends_on.length).toBeGreaterThanOrEqual(2) // the cluster's input-claim ids
    // The ids must RESOLVE to real facts — an edge naming nothing is unwalkable and would make every
    // downstream stage (audit join, cascade, trust semiring) silently degenerate.
    const ids = new Set(getAllOperatorFacts().map((f) => f.id))
    for (const id of edge.depends_on) expect(ids.has(id)).toBe(true)
  })

  it('records the edge UNVERIFIED when no NLI verifier is injected (keyless-safe)', async () => {
    await runConsolidationSynthesis({ synthesize: async () => FOLDED })
    const edge = withEdges()[0].dependsOn![0]
    expect(edge.verifier).toBeNull() // "couldn't verify" must never read as "verified true"
    expect(edge.verdict).not.toBe('entails')
  })

  it('carries an INDEPENDENT verifier verdict through when one IS injected', async () => {
    await runConsolidationSynthesis({
      synthesize: async () => FOLDED,
      verify: async () => ({ label: 'entails', score: 0.91, rationale: 'premises support it', verifier: 'judge-1' })
    })
    const edge = withEdges()[0].dependsOn![0]
    expect(edge.verdict).toBe('entails')
    expect(edge.verifier).toBe('judge-1')
    expect(edge.score).toBeCloseTo(0.91, 2)
  })

  it('mints NOTHING when the fold declines — no engine must not fabricate a derivation', async () => {
    const r = await runConsolidationSynthesis({ synthesize: async () => null })
    expect(r.synthesized).toBe(false)
    expect(withEdges()).toHaveLength(0)
  })

  it('an abstaining verifier still records the edge, just unverified', async () => {
    await runConsolidationSynthesis({ synthesize: async () => FOLDED, verify: async () => null })
    const derived = withEdges()
    expect(derived).toHaveLength(1) // the derivation is real even when the check could not run
    expect(derived[0].dependsOn![0].verifier).toBeNull()
  })

  it('the minted edge is consumable by the downstream stages it exists to feed', async () => {
    // Guards the actual failure mode: an edge that exists but is shaped wrong would leave every stage
    // silently degenerate rather than erroring.
    await runConsolidationSynthesis({
      synthesize: async () => FOLDED,
      verify: async () => ({ label: 'entails', score: 0.9, rationale: 'r', verifier: 'j' })
    })
    const { reliabilityByFact } = await import('./derivation-reliability')
    const { cascadeTargets } = await import('./derivation-cascade')
    const all = getAllOperatorFacts()
    const derivedId = withEdges()[0].id
    const premiseId = withEdges()[0].dependsOn![0].depends_on[0]

    // Stage 3: the trust semiring must score it as a DERIVED fact, not fall back to a bare tier.
    const rel = reliabilityByFact(all.map((f) => ({ id: f.id, source: f.source, dependsOn: f.dependsOn })))
    expect(rel.get(derivedId)).toBeGreaterThan(0)

    // Stage 2: retiring a premise must actually reach the derived fact through the minted edge.
    const dead = cascadeTargets(
      all.map((f) => ({ id: f.id, status: f.status, dependsOn: f.dependsOn?.map((e) => ({ depends_on: e.depends_on })) })),
      [premiseId]
    )
    expect(dead).toContain(derivedId)
  })
})
