import { describe, it, expect, afterEach } from 'vitest'
import {
  evaluateNudge,
  nudgeCopy,
  nudgePatternKey,
  divergenceNudgeEnabled,
  SENSITIVE_DOMAINS,
  type NudgeInputs
} from './divergence-nudge'
import type { FingerprintAxis } from './operator-fingerprint'

const confidentOneWayAxis = (over: Partial<FingerprintAxis> = {}): FingerprintAxis => ({
  id: 'reversibility-lean',
  label: 'Reversible vs one-way doors',
  poles: ['one-way', 'reversible'],
  countA: 9,
  countB: 5,
  n: 14,
  total: 14,
  explicitN: 14,
  ratio: 0.62,
  ci: [0.59, 0.83], // band clears 0.5 → confident one-way record
  lean: 'A',
  gate: 'norm',
  source: 'decision-notes',
  derivable: 'now',
  ...over
})
const base = (over: Partial<NudgeInputs> = {}): NudgeInputs => ({
  decisionIsOneWay: true,
  decisionDomain: 'work',
  reversibilityAxis: confidentOneWayAxis(),
  promotedContradictingFact: { id: 'f1', text: 'keep options open' },
  dismissedPatternKeys: new Set(),
  domainOptOuts: new Set(),
  ...over
})

describe('evaluateNudge — all five conditions must hold', () => {
  it('fires when every condition holds', () => {
    const d = evaluateNudge(base())
    expect(d.fire).toBe(true)
    expect(d.reason).toBe('fires')
    expect(d.patternKey).toBe('reversibility-lean:f1')
    expect(d.copy).toContain('9 of your last 14')
  })
  it('(1) does not fire when the decision is not one-way', () => {
    expect(evaluateNudge(base({ decisionIsOneWay: false })).reason).toBe('decision-not-one-way')
  })
  it('(2) does not fire without a promoted contradicting fact', () => {
    expect(evaluateNudge(base({ promotedContradictingFact: null })).reason).toBe('no-contradicting-fact')
  })
  it('(3) does not fire when the axis is not confident (band swallows τ)', () => {
    expect(evaluateNudge(base({ reversibilityAxis: confidentOneWayAxis({ ci: [0.44, 0.74], lean: 'balanced' }) })).reason).toBe(
      'axis-not-confident'
    )
    expect(evaluateNudge(base({ reversibilityAxis: confidentOneWayAxis({ gate: 'observe' }) })).reason).toBe('axis-not-confident')
  })
  it('(5) never pushes on sensitive life domains', () => {
    for (const dom of SENSITIVE_DOMAINS) {
      expect(evaluateNudge(base({ decisionDomain: dom })).fire).toBe(false)
      expect(evaluateNudge(base({ decisionDomain: dom })).reason).toBe('sensitive-domain')
    }
  })
  it('(5) respects a per-domain opt-out', () => {
    expect(evaluateNudge(base({ domainOptOuts: new Set(['work']) })).reason).toBe('domain-opted-out')
  })
  it('(4) stays silent once the pattern is dismissed', () => {
    expect(evaluateNudge(base({ dismissedPatternKeys: new Set(['reversibility-lean:f1']) })).reason).toBe('dismissed')
  })
  it('is pure — does not mutate its inputs', () => {
    const inp = base()
    const snap = JSON.stringify({ dk: [...inp.dismissedPatternKeys], oo: [...inp.domainOptOuts], ax: inp.reversibilityAxis })
    evaluateNudge(inp)
    expect(JSON.stringify({ dk: [...inp.dismissedPatternKeys], oo: [...inp.domainOptOuts], ax: inp.reversibilityAxis })).toBe(snap)
  })
})

describe('divergenceNudgeEnabled — OFF by default (pull-only v1)', () => {
  const prev = process.env.DUIN_DIVERGENCE_NUDGE
  afterEach(() => {
    if (prev === undefined) delete process.env.DUIN_DIVERGENCE_NUDGE
    else process.env.DUIN_DIVERGENCE_NUDGE = prev
  })
  it('off when unset', () => {
    delete process.env.DUIN_DIVERGENCE_NUDGE
    expect(divergenceNudgeEnabled()).toBe(false)
  })
  for (const v of ['0', 'false', 'off', '']) {
    it(`off for "${v}"`, () => {
      process.env.DUIN_DIVERGENCE_NUDGE = v
      expect(divergenceNudgeEnabled()).toBe(false)
    })
  }
  it('on only when explicitly enabled', () => {
    process.env.DUIN_DIVERGENCE_NUDGE = '1'
    expect(divergenceNudgeEnabled()).toBe(true)
  })
})

describe('nudge copy — tone contract (imperative-free)', () => {
  const IMPERATIVE = /\b(should|must|try|consider|reconsider)\b|maybe you|have you thought/i
  it('the nudge copy is descriptive, never advice', () => {
    expect(IMPERATIVE.test(nudgeCopy(9, 14))).toBe(false)
    expect(nudgeCopy(9, 14).endsWith('The call is yours.')).toBe(true)
  })
  it('patternKey composes axis × fact', () => {
    expect(nudgePatternKey('reversibility-lean', 'f9')).toBe('reversibility-lean:f9')
  })
})
