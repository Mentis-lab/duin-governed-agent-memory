// Unit tests for the Feishu 长连接 transport.
//
// SCOPE: the PURE parts (event → TransportMessage, id selection, threading, text
// extraction) plus the two impure behaviours the transport contract is explicit about
// — connect() resolving only on a real handshake, and send() throwing on a failure that
// arrived as HTTP 200. Nothing here touches @larksuiteoapi/node-sdk or the network: the
// SDK is injected through `loadSdk`, so these run with no credentials and no install.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createFeishuTransport,
  extractFeishuText,
  feishuEventToMessage,
  resolveFeishuMentions,
  type FeishuMessageEvent,
  type FeishuSdk,
  type FeishuWsClientOptions
} from './feishu-ws'
import type { TransportMessage } from './transport'

// ─────────────────── fixtures ───────────────────

const APP_ID = 'cli_0123456789abcdef'

function event(over: Partial<FeishuMessageEvent['message']> = {}, sender?: FeishuMessageEvent['sender']): FeishuMessageEvent {
  return {
    event_id: 'evt_1',
    sender: sender ?? { sender_id: { open_id: 'ou_alice', union_id: 'on_alice', user_id: 'u_alice' }, sender_type: 'user' },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_room',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
      ...over
    }
  }
}

// ─────────────────── text extraction ───────────────────

describe('extractFeishuText', () => {
  it('reads the text body of a plain text message', () => {
    expect(extractFeishuText('text', JSON.stringify({ text: 'hi there' }))).toBe('hi there')
  })

  it('flattens a post (rich text) into lines, keeping link text and @-runs', () => {
    const content = JSON.stringify({
      title: 'Release',
      content: [
        [{ tag: 'text', text: 'ship ' }, { tag: 'a', text: 'the notes', href: 'https://x' }],
        [{ tag: 'at', user_name: 'Bob' }, { tag: 'text', text: ' please' }]
      ]
    })
    expect(extractFeishuText('post', content)).toBe('Release\nship the notes\n@Bob please')
  })

  it('unwraps a locale-keyed post', () => {
    const content = JSON.stringify({ zh_cn: { title: '标题', content: [[{ tag: 'text', text: '正文' }]] } })
    expect(extractFeishuText('post', content)).toBe('标题\n正文')
  })

  it('returns empty for types that carry no prose', () => {
    expect(extractFeishuText('image', JSON.stringify({ image_key: 'img_1' }))).toBe('')
    expect(extractFeishuText('file', JSON.stringify({ file_key: 'f_1' }))).toBe('')
    expect(extractFeishuText('interactive', JSON.stringify({ elements: [] }))).toBe('')
  })

  it('returns empty rather than throwing on malformed content', () => {
    // One unparseable message must not be able to take down the read loop.
    expect(extractFeishuText('text', '{not json')).toBe('')
    expect(extractFeishuText('text', undefined)).toBe('')
    expect(extractFeishuText('text', JSON.stringify({ text: 42 }))).toBe('')
  })
})

// ─────────────────── mentions ───────────────────

describe('resolveFeishuMentions', () => {
  it('substitutes the placeholder with the display name', () => {
    const out = resolveFeishuMentions('@_user_1 summarise this', [
      { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'DUIN' }
    ])
    expect(out).toBe('@DUIN summarise this')
  })

  it('replaces longest key first so @_user_1 does not clobber @_user_10', () => {
    // Naive in-order replacement rewrites the first 8 chars of `@_user_10` and leaves a
    // stray `0` behind — the reason the implementation sorts by key length descending.
    const out = resolveFeishuMentions('@_user_10 and @_user_1 talk', [
      { key: '@_user_1', name: 'One' },
      { key: '@_user_10', name: 'Ten' }
    ])
    expect(out).toBe('@Ten and @One talk')
  })

  it('drops the placeholder entirely when the mention has no name', () => {
    // A bare "@" would read as a real, empty mention.
    expect(resolveFeishuMentions('@_user_1 hi', [{ key: '@_user_1' }])).toBe('hi')
  })

  it('is a no-op without mentions', () => {
    expect(resolveFeishuMentions('plain', undefined)).toBe('plain')
    expect(resolveFeishuMentions('plain', [])).toBe('plain')
  })
})

// ─────────────────── event → TransportMessage ───────────────────

describe('feishuEventToMessage — id selection', () => {
  it('uses open_id as the pairing subject', () => {
    expect(feishuEventToMessage(event())?.userId).toBe('ou_alice')
  })

  it('falls back union_id → user_id when open_id is absent', () => {
    const noOpen = event({}, { sender_id: { union_id: 'on_alice', user_id: 'u_alice' }, sender_type: 'user' })
    expect(feishuEventToMessage(noOpen)?.userId).toBe('on_alice')

    const onlyUser = event({}, { sender_id: { user_id: 'u_alice' }, sender_type: 'user' })
    expect(feishuEventToMessage(onlyUser)?.userId).toBe('u_alice')
  })

  it('drops a message with no stable sender id', () => {
    // userId becomes the pairing subject, so an unattributable message must never
    // reach the authorization gate — there is nothing to key an approval on.
    expect(feishuEventToMessage(event({}, { sender_id: {}, sender_type: 'user' }))).toBeNull()
    expect(feishuEventToMessage(event({}, { sender_type: 'user' }))).toBeNull()
  })

  it('never uses a display name as the id', () => {
    const msg = feishuEventToMessage(
      event({ mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'DUIN' }] })
    )
    expect(msg?.userId).toBe('ou_alice')
    expect(msg?.userId).not.toContain('DUIN')
  })

  it('addresses the CHAT, not the sender', () => {
    // Replying to the sender's open_id would DM whoever asked instead of answering in
    // the group the question was asked in.
    const msg = feishuEventToMessage(event())
    expect(msg?.conversationId).toBe('oc_room')
    expect(msg?.conversationId).not.toBe('ou_alice')
  })
})

describe('feishuEventToMessage — threading', () => {
  it('carries root_id as threadId', () => {
    expect(feishuEventToMessage(event({ root_id: 'om_root' }))?.threadId).toBe('om_root')
  })

  it('leaves threadId absent on a top-level message', () => {
    expect(feishuEventToMessage(event())?.threadId).toBeUndefined()
  })

  it('does NOT use parent_id or thread_id as the threadId', () => {
    // parent_id is the immediate parent — using it splinters one conversation into a
    // chain of separate threads. thread_id (topic groups) is not a message id and
    // cannot be passed to im.message.reply.
    const msg = feishuEventToMessage(event({ parent_id: 'om_parent', thread_id: 'omt_topic' }))
    expect(msg?.threadId).toBeUndefined()
  })

  it('prefers root_id over parent_id when both are present', () => {
    expect(feishuEventToMessage(event({ root_id: 'om_root', parent_id: 'om_parent' }))?.threadId).toBe('om_root')
  })

  it('exposes messageId so the caller can start a thread on this message', () => {
    expect(feishuEventToMessage(event())?.messageId).toBe('om_1')
  })
})

describe('feishuEventToMessage — what gets dropped', () => {
  it('drops messages from other bots', () => {
    // Two bots in one group otherwise talk to each other forever.
    const bot = event({}, { sender_id: { open_id: 'ou_bot' }, sender_type: 'app' })
    expect(feishuEventToMessage(bot)).toBeNull()
  })

  it('keeps a message whose sender_type is missing', () => {
    // Only an EXPLICIT non-'user' is treated as a bot, so an unlabelled human message
    // is not silently discarded.
    const unlabelled = event({}, { sender_id: { open_id: 'ou_alice' } })
    expect(feishuEventToMessage(unlabelled)?.userId).toBe('ou_alice')
  })

  it('drops messages with no chat_id or no message_id', () => {
    expect(feishuEventToMessage(event({ chat_id: undefined }))).toBeNull()
    expect(feishuEventToMessage(event({ message_id: undefined }))).toBeNull()
  })

  it('drops non-prose messages instead of inventing a stand-in prompt', () => {
    const img = event({ message_type: 'image', content: JSON.stringify({ image_key: 'img_1' }) })
    expect(feishuEventToMessage(img)).toBeNull()
  })

  it('keeps a bare @-mention (it still reads as addressing the bot)', () => {
    const named = event({
      content: JSON.stringify({ text: '@_user_1' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'DUIN' }]
    })
    expect(feishuEventToMessage(named)?.text).toBe('@DUIN')
  })

  it('drops a mention-only message whose mention has no name', () => {
    // The placeholder resolves to nothing, leaving no prose at all.
    const nameless = event({
      content: JSON.stringify({ text: '@_user_1' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }]
    })
    expect(feishuEventToMessage(nameless)).toBeNull()
  })

  it('drops an event with no message at all', () => {
    expect(feishuEventToMessage({})).toBeNull()
  })

  it('keeps the raw event for the caller', () => {
    const e = event()
    expect(feishuEventToMessage(e)?.raw).toBe(e)
  })
})

// ─────────────────── fake SDK ───────────────────

interface Fake {
  sdk: FeishuSdk
  wsOpts: FeishuWsClientOptions | null
  started: number
  closed: number
  create: ReturnType<typeof vi.fn>
  reply: ReturnType<typeof vi.fn>
  /** Fire the event the WSClient would have delivered, returning whatever the
   *  registered handler returned — that value is what the SDK puts in the ack frame. */
  emit: (data: FeishuMessageEvent) => unknown
}

function fakeSdk(): Fake {
  const state = {
    wsOpts: null as FeishuWsClientOptions | null,
    started: 0,
    closed: 0
  }
  let handler: ((data: FeishuMessageEvent) => unknown) | null = null

  const create = vi.fn(async () => ({ code: 0 }))
  const reply = vi.fn(async () => ({ code: 0 }))

  const sdk: FeishuSdk = {
    EventDispatcher: class {
      register(handles: Record<string, (data: never) => unknown>): this {
        handler = handles['im.message.receive_v1'] as (data: FeishuMessageEvent) => unknown
        return this
      }
    } as unknown as FeishuSdk['EventDispatcher'],
    WSClient: class {
      constructor(o: FeishuWsClientOptions) {
        state.wsOpts = o
      }
      async start(): Promise<void> {
        state.started += 1
      }
      close(): void {
        state.closed += 1
      }
    } as unknown as FeishuSdk['WSClient'],
    Client: class {
      im = { message: { create, reply }, image: { create: vi.fn() }, file: { create: vi.fn() } }
    } as unknown as FeishuSdk['Client']
  }

  return {
    sdk,
    get wsOpts() {
      return state.wsOpts
    },
    get started() {
      return state.started
    },
    get closed() {
      return state.closed
    },
    create,
    reply,
    emit: (data) => handler?.(data)
  } as Fake
}

const transport = (f: Fake): ReturnType<typeof createFeishuTransport> =>
  createFeishuTransport({ appId: APP_ID, appSecret: 'sec' }, { loadSdk: async () => f.sdk })

// ─────────────────── the contract transport.ts spells out ───────────────────

describe('capabilities', () => {
  it('declares only what is wired', () => {
    expect(transport(fakeSdk()).capabilities()).toEqual(['threads', 'files'])
  })
})

describe('connect — resolves only once messages can arrive', () => {
  beforeEach(() => vi.useRealTimers())

  it('does NOT resolve on start(); it waits for the SDK onReady callback', async () => {
    // WSClient.start() resolves while the socket is still dialling, so awaiting it
    // would report a channel as running before any event could arrive.
    const f = fakeSdk()
    const t = transport(f)
    let resolved = false
    const p = t.connect(async () => {}).then(() => {
      resolved = true
    })

    await vi.waitFor(() => expect(f.started).toBe(1))
    expect(resolved).toBe(false) // started, but not ready

    f.wsOpts?.onReady?.()
    await p
    expect(resolved).toBe(true)
  })

  it('throws when the SDK reports a connect failure', async () => {
    const f = fakeSdk()
    const t = transport(f)
    const p = t.connect(async () => {})
    await vi.waitFor(() => expect(f.wsOpts).not.toBeNull())
    f.wsOpts?.onError?.(new Error('invalid app secret'))
    await expect(p).rejects.toThrow(/invalid app secret/)
  })

  it('closes the socket when connect fails, so no reconnect loop is left running', async () => {
    const f = fakeSdk()
    const t = transport(f)
    const p = t.connect(async () => {})
    await vi.waitFor(() => expect(f.wsOpts).not.toBeNull())
    f.wsOpts?.onError?.(new Error('nope'))
    await expect(p).rejects.toThrow()
    expect(f.closed).toBe(1)
  })

  it('rejects a malformed appId up front instead of hanging to the timeout', async () => {
    // WSClient.start() logs and RETURNS on an appId that is not cli_<16 hex> — no throw,
    // no callback, ever. Without this pre-check connect() would wait out its full
    // timeout and then blame the network.
    const f = fakeSdk()
    const t = createFeishuTransport({ appId: 'not-an-app-id', appSecret: 'sec' }, { loadSdk: async () => f.sdk })
    await expect(t.connect(async () => {})).rejects.toThrow(/cli_<16 hex>/)
    expect(f.started).toBe(0)
  })

  it('requires an app secret', async () => {
    const f = fakeSdk()
    const t = createFeishuTransport({ appId: APP_ID, appSecret: '' }, { loadSdk: async () => f.sdk })
    await expect(t.connect(async () => {})).rejects.toThrow(/appSecret/)
  })

  it('is idempotent — a second connect does not open a second socket', async () => {
    const f = fakeSdk()
    const t = transport(f)
    const p = t.connect(async () => {})
    await vi.waitFor(() => expect(f.wsOpts).not.toBeNull())
    f.wsOpts?.onReady?.()
    await p
    await t.connect(async () => {})
    expect(f.started).toBe(1)
  })
})

describe('inbound delivery', () => {
  async function connected(): Promise<{ f: Fake; got: TransportMessage[]; t: ReturnType<typeof createFeishuTransport> }> {
    const f = fakeSdk()
    const t = transport(f)
    const got: TransportMessage[] = []
    const p = t.connect(async (m) => {
      got.push(m)
    })
    await vi.waitFor(() => expect(f.wsOpts).not.toBeNull())
    f.wsOpts?.onReady?.()
    await p
    return { f, got, t }
  }

  it('delivers a mapped message to the sink', async () => {
    const { f, got } = await connected()
    f.emit(event())
    await vi.waitFor(() => expect(got).toHaveLength(1))
    expect(got[0]).toMatchObject({ userId: 'ou_alice', conversationId: 'oc_room', text: 'hello', messageId: 'om_1' })
  })

  it('acks without waiting for the sink — a slow turn must not trigger a re-push', async () => {
    // Feishu re-pushes an event the app has not acked within 3 seconds, and the SDK
    // sends the ack only after the handler settles. Awaiting a full DUIN turn here
    // would re-deliver and re-run every message.
    const f = fakeSdk()
    const t = transport(f)
    // Held in an object so TypeScript does not narrow the binding to `null` — the
    // assignment happens inside a callback its control-flow analysis cannot see.
    const gate: { release: (() => void) | null } = { release: null }
    let finished = false
    const p = t.connect(
      () =>
        new Promise<void>((r) => {
          gate.release = () => {
            finished = true
            r()
          }
        })
    )
    await vi.waitFor(() => expect(f.wsOpts).not.toBeNull())
    f.wsOpts?.onReady?.()
    await p

    // emit() IS the SDK's registered handler. Its return value goes into the ack frame,
    // so a non-promise return means Feishu is acked now rather than after the turn.
    const acked = f.emit(event())
    expect(acked).toBeUndefined()

    await vi.waitFor(() => expect(gate.release).not.toBeNull()) // sink started …
    expect(finished).toBe(false) // … and is still running, un-awaited

    gate.release?.()
    await vi.waitFor(() => expect(finished).toBe(true))
  })

  it('de-duplicates a re-pushed message', async () => {
    const { f, got } = await connected()
    f.emit(event())
    f.emit(event()) // same message_id — Feishu retry or a reconnect replay
    await vi.waitFor(() => expect(got).toHaveLength(1))
  })

  it('does not treat distinct messages as duplicates', async () => {
    const { f, got } = await connected()
    f.emit(event())
    f.emit(event({ message_id: 'om_2' }))
    await vi.waitFor(() => expect(got).toHaveLength(2))
  })

  it('serialises the sink per chat so replies cannot land out of order', async () => {
    const f = fakeSdk()
    const t = transport(f)
    const order: string[] = []
    const p = t.connect(async (m) => {
      order.push(`start:${m.messageId}`)
      await new Promise((r) => setTimeout(r, 10))
      order.push(`end:${m.messageId}`)
    })
    await vi.waitFor(() => expect(f.wsOpts).not.toBeNull())
    f.wsOpts?.onReady?.()
    await p

    f.emit(event({ message_id: 'om_1' }))
    f.emit(event({ message_id: 'om_2' }))
    await vi.waitFor(() => expect(order).toHaveLength(4))
    expect(order).toEqual(['start:om_1', 'end:om_1', 'start:om_2', 'end:om_2'])
  })

  it('a throwing sink does not kill the read loop', async () => {
    const f = fakeSdk()
    const t = transport(f)
    const got: string[] = []
    const p = t.connect(async (m) => {
      if (m.messageId === 'om_1') throw new Error('turn blew up')
      got.push(m.messageId as string)
    })
    await vi.waitFor(() => expect(f.wsOpts).not.toBeNull())
    f.wsOpts?.onReady?.()
    await p

    f.emit(event({ message_id: 'om_1' }))
    f.emit(event({ message_id: 'om_2' }))
    await vi.waitFor(() => expect(got).toEqual(['om_2']))
  })
})

describe('send — resolving means delivered', () => {
  it('throws on a Feishu refusal that arrived as HTTP 200', async () => {
    // The SDK's axios interceptor returns resp.data for any 2xx, and Feishu answers 200
    // with {code: non-zero} for "bot not in chat" / "no permission" / rate limits. A
    // resolved promise is NOT proof of delivery.
    const f = fakeSdk()
    f.create.mockResolvedValueOnce({ code: 230002, msg: 'bot is not in the chat' })
    await expect(transport(f).send('oc_room', 'hi')).rejects.toThrow(/bot is not in the chat.*230002/)
  })

  it('resolves on code 0', async () => {
    const f = fakeSdk()
    await expect(transport(f).send('oc_room', 'hi')).resolves.toBeUndefined()
  })

  it('addresses the chat by chat_id with a JSON text body', async () => {
    const f = fakeSdk()
    await transport(f).send('oc_room', 'hi')
    expect(f.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_room', msg_type: 'text', content: JSON.stringify({ text: 'hi' }) }
    })
  })

  it('uses the reply endpoint when a threadId is given', async () => {
    // im.message.create has no thread parameter — joining a thread is a different
    // endpoint, keyed on the message being replied to.
    const f = fakeSdk()
    await transport(f).send('oc_room', 'in-thread', { threadId: 'om_root' })
    expect(f.reply).toHaveBeenCalledWith({
      path: { message_id: 'om_root' },
      data: { content: JSON.stringify({ text: 'in-thread' }), msg_type: 'text' }
    })
    expect(f.create).not.toHaveBeenCalled()
  })

  it('propagates a thrown transport-level error', async () => {
    const f = fakeSdk()
    f.create.mockRejectedValueOnce(new Error('ECONNRESET'))
    await expect(transport(f).send('oc_room', 'hi')).rejects.toThrow(/ECONNRESET/)
  })

  it('does not require connect() first — egress and ingress are separate', async () => {
    const f = fakeSdk()
    await expect(transport(f).send('oc_room', 'outbound only')).resolves.toBeUndefined()
    expect(f.started).toBe(0)
  })
})

describe('disconnect', () => {
  it('is safe when never connected', async () => {
    await expect(transport(fakeSdk()).disconnect()).resolves.toBeUndefined()
  })

  it('closes the socket and stops delivering', async () => {
    const f = fakeSdk()
    const t = transport(f)
    const got: TransportMessage[] = []
    const p = t.connect(async (m) => {
      got.push(m)
    })
    await vi.waitFor(() => expect(f.wsOpts).not.toBeNull())
    f.wsOpts?.onReady?.()
    await p

    await t.disconnect()
    expect(f.closed).toBe(1)

    f.emit(event({ message_id: 'om_after' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(got).toHaveLength(0)
  })
})
