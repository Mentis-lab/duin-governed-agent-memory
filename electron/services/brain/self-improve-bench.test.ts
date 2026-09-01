import { describe, it, expect } from 'vitest'
import { scoreBench, type BenchInputs } from './self-improve-bench'
import type { InflightChange, AutonomyState } from './self-improve-registry'
import type { Capability } from '../ans/capability-ledger'

const NOW = '2026-07-17T00:00:00.000Z'

const cap = (over: Partial<Capability>): Capability =>
  ({ id: 'c', title: 't', rung: 'stage', floorRung: 'stage', ratifyN: 0, ratifyK: 0, reverts: 0, ...over } as Capability)

const change = (over: Partial<InflightChange>): InflightChange =>
  ({
    id: 'x', changeClass: 'kind-weight', engine: 'risk', targetPath: 'p',
    beforeBytes: 'a', afterBytes: 'b', proposedAt: NOW, status: 'applied', ...over,
  } as InflightChange)

// Must match SEEDED_CAPS / seedCapabilities() — the 4th is item 24's rsi-tunable-apply, added when
// the RSI apply path became the safe-undo ledger's producer. A stale count here would make the
// skill↔capability wire read 1 (a skill registered a capability) on a bare boot.
const SEEDED = (): Capability[] => [cap({ id: '1' }), cap({ id: '2' }), cap({ id: '3' }), cap({ id: '4' })]

// Pre-build baseline declared-wire state (named-skill write-only, rsi unfed, no skill caps).
const BASELINE_DECLARED = { namedSkillReadback: 0.5, rsiProducer: 0, skillCapBridge: 0 }

const base = (over: Partial<BenchInputs> = {}): BenchInputs => ({
  inflight: [],
  autonomy: new Map<string, AutonomyState>(),
  namedSkillCount: 0,
  reuseEventCount: 0,
  capabilities: SEEDED(),
  moatStatus: 'cold',
  prevCompoundingLevel: null,
  declared: { ...BASELINE_DECLARED },
  meritAutonomyOn: false,
  namedSkillLift: { value: null, note: 'no transfer-A/B run recorded yet (the grader has never been asked)' },
  ...over,
})

describe('self-improve-bench · scoreBench', () => {
  it('baseline (runtime-dead, enforcement built-not-active): connectedness ~41.7, efficacy null, safety 100', () => {
    const b = scoreBench(base(), NOW)
    // wires: named 0.5, rsi 0, classify 0.5 (built/off), ceilings 0.5 (built/off), skill↔cap 0, consolidation 1 = 2.5/6
    expect(b.connectedness).toBeCloseTo(41.7, 1)
    expect(b.efficacy).toBeNull()
    expect(b.safety).toBe(100)
    expect(b.compounding.level).toBe(0)
    expect(b.compounding.slope).toBeNull()
  })

  it('DUIN_MERIT_AUTONOMY active lifts classify + ceilings wires to 1 (completion)', () => {
    const b = scoreBench(base({ meritAutonomyOn: true }), NOW)
    expect(b.wires.find((w) => w.wire === 'ans:classify-gate')!.score).toBe(1)
    expect(b.wires.find((w) => w.wire === 'ans:effective-ceilings')!.score).toBe(1)
  })

  it('named-skill read-back wire lands (declared=1) lifts connectedness above baseline', () => {
    const b = scoreBench(base({ declared: { ...BASELINE_DECLARED, namedSkillReadback: 1 } }), NOW)
    const w = b.wires.find((w) => w.wire === 'named-skill:read-back')!
    expect(w.score).toBe(1)
    expect(b.connectedness).toBeGreaterThan(33.3)
  })

  it('RSI wire: proposed-only = 0.5, adjudicated = 1; kept-rate honest-null below min-N', () => {
    const proposed = scoreBench(base({ inflight: [change({})] }), NOW)
    expect(proposed.wires.find((w) => w.wire === 'rsi:proposer→adjudicate')!.score).toBe(0.5)
    expect(proposed.efficacy).toBeNull() // <5 adjudicated

    const adj = Array.from({ length: 5 }, (_, i) =>
      change({ id: `k${i}`, status: 'kept', resolvedVerdict: { pass: true } as any })
    )
    const b = scoreBench(base({ inflight: adj }), NOW)
    expect(b.wires.find((w) => w.wire === 'rsi:proposer→adjudicate')!.score).toBe(1)
    expect(b.efficacy).toBe(100) // 5/5 kept
  })

  it('SAFETY drops below 100 when a CAP-class capability can earn reflexive autonomy', () => {
    const bad = scoreBench(base({ capabilities: [...SEEDED(), cap({ id: 'x', title: 'send_message', floorRung: 'reflexive' })] }), NOW)
    expect(bad.safetyChecks.find((c) => c.name === 'cap-class-floored')!.pass).toBe(false)
    expect(bad.safety).toBeLessThan(100)
  })

  it('SAFETY flags two in-flight changes on the same engine (attribution invariant)', () => {
    const b = scoreBench(base({ inflight: [change({ id: 'a', engine: 'risk' }), change({ id: 'b', engine: 'risk' })] }), NOW)
    expect(b.safetyChecks.find((c) => c.name === 'one-inflight-per-engine')!.pass).toBe(false)
  })

  it('skill↔capability wire lights when caps exceed the seeded set', () => {
    const b = scoreBench(base({ capabilities: [...SEEDED(), cap({ id: 'skill-cap', title: 'my_skill' })] }), NOW)
    expect(b.wires.find((w) => w.wire === 'skill↔capability')!.score).toBe(1)
  })

  it('compounding slope = level − prev', () => {
    const b = scoreBench(base({ reuseEventCount: 10, moatStatus: 'warming', prevCompoundingLevel: 10 }), NOW)
    // reuseSignal=50, gradSignal=0, moat=50 → level=33.3; slope=33.3−10=23.3
    expect(b.compounding.level).toBeCloseTo(33.3, 1)
    expect(b.compounding.slope).toBeCloseTo(23.3, 1)
  })
})
