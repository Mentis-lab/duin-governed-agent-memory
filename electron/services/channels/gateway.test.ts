import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChannelAdapter, ChannelContext, InboundMessage } from './channel-adapter'

// Keep the turn engine fast + off Electron (mirrors channel-runtime.test).
vi.mock('../providers/registry', () => ({ readStreamInactivityMs: () => 0 }))
vi.mock('../local-brain/server', () => ({
  getBrainExecToken: () => 'RENDERER-ONLY-TOKEN',
  getBrainControlToken: () => 'CONTROL-TOKEN'
}))

// The gateway reads enabled-state from channels-store and the adapter list from
// ./index — mock both so we can drive fake adapters with no live creds.
const enabled: Record<string, boolean> = {}
vi.mock('./channels-store', () => ({
  isChannelEnabled: (id: string) => !!enabled[id],
  recordChannelStarted: vi.fn(),
  recordChannelError: vi.fn()
}))

let registry: ChannelAdapter[] = []
vi.mock('./index', () => ({ listChannels: () => registry }))

import { startGateway, stopGateway } from './gateway'

// A controllable fake channel. `configured` + `auth` drive the gate; `emit`
// lets a test push an inbound message through the ctx the gateway wired.
function fakeChannel(
  id: string,
  opts: { configured?: boolean; auth?: 'approved' | 'pending' | 'denied' } = {}
): ChannelAdapter & { ctx: ChannelContext | null; started: boolean; sent: [string, string][] } {
  const self = {
    id,
    label: id,
    ctx: null as ChannelContext | null,
    started: false,
    sent: [] as [string, string][],
    isConfigured: () => opts.configured ?? true,
    start: async (c: ChannelContext) => {
      self.started = true
      self.ctx = c
    },
    stop: async () => {
      self.started = false
    },
    send: async (to: string, text: string) => {
      self.sent.push([to, text])
    },
    authorizeUser: async () => opts.auth ?? 'pending'
  }
  return self
}

const SSE = [
  'data: {"type":"RUN_STARTED"}',
  'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"reply"}',
  'data: {"type":"RUN_FINISHED"}',
  ''
].join('\n')

const origFetch = global.fetch
function mockBrain(): ReturnType<typeof vi.fn> {
  const f = vi.fn(async () =>
    new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  )
  global.fetch = f as unknown as typeof fetch
  return f
}

beforeEach(() => {
  for (const k of Object.keys(enabled)) delete enabled[k]
  registry = []
})
afterEach(async () => {
  await stopGateway()
  global.fetch = origFetch
  vi.restoreAllMocks()
})

const msg = (userId: string): InboundMessage => ({
  channelId: 'x',
  userId,
  threadId: 'th',
  text: 'hi'
})

describe('startGateway — only enabled + configured channels start', () => {
  it('starts an enabled+configured channel, skips disabled and unconfigured ones', async () => {
    const on = fakeChannel('on', { configured: true })
    const off = fakeChannel('off', { configured: true })
    const unconfigured = fakeChannel('unconf', { configured: false })
    registry = [on, off, unconfigured]
    enabled['on'] = true
    enabled['off'] = false
    enabled['unconf'] = true // enabled but not configured

    await startGateway()

    expect(on.started).toBe(true)
    expect(off.started).toBe(false)
    expect(unconfigured.started).toBe(false)
  })

  it('is idempotent — a second start does not re-start channels', async () => {
    const ch = fakeChannel('on')
    const spy = vi.spyOn(ch, 'start')
    registry = [ch]
    enabled['on'] = true
    await startGateway()
    await startGateway()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('authorize-before-turn gate (the security property)', () => {
  it('an UNPAIRED sender is refused BEFORE any brain turn — no fetch, no reply', async () => {
    const brain = mockBrain()
    const ch = fakeChannel('on', { auth: 'pending' })
    registry = [ch]
    enabled['on'] = true
    await startGateway()

    // The gateway wired ctx.onMessage → handleInbound; deliver an unpaired msg.
    await ch.ctx?.onMessage(msg('stranger'))

    expect(brain).not.toHaveBeenCalled() // brain never contacted
    expect(ch.sent).toEqual([]) // no reply delivered
  })

  it('an APPROVED sender runs a de-privileged turn and gets a reply', async () => {
    const brain = mockBrain()
    const ch = fakeChannel('on', { auth: 'approved' })
    registry = [ch]
    enabled['on'] = true
    await startGateway()

    await ch.ctx?.onMessage(msg('friend'))

    expect(brain).toHaveBeenCalledTimes(1)
    // KEYSTONE: the turn carried NO exec authority (empty x-duin-exec header)
    // even though a renderer token exists in-process.
    const init = brain.mock.calls[0][1] as { headers: Record<string, string> }
    expect(init.headers['x-duin-exec']).toBe('')
    expect(ch.sent).toEqual([['friend', 'reply']])
  })
})
