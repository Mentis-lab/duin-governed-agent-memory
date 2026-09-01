// external-action-enablement.test.ts — the ACT approval seam must not ask for
// approval over a channel the operator cannot reply on.
//
// THE ASYMMETRY: a channel is live for INBOUND only when it is BOTH configured and
// enabled — gateway.startGateway() skips any channel failing either test, so no
// receive loop exists for a disabled channel and handleInbound → resolveApprovalReply
// is never reached for it. OUTBOUND channelDispatch checks only `isConfigured()`.
//
// So with a configured-but-DISABLED home channel, DUIN delivers "Approval needed:
// … reply YES", the operator replies, and nothing is listening. The approval sits
// for the whole timeout and then denies. Fail-closed — but it asked into a void and
// stalled the turn for the full window.
//
// These tests pin the gate that makes that ask UNDELIVERABLE instead of merely
// unanswerable, and — just as importantly — pin what must NOT be gated: OS push and
// email carry no enablement toggle and must stay reachable, or an approval loses its
// fallback surface.

import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-external-action-enablement', isReady: () => true },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { channelEnablementVerdict, gateDispatchOnChannelEnabled } from './external-action'
import type { ChannelRef, DispatchResult } from '../channel-dispatch'

/** A dispatch stub with channelDispatch's real signature, so the gate wrapper is
 *  exercised against the shape it wraps in production. */
function dispatchStub(kind: string) {
  return vi.fn(async (_ref: ChannelRef, _text: string): Promise<DispatchResult> => ({ ok: true, kind }))
}

/** A stand-in for the real channel registry: telegram/discord/feishu are adapters. */
const ADAPTERS = new Set(['telegram', 'discord', 'feishu'])
const hasAdapter = (id: string): boolean => ADAPTERS.has(id)

function deps(enabled: string[]) {
  const on = new Set(enabled)
  return { hasAdapter, isEnabled: (id: string) => on.has(id) }
}

describe('channelEnablementVerdict — one toggle governs the approval ask', () => {
  it('REFUSES a registry channel that is configured but not enabled', () => {
    // "configured" is exactly why this is dangerous: channelDispatch would happily
    // deliver, because credentials exist. Enablement is the condition that decides
    // whether anything is listening for the answer.
    expect(channelEnablementVerdict('telegram', deps([]))).toEqual({
      ok: false,
      error: 'channel not enabled'
    })
  })

  it('ALLOWS a registry channel the operator has enabled', () => {
    expect(channelEnablementVerdict('telegram', deps(['telegram']))).toEqual({ ok: true })
  })

  it('judges each channel independently', () => {
    const d = deps(['discord'])
    expect(channelEnablementVerdict('discord', d).ok).toBe(true)
    expect(channelEnablementVerdict('telegram', d).ok).toBe(false)
    expect(channelEnablementVerdict('feishu', d).ok).toBe(false)
  })

  it('normalizes the kind the way channelDispatch does (trim + lowercase)', () => {
    expect(channelEnablementVerdict('  TELEGRAM ', deps(['telegram'])).ok).toBe(true)
    expect(channelEnablementVerdict('  TELEGRAM ', deps([])).ok).toBe(false)
  })

  it('does NOT gate OS push / email — they have no adapter and no enable toggle', () => {
    // Gating these would be a REGRESSION, not extra safety: they are the surfaces an
    // approval falls back to when no two-way channel is live.
    for (const kind of ['push', 'os', 'notification', 'notify', 'email', 'gmail', 'mail']) {
      expect(channelEnablementVerdict(kind, deps([])), `kind ${kind}`).toEqual({ ok: true })
    }
  })

  it('leaves an empty or unknown kind to channelDispatch to report', () => {
    expect(channelEnablementVerdict('', deps([]))).toEqual({ ok: true })
    expect(channelEnablementVerdict('carrier-pigeon', deps([]))).toEqual({ ok: true })
  })

  it('FAILS CLOSED when the enablement lookup throws', () => {
    // We could not establish that anyone can hear a reply, so we refuse to ask. Being
    // wrong here means an irreversible action does not happen — the safe direction.
    const verdict = channelEnablementVerdict('telegram', {
      hasAdapter,
      isEnabled: () => {
        throw new Error('channels store unavailable')
      }
    })
    expect(verdict).toEqual({ ok: false, error: 'channel not enabled' })
  })
})

describe('gateDispatchOnChannelEnabled — the send is never attempted when disabled', () => {
  it('returns ok:false / "channel not enabled" and does NOT invoke the dispatch', async () => {
    const inner = dispatchStub('telegram')
    const gated = gateDispatchOnChannelEnabled(inner, deps([]))

    const r = await gated({ kind: 'telegram', target: 'op' }, 'Approval needed: …')

    expect(r).toEqual({ ok: false, kind: 'telegram', error: 'channel not enabled' })
    // The load-bearing assertion: refusal happens BEFORE the send, so no message is
    // delivered that the operator could answer into a void.
    expect(inner).not.toHaveBeenCalled()
  })

  it('invokes the dispatch (adapter send) when the channel IS enabled', async () => {
    const inner = dispatchStub('telegram')
    const gated = gateDispatchOnChannelEnabled(inner, deps(['telegram']))

    const r = await gated({ kind: 'telegram', target: 'op' }, 'Approval needed: …')

    expect(r).toEqual({ ok: true, kind: 'telegram' })
    expect(inner).toHaveBeenCalledTimes(1)
    expect(inner).toHaveBeenCalledWith({ kind: 'telegram', target: 'op' }, 'Approval needed: …')
  })

  it('passes OS push straight through', async () => {
    const inner = dispatchStub('push')
    const gated = gateDispatchOnChannelEnabled(inner, deps([]))
    await gated({ kind: 'push', target: '' }, 'Approval needed: …')
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it('a refusal reaches requestOperatorApproval as a dispatch failure, which DENIES', async () => {
    // Not a new refusal route: requestOperatorApproval already treats !disp.ok as
    // fail-closed — it cancels the pending interaction so no approvable window is
    // left dangling, settles the waiter as a deny, and returns immediately instead of
    // burning the full timeout. This test pins the CONTRACT the gate relies on.
    const { requestOperatorApproval, __resetApprovalWaiters } = await import(
      '../proactive/approval-roundtrip'
    )
    __resetApprovalWaiters()

    const inner = dispatchStub('telegram')
    const audits: string[] = []
    const outcome = await requestOperatorApproval(
      { summary: 'delete the thing', tool: 'calendar_delete_event' },
      {
        operator: { channelId: 'telegram', userId: 'op-1' },
        homeChannel: { kind: 'telegram', target: 'op-1' },
        // A long timeout: if the gate did NOT short-circuit, this test would hang
        // rather than resolve, which is exactly the stall being removed.
        timeoutMs: 60_000,
        dispatch: gateDispatchOnChannelEnabled(inner, deps([])),
        audit: (e) => audits.push(`${e.phase}:${e.source ?? ''}`)
      }
    )

    expect(outcome.decision).toBe('deny')
    expect(outcome.source).toBe('dispatch-failed')
    expect(inner).not.toHaveBeenCalled()
    expect(audits).toContain('denied:dispatch-failed')
    // Never audited as 'requested' — the operator was never told to expect anything.
    expect(audits.some((a) => a.startsWith('requested'))).toBe(false)
  })
})
