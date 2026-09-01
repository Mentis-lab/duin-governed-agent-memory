// @cohesion-invocation: on-demand-eval — intentionally unwired. A benchmark harness that needs TWO
//   live provider keys (organizationally gated); the live adapter is the caller's job. Not a
//   continuous engine, so it has no tick/hook by design. Cohesion-lint treats this as intentional.
// entanglement-harness — the "is it DUIN or the model?" attribution eval (item 22, transfer proof).
//
// For a fixed probe set, run each probe under a 2×2: {provider A, provider B} × {grounded, bare}.
// If DUIN-grounding shifts the answer the SAME way under BOTH models, the effect is DUIN
// (model-agnostic → transferable); if it shifts under only one model, the effect is entangled with
// that model. The headline attributionScore is the fraction of probes DUIN-grounding moved under
// BOTH providers.
//
// PURE core: the runner injects an `answer(query, provider, grounded)` fn + a `grade` judge, so it
// unit-tests deterministically with mock providers. The LIVE adapter (wire `answer` to
// buildGroundedMessages + chatOnce under two distinct model ids) is the caller's job — a REAL N>1
// attribution needs TWO live provider keys (organizationally gated, like the pilot); on a
// single-provider install provider A === provider B degrades this to a temperature/seed delta.

export interface EntanglementProbe {
  id: string
  query: string
  /** What a DUIN-grounded answer should reflect that a bare one would not — the grader decides
   *  whether grounding actually moved the answer toward this. */
  groundedExpectation: string
}

/** Answer a probe under a given provider, with or without DUIN grounding injected. */
export type AnswerFn = (query: string, provider: string, grounded: boolean) => Promise<string> | string
/** Did grounding move the answer toward the expectation vs the bare answer? (the judge). */
export type ShiftGrader = (bare: string, grounded: string, expectation: string) => Promise<boolean> | boolean

export interface ProbeResult {
  id: string
  shiftedUnderA: boolean
  shiftedUnderB: boolean
  /** Grounding shifted the answer under BOTH models → a model-agnostic (DUIN) effect. */
  duinAttributable: boolean
  /** Shifted under exactly one model → entangled with that model. */
  modelEntangled: boolean
}

export interface EntanglementReport {
  n: number
  providerA: string
  providerB: string
  /** Fraction of probes DUIN-grounding moved under BOTH models — the "it's DUIN, not the model"
   *  score (higher = more transferable). */
  attributionScore: number
  /** Fraction shifted under exactly one model. */
  entanglementRate: number
  results: ProbeResult[]
}

export async function runEntanglement(
  probes: EntanglementProbe[],
  providerA: string,
  providerB: string,
  answer: AnswerFn,
  grade: ShiftGrader
): Promise<EntanglementReport> {
  const results: ProbeResult[] = []
  for (const p of probes) {
    const [aBare, aGround, bBare, bGround] = await Promise.all([
      answer(p.query, providerA, false),
      answer(p.query, providerA, true),
      answer(p.query, providerB, false),
      answer(p.query, providerB, true)
    ])
    const shiftedUnderA = await grade(aBare, aGround, p.groundedExpectation)
    const shiftedUnderB = await grade(bBare, bGround, p.groundedExpectation)
    results.push({
      id: p.id,
      shiftedUnderA,
      shiftedUnderB,
      duinAttributable: shiftedUnderA && shiftedUnderB,
      modelEntangled: shiftedUnderA !== shiftedUnderB
    })
  }
  const n = results.length
  const frac = (pred: (r: ProbeResult) => boolean): number => (n ? results.filter(pred).length / n : 0)
  return {
    n,
    providerA,
    providerB,
    attributionScore: frac((r) => r.duinAttributable),
    entanglementRate: frac((r) => r.modelEntangled),
    results
  }
}

/** A tiny illustrative probe set — the real fixture is the operator's to author (domain-specific). */
export const EXAMPLE_PROBES: EntanglementProbe[] = [
  { id: 'ex-launch', query: 'How should I frame the next update?', groundedExpectation: 'leads with the launch risk' },
  { id: 'ex-units', query: 'Summarize the measurements.', groundedExpectation: 'uses metric units' }
]
