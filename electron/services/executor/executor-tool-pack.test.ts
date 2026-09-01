import { describe, it, expect } from 'vitest'
import { toolRegistry } from '../tool-registry'
import { AGUI_GATED_TOOLS } from '../local-brain/agui-guard'
import { aguiTier, decideAguiGate, isReviewAutoAllowTier } from '../local-brain/agui-approval'
import { capFloorForDescriptor } from '../governance/action-class'
import { DSH_SUBAGENT_TYPE } from './executor-tool-pack'

// delegate_task is the door; these pin that it is locked the way the plan says (Q1,
// attended-first): gated, spawn-recursive, prompted under review, refused unattended and under
// trusted-afk, and floored by its own descriptor for every background surface.

describe('delegate_task — registration and gating', () => {
  const d = toolRegistry.getById('delegate_task')

  it('is registered as a native tool that requires approval and declares shell-class risk', () => {
    expect(d).toBeTruthy()
    expect(d?.requiresApproval).toBe(true)
    expect(d?.risks).toContain('sandboxBypass')
    expect(d?.mutates).toBe(true)
    expect(d?.parallelizable).toBe(false)
  })

  it('sits in the AGUI gated set on the spawn-recursive tier, which review does NOT auto-allow', () => {
    expect(AGUI_GATED_TOOLS.has('delegate_task')).toBe(true)
    expect(aguiTier('delegate_task')).toBe('spawn-recursive')
    expect(isReviewAutoAllowTier('spawn-recursive')).toBe(false)
  })

  it('under review it prompts; under trusted-afk it is denied when not sandboxed', () => {
    const base = { toolName: 'delegate_task', execOk: true, screen: { ok: true as const }, policy: null, hasWindow: true }
    expect(decideAguiGate({ ...base, posture: 'review' }).kind).toBe('prompt')
    expect(decideAguiGate({ ...base, posture: 'interactive' }).kind).toBe('prompt')
    // a de-privileged turn (inbound channel) never gets it
    expect(decideAguiGate({ ...base, execOk: false, posture: 'trusted-afk' }).kind).toBe('deny')
  })

  it('the unattended CAP floor refuses it outright (background loops, automations)', () => {
    const floored = capFloorForDescriptor({ name: 'delegate_task', risks: ['sandboxBypass'], requiresApproval: true, mutates: true }, { task: 'anything' })
    expect(floored).not.toBeNull()
  })

  it('the dsh subagent type grants exactly the capabilities the gate can map', () => {
    expect(DSH_SUBAGENT_TYPE.allowedTools).toEqual(['read_file', 'write_file', 'edit_file', 'run_command', 'update_plan'])
  })
})
