import { describe, it, expect, beforeEach } from 'vitest'
import { decideAguiGate, aguiTier, tierRisks, type AguiGateInput } from './agui-approval'
import {
  registerExternalActionTier,
  __clearExternalActionRegistry
} from '../act/action-tier'

// Proves the DISPATCH-LAYER enforcement: once an ACT connector is registered, the
// brain's deny-first verdict core (decideAguiGate) treats it as a gated external
// effect. A de-privileged inbound (channel) turn — execOk:false — is denied at the
// exec-token rule BEFORE any posture/approval can permit it. This is the structural
// guarantee that a remote channel message can never cause an unapproved irreversible
// external write.

function base(over: Partial<AguiGateInput> = {}): AguiGateInput {
  return {
    toolName: 'calendar_delete_event',
    execOk: true,
    screen: null,
    posture: 'trusted-afk',
    policy: null,
    hasWindow: false,
    ...over
  }
}

beforeEach(() => {
  __clearExternalActionRegistry()
  registerExternalActionTier('calendar_create_event', 'write-reversible')
  registerExternalActionTier('calendar_delete_event', 'irreversible')
  registerExternalActionTier('calendar_list_events', 'read')
})

describe('aguiTier maps registered external actions onto gated tiers', () => {
  it('irreversible → external-irreversible, write → external-write, read → none', () => {
    expect(aguiTier('calendar_delete_event')).toBe('external-irreversible')
    expect(aguiTier('calendar_create_event')).toBe('external-write')
    expect(aguiTier('calendar_list_events')).toBe('none')
  })
  it('tierRisks carries destructive for irreversible, network for write', () => {
    expect(tierRisks('external-irreversible')).toEqual(['destructive'])
    expect(tierRisks('external-write')).toEqual(['network'])
  })
})

describe('decideAguiGate — registered external actions are gated by exec-token', () => {
  it('DENIES an irreversible external action on a de-privileged inbound turn (execOk:false)', () => {
    const v = decideAguiGate(base({ toolName: 'calendar_delete_event', execOk: false }))
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('exec-token')
    expect(v.tier).toBe('external-irreversible')
  })
  it('DENIES a write-reversible external action on a de-privileged inbound turn', () => {
    const v = decideAguiGate(base({ toolName: 'calendar_create_event', execOk: false }))
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('exec-token')
    expect(v.tier).toBe('external-write')
  })
  it('does NOT gate a registered READ external action (ungated, passes through)', () => {
    const v = decideAguiGate(base({ toolName: 'calendar_list_events', execOk: false }))
    expect(v.kind).toBe('allow')
    expect(v.kind === 'allow' && v.source).toBe('ungated')
  })
  it('a persisted DENY policy blocks a registered external action even when privileged', () => {
    const v = decideAguiGate(base({ toolName: 'calendar_delete_event', execOk: true, policy: 'deny' }))
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('policy')
  })
  it('a privileged trusted-afk turn passes the exec-token gate (handler then owns approval)', () => {
    const v = decideAguiGate(base({ toolName: 'calendar_delete_event', execOk: true }))
    expect(v.kind).toBe('allow')
    expect(v.kind === 'allow' && v.source).toBe('posture:trusted-afk')
  })
})
