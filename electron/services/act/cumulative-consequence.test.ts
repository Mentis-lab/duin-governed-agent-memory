import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  tierWeight,
  consequenceCeiling,
  overConsequenceCeiling,
  accrueConsequence,
  sessionConsequence,
  resetConsequence,
  shouldEscalateCumulative,
  __resetAllConsequence,
  RECOMMENDED_CONSEQUENCE_CEILING
} from './cumulative-consequence'

beforeEach(() => __resetAllConsequence())
afterEach(() => {
  delete process.env.DUIN_CONSEQUENCE_CEILING
})

describe('tierWeight', () => {
  it('is 0 for reads (never accrue), cheap for reversible, heavy for external/irreversible', () => {
    expect(tierWeight('read')).toBe(0)
    expect(tierWeight('none')).toBe(0)
    expect(tierWeight('write-reversible')).toBe(1)
    expect(tierWeight('external-write')).toBe(3)
    expect(tierWeight('irreversible')).toBe(6)
    expect(tierWeight('external-irreversible')).toBe(6)
  })
  it('treats an unknown tier as a reversible write (conservative non-zero)', () => {
    expect(tierWeight('something-new')).toBe(1)
  })
  // REGRESSION GUARD: the SOLE production caller (agui-gate.ts) passes verdict.tier, an AguiTier —
  // NOT an ActionTier. Every AguiTier member must weigh explicitly; a native irreversible action
  // falling through to the default weight of 1 is the exact defect this guards (a send scored 1, so
  // ~20 were needed to trip a ceiling designed for ~3). Assert every AguiTier value AND that none of
  // the consequential ones collapse to the default.
  it('weighs every AguiTier the gate can produce — no native irreversible action falls to the default', () => {
    // The full AguiTier union from agui-approval.ts. Kept literal (not imported) so a future rename
    // there fails THIS test loudly rather than silently drifting the two vocabularies apart again.
    const aguiTiers = [
      'host-exec',
      'irreversible-file',
      'irreversible-send',
      'spawn-recursive',
      'mcp-external',
      'external-write',
      'external-irreversible',
      'none'
    ] as const
    const expected: Record<(typeof aguiTiers)[number], number> = {
      'host-exec': 6,
      'irreversible-file': 6,
      'irreversible-send': 6,
      'spawn-recursive': 6,
      'mcp-external': 3,
      'external-write': 3,
      'external-irreversible': 6,
      none: 0
    }
    for (const tier of aguiTiers) {
      expect(tierWeight(tier), `AguiTier '${tier}'`).toBe(expected[tier])
    }
    // The four native irreversible tiers specifically must NOT score the conservative default of 1.
    for (const tier of ['host-exec', 'irreversible-file', 'irreversible-send', 'spawn-recursive'] as const) {
      expect(tierWeight(tier), `native irreversible '${tier}' must not fall to default`).toBeGreaterThan(1)
    }
  })
})

describe('consequenceCeiling (env, opt-in)', () => {
  it('is DISABLED (0) when unset — byte-identical gate by default', () => {
    expect(consequenceCeiling()).toBe(0)
    expect(RECOMMENDED_CONSEQUENCE_CEILING).toBeGreaterThan(0) // a suggestion, not the default
  })
  it('honours a positive override; 0 stays disabled', () => {
    process.env.DUIN_CONSEQUENCE_CEILING = '25'
    expect(consequenceCeiling()).toBe(25)
    process.env.DUIN_CONSEQUENCE_CEILING = '0'
    expect(consequenceCeiling()).toBe(0)
  })
  it('treats garbage / negative as disabled (safe)', () => {
    process.env.DUIN_CONSEQUENCE_CEILING = 'nonsense'
    expect(consequenceCeiling()).toBe(0)
    process.env.DUIN_CONSEQUENCE_CEILING = '-5'
    expect(consequenceCeiling()).toBe(0)
  })
})

describe('accrue + sessionConsequence', () => {
  it('accumulates per conversation, isolated across conversations', () => {
    accrueConsequence('conv-a', 3)
    accrueConsequence('conv-a', 1)
    accrueConsequence('conv-b', 6)
    expect(sessionConsequence('conv-a')).toBe(4)
    expect(sessionConsequence('conv-b')).toBe(6)
    expect(sessionConsequence('conv-unknown')).toBe(0)
  })
  it('a zero-weight action (a read) never moves the budget', () => {
    accrueConsequence('c', 0)
    expect(sessionConsequence('c')).toBe(0)
  })
  it('reset clears one conversation', () => {
    accrueConsequence('c', 5)
    resetConsequence('c')
    expect(sessionConsequence('c')).toBe(0)
  })
})

describe('overConsequenceCeiling', () => {
  it('escalates on the crossing action AND stays escalated after (budget spent, not beeped once)', () => {
    const ceiling = 12
    accrueConsequence('c', 6)
    accrueConsequence('c', 4)
    expect(sessionConsequence('c')).toBe(10)
    // a +1 keeps us under (11 < 12) → no escalation yet
    expect(overConsequenceCeiling('c', 1, ceiling)).toBe(false)
    // a +3 would reach 13 ≥ 12 → escalate on THIS action
    expect(overConsequenceCeiling('c', 3, ceiling)).toBe(true)
    accrueConsequence('c', 3) // now 13, over
    // CRITICAL: once at/over the ceiling, EVERY further consequential action still escalates
    expect(overConsequenceCeiling('c', 1, ceiling)).toBe(true)
    expect(overConsequenceCeiling('c', 6, ceiling)).toBe(true)
  })
  it('a ceiling of 0 disables escalation entirely', () => {
    accrueConsequence('c', 100)
    expect(overConsequenceCeiling('c', 6, 0)).toBe(false)
  })
  it('models a real flood: a drip of reversible writes escalates from the trip point ONWARD', () => {
    const ceiling = 5
    const escalated: number[] = []
    for (let i = 1; i <= 8; i++) {
      if (overConsequenceCeiling('drip', 1, ceiling)) escalated.push(i)
      accrueConsequence('drip', 1)
    }
    // the 5th write trips it and every write after keeps escalating (5,6,7,8) — not just once
    expect(escalated).toEqual([5, 6, 7, 8])
  })
})

describe('shouldEscalateCumulative — the tighten-only gate decision (Govern P2)', () => {
  const CEIL = 5
  it('escalates ONLY an allow whose weight>0 crosses the ceiling', () => {
    accrueConsequence('c', CEIL) // already at the ceiling
    expect(shouldEscalateCumulative('allow', 'write-reversible', 'c', CEIL)).toBe(true)
  })
  it('NEVER escalates a prompt or deny (already tightened — never loosens the tier floor)', () => {
    accrueConsequence('c', 100) // far over the ceiling
    expect(shouldEscalateCumulative('prompt', 'irreversible', 'c', CEIL)).toBe(false)
    expect(shouldEscalateCumulative('deny', 'irreversible', 'c', CEIL)).toBe(false)
  })
  it('NEVER escalates a read (weight 0 → the budget is untouched)', () => {
    accrueConsequence('c', 100)
    expect(shouldEscalateCumulative('allow', 'read', 'c', CEIL)).toBe(false)
  })
  it('is disabled when the ceiling is 0 (opt-in default → inert)', () => {
    accrueConsequence('c', 100)
    expect(shouldEscalateCumulative('allow', 'irreversible', 'c', 0)).toBe(false)
  })
})

describe('loop-closure: an operator approval resets the budget (Govern P2)', () => {
  const CEIL = 5
  it('UNDER-escalation guard — after reset, a later benign action is NOT escalated', () => {
    // flood past the ceiling → escalating
    for (let i = 0; i < 6; i++) accrueConsequence('c', 1)
    expect(shouldEscalateCumulative('allow', 'write-reversible', 'c', CEIL)).toBe(true)
    // operator ratifies "continue" → reset closes the loop
    resetConsequence('c')
    expect(sessionConsequence('c')).toBe(0)
    // the very next benign action no longer escalates (the ratchet was released, not merely beeped)
    expect(shouldEscalateCumulative('allow', 'write-reversible', 'c', CEIL)).toBe(false)
  })
  it('OVER-escalation guard — reset does NOT disable the ratchet; a fresh flood re-trips it', () => {
    for (let i = 0; i < 6; i++) accrueConsequence('c', 1)
    resetConsequence('c')
    // refill after the reset → the ceiling trips again (reset released the budget, did not turn the gate off)
    for (let i = 0; i < 6; i++) accrueConsequence('c', 1)
    expect(shouldEscalateCumulative('allow', 'write-reversible', 'c', CEIL)).toBe(true)
  })
  it('reset only zeroes the CUMULATIVE budget — it can never convert a tier prompt/deny into an allow', () => {
    resetConsequence('c') // fresh budget
    // even with an empty accumulator, a tier-denied/prompted action is untouched by the cumulative layer
    expect(shouldEscalateCumulative('deny', 'irreversible', 'c', CEIL)).toBe(false)
    expect(shouldEscalateCumulative('prompt', 'irreversible', 'c', CEIL)).toBe(false)
  })
})
