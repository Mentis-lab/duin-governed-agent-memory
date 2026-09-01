import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import {
  parseApprovalReply,
  isDesignatedOperator,
  shouldRouteToChannelApproval,
  awaitApproval,
  settleApproval,
  pendingApprovalCount,
  __resetApprovalWaiters,
  requestOperatorApproval,
  resolveApprovalReply,
  readApprovalConfig,
  type OperatorIdentity,
  type ApprovalAuditEvent
} from './approval-roundtrip'
import {
  setPairingPath,
  requestPairing,
  approvePairing,
  revokePairing
} from '../channels/pairing-store'
import {
  setPendingInteractionsPath,
  createInteraction,
  getInteraction,
  listInteractions
} from './pending-interactions'
import type { ChannelRef, DispatchResult } from '../channel-dispatch'
import { decideAguiGate } from '../local-brain/agui-approval'

const OP: OperatorIdentity = { channelId: 'telegram', userId: 'operator-1' }
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  setPendingInteractionsPath(mkdtempSync(join(tmpdir(), 'appr-')))
  __resetApprovalWaiters()
})
afterEach(() => {
  __resetApprovalWaiters()
  vi.restoreAllMocks()
})

// ──────────────────── pure helpers ────────────────────

describe('parseApprovalReply', () => {
  it('recognizes clear approvals (whole word + first word + emoji)', () => {
    for (const t of ['yes', 'YES', 'y', 'ok', 'approve', 'Approved.', 'go', 'yes please', '👍'])
      expect(parseApprovalReply(t)).toBe('approve')
  })
  it('recognizes clear denials', () => {
    for (const t of ['no', 'N', 'nope', 'deny', 'Reject', 'cancel', 'no thanks', '👎'])
      expect(parseApprovalReply(t)).toBe('deny')
  })
  it('returns null for ambiguous / empty / non-string input', () => {
    for (const t of ['', '   ', 'maybe', 'what does this do?', 'hold on', 'later'])
      expect(parseApprovalReply(t)).toBeNull()
    expect(parseApprovalReply(undefined)).toBeNull()
    expect(parseApprovalReply(42)).toBeNull()
  })
})

describe('isDesignatedOperator', () => {
  it('matches only the exact configured (channelId,userId)', () => {
    expect(isDesignatedOperator(OP, 'telegram', 'operator-1')).toBe(true)
    expect(isDesignatedOperator(OP, 'telegram', 'someone-else')).toBe(false)
    expect(isDesignatedOperator(OP, 'discord', 'operator-1')).toBe(false)
  })
  it('an unset / blank operator matches nobody', () => {
    expect(isDesignatedOperator(null, 'telegram', 'operator-1')).toBe(false)
    expect(isDesignatedOperator({ channelId: '', userId: '' }, 'telegram', 'operator-1')).toBe(false)
    expect(isDesignatedOperator({ channelId: 'telegram', userId: '' }, 'telegram', 'x')).toBe(false)
  })
})

describe('shouldRouteToChannelApproval', () => {
  const base = {
    enabled: true,
    posture: 'trusted-afk' as const,
    hasWindow: false,
    operator: OP,
    homeChannelKind: 'telegram'
  }
  it('routes only when enabled + afk + no window + operator + two-way channel', () => {
    expect(shouldRouteToChannelApproval(base)).toBe(true)
  })
  it('does NOT route when disabled (default OFF → live app unchanged)', () => {
    expect(shouldRouteToChannelApproval({ ...base, enabled: false })).toBe(false)
  })
  it('does NOT route with an interactive window, interactive posture, no operator, or a push-only channel', () => {
    expect(shouldRouteToChannelApproval({ ...base, hasWindow: true })).toBe(false)
    expect(shouldRouteToChannelApproval({ ...base, posture: 'interactive' })).toBe(false)
    expect(shouldRouteToChannelApproval({ ...base, operator: null })).toBe(false)
    expect(shouldRouteToChannelApproval({ ...base, homeChannelKind: 'push' })).toBe(false)
  })
})

// ──────────────────── waiter registry ────────────────────

describe('waiter registry', () => {
  it('settleApproval resolves the exact awaiting action', async () => {
    const p = awaitApproval('act-A', 10_000)
    expect(pendingApprovalCount()).toBe(1)
    expect(settleApproval('act-A', 'approve', 'operator-approve')).toBe(true)
    await expect(p).resolves.toEqual({ decision: 'approve', source: 'operator-approve', actionId: 'act-A' })
    expect(pendingApprovalCount()).toBe(0)
  })
  it('is replay-safe: a second settle finds no waiter', async () => {
    const p = awaitApproval('act-B', 10_000)
    expect(settleApproval('act-B', 'deny', 'operator-deny')).toBe(true)
    await p
    expect(settleApproval('act-B', 'approve', 'operator-approve')).toBe(false)
  })
  it('defaults to DENY on timeout', async () => {
    const p = awaitApproval('act-C', 15)
    await expect(p).resolves.toEqual({ decision: 'deny', source: 'timeout', actionId: 'act-C' })
  })
  it('settling one action never releases a different action', async () => {
    const pA = awaitApproval('act-A', 10_000)
    const pB = awaitApproval('act-B', 10_000)
    settleApproval('act-A', 'approve', 'operator-approve')
    await expect(pA).resolves.toMatchObject({ decision: 'approve' })
    expect(pendingApprovalCount()).toBe(1) // B still pending
    settleApproval('act-B', 'deny', 'operator-deny')
    await expect(pB).resolves.toMatchObject({ decision: 'deny' })
  })
})

// ──────────────────── requestOperatorApproval (producer) ────────────────────

const HOME: ChannelRef = { kind: 'telegram', target: 'operator-1' }
const okDispatch = async (_ref: ChannelRef, _text: string): Promise<DispatchResult> => ({
  ok: true,
  kind: 'telegram'
})

describe('readApprovalConfig — operator fallback to channel pairing', () => {
  // `settings.operator` defaults to blank and nothing in the product writes it, so
  // without this fallback every irreversible ACT action denies with 'no-operator'.
  // Under vitest electron's `app` is undefined, so readSettings() is {} — i.e. exactly
  // the shipped "operator never configured" state.
  // A DEFAULT install: no env set at all. That is the whole point — an earlier attempt
  // gated this on DUIN_CHANNEL_APPROVAL, which has no writer anywhere in the product, so
  // the operator was null on every real install and the fix was inert.
  const NO_ENV = {} as unknown as NodeJS.ProcessEnv

  beforeEach(() => {
    setPairingPath(mkdtempSync(join(tmpdir(), 'duin-pairing-')))
  })

  // pairing-store keeps `pairings` as MODULE state that only setPairingPath rewrites.
  // Without this, whatever the last test here leaves approved stays visible to every
  // later describe in this file — all of which now resolve an operator through the
  // fallback — so their operator would depend on test order.
  afterEach(() => {
    setPairingPath(mkdtempSync(join(tmpdir(), 'duin-pairing-clean-')))
  })

  it('promotes the sole approved pairing on the home channel', () => {
    requestPairing('push', 'u-1')
    approvePairing('push', 'u-1')
    expect(readApprovalConfig(NO_ENV).operator).toEqual({
      channelId: 'push',
      userId: 'u-1'
    })
  })

  it('stays unset when the only pairing is still pending', () => {
    requestPairing('push', 'u-1')
    expect(readApprovalConfig(NO_ENV).operator).toBeNull()
  })

  it('stays unset when two identities are approved (ambiguous, never guess)', () => {
    requestPairing('push', 'u-1')
    approvePairing('push', 'u-1')
    requestPairing('push', 'u-2')
    approvePairing('push', 'u-2')
    expect(readApprovalConfig(NO_ENV).operator).toBeNull()
  })

  it('ignores approved pairings on other channels', () => {
    requestPairing('feishu', 'u-1')
    approvePairing('feishu', 'u-1')
    expect(readApprovalConfig(NO_ENV).operator).toBeNull()
  })

  it('drops back to unset when the pairing is revoked', () => {
    requestPairing('push', 'u-1')
    approvePairing('push', 'u-1')
    revokePairing('push', 'u-1')
    expect(readApprovalConfig(NO_ENV).operator).toBeNull()
  })

  it('promotes on a DEFAULT install — no env var required', () => {
    // Regression guard. DUIN_CHANNEL_APPROVAL has no settings field, no IPC handler and
    // no UI, and external-action's defaultRequestApproval never reads cfg.enabled — so
    // requiring it here is not an opt-in, it is an off switch the user cannot reach.
    requestPairing('push', 'u-1')
    approvePairing('push', 'u-1')
    expect(readApprovalConfig(NO_ENV).operator).toEqual({ channelId: 'push', userId: 'u-1' })
    const withFlag = { DUIN_CHANNEL_APPROVAL: '1' } as unknown as NodeJS.ProcessEnv
    expect(readApprovalConfig(withFlag).operator).toEqual({ channelId: 'push', userId: 'u-1' })
  })
})

describe('requestOperatorApproval', () => {
  it('pushes to the home channel and resolves when the operator approves', async () => {
    const dispatch = vi.fn(okDispatch)
    const audits: ApprovalAuditEvent[] = []
    const p = requestOperatorApproval(
      { summary: 'deploy prod', tool: 'run_command', actionId: 'act-1' },
      { operator: OP, homeChannel: HOME, timeoutMs: 10_000, dispatch, audit: (e) => audits.push(e) }
    )
    await flush() // past createInteraction + dispatch, parked on the waiter
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0]).toEqual(HOME)
    expect(String(dispatch.mock.calls[0][1])).toContain('deploy prod')

    // Operator replies "yes" → resolver settles the waiter.
    const res = resolveApprovalReply(
      { channelId: 'telegram', userId: 'operator-1', text: 'yes' },
      { operator: OP, audit: (e) => audits.push(e) }
    )
    expect(res.status).toBe('decided')
    await expect(p).resolves.toEqual({ decision: 'approve', source: 'operator-approve', actionId: 'act-1' })
    expect(audits.map((a) => a.phase)).toEqual(expect.arrayContaining(['requested', 'approved']))
  })

  it('a NON-operator reply cannot approve; the request times out to DENY', async () => {
    const p = requestOperatorApproval(
      { summary: 'wipe cache', actionId: 'act-2' },
      { operator: OP, homeChannel: HOME, timeoutMs: 30, dispatch: okDispatch }
    )
    // No flush() here, deliberately. requestOperatorApproval registers the interaction
    // synchronously before its first await (see the "BEFORE dispatch" comment at its
    // createInteraction call), so the record already exists the moment it returns a promise.
    // Awaiting a real 0ms timer first only burned the 30ms TTL: under full-suite CPU
    // contention the window expired before the intruder replied, so listOpen found nothing
    // and this got status 'none' instead of 'refused' -- passing alone, failing in the suite.
    // Replying immediately is also the stronger test: it exercises the very race the
    // register-before-dispatch ordering exists to defeat.
    // A different paired user says "yes" — refused, interaction NOT consumed.
    const res = resolveApprovalReply(
      { channelId: 'telegram', userId: 'intruder', text: 'yes' },
      { operator: OP }
    )
    expect(res.status).toBe('refused')
    await expect(p).resolves.toMatchObject({ decision: 'deny', source: 'timeout' })
  })

  it('fail-closed: no operator configured → immediate DENY, no dispatch', async () => {
    const dispatch = vi.fn(okDispatch)
    const out = await requestOperatorApproval(
      { summary: 'x', actionId: 'act-3' },
      { operator: null, homeChannel: HOME, timeoutMs: 10_000, dispatch }
    )
    expect(out).toEqual({ decision: 'deny', source: 'no-operator', actionId: 'act-3' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('fail-closed: a failed push → DENY and the interaction is cancelled (no approvable window)', async () => {
    const failDispatch = async (): Promise<DispatchResult> => ({ ok: false, kind: 'telegram', error: 'offline' })
    const out = await requestOperatorApproval(
      { summary: 'y', actionId: 'act-4' },
      { operator: OP, homeChannel: HOME, timeoutMs: 10_000, dispatch: failDispatch }
    )
    expect(out).toMatchObject({ decision: 'deny', source: 'dispatch-failed' })
    // The pending interaction was cancelled → a late operator reply cannot approve it.
    const rec = listInteractions().find((r) => (r.payload as { actionId?: string }).actionId === 'act-4')
    expect(rec?.status).toBe('expired')
  })

  it('defaults to DENY on operator silence (timeout)', async () => {
    const out = await requestOperatorApproval(
      { summary: 'z', actionId: 'act-5' },
      { operator: OP, homeChannel: HOME, timeoutMs: 20, dispatch: okDispatch }
    )
    expect(out).toMatchObject({ decision: 'deny', source: 'timeout' })
  })
})

// ──────────────────── resolveApprovalReply (consumer) ────────────────────

describe('resolveApprovalReply — operator-gated resolution', () => {
  it('no open approval → status none', () => {
    expect(resolveApprovalReply({ channelId: 'telegram', userId: 'operator-1', text: 'yes' }, { operator: OP })).toEqual({
      status: 'none'
    })
  })

  it('operator YES resolves the specific action, single-use', () => {
    const rec = createInteraction({
      channelId: 'telegram',
      userId: 'operator-1',
      kind: 'approval',
      prompt: 'p',
      payload: { actionId: 'act-1' }
    })
    const waiter = awaitApproval('act-1', 10_000)
    const res = resolveApprovalReply({ channelId: 'telegram', userId: 'operator-1', text: 'approve' }, { operator: OP })
    expect(res.status).toBe('decided')
    expect(getInteraction(rec.id)?.status).toBe('resolved')
    // single-use: a second operator reply finds nothing pending
    expect(resolveApprovalReply({ channelId: 'telegram', userId: 'operator-1', text: 'yes' }, { operator: OP })).toEqual({
      status: 'none'
    })
    return expect(waiter).resolves.toMatchObject({ decision: 'approve' })
  })

  it('a non-operator reply is REFUSED and does NOT consume the approval', () => {
    const rec = createInteraction({
      channelId: 'telegram',
      userId: 'operator-1',
      kind: 'approval',
      prompt: 'p',
      payload: { actionId: 'act-1' }
    })
    const res = resolveApprovalReply({ channelId: 'telegram', userId: 'intruder', text: 'yes' }, { operator: OP })
    expect(res.status).toBe('refused')
    // Still OPEN — the intruder could not burn the single-use interaction.
    expect(getInteraction(rec.id)?.status).toBe('open')
    // The real operator can still approve afterward.
    const waiter = awaitApproval('act-1', 10_000)
    expect(resolveApprovalReply({ channelId: 'telegram', userId: 'operator-1', text: 'yes' }, { operator: OP }).status).toBe(
      'decided'
    )
    settleApproval('act-1', 'deny', 'x') // no-op cleanup
    return expect(waiter).resolves.toBeDefined()
  })

  it('an ambiguous operator reply does NOT consume the approval (re-ask)', () => {
    const rec = createInteraction({
      channelId: 'telegram',
      userId: 'operator-1',
      kind: 'approval',
      prompt: 'p',
      payload: { actionId: 'act-1' }
    })
    const res = resolveApprovalReply({ channelId: 'telegram', userId: 'operator-1', text: 'what does it do?' }, { operator: OP })
    expect(res.status).toBe('ambiguous')
    expect(getInteraction(rec.id)?.status).toBe('open')
  })

  it('ACTION-ID BINDING: an operator reply approves only the OLDEST specific action, never a broader set', async () => {
    // Two pending approvals on the same channel.
    createInteraction({ channelId: 'telegram', userId: 'operator-1', kind: 'approval', prompt: 'A', payload: { actionId: 'act-A' }, now: 1 })
    createInteraction({ channelId: 'telegram', userId: 'operator-1', kind: 'approval', prompt: 'B', payload: { actionId: 'act-B' }, now: 2 })
    const wA = awaitApproval('act-A', 10_000)
    const wB = awaitApproval('act-B', 10_000)

    // One "yes" resolves ONLY act-A (the oldest); act-B stays pending. (now=100 is
    // within both interactions' default TTL created at now=1/2.)
    const res = resolveApprovalReply({ channelId: 'telegram', userId: 'operator-1', text: 'yes', now: 100 }, { operator: OP })
    expect(res.status).toBe('decided')
    expect((res as { interaction: { payload: { actionId?: string } } }).interaction.payload.actionId).toBe('act-A')
    await expect(wA).resolves.toMatchObject({ decision: 'approve', actionId: 'act-A' })
    expect(pendingApprovalCount()).toBe(1) // act-B still awaiting — one reply approved one action only
    settleApproval('act-B', 'deny', 'cleanup')
    await wB
  })

  it('expiry: a lapsed approval cannot be resolved by a late operator reply', () => {
    createInteraction({
      channelId: 'telegram',
      userId: 'operator-1',
      kind: 'approval',
      prompt: 'p',
      payload: { actionId: 'act-1' },
      now: 0,
      ttlMs: 100
    })
    // listOpen filters out the expired interaction → nothing to resolve.
    const res = resolveApprovalReply({ channelId: 'telegram', userId: 'operator-1', text: 'yes', now: 1_000 }, { operator: OP })
    expect(res.status).toBe('none')
  })
})

// ──────────────────── no privilege escalation (structural) ────────────────────

describe('no privilege escalation', () => {
  it('a de-privileged turn (execOk:false) is denied at the exec-token rule and never reaches the trusted-afk channel-approval branch', () => {
    // channel-runtime runs inbound turns with execToken:null → execOk:false. The pure
    // gate refuses gated tools BEFORE the trusted-afk allow that the channel loop hooks,
    // so a channel reply can never escalate an unprivileged turn to exec.
    const verdict = decideAguiGate({
      toolName: 'run_command',
      execOk: false,
      screen: { ok: true },
      posture: 'trusted-afk',
      policy: null,
      hasWindow: false
    })
    expect(verdict).toMatchObject({ kind: 'deny', source: 'exec-token' })
  })

  it('settling an approval only returns a decision — it invokes NO action executor', async () => {
    // The waiter resolves to a plain decision object; the module has no path that
    // runs the gated action. The ORIGINAL turn, not this reply, acts on the decision.
    const p = awaitApproval('act-1', 10_000)
    settleApproval('act-1', 'approve', 'operator-approve')
    const outcome = await p
    expect(outcome).toEqual({ decision: 'approve', source: 'operator-approve', actionId: 'act-1' })
    expect(Object.keys(outcome).sort()).toEqual(['actionId', 'decision', 'source'])
  })
})
