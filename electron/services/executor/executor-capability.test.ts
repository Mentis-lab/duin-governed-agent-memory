import { describe, it, expect, beforeEach } from 'vitest'
import { registerExecutorCapability, executorRung, recordExecutorOutcome, EXECUTOR_DSH_CAP_ID } from './executor-capability'
import { __resetCapabilityLedger, classify, getCapability } from '../ans/capability-ledger'
import { composeTierRung } from '../ans/gate-compose'

// The earned-autonomy stance, made mechanical. Two claims: the capability id EQUALS the tool name
// so the gate composer picks it up; and the compose meet gives attended-first-until-earned without
// a line of gate code — a stage rung tightens a trusted-afk allow to prompt (which fails closed
// AFK), and a reflexive rung leaves it alone.

beforeEach(() => {
  __resetCapabilityLedger()
})

describe('registration', () => {
  it("registers under the tool name 'delegate_task' at stage", () => {
    expect(EXECUTOR_DSH_CAP_ID).toBe('delegate_task')
    registerExecutorCapability()
    expect(getCapability('delegate_task')?.rung).toBe('stage')
    expect(executorRung()).toBe('stage')
  })
  it('an unregistered / reset ledger reports unknown, never a permissive default', () => {
    expect(executorRung()).toBe('unknown')
    expect(classify('delegate_task')).toBe('unknown')
  })
})

describe('the gate composer governs delegate_task by its earned rung', () => {
  it('STAGE tightens a trusted-afk allow to prompt (→ fail-closed with no window)', () => {
    registerExecutorCapability()
    const c = composeTierRung('allow', getCapability('delegate_task')!.rung)
    expect(c.kind).toBe('prompt')
    expect(c.tightenedByRung).toBe(true)
  })
  it('REFLEXIVE leaves a trusted-afk allow alone — an earned run may start', () => {
    registerExecutorCapability()
    // simulate the governor promoting it
    const cap = getCapability('delegate_task')!
    const promoted = composeTierRung('allow', 'reflexive')
    expect(promoted.kind).toBe('allow')
    expect(promoted.tightenedByRung).toBe(false)
    expect(cap.rung).toBe('stage') // registration itself never promotes
  })
  it('interactive/review already prompt, and the rung does not loosen that', () => {
    registerExecutorCapability()
    expect(composeTierRung('prompt', 'stage').kind).toBe('prompt')
    expect(composeTierRung('prompt', 'reflexive').kind).toBe('prompt') // rung can only tighten
  })
})

describe('keep/discard moves the rung record', () => {
  it('keep records a ratify; discard records a revert', () => {
    registerExecutorCapability()
    recordExecutorOutcome(true)
    recordExecutorOutcome(true)
    let cap = getCapability('delegate_task')!
    expect(cap.ratifyN).toBe(2)
    expect(cap.ratifyK).toBe(2)
    expect(cap.reverts).toBe(0)
    recordExecutorOutcome(false)
    cap = getCapability('delegate_task')!
    expect(cap.reverts).toBe(1)
    expect(cap.ratifyN).toBe(2) // a revert is a miss, not a decision count
  })
  it('recording an outcome for an unregistered capability does not throw', () => {
    expect(() => recordExecutorOutcome(true)).not.toThrow()
  })
})
