import { describe, it, expect, beforeEach } from 'vitest'
import {
  authorizeGoalTransition,
  assertGoalTransitionAuthorized,
  isTerminalGoalAction,
  GOAL_TERMINAL_TRANSITION_CAP_ID
} from './goal-transition-authority'
import {
  __resetCapabilityLedger,
  registerCapability,
  setRung,
  getCapability
} from './ans/capability-ledger'

// The DUIN adaptation: MODEL-initiated goal TERMINAL transitions (abort/clear/complete)
// are routed through the ANS capability-ledger rung gate instead of upstream's static
// model-cannot-abort rule; user/system actors always bypass.

describe('goal-transition-authority', () => {
  beforeEach(() => {
    __resetCapabilityLedger()
  })

  it('classifies terminal vs non-terminal actions', () => {
    expect(isTerminalGoalAction('abort')).toBe(true)
    expect(isTerminalGoalAction('clear')).toBe(true)
    expect(isTerminalGoalAction('complete')).toBe(true)
    expect(isTerminalGoalAction('pause')).toBe(false)
    expect(isTerminalGoalAction('start')).toBe(false)
    expect(isTerminalGoalAction('record_usage')).toBe(false)
  })

  it('user and system actors always bypass the gate (even for terminal actions)', () => {
    for (const actor of ['user', 'system'] as const) {
      const abort = authorizeGoalTransition('abort', actor)
      expect(abort.authorized).toBe(true)
      expect(abort.via).toBe('actor-bypass')
      const clear = authorizeGoalTransition('clear', actor)
      expect(clear.authorized).toBe(true)
    }
  })

  it('model + non-terminal action is authorized without touching the ledger', () => {
    const r = authorizeGoalTransition('pause', 'model')
    expect(r.authorized).toBe(true)
    expect(r.via).toBe('non-terminal')
  })

  it('model + terminal is DENIED by default (seeded/absent capability is not reflexive)', () => {
    // Absent capability → classify() answers 'unknown' → denied, because this gate requires 'run'.
    // It used to report 'stage', which denied for the right reason but said the wrong thing: the
    // thrown message named a rung the ledger had never assigned. This gate already failed closed;
    // the distinction only makes the refusal legible ("never registered" vs "deliberately held").
    const r = authorizeGoalTransition('abort', 'model')
    expect(r.authorized).toBe(false)
    expect(r.via).toBe('ans-rung')
    expect(r.rung).toBe('unknown')
    expect(() => assertGoalTransitionAuthorized('abort', 'model')).toThrow(
      /model authority cannot abort/i
    )
  })

  it('model + terminal is DENIED while the capability sits at staged', () => {
    registerCapability({ id: GOAL_TERMINAL_TRANSITION_CAP_ID, title: 'terminal', rung: 'stage' })
    expect(authorizeGoalTransition('complete', 'model').authorized).toBe(false)
  })

  it('model + terminal is AUTHORIZED once the capability earns the reflexive rung', () => {
    registerCapability({ id: GOAL_TERMINAL_TRANSITION_CAP_ID, title: 'terminal', rung: 'stage' })
    setRung(GOAL_TERMINAL_TRANSITION_CAP_ID, 'reflexive')
    const r = authorizeGoalTransition('abort', 'model')
    expect(r.authorized).toBe(true)
    expect(r.via).toBe('ans-rung')
    expect(r.rung).toBe('run')
    expect(() => assertGoalTransitionAuthorized('abort', 'model')).not.toThrow()
  })

  it('records a ratify verdict on an authorized terminal, dismiss on a denied one', () => {
    registerCapability({ id: GOAL_TERMINAL_TRANSITION_CAP_ID, title: 'terminal', rung: 'stage' })
    // denied → dismiss (ratifyN increments, ratifyK does not)
    authorizeGoalTransition('abort', 'model')
    const afterDeny = getCapability(GOAL_TERMINAL_TRANSITION_CAP_ID)!
    expect(afterDeny.ratifyN).toBe(1)
    expect(afterDeny.ratifyK).toBe(0)
    // earn autonomy, then an authorized terminal → ratify (both increment)
    setRung(GOAL_TERMINAL_TRANSITION_CAP_ID, 'reflexive')
    authorizeGoalTransition('complete', 'model')
    const afterRatify = getCapability(GOAL_TERMINAL_TRANSITION_CAP_ID)!
    expect(afterRatify.ratifyN).toBe(2)
    expect(afterRatify.ratifyK).toBe(1)
  })
})
