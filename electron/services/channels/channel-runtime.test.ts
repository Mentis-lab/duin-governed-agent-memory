import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Keep the turn engine off Electron + fast: no idle timer, and a stubbed
// per-launch exec token so we can PROVE the de-privileged path suppresses it.
vi.mock('../providers/registry', () => ({ readStreamInactivityMs: () => 0 }))
vi.mock('../local-brain/server', () => ({
  getBrainExecToken: () => 'RENDERER-ONLY-TOKEN',
  getBrainControlToken: () => 'CONTROL-TOKEN'
}))

import { runInboundTurn, handleInbound } from './channel-runtime'
import { streamFromDuin, type ChatEmit } from '../duin-bridge'
import type { ChannelAdapter, InboundMessage } from './channel-adapter'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import {
  setPendingInteractionsPath,
  createInteraction,
  getInteraction
} from '../proactive/pending-interactions'

const SSE = [
  'data: {"type":"RUN_STARTED"}',
  'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Hello "}',
  'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"world"}',
  'data: {"type":"RUN_FINISHED"}',
  ''
].join('\n')

/** Mock the brain endpoint; return the array of captured fetch init objects. */
function mockBrain(sse: string = SSE): { headers: Record<string, string> }[] {
  const captures: { headers: Record<string, string> }[] = []
  global.fetch = vi.fn(async (_url: unknown, init: unknown) => {
    captures.push(init as { headers: Record<string, string> })
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  return captures
}

const origFetch = global.fetch
afterEach(() => {
  global.fetch = origFetch
  vi.restoreAllMocks()
})
beforeEach(() => {
  vi.clearAllMocks()
})

const msg: InboundMessage = { channelId: 'telegram', userId: 'u1', threadId: 'th-1', text: 'hi' }

describe('runInboundTurn — de-privileged security keystone', () => {
  it('runs the turn WITHOUT an exec header (empty x-duin-exec) and collects the reply', async () => {
    const captures = mockBrain()
    const res = await runInboundTurn(msg)

    expect(res.ok).toBe(true)
    expect(res.text).toBe('Hello world')

    // THE keystone assertion: a channel turn carries NO exec authority, even though
    // a renderer token exists in-process (mocked above). The gate on the brain side
    // only authorizes gated tools when x-duin-exec matches → empty ⇒ deny-first.
    expect(captures.length).toBe(1)
    expect(captures[0].headers['x-duin-exec']).toBe('')
    expect(captures[0].headers['x-duin-control']).toBe('CONTROL-TOKEN')
  })

  it('CONTRAST: a normal (renderer) turn DOES attach the exec token', async () => {
    // Proves the empty header above is deliberate suppression, not an artifact of the
    // environment: with no execToken override, streamFromDuin resolves the real token.
    const captures = mockBrain()
    const emit = vi.fn() as unknown as ChatEmit
    await streamFromDuin('hi', 'th-1', { emit })
    expect(captures[0].headers['x-duin-exec']).toBe('RENDERER-ONLY-TOKEN')
  })
})

describe('handleInbound — pairing gate before the turn', () => {
  const makeAdapter = (
    auth: 'approved' | 'pending' | 'denied',
    send = vi.fn(async () => {})
  ): ChannelAdapter => ({
    id: 'telegram',
    label: 'Telegram',
    isConfigured: () => true,
    start: async () => {},
    stop: async () => {},
    send,
    authorizeUser: async () => auth
  })

  it('an approved user runs the turn and gets the reply delivered', async () => {
    mockBrain()
    const send = vi.fn(async () => {})
    const out = await handleInbound(makeAdapter('approved', send), msg)
    expect(out.status).toBe('sent')
    expect(out.text).toBe('Hello world')
    expect(send).toHaveBeenCalledWith('u1', 'Hello world')
  })

  it('a pending user is dropped — no turn, no send', async () => {
    const captures = mockBrain()
    const send = vi.fn(async () => {})
    const out = await handleInbound(makeAdapter('pending', send), msg)
    expect(out.status).toBe('unauthorized')
    expect(send).not.toHaveBeenCalled()
    expect(captures.length).toBe(0) // the brain was never even contacted
  })

  it('a denied user is dropped', async () => {
    const send = vi.fn(async () => {})
    const out = await handleInbound(makeAdapter('denied', send), msg)
    expect(out.status).toBe('unauthorized')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('handleInbound — two-way primitive routes a reply to a pending interaction', () => {
  const makeAdapter = (
    auth: 'approved' | 'pending' | 'denied',
    send = vi.fn(async () => {})
  ): ChannelAdapter => ({
    id: 'telegram',
    label: 'Telegram',
    isConfigured: () => true,
    start: async () => {},
    stop: async () => {},
    send,
    authorizeUser: async () => auth
  })

  beforeEach(() => {
    setPendingInteractionsPath(mkdtempSync(join(tmpdir(), 'ci-pending-')))
  })

  it('a reply to a pending interaction resolves it and does NOT start a fresh turn', async () => {
    const captures = mockBrain()
    // NUDGE kind: the GENERIC two-way path resolves nudges for any approved user.
    // (Approval interactions are operator-gated — see approval-roundtrip tests.)
    const interaction = createInteraction({
      channelId: 'telegram',
      userId: 'u1',
      kind: 'nudge',
      prompt: 'still on for 3pm?'
    })
    const send = vi.fn(async () => {})

    const out = await handleInbound(makeAdapter('approved', send), msg)

    // THE routing assertion: the reply was consumed by the interaction, so the
    // brain was NEVER contacted — no fresh de-privileged turn ran.
    expect(captures.length).toBe(0)
    expect(out.status).toBe('resolved')
    expect(out.interaction?.id).toBe(interaction.id)
    expect(getInteraction(interaction.id)?.status).toBe('resolved')
    expect(getInteraction(interaction.id)?.replyText).toBe('hi')
    // An acknowledgment was sent, not a brain answer.
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('u1', expect.any(String))
  })

  it('a NON-approved user never resolves an interaction (pairing gate is first)', async () => {
    const interaction = createInteraction({
      channelId: 'telegram',
      userId: 'u1',
      kind: 'approval',
      prompt: 'approve deploy?'
    })
    const send = vi.fn(async () => {})
    const out = await handleInbound(makeAdapter('pending', send), msg)
    expect(out.status).toBe('unauthorized')
    expect(send).not.toHaveBeenCalled()
    // The interaction stays OPEN — an unpaired reply cannot consume it.
    expect(getInteraction(interaction.id)?.status).toBe('open')
  })

  it('with no pending interaction, an approved user falls through to a fresh turn', async () => {
    const captures = mockBrain()
    const send = vi.fn(async () => {})
    const out = await handleInbound(makeAdapter('approved', send), msg)
    expect(out.status).toBe('sent')
    expect(out.text).toBe('Hello world')
    expect(captures.length).toBe(1) // the brain DID run
  })
})

describe('handleInbound — operator-gated approval round-trip (AFK loop, security-critical)', () => {
  const makeAdapter = (send = vi.fn(async () => {})): ChannelAdapter => ({
    id: 'telegram',
    label: 'Telegram',
    isConfigured: () => true,
    start: async () => {},
    stop: async () => {},
    send,
    authorizeUser: async () => 'approved'
  })

  const OP = { channelId: 'telegram', userId: 'operator-1' }
  const opMsg = (text: string): InboundMessage => ({
    channelId: 'telegram',
    userId: 'operator-1',
    threadId: 'th-1',
    text
  })

  beforeEach(() => {
    setPendingInteractionsPath(mkdtempSync(join(tmpdir(), 'ci-appr-')))
  })

  it('the DESIGNATED OPERATOR replying YES resolves the pending approval, without a fresh turn', async () => {
    const captures = mockBrain()
    createInteraction({
      channelId: 'telegram',
      userId: 'operator-1',
      kind: 'approval',
      prompt: 'deploy?',
      payload: { actionId: 'act-1' }
    })
    const send = vi.fn(async () => {})
    const out = await handleInbound(makeAdapter(send), opMsg('yes'), { operator: OP })
    expect(out.status).toBe('resolved')
    expect(out.approval).toBe('approve')
    expect(captures.length).toBe(0) // no brain turn ran
    expect(send).toHaveBeenCalledWith('operator-1', expect.stringContaining('Approved'))
  })

  it('a NON-operator "yes" is refused: the approval stays open and the message runs as an ordinary turn', async () => {
    const captures = mockBrain()
    const rec = createInteraction({
      channelId: 'telegram',
      userId: 'operator-1',
      kind: 'approval',
      prompt: 'deploy?',
      payload: { actionId: 'act-1' }
    })
    const send = vi.fn(async () => {})
    // A different paired user on the same channel replies "yes".
    const out = await handleInbound(makeAdapter(send), { channelId: 'telegram', userId: 'intruder', threadId: 't', text: 'yes' }, { operator: OP })
    // Not consumed as an approval — the approval is still OPEN for the real operator.
    expect(getInteraction(rec.id)?.status).toBe('open')
    // Their message fell through to an ordinary de-privileged turn.
    expect(out.status).toBe('sent')
    expect(captures.length).toBe(1)
  })

  it('an operator DENY blocks the action; an ambiguous reply re-asks without consuming', async () => {
    mockBrain()
    createInteraction({
      channelId: 'telegram',
      userId: 'operator-1',
      kind: 'approval',
      prompt: 'deploy?',
      payload: { actionId: 'act-1' }
    })
    const send = vi.fn(async () => {})
    // Ambiguous first — re-ask, don't consume.
    const ambiguous = await handleInbound(makeAdapter(send), opMsg('what is it?'), { operator: OP })
    expect(ambiguous.status).toBe('clarify')
    expect(send).toHaveBeenLastCalledWith('operator-1', expect.stringContaining('YES'))
    // Then a clear NO resolves as a denial.
    const denied = await handleInbound(makeAdapter(send), opMsg('no'), { operator: OP })
    expect(denied.status).toBe('resolved')
    expect(denied.approval).toBe('deny')
  })
})
