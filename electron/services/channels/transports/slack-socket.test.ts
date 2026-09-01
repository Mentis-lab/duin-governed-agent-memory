// Slack transport tests. The SDK is MOCKED throughout — @slack/socket-mode and
// @slack/web-api are not dependencies of this app yet, and even installed they would
// need a live workspace. What is tested is everything that is a DECISION: the
// event→TransportMessage mapping, self-echo and subtype filtering, thread_ts handling,
// the connect/send contracts, and the directory walk.

import { describe, it, expect, vi } from 'vitest'

import {
  createSlackTransport,
  parseSlackMessage,
  toTarget,
  type SlackClients,
  type SlackConversation,
  type SlackEventArgs,
  type SlackMessageEvent
} from './slack-socket'

const SELF = 'UBOT'

const msg = (over: Partial<SlackMessageEvent> = {}): SlackMessageEvent => ({
  type: 'message',
  user: 'U123',
  channel: 'C999',
  text: 'hello',
  ts: '1712345678.000100',
  ...over
})

// ── the pure mapper ──────────────────────────────────────────────────────────

describe('parseSlackMessage — mapping', () => {
  it('maps a plain channel message, keeping STABLE ids and the message ts', () => {
    expect(parseSlackMessage(msg(), SELF)).toEqual({
      userId: 'U123',
      conversationId: 'C999',
      text: 'hello',
      messageId: '1712345678.000100',
      raw: msg()
    })
  })

  it('maps a DM the same way (D… channel id, no special-casing)', () => {
    const m = parseSlackMessage(msg({ channel: 'D42', channel_type: 'im' }), SELF)
    expect(m?.conversationId).toBe('D42')
    expect(m?.userId).toBe('U123')
  })

  it('accepts an Enterprise Grid W… sender id (userId is not prefix-checked)', () => {
    expect(parseSlackMessage(msg({ user: 'W777' }), SELF)?.userId).toBe('W777')
  })

  it('returns null when the routable fields are missing', () => {
    expect(parseSlackMessage(undefined, SELF)).toBeNull()
    expect(parseSlackMessage(msg({ user: undefined }), SELF)).toBeNull()
    expect(parseSlackMessage(msg({ channel: undefined }), SELF)).toBeNull()
    expect(parseSlackMessage(msg({ text: undefined }), SELF)).toBeNull()
    // A file-only upload: nothing to run a turn on.
    expect(parseSlackMessage(msg({ subtype: 'file_share', text: '   ' }), SELF)).toBeNull()
  })

  it('ignores a non-message event that reaches the mapper', () => {
    expect(parseSlackMessage(msg({ type: 'reaction_added' }), SELF)).toBeNull()
  })
})

describe('parseSlackMessage — self/bot filtering', () => {
  it('drops anything carrying bot_id (our own reply echoes back with one)', () => {
    expect(parseSlackMessage(msg({ bot_id: 'B123' }), SELF)).toBeNull()
  })

  it('drops a message from our own user id even with no bot_id', () => {
    expect(parseSlackMessage(msg({ user: SELF }), SELF)).toBeNull()
  })

  it('still routes other users when we do not know our own id', () => {
    expect(parseSlackMessage(msg(), null)?.userId).toBe('U123')
  })

  it('drops another app bot_message — a bot answering a bot is a loop', () => {
    expect(parseSlackMessage(msg({ subtype: 'bot_message', bot_id: 'B999' }), SELF)).toBeNull()
  })
})

describe('parseSlackMessage — subtype filtering', () => {
  it('drops message_changed and message_deleted (edits/tombstones are not new turns)', () => {
    expect(parseSlackMessage(msg({ subtype: 'message_changed' }), SELF)).toBeNull()
    expect(parseSlackMessage(msg({ subtype: 'message_deleted' }), SELF)).toBeNull()
  })

  it('drops channel noise that arrives with a real user and real text', () => {
    for (const subtype of ['channel_join', 'channel_leave', 'channel_purpose', 'message_replied']) {
      expect(parseSlackMessage(msg({ subtype, text: 'set the channel purpose: x' }), SELF)).toBeNull()
    }
  })

  it('routes the subtypes that are still a human talking', () => {
    for (const subtype of ['file_share', 'thread_broadcast', 'me_message']) {
      expect(parseSlackMessage(msg({ subtype }), SELF)?.text).toBe('hello')
    }
  })

  it('drops an UNKNOWN subtype (allowlist, not blocklist)', () => {
    expect(parseSlackMessage(msg({ subtype: 'some_future_subtype' }), SELF)).toBeNull()
  })
})

describe('parseSlackMessage — thread_ts', () => {
  it('carries thread_ts to threadId so the reply can land in-thread', () => {
    const m = parseSlackMessage(msg({ ts: '200.2', thread_ts: '100.1' }), SELF)
    expect(m?.threadId).toBe('100.1')
    expect(m?.messageId).toBe('200.2') // the reply's own id, NOT the root
  })

  it('omits threadId for a top-level message', () => {
    expect(parseSlackMessage(msg(), SELF)).not.toHaveProperty('threadId')
  })

  it('keeps thread_ts on a thread ROOT (ts === thread_ts), which is the id to reply to', () => {
    const m = parseSlackMessage(msg({ ts: '100.1', thread_ts: '100.1' }), SELF)
    expect(m?.threadId).toBe('100.1')
  })
})

// ── the pure directory mapper ────────────────────────────────────────────────

describe('toTarget', () => {
  const conv = (o: SlackConversation): SlackConversation => ({ id: 'C1', name: 'general', ...o })

  it('maps kinds: im → user, mpim → group, everything else → channel', () => {
    expect(toTarget(conv({ id: 'D1', is_im: true, name: undefined, user: 'U5' }))).toEqual({
      id: 'D1',
      name: 'U5', // no display name without users:read; the id is at least addressable
      kind: 'user'
    })
    expect(toTarget(conv({ is_mpim: true }))?.kind).toBe('group')
    expect(toTarget(conv({ is_member: true }))?.kind).toBe('channel')
  })

  it('excludes what cannot be delivered to', () => {
    expect(toTarget(conv({ is_member: false }))).toBeNull() // not_in_channel on send
    expect(toTarget(conv({ is_archived: true }))).toBeNull()
    expect(toTarget(conv({ is_im: true, is_user_deleted: true }))).toBeNull()
    expect(toTarget(conv({ id: undefined }))).toBeNull()
  })

  it('keeps im/mpim, which have no is_member', () => {
    expect(toTarget(conv({ id: 'D1', is_im: true, user: 'U5' }))).not.toBeNull()
    expect(toTarget(conv({ is_mpim: true }))).not.toBeNull()
  })
})

// ── transport wiring, SDK faked ──────────────────────────────────────────────

interface FakeSocket {
  on: (ev: string, fn: (a: SlackEventArgs) => void) => void
  once?: (ev: string, fn: (a?: unknown) => void) => void
  start: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  emit: (ev: string, args: SlackEventArgs) => void
}

function fakeSocket(over: Partial<FakeSocket> = {}): FakeSocket {
  const listeners = new Map<string, ((a: SlackEventArgs) => void)[]>()
  return {
    on: (ev, fn) => void listeners.set(ev, [...(listeners.get(ev) ?? []), fn]),
    start: vi.fn(async () => ({ ok: true })),
    disconnect: vi.fn(async () => undefined),
    emit: (ev, args) => (listeners.get(ev) ?? []).forEach((fn) => fn(args)),
    ...over
  }
}

function fakeWeb(over: Record<string, unknown> = {}) {
  return {
    auth: { test: vi.fn(async () => ({ ok: true, user_id: SELF })) },
    chat: { postMessage: vi.fn(async () => ({ ok: true, ts: '1.1' })) },
    conversations: { list: vi.fn(async () => ({ ok: true, channels: [] as SlackConversation[] })) },
    ...over
  }
}

function harness(socket = fakeSocket(), web = fakeWeb()) {
  const t = createSlackTransport(
    { appToken: 'xapp-test', botToken: 'xoxb-test' },
    {
      createClients: async () => ({ socket, web } as unknown as SlackClients),
      connectTimeoutMs: 50
    }
  )
  return { t, socket, web }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('createSlackTransport — identity + capabilities', () => {
  it('declares threads + directory, and NOT typing (Slack has no bot typing API)', () => {
    const { t } = harness()
    expect(t.id).toBe('slack')
    expect(t.capabilities()).toEqual(['threads', 'directory'])
    expect(t.setTyping).toBeUndefined()
    expect(typeof t.listTargets).toBe('function')
  })
})

describe('createSlackTransport — connect', () => {
  it('delivers a mapped message to the sink, and ACKS BEFORE routing', async () => {
    const { t, socket } = harness()
    const order: string[] = []
    const seen: string[] = []
    await t.connect(async (m) => {
      order.push('route')
      seen.push(`${m.userId}:${m.conversationId}:${m.text}`)
    })
    socket.emit('message', {
      ack: async () => void order.push('ack'),
      event: msg({ text: 'ping' })
    })
    await flush()
    expect(seen).toEqual(['U123:C999:ping'])
    // Slack retries an envelope unacked for 3s; acking after a (long) turn would fire it
    // again and again.
    expect(order).toEqual(['ack', 'route'])
  })

  it('reads the event from body.event when the SDK omits the top-level `event`', async () => {
    const { t, socket } = harness()
    const seen: string[] = []
    await t.connect(async (m) => void seen.push(m.text))
    socket.emit('message', { ack: async () => undefined, body: { event: msg({ text: 'nested' }) } })
    await flush()
    expect(seen).toEqual(['nested'])
  })

  it('filters our OWN echo using the id from auth.test', async () => {
    const { t, socket } = harness()
    const seen: string[] = []
    await t.connect(async (m) => void seen.push(m.text))
    socket.emit('message', { ack: async () => undefined, event: msg({ user: SELF, text: 'echo' }) })
    socket.emit('message', { ack: async () => undefined, event: msg({ bot_id: 'B1', text: 'bot' }) })
    socket.emit('message', { ack: async () => undefined, event: msg({ text: 'human' }) })
    await flush()
    expect(seen).toEqual(['human'])
  })

  it('a throwing sink does not take the socket down', async () => {
    const { t, socket } = harness()
    const seen: string[] = []
    await t.connect(async (m) => {
      if (m.text === 'boom') throw new Error('turn failed')
      seen.push(m.text)
    })
    socket.emit('message', { ack: async () => undefined, event: msg({ text: 'boom' }) })
    socket.emit('message', { ack: async () => undefined, event: msg({ text: 'after' }) })
    await flush()
    expect(seen).toEqual(['after'])
  })

  it('still acks (and drops) a message it will not route', async () => {
    const { t, socket } = harness()
    let acked = 0
    await t.connect(async () => undefined)
    socket.emit('message', {
      ack: async () => void (acked += 1),
      event: msg({ subtype: 'message_changed' })
    })
    await flush()
    expect(acked).toBe(1) // unacked ⇒ Slack redelivers the same edit forever
  })

  it('throws when the bot token is bad, BEFORE opening the socket', async () => {
    const web = fakeWeb({ auth: { test: vi.fn(async () => ({ ok: false, error: 'invalid_auth' })) } })
    const { t, socket } = harness(fakeSocket(), web)
    await expect(t.connect(async () => undefined)).rejects.toThrow(/invalid_auth/)
    expect(socket.start).not.toHaveBeenCalled()
  })

  it('subscribes BEFORE start(), so a backlog delivered at handshake is not missed', async () => {
    const calls: string[] = []
    const socket = fakeSocket({
      on: () => void calls.push('on'),
      start: vi.fn(async () => void calls.push('start'))
    })
    const { t } = harness(socket)
    await t.connect(async () => undefined)
    expect(calls).toEqual(['on', 'start'])
  })

  it('throws a MEANINGFUL error when start() rejects with undefined', async () => {
    // The SDK rejects start() with whatever emit('disconnected') carried — frequently
    // nothing at all, which would otherwise surface to the operator as "undefined".
    const socket = fakeSocket({ start: vi.fn(() => Promise.reject(undefined)) })
    const { t } = harness(socket)
    await expect(t.connect(async () => undefined)).rejects.toThrow(/socket mode did not start/)
    expect(socket.disconnect).toHaveBeenCalled()
  })

  it('times out instead of hanging, and releases the SDK reconnect loop', async () => {
    // The SDK retries a recoverable apps.connections.open failure forever, so start()
    // can never settle. Reporting a connected channel — or hanging — is the failure.
    const socket = fakeSocket({ start: vi.fn(() => new Promise<never>(() => {})) })
    const { t } = harness(socket)
    await expect(t.connect(async () => undefined)).rejects.toThrow(/timed out/)
    expect(socket.disconnect).toHaveBeenCalled()
  })

  it('is idempotent: a second connect does not open a second socket', async () => {
    const { t, socket } = harness()
    await t.connect(async () => undefined)
    await t.connect(async () => undefined)
    expect(socket.start).toHaveBeenCalledTimes(1)
  })

  it('two OVERLAPPING connects still open one socket (the body is async)', async () => {
    const { t, socket } = harness()
    await Promise.all([t.connect(async () => undefined), t.connect(async () => undefined)])
    expect(socket.start).toHaveBeenCalledTimes(1)
  })
})

describe('createSlackTransport — disconnect', () => {
  it('closes the socket and is safe to call when never connected', async () => {
    const { t, socket } = harness()
    await expect(t.disconnect()).resolves.toBeUndefined()
    expect(socket.disconnect).not.toHaveBeenCalled()
    await t.connect(async () => undefined)
    await t.disconnect()
    expect(socket.disconnect).toHaveBeenCalledTimes(1)
    await expect(t.disconnect()).resolves.toBeUndefined()
    expect(socket.disconnect).toHaveBeenCalledTimes(1)
  })

  it('does not hang when the socket never reports itself closed', async () => {
    // SocketModeClient.disconnect() resolves on its own 'disconnected' event; a half-open
    // socket that never emits it would hold app shutdown open. Fake timers so the test
    // does not actually spend the 5s bound.
    const socket = fakeSocket({ disconnect: vi.fn(() => new Promise<void>(() => {})) })
    const { t } = harness(socket)
    await t.connect(async () => undefined)
    vi.useFakeTimers()
    try {
      const closing = t.disconnect()
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(closing).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createSlackTransport — send', () => {
  it('posts to the conversation, with no thread_ts when top-level', async () => {
    const { t, web } = harness()
    await t.send('C999', 'hi')
    expect(web.chat.postMessage).toHaveBeenCalledWith({ channel: 'C999', text: 'hi' })
  })

  it('honours opts.threadId so the reply lands IN the thread', async () => {
    const { t, web } = harness()
    await t.send('C999', 'hi', { threadId: '100.1' })
    expect(web.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C999',
      text: 'hi',
      thread_ts: '100.1'
    })
  })

  it('works without connect() — chat.postMessage needs no socket', async () => {
    const { t, web } = harness()
    await expect(t.send('C1', 'outbound only')).resolves.toBeUndefined()
    expect(web.chat.postMessage).toHaveBeenCalled()
  })

  it('THROWS on ok:false rather than reporting a delivery', async () => {
    const web = fakeWeb({
      chat: { postMessage: vi.fn(async () => ({ ok: false, error: 'not_in_channel' })) }
    })
    const { t } = harness(fakeSocket(), web)
    await expect(t.send('C999', 'hi')).rejects.toThrow(/not_in_channel/)
  })

  it('propagates a rejected postMessage (the SDK throws on platform errors)', async () => {
    const web = fakeWeb({
      chat: { postMessage: vi.fn(async () => Promise.reject(new Error('channel_not_found'))) }
    })
    const { t } = harness(fakeSocket(), web)
    await expect(t.send('CBAD', 'hi')).rejects.toThrow(/channel_not_found/)
  })
})

describe('createSlackTransport — listTargets', () => {
  const page = (channels: SlackConversation[], next?: string) => ({
    ok: true,
    channels,
    response_metadata: { next_cursor: next ?? '' }
  })

  it('walks the cursor, maps kinds, and drops unreachable rows', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(
        page(
          [
            { id: 'C1', name: 'general', is_member: true },
            { id: 'C2', name: 'locked-out', is_member: false }
          ],
          'CUR2'
        )
      )
      .mockResolvedValueOnce(page([{ id: 'D1', is_im: true, user: 'U5' }]))
    const { t } = harness(fakeSocket(), fakeWeb({ conversations: { list } }))
    const targets = await t.listTargets?.()
    expect(targets).toEqual([
      { id: 'C1', name: 'general', kind: 'channel' },
      { id: 'D1', name: 'U5', kind: 'user' }
    ])
    expect(list).toHaveBeenCalledTimes(2)
    expect(list.mock.calls[0][0]).toMatchObject({
      types: 'public_channel,private_channel,mpim,im',
      exclude_archived: true
    })
    expect(list.mock.calls[1][0]).toMatchObject({ cursor: 'CUR2' })
  })

  it('filters case-insensitively on the client (conversations.list has no search)', async () => {
    const list = vi.fn(async () =>
      page([
        { id: 'C1', name: 'General', is_member: true },
        { id: 'C2', name: 'random', is_member: true }
      ])
    )
    const { t } = harness(fakeSocket(), fakeWeb({ conversations: { list } }))
    expect(await t.listTargets?.('gene')).toEqual([{ id: 'C1', name: 'General', kind: 'channel' }])
  })

  it('throws on ok:false rather than reporting an empty directory', async () => {
    // An empty picker reads as "I have no conversations"; a missing scope must not
    // masquerade as one.
    const list = vi.fn(async () => ({ ok: false, error: 'missing_scope' }))
    const { t } = harness(fakeSocket(), fakeWeb({ conversations: { list } }))
    await expect(t.listTargets?.()).rejects.toThrow(/missing_scope/)
  })
})
