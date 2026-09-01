// Backlog findings 26 + 27, both on the AFK channel-approval path in agui-gate.ts.
//
// 27: the gate skipped channel approval for BOTH external tiers on the premise that a
//     registered ACT action runs its own operator-approval step. That premise holds for
//     exactly one tier — action-tier.ts's `requiresApproval` is `tier === 'irreversible'`
//     and a write-reversible action is explicitly soft-gated. So an `external-write` tool
//     while AFK got no notification anywhere: not this gate (excluded), not a modal (no
//     window), not the ACT substrate (auto-allows).
// 26: the two dispatch sites passed channelDispatch raw, so an ask could be "sent" over a
//     configured-but-disabled channel with nothing listening.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-agui-gate-xw-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.mock('../workspace-state', () => ({ getActiveWorkspace: () => '/ws' }))
vi.mock('../permission-policies-store', () => ({ resolveDecision: () => null }))

const H = vi.hoisted(() => ({
  tier: 'external-write',
  asks: [] as Array<{ tool: string }>,
  dispatchesSeen: [] as unknown[],
  rawDispatch: async () => ({ ok: true, kind: 'feishu' })
}))

vi.mock('./agui-approval', () => ({
  decideAguiGate: () => ({ kind: 'allow', tier: H.tier, source: 'posture:trusted-afk' }),
  aguiTier: () => H.tier,
  tierRisks: () => [],
  isMcpToolName: () => false
}))

// Every registered ACT effector counts as gated, so the call reaches the approval block.
vi.mock('../act/action-tier', () => ({ isRegisteredExternalActionGated: () => true }))

vi.mock('../proactive/approval-roundtrip', () => ({
  readApprovalConfig: () => ({
    enabled: true,
    operator: 'rg',
    homeChannel: { kind: 'feishu', target: 'x' },
    timeoutMs: 1000
  }),
  shouldRouteToChannelApproval: () => true,
  requestOperatorApproval: async (req: { tool: string }, opts: { dispatch: unknown }) => {
    H.asks.push({ tool: req.tool })
    H.dispatchesSeen.push(opts.dispatch)
    return { decision: 'approve', source: 'operator-approve' }
  }
}))

// Identity-tagged so the test can prove the gate wrapped it rather than passing it raw.
vi.mock('../channel-dispatch', () => ({ channelDispatch: H.rawDispatch }))

import { resolveAguiGate } from './agui-gate'

const call = (name: string) => ({ id: 'x', function: { name, arguments: '{}' } })
const ctx = {
  execOk: true,
  posture: 'trusted-afk',
  conversationId: 'c1',
  workspacePath: '/vault'
} as never

beforeEach(() => {
  H.asks.length = 0
  H.dispatchesSeen.length = 0
})

describe('agui-gate — AFK approval for external-write actions', () => {
  it('routes an external-write tool to the operator instead of silently auto-allowing', async () => {
    H.tier = 'external-write'
    const out = await resolveAguiGate(call('drive_upload_file'), ctx)
    expect(H.asks.map((a) => a.tool)).toEqual(['drive_upload_file'])
    expect(out.allow).toBe(true)
  })

  it('still leaves external-irreversible to the ACT substrate, so it is not double-prompted', async () => {
    H.tier = 'external-irreversible'
    await resolveAguiGate(call('send_email'), ctx)
    expect(H.asks).toEqual([])
  })

  it('passes an enablement-gated dispatch, not the raw one', async () => {
    H.tier = 'external-write'
    await resolveAguiGate(call('drive_upload_file'), ctx)
    expect(H.dispatchesSeen).toHaveLength(1)
    expect(H.dispatchesSeen[0]).not.toBe(H.rawDispatch)
  })
})
