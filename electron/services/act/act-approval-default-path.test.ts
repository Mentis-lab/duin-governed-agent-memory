// act-approval-default-path.test.ts — the DEFAULT (production) approval path, driven
// end-to-end with only the channel REGISTRY faked.
//
// WHY THIS FILE EXISTS, given external-action-enablement.test.ts already exists.
// That suite proves the two enablement PRIMITIVES behave (channelEnablementVerdict,
// gateDispatchOnChannelEnabled), but every one of its cases calls them with an
// injected dispatch stub and injected deps. Nothing anywhere asserts that the
// production path actually COMPOSES them. `defaultRequestApproval` (external-action.ts)
// is what `runExternalAction` reaches when a caller does not inject `requestApproval`
// — i.e. every real ACT connector — and it is the single line
//
//     dispatch: gateDispatchOnChannelEnabled(channelDispatch)
//
// that puts the gate on that path. Delete the wrapper there, leaving plain
// `channelDispatch`, and the ENTIRE suite still passes: the primitives are still
// correct, they are just no longer called. That is precisely the shape of regression
// this lane exists for — a safety mechanism removed with every test green.
//
// So these tests refuse to inject anything the production path would supply itself:
//   * approval router  — NOT injected, so `defaultRequestApproval` runs.
//   * approval config  — real `readApprovalConfig` over a real settings.json.
//   * enablement       — real `isChannelEnabled` over a real channels store.
//   * dispatch         — the real `channelDispatch`, not a stub.
// The ONLY seam is `../channels/index`, the credential/network boundary. The fake
// adapter reports isConfigured():true, because "configured but not enabled" is
// exactly the state in which the defect bites: credentials exist, so outbound would
// happily deliver, while the gateway never started a receive loop to hear the answer.
//
// (`audit` IS injected — it is an assertion sink here, and the real one writes to the
// event-spine DB, which is not this test's subject.)

import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock factories are hoisted above the imports and run before any module-scope
// const initialises, so everything they touch must be created inside vi.hoisted() or
// the factory hits it in the TDZ.
const { USER_DATA, send, fakeTelegram } = vi.hoisted(() => {
  // OS temp, not a repo-relative dir: this suite really does persist (channels.json,
  // interactions, settings.json), and a repo-relative path would leave untracked dirs
  // in the working tree. `pid` keeps parallel vitest workers off each other's state.
  const base = process.env.RUNNER_TEMP || process.env.TEMP || process.env.TMPDIR || '.'
  const send = vi.fn(async (_to: string, _text: string): Promise<void> => {})
  return {
    USER_DATA: `${base.replace(/\\/g, '/')}/duin-act-approval-default-${process.pid}`,
    send,
    fakeTelegram: {
      id: 'telegram',
      label: 'Telegram',
      // CONFIGURED. This is what makes a disabled channel dangerous rather than
      // merely inert: channelDispatch's only check is isConfigured(), so outbound
      // delivery is live the moment a credential exists.
      isConfigured: (): boolean => true,
      send,
      start: async (): Promise<void> => {},
      stop: async (): Promise<void> => {}
    }
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA, isReady: () => true },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.mock('../channels/index', () => ({
  getChannel: (id: string) => (id === 'telegram' ? fakeTelegram : undefined),
  listChannels: () => [fakeTelegram],
  makeChannelRegistry: (adapters: { id: string }[]) => ({
    list: () => adapters,
    get: (id: string) => adapters.find((a) => a.id === id)
  })
}))

import {
  runExternalAction,
  channelEnablementVerdict,
  gateDispatchOnChannelEnabled,
  type ActAuditEvent,
  type ExternalActionSpec
} from './external-action'
import { channelDispatch } from '../channel-dispatch'
import { setChannelsPath, setChannelEnabled } from '../channels/channels-store'
import { patchSettings } from '../settings-helper'
import { setPendingInteractionsPath, listOpen } from '../proactive/pending-interactions'
import { settleApproval, __resetApprovalWaiters } from '../proactive/approval-roundtrip'

/** Long enough that a fail-OPEN regression is unmistakable: without the gate the
 *  disabled case waits out this whole window before denying on timeout, which is the
 *  stall the gate removes. Short enough not to slow the suite when it passes. */
const APPROVAL_TIMEOUT_MS = 4_000

function irreversibleSpec(handler: ExternalActionSpec['handler']): ExternalActionSpec {
  return {
    id: 'calendar_delete_event',
    description: 'Delete a calendar event',
    tier: 'irreversible',
    handler
  }
}

beforeEach(() => {
  setChannelsPath(USER_DATA)
  setPendingInteractionsPath(USER_DATA)
  patchSettings({
    operator: { channelId: 'telegram', userId: 'op-1' },
    homeChannel: { kind: 'telegram', target: 'op-1' },
    approvalTimeoutMs: APPROVAL_TIMEOUT_MS
  })
  __resetApprovalWaiters()
  send.mockClear()
})

describe('the default ACT approval path consults channel enablement', () => {
  it('a CONFIGURED but DISABLED home channel: no send, immediate deny, action never runs', async () => {
    expect(setChannelEnabled('telegram', false)).toBe(true)

    const handler = vi.fn(async () => 'deleted')
    const audits: string[] = []
    const started = Date.now()

    const r = await runExternalAction(irreversibleSpec(handler), {}, {
      execOk: true,
      audit: (e: ActAuditEvent) => audits.push(`${e.phase}:${e.source ?? ''}`)
    })

    // 1. THE ASK IS UNDELIVERABLE. Not "sent and unanswered" — never sent at all, so
    //    the operator is never shown a prompt they cannot answer.
    expect(send).not.toHaveBeenCalled()
    // 2. FAIL-CLOSED. The irreversible action does not happen.
    expect(r.ok).toBe(false)
    expect(r.denied).toBe(true)
    expect(handler).not.toHaveBeenCalled()
    // 3. Refused by the DISPATCH, which is what proves the gate ran on this path
    //    rather than the approval merely timing out.
    expect(r.source).toBe('dispatch-failed')
    expect(audits).toContain('denied:dispatch-failed')
    // 4. NO STALL. Without the gate this resolves only after the full timeout.
    expect(Date.now() - started).toBeLessThan(APPROVAL_TIMEOUT_MS / 2)
  })

  it('an ENABLED home channel: the adapter send IS invoked and the roundtrip completes', async () => {
    expect(setChannelEnabled('telegram', true)).toBe(true)

    const handler = vi.fn(async () => 'deleted')
    const audits: string[] = []

    const pending = runExternalAction(irreversibleSpec(handler), {}, {
      execOk: true,
      audit: (e: ActAuditEvent) => audits.push(`${e.phase}:${e.source ?? ''}`)
    })

    // The gate lets it through and the REAL channelDispatch reaches the adapter.
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send).toHaveBeenCalledWith('op-1', expect.stringContaining('Approval needed'))

    // The operator answers — the window the ask opened is real and settleable.
    const open = listOpen({ channelId: 'telegram', userId: 'op-1' })
    expect(open).toHaveLength(1)
    const actionId = String((open[0].payload as Record<string, unknown>).actionId)
    expect(settleApproval(actionId, 'approve', 'operator')).toBe(true)

    const r = await pending
    expect(r.ok).toBe(true)
    expect(r.source).toBe('operator-approve')
    expect(handler).toHaveBeenCalledTimes(1)
    expect(audits).toContain('executed:operator-approve')
  })

  it('enablement is judged per channel: enabling a DIFFERENT channel does not open this one', async () => {
    // Guards against a gate that degrades to "is ANY channel enabled" — the kind of
    // near-miss that keeps every existing primitive test green.
    setChannelEnabled('telegram', false)

    const handler = vi.fn(async () => 'deleted')
    const r = await runExternalAction(irreversibleSpec(handler), {}, { execOk: true, audit: () => {} })

    expect(send).not.toHaveBeenCalled()
    expect(r.source).toBe('dispatch-failed')
  })
})

// The block above proves the gate is REACHED on the production path. This one pins the
// gate's own contract against the REAL channelDispatch and — the part nothing else
// covers — against its REAL default deps.
//
// Every case in external-action-enablement.test.ts passes `deps({hasAdapter, isEnabled})`
// explicitly, so the `deps.hasAdapter ?? …` / `deps.isEnabled ?? …` fallbacks are never
// executed by any test. Those fallbacks were the two bare requires that could not
// resolve in a bundle: had they stayed, every registry channel would have failed CLOSED
// on its own lookup and the gate could never have said yes — "one toggle governs both
// directions" degraded to "always off". A gate that cannot be opened fails no test that
// only ever checks it can be shut.
describe('gateDispatchOnChannelEnabled over the real channelDispatch, with real defaults', () => {
  it('DISABLED → ok:false / "channel not enabled", and the adapter is never touched', async () => {
    setChannelEnabled('telegram', false)
    const gated = gateDispatchOnChannelEnabled(channelDispatch)

    expect(await gated({ kind: 'telegram', target: 'op-1' }, 'Approval needed: …')).toEqual({
      ok: false,
      kind: 'telegram',
      error: 'channel not enabled'
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('ENABLED → ok:true and the adapter send IS invoked', async () => {
    setChannelEnabled('telegram', true)
    const gated = gateDispatchOnChannelEnabled(channelDispatch)

    expect(await gated({ kind: 'telegram', target: 'op-1' }, 'Approval needed: …')).toEqual({
      ok: true,
      kind: 'telegram'
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('op-1', 'Approval needed: …')
  })

  it('the default deps resolve for real — no injected deps, both answers reachable', () => {
    // Directly pins the fallbacks. Before the fix both threw, so channelEnablementVerdict
    // took its fail-closed catch and returned 'channel not enabled' for BOTH of these.
    setChannelEnabled('telegram', true)
    expect(channelEnablementVerdict('telegram')).toEqual({ ok: true })

    setChannelEnabled('telegram', false)
    expect(channelEnablementVerdict('telegram')).toEqual({ ok: false, error: 'channel not enabled' })

    // Still correctly ungated for the surfaces that carry no adapter and no toggle —
    // OS push and email must stay reachable or an approval loses its fallback surface.
    expect(channelEnablementVerdict('push')).toEqual({ ok: true })
    expect(channelEnablementVerdict('email')).toEqual({ ok: true })
  })
})
