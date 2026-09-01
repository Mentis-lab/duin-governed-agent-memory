// decision-axes — the closed set of DIVERGENCE-ELIGIBLE decision idioms, each owning a
// keyless regex that maps a stated operator preference to a pole on the axis. This is the
// idiomatic keyless-pattern approach (mirrors operator-model.ts KEYLESS_PATTERNS): NO new
// field on OperatorFact, no migration, no embedding, no model call — a promoted fact's text
// is matched by regex to a pole, and the fingerprint's measured behavior is joined against it.
//
// Design (plan §5): the axis descriptor deliberately does NOT re-read behavior — the
// FingerprintAxis (operator-fingerprint.ts) IS the single behavior read. Duplicating a
// behavior reader here is exactly the divergent-logic trap the plan §0.2 warns about, so
// matchClaim is the only responsibility. Pole A is ALWAYS the notable/riskier idiom.

export interface DecisionAxisDescriptor {
  id: string // MUST match a FingerprintAxis.id
  binary: boolean // only binary axes are divergence-eligible
  poles: [string, string] // [A = riskier, B]
  /** Map a stated preference to the pole it endorses, or null if the fact is off-axis. */
  matchClaim(factText: string): { pole: string } | null
}

/** Build a matchClaim that tries the A-pole regex first, then the B-pole regex. */
function poleMatcher(poles: [string, string], reA: RegExp, reB: RegExp) {
  return (factText: string): { pole: string } | null => {
    if (reA.test(factText)) return { pole: poles[0] }
    if (reB.test(factText)) return { pole: poles[1] }
    return null
  }
}

const REVERSIBILITY_POLES: [string, string] = ['one-way', 'reversible']
const FORECAST_POLES: [string, string] = ['confident', 'hedged']

export const DECISION_AXES: DecisionAxisDescriptor[] = [
  {
    id: 'reversibility-lean',
    binary: true,
    poles: REVERSIBILITY_POLES,
    matchClaim: poleMatcher(
      REVERSIBILITY_POLES,
      // A: endorses one-way / decisive / committing
      /prefer(?:s|red)?[^.]*(?:one[-\s]?way|irreversible|commit\b|decisive)|burn[^.]*boat|no going back|point of no return|\bcommit\s+(?:hard|fully|early)/i,
      // B: endorses reversibility / keeping options open
      /prefer(?:s|red)?[^.]*revers|keep[^.]*options?\s+open|leav[^.]*options?\s+open|two[-\s]?way door|reversible by default|avoid[^.]*(?:one[-\s]?way|irreversible)/i
    )
  },
  {
    id: 'forecast-optimism',
    binary: true,
    poles: FORECAST_POLES,
    matchClaim: poleMatcher(
      FORECAST_POLES,
      // A: endorses confident / bullish forecasting
      /(?:bullish|optimistic|confident)[^.]*(?:forecast|call|predict|estimat|bet)|back myself|swing for the fences/i,
      // B: endorses hedging / caution
      /hedge|sandbag|under[-\s]?promise|(?:cautious|conservative)[^.]*(?:forecast|call|predict|estimat|bet)|pad[^.]*estimat/i
    )
  }
]

export const decisionAxisById = (id: string): DecisionAxisDescriptor | undefined =>
  DECISION_AXES.find((a) => a.id === id)
