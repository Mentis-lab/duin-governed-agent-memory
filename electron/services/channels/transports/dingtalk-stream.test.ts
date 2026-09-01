import { describe, it, expect, vi, afterEach } from 'vitest'

import {
  conversationAddress,
  parseAddress,
  describeNonText,
  parseBotCallback,
  buildCallbackAck,
  buildEventAck,
  buildSystemAck,
  reconnectDelayMs,
  explainUndeliverable,
  assertSendAccepted,
  createDingTalkTransport,
  type DingTalkBotPayload
} from './dingtalk-stream'

afterEach(() => {
  vi.restoreAllMocks()
})

const CREDS = { appKey: 'APPKEY', appSecret: 'APPSECRET' }

/** A group text message, the shape DingTalk pushes on the bot callback topic. */
function groupText(over: Partial<DingTalkBotPayload> = {}): DingTalkBotPayload {
  return {
    msgtype: 'text',
    msgId: 'msg-1',
    senderStaffId: 'staff-9',
    senderId: 'dtid-9',
    senderNick: 'Theo',
    conversationId: 'cidABC==',
    conversationType: '2',
    conversationTitle: 'Ops',
    robotCode: 'APPKEY',
    text: { content: 'hello' },
    ...over
  }
}

// ── payload → TransportMessage ───────────────────────────────────────────────

describe('parseBotCallback — callback payload to TransportMessage', () => {
  it('maps a group text message, addressing the reply by openConversationId', () => {
    const msg = parseBotCallback(groupText())
    expect(msg).toMatchObject({
      userId: 'staff-9',
      conversationId: 'group:cidABC==',
      text: 'hello',
      messageId: 'msg-1'
    })
  })

  it('maps a 1:1 text message, addressing the reply by staff id', () => {
    // The 1:1 send endpoint takes userIds, never a conversation id — so the
    // address encodes the staff id, not cidXYZ.
    const msg = parseBotCallback(groupText({ conversationType: '1', conversationId: 'cidXYZ==' }))
    expect(msg?.conversationId).toBe('user:staff-9')
  })

  it('uses senderStaffId as the pairing subject, never the display name', () => {
    const msg = parseBotCallback(groupText({ senderNick: 'Totally Not Theo' }))
    expect(msg?.userId).toBe('staff-9')
    expect(msg?.userId).not.toBe('Totally Not Theo')
  })

  it('emits no threadId — DingTalk bot conversations are flat', () => {
    expect(parseBotCallback(groupText())?.threadId).toBeUndefined()
  })

  it('keeps the original payload on raw so nothing modelled here is lost', () => {
    const p = groupText({ extraVendorField: 'kept' } as Partial<DingTalkBotPayload>)
    expect(parseBotCallback(p)?.raw).toBe(p)
  })

  it('refuses to fall back to senderId — the pairing subject must not change on publish', () => {
    // senderStaffId is empty until the robot is published. Falling back to the
    // DingTalk-global senderId would make the same human a different pairing
    // subject before and after publish, silently voiding an approval.
    expect(parseBotCallback(groupText({ senderStaffId: undefined }))).toBeNull()
  })

  it('returns null only when there is no sender or no addressable conversation', () => {
    expect(parseBotCallback(groupText({ senderStaffId: undefined, senderId: undefined }))).toBeNull()
    expect(parseBotCallback(groupText({ conversationId: undefined }))).toBeNull()
    // 1:1 stays routable without a conversationId — the staff id is the address.
    expect(
      parseBotCallback(groupText({ conversationType: '1', conversationId: undefined }))?.conversationId
    ).toBe('user:staff-9')
  })
})

// ── TRAP 1: non-text messages must never be silently swallowed ───────────────

describe('non-text messages are surfaced, not dropped (trap 1)', () => {
  it('turns a FILE message into a visible message carrying name + downloadCode', () => {
    const msg = parseBotCallback(
      groupText({
        msgtype: 'file',
        text: undefined,
        content: { fileName: 'contract.pdf', downloadCode: 'dc-123' }
      })
    )
    // The competitor's bug: this returned null and the PDF vanished.
    expect(msg).not.toBeNull()
    expect(msg?.text).toContain('contract.pdf')
    expect(msg?.text).toContain('dc-123')
    expect(msg?.text).toContain('[dingtalk:file]')
  })

  it('surfaces a DOCX the same way', () => {
    expect(describeNonText({ msgtype: 'file', content: { fileName: 'spec.docx' } })).toContain(
      'spec.docx'
    )
  })

  it('flattens richText to its text run', () => {
    expect(
      describeNonText({
        msgtype: 'richText',
        content: { richText: [{ text: 'see ' }, { text: 'this' }] }
      })
    ).toBe('see this')
  })

  it('reports an image-only richText instead of an empty string', () => {
    const out = describeNonText({ msgtype: 'richText', content: { richText: [{ downloadCode: 'i1' }] } })
    expect(out).toContain('richText')
    expect(out).toContain('1 image')
  })

  it('prefers DingTalk’s own transcript for a voice message', () => {
    expect(describeNonText({ msgtype: 'audio', content: { recognition: 'call me back' } })).toBe(
      'call me back'
    )
  })

  it('falls back to a placeholder for an untranscribed voice message', () => {
    expect(describeNonText({ msgtype: 'audio', content: { downloadCode: 'a1' } })).toContain(
      '[dingtalk:audio]'
    )
  })

  it('names picture and video messages', () => {
    expect(describeNonText({ msgtype: 'picture', content: { downloadCode: 'p1' } })).toContain(
      '[dingtalk:picture]'
    )
    expect(describeNonText({ msgtype: 'video', content: { downloadCode: 'v1' } })).toContain(
      '[dingtalk:video]'
    )
  })

  it('passes markdown through as its text', () => {
    expect(describeNonText({ msgtype: 'markdown', content: { text: '# hi' } })).toBe('# hi')
  })

  it('makes an UNKNOWN msgtype visible rather than dropping it', () => {
    // The forward-compat case: DingTalk ships a new type, we still surface it.
    const msg = parseBotCallback(groupText({ msgtype: 'spaceDoc', text: undefined, content: {} }))
    expect(msg).not.toBeNull()
    expect(msg?.text).toContain('[dingtalk:spaceDoc]')
    expect(msg?.text).toContain('unsupported message type')
  })

  it('does not treat a whitespace-only text body as text', () => {
    // Still surfaced, and diagnosed accurately as empty rather than "unsupported".
    const msg = parseBotCallback(groupText({ msgtype: 'text', text: { content: '   ' } }))
    expect(msg?.text).toBe('[dingtalk:text] empty text message')
  })
})

// ── ack / response shapes ────────────────────────────────────────────────────

describe('ack frames', () => {
  it('wraps a callback ack in the double-encoded {response} envelope', () => {
    const ack = buildCallbackAck('m-1', 'ok')
    expect(ack.code).toBe(200)
    expect(ack.headers).toEqual({ contentType: 'application/json', messageId: 'm-1' })
    // `data` is a JSON STRING, not an object — the protocol double-encodes it.
    expect(typeof ack.data).toBe('string')
    expect(JSON.parse(ack.data)).toEqual({ response: 'ok' })
  })

  it('acks an event as SUCCESS so it is not redelivered', () => {
    expect(JSON.parse(buildEventAck('m-2').data)).toEqual({ status: 'SUCCESS' })
  })

  it('echoes a SYSTEM ping back with its own headers and data', () => {
    const ack = buildSystemAck({
      type: 'SYSTEM',
      headers: { topic: 'ping', messageId: 'm-3', contentType: 'application/json' },
      data: '{"t":1}'
    })
    expect(ack.code).toBe(200)
    expect(ack.headers.topic).toBe('ping')
    expect(ack.headers.messageId).toBe('m-3')
    expect(ack.data).toBe('{"t":1}')
  })
})

// ── drop diagnostics: a refusal must name its cause ─────────────────────────

describe('explainUndeliverable', () => {
  it('names quota exhaustion, which arrives as a body-less callback', () => {
    // errorCode 20001 replaces the message entirely — no text, no content. Left
    // ungraded this reads as "unknown msgtype", which sends the operator hunting
    // a parser bug instead of topping up the org's message quota.
    const out = explainUndeliverable({ errorCode: 20001, errorMessage: 'quota exceeded' })
    expect(out).toContain('20001')
    expect(out).toContain('quota')
  })

  it('names the unpublished-robot cause when senderStaffId is missing', () => {
    expect(explainUndeliverable(groupText({ senderStaffId: undefined }))).toContain('PUBLISHED')
  })

  it('names a group with no conversationId', () => {
    expect(explainUndeliverable(groupText({ conversationId: undefined }))).toContain('conversationId')
  })

  it('falls back to the raw shape when the cause is not one of the known ones', () => {
    expect(explainUndeliverable(groupText({ conversationType: '9' }))).toContain('conversationType=9')
  })
})

// ── send responses: HTTP 200 is not proof of delivery ───────────────────────

describe('assertSendAccepted', () => {
  it('accepts a clean batchSend response', () => {
    expect(() => assertSendAccepted({ processQueryKey: 'k' })).not.toThrow()
    expect(() =>
      assertSendAccepted({ processQueryKey: 'k', invalidStaffIdList: [], flowControlledStaffIdList: [] })
    ).not.toThrow()
  })

  it('THROWS on recipients the org does not recognise, despite the 200', () => {
    expect(() =>
      assertSendAccepted({ processQueryKey: 'k', invalidStaffIdList: ['manage25231'] })
    ).toThrow(/unknown recipients: manage25231/)
  })

  it('THROWS on flow-controlled recipients, despite the 200', () => {
    // DingTalk drops throttled recipients and still answers 200. Reporting that
    // as delivered is the exact bug the transport contract forbids.
    expect(() =>
      assertSendAccepted({ processQueryKey: 'k', flowControlledStaffIdList: ['manage25232'] })
    ).toThrow(/flow-controlled recipients: manage25232/)
  })

  it('THROWS on the IP-ban throttle blob, which is not an error envelope', () => {
    expect(() => assertSendAccepted({ status: 1111, wait: 5, punish: 'deny' })).toThrow(/throttled/)
  })

  it('THROWS on either spelling of the error envelope', () => {
    expect(() =>
      assertSendAccepted({ code: 'invalidParameter.robotCode.auth', message: 'bad robotCode' })
    ).toThrow(/invalidParameter\.robotCode\.auth/)
    expect(() => assertSendAccepted({ errcode: 88, errmsg: 'nope' })).toThrow(/errcode 88/)
  })

  it('treats an unparseable body as no contradiction of the 2xx', () => {
    expect(() => assertSendAccepted(null)).not.toThrow()
  })
})

describe('reconnectDelayMs', () => {
  it('backs off exponentially from 1s and caps at 60s', () => {
    expect(reconnectDelayMs(0, 0)).toBe(1_000)
    expect(reconnectDelayMs(1, 0)).toBe(2_000)
    expect(reconnectDelayMs(4, 0)).toBe(16_000)
    expect(reconnectDelayMs(99, 1)).toBe(60_000)
  })
})

// ── addressing ───────────────────────────────────────────────────────────────

describe('conversation addressing', () => {
  it('round-trips a group address', () => {
    expect(parseAddress(conversationAddress(groupText())!)).toEqual({ kind: 'group', id: 'cidABC==' })
  })

  it('round-trips a 1:1 address', () => {
    const addr = conversationAddress(groupText({ conversationType: '1' }))!
    expect(parseAddress(addr)).toEqual({ kind: 'user', id: 'staff-9' })
  })

  it('rejects an unprefixed or empty address rather than guessing', () => {
    expect(parseAddress('cidABC==')).toBeNull()
    expect(parseAddress('user:')).toBeNull()
    expect(parseAddress('group:')).toBeNull()
  })
})

// ── TRAP 2: send works from stream credentials alone ─────────────────────────

interface Captured {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** Stub fetch: token endpoint always succeeds, send endpoints reply per `send`. */
function stubFetch(send: { ok: boolean; status?: number } = { ok: true }): {
  calls: Captured[]
  fetchImpl: typeof fetch
} {
  const calls: Captured[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string>, body })
    if (String(url).includes('/oauth2/accessToken')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ accessToken: 'AT-1', expireIn: 7200 }),
        text: async () => ''
      }
    }
    return {
      ok: send.ok,
      status: send.status ?? 200,
      json: async () => ({}),
      text: async () => 'boom'
    }
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe('send — stream-mode credentials only, no webhook (trap 2)', () => {
  it('sends a group reply via groupMessages/send with openConversationId', async () => {
    const { calls, fetchImpl } = stubFetch()
    await createDingTalkTransport(CREDS, { fetchImpl }).send('group:cidABC==', 'hi')
    const send = calls.find((c) => c.url.includes('/robot/'))!
    expect(send.url).toBe('https://api.dingtalk.com/v1.0/robot/groupMessages/send')
    expect(send.body.openConversationId).toBe('cidABC==')
    expect(send.body.robotCode).toBe('APPKEY') // robotCode IS the AppKey
    expect(send.body.msgKey).toBe('sampleText')
    expect(JSON.parse(String(send.body.msgParam))).toEqual({ content: 'hi' })
  })

  it('sends a 1:1 reply via oToMessages/batchSend addressed by userIds', async () => {
    const { calls, fetchImpl } = stubFetch()
    await createDingTalkTransport(CREDS, { fetchImpl }).send('user:staff-9', 'hi')
    const send = calls.find((c) => c.url.includes('/robot/'))!
    expect(send.url).toBe('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend')
    expect(send.body.userIds).toEqual(['staff-9'])
    // The trap: a 1:1 reply must NOT be addressed by conversation id.
    expect(send.body.openConversationId).toBeUndefined()
  })

  it('mints an access token from appKey/appSecret and carries it in the acs header', async () => {
    const { calls, fetchImpl } = stubFetch()
    await createDingTalkTransport(CREDS, { fetchImpl }).send('user:staff-9', 'hi')
    const tokenCall = calls.find((c) => c.url.includes('/oauth2/accessToken'))!
    expect(tokenCall.body).toEqual({ appKey: 'APPKEY', appSecret: 'APPSECRET' })
    const send = calls.find((c) => c.url.includes('/robot/'))!
    expect(send.headers['x-acs-dingtalk-access-token']).toBe('AT-1')
  })

  it('never touches a sessionWebhook, even when the inbound message offered one', async () => {
    const { calls, fetchImpl } = stubFetch()
    const t = createDingTalkTransport(CREDS, { fetchImpl })
    // sessionWebhook is present on the payload and must simply be ignored.
    const msg = parseBotCallback(
      groupText({ sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=abc' })
    )!
    await t.send(msg.conversationId, 'hi')
    expect(calls.every((c) => !c.url.includes('sendBySession'))).toBe(true)
    expect(calls.some((c) => c.url.includes('/robot/groupMessages/send'))).toBe(true)
  })

  it('caches the token across sends instead of minting one each time', async () => {
    const { calls, fetchImpl } = stubFetch()
    const t = createDingTalkTransport(CREDS, { fetchImpl })
    await t.send('user:u1', 'a')
    await t.send('user:u1', 'b')
    expect(calls.filter((c) => c.url.includes('/oauth2/accessToken'))).toHaveLength(1)
  })

  it('refreshes the token and retries once on a 401', async () => {
    const calls: string[] = []
    let sendAttempts = 0
    const fetchImpl = (async (url: string) => {
      calls.push(String(url))
      if (String(url).includes('/oauth2/accessToken')) {
        return { ok: true, status: 200, json: async () => ({ accessToken: 'AT', expireIn: 7200 }), text: async () => '' }
      }
      sendAttempts += 1
      const ok = sendAttempts > 1
      return { ok, status: ok ? 200 : 401, json: async () => ({}), text: async () => 'expired' }
    }) as unknown as typeof fetch
    await expect(
      createDingTalkTransport(CREDS, { fetchImpl }).send('user:u1', 'hi')
    ).resolves.toBeUndefined()
    expect(sendAttempts).toBe(2)
    expect(calls.filter((c) => c.includes('/oauth2/accessToken'))).toHaveLength(2)
  })

  it('THROWS on a rejected send — resolving must mean delivered', async () => {
    const { fetchImpl } = stubFetch({ ok: false, status: 403 })
    await expect(createDingTalkTransport(CREDS, { fetchImpl }).send('user:u1', 'hi')).rejects.toThrow(
      /HTTP 403/
    )
  })

  it('THROWS on a 200 that reports the recipient was never reached', async () => {
    // batchSend reports per-recipient failure inside a 200 body. Checking only
    // res.ok reported an undelivered message as sent.
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/oauth2/accessToken')) {
        return { ok: true, status: 200, json: async () => ({ accessToken: 'AT', expireIn: 7200 }), text: async () => '' }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ processQueryKey: 'k', invalidStaffIdList: ['staff-9'] }),
        text: async () => ''
      }
    }) as unknown as typeof fetch
    await expect(
      createDingTalkTransport(CREDS, { fetchImpl }).send('user:staff-9', 'hi')
    ).rejects.toThrow(/unknown recipients: staff-9/)
  })

  it('carries coolAppCode only when the install path needs one', async () => {
    const a = stubFetch()
    await createDingTalkTransport(CREDS, { fetchImpl: a.fetchImpl }).send('group:cid', 'hi')
    expect(a.calls.find((c) => c.url.includes('/robot/'))!.body.coolAppCode).toBeUndefined()

    const b = stubFetch()
    await createDingTalkTransport({ ...CREDS, coolAppCode: 'COOL' }, { fetchImpl: b.fetchImpl }).send(
      'group:cid',
      'hi'
    )
    expect(b.calls.find((c) => c.url.includes('/robot/'))!.body.coolAppCode).toBe('COOL')
  })

  it('throws on an unroutable id rather than guessing an endpoint', async () => {
    const { fetchImpl } = stubFetch()
    await expect(
      createDingTalkTransport(CREDS, { fetchImpl }).send('cidABC==', 'hi')
    ).rejects.toThrow(/cannot address/)
  })

  it('throws when credentials are missing', async () => {
    const { fetchImpl } = stubFetch()
    await expect(
      createDingTalkTransport({ appKey: '', appSecret: '' }, { fetchImpl }).send('user:u1', 'hi')
    ).rejects.toThrow(/not configured/)
  })
})

// ── connect / dispatch, with the network and socket mocked ───────────────────

class FakeSocket {
  sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  send(d: string): void {
    this.sent.push(d)
  }
  close(): void {
    this.closed = true
    this.onclose?.()
  }
  /** Deliver a frame as the gateway would. */
  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

/** fetch stub whose gateway handshake succeeds. */
function gatewayFetch(over: { ok?: boolean } = {}): typeof fetch {
  return (async (url: string) => {
    if (String(url).includes('/gateway/connections/open')) {
      return {
        ok: over.ok ?? true,
        status: over.ok === false ? 401 : 200,
        json: async () => ({ endpoint: 'wss://dt.example/ws', ticket: 'TICKET/+1' }),
        text: async () => 'denied'
      }
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
  }) as unknown as typeof fetch
}

function harness(): { socket: FakeSocket; wsFactory: (u: string) => FakeSocket; urls: string[] } {
  const socket = new FakeSocket()
  const urls: string[] = []
  const wsFactory = (u: string): FakeSocket => {
    urls.push(u)
    // Open on the next tick, as a real socket would.
    setTimeout(() => socket.onopen?.(), 0)
    return socket
  }
  return { socket, wsFactory, urls }
}

describe('connect — honest about whether messages can arrive', () => {
  it('resolves once the socket is open, and url-encodes the ticket', async () => {
    const { socket, wsFactory, urls } = harness()
    const t = createDingTalkTransport(CREDS, { fetchImpl: gatewayFetch(), wsFactory })
    await expect(t.connect(async () => {})).resolves.toBeUndefined()
    expect(urls[0]).toBe('wss://dt.example/ws?ticket=TICKET%2F%2B1')
    expect(socket.closed).toBe(false)
    await t.disconnect()
  })

  it('subscribes to the bot CALLBACK topic — without it the socket opens and stays silent', async () => {
    const bodies: unknown[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return {
        ok: true,
        status: 200,
        json: async () => ({ endpoint: 'wss://dt.example/ws', ticket: 'T' }),
        text: async () => ''
      }
    }) as unknown as typeof fetch
    const { wsFactory } = harness()
    const t = createDingTalkTransport(CREDS, { fetchImpl, wsFactory })
    await t.connect(async () => {})
    expect(bodies[0]).toMatchObject({
      clientId: 'APPKEY',
      clientSecret: 'APPSECRET',
      subscriptions: [
        { type: 'EVENT', topic: '*' },
        { type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }
      ]
    })
    await t.disconnect()
  })

  it('THROWS when the gateway handshake is refused', async () => {
    const { wsFactory } = harness()
    const t = createDingTalkTransport(CREDS, { fetchImpl: gatewayFetch({ ok: false }), wsFactory })
    await expect(t.connect(async () => {})).rejects.toThrow(/gateway open failed: HTTP 401/)
  })

  it('THROWS when the socket closes before it opens', async () => {
    const wsFactory = (): FakeSocket => {
      const s = new FakeSocket()
      setTimeout(() => s.onclose?.(), 0)
      return s
    }
    const t = createDingTalkTransport(CREDS, { fetchImpl: gatewayFetch(), wsFactory })
    await expect(t.connect(async () => {})).rejects.toThrow(/closed before it opened/)
  })
})

describe('inbound dispatch + ack discipline', () => {
  const botFrame = (payload: DingTalkBotPayload, messageId = 'm-1'): unknown => ({
    specVersion: '1.0',
    type: 'CALLBACK',
    headers: {
      topic: '/v1.0/im/bot/messages/get',
      messageId,
      contentType: 'application/json'
    },
    data: JSON.stringify(payload)
  })

  it('dispatches a text message and acks it', async () => {
    const { socket, wsFactory } = harness()
    const seen: string[] = []
    const t = createDingTalkTransport(CREDS, { fetchImpl: gatewayFetch(), wsFactory })
    await t.connect(async (m) => {
      seen.push(m.text)
    })
    socket.push(botFrame(groupText()))
    await vi.waitFor(() => expect(seen).toEqual(['hello']))
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      code: 200,
      headers: { messageId: 'm-1' }
    })
    await t.disconnect()
  })

  it('dispatches a FILE message instead of dropping it (trap 1, end to end)', async () => {
    const { socket, wsFactory } = harness()
    const seen: string[] = []
    const t = createDingTalkTransport(CREDS, { fetchImpl: gatewayFetch(), wsFactory })
    await t.connect(async (m) => {
      seen.push(m.text)
    })
    socket.push(
      botFrame(groupText({ msgtype: 'file', text: undefined, content: { fileName: 'q3.pdf', downloadCode: 'dc' } }))
    )
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toContain('q3.pdf')
    await t.disconnect()
  })

  it('STILL acks when the sink throws — an unacked frame is redelivered for ~60s', async () => {
    const { socket, wsFactory } = harness()
    const t = createDingTalkTransport(CREDS, { fetchImpl: gatewayFetch(), wsFactory })
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    await t.connect(async () => {
      throw new Error('handler blew up')
    })
    socket.push(botFrame(groupText()))
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    expect(JSON.parse(JSON.parse(socket.sent[0]).data)).toEqual({ response: 'error' })
    await t.disconnect()
  })

  it('acks an unroutable payload rather than leaving it to be redelivered', async () => {
    const { socket, wsFactory } = harness()
    const seen: unknown[] = []
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = createDingTalkTransport(CREDS, { fetchImpl: gatewayFetch(), wsFactory })
    await t.connect(async (m) => {
      seen.push(m)
    })
    socket.push(botFrame(groupText({ senderStaffId: undefined, senderId: undefined })))
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    expect(seen).toHaveLength(0)
    // Visibly ignored: warned, and acked.
    expect(console.warn).toHaveBeenCalled()
    await t.disconnect()
  })

  it('answers a SYSTEM ping by echoing it back', async () => {
    const { socket, wsFactory } = harness()
    const t = createDingTalkTransport(CREDS, { fetchImpl: gatewayFetch(), wsFactory })
    await t.connect(async () => {})
    socket.push({ type: 'SYSTEM', headers: { topic: 'ping', messageId: 'p-1' }, data: '{"n":1}' })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const ack = JSON.parse(socket.sent[0])
    expect(ack.headers.topic).toBe('ping')
    expect(ack.data).toBe('{"n":1}')
    expect(socket.closed).toBe(false)
    await t.disconnect()
  })

  it('closes the socket on a SYSTEM disconnect so a fresh ticket is fetched', async () => {
    const { socket, wsFactory } = harness()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const t = createDingTalkTransport(CREDS, { fetchImpl: gatewayFetch(), wsFactory })
    await t.connect(async () => {})
    socket.push({ type: 'SYSTEM', headers: { topic: 'disconnect', messageId: 'd-1' }, data: '{}' })
    expect(socket.sent).toHaveLength(1) // acked first
    expect(socket.closed).toBe(true)
    await t.disconnect()
  })

  it('acks an EVENT frame as SUCCESS', async () => {
    const { socket, wsFactory } = harness()
    const t = createDingTalkTransport(CREDS, { fetchImpl: gatewayFetch(), wsFactory })
    await t.connect(async () => {})
    socket.push({ type: 'EVENT', headers: { messageId: 'e-1', eventType: 'org_dept_create' }, data: '{}' })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    expect(JSON.parse(JSON.parse(socket.sent[0]).data)).toEqual({ status: 'SUCCESS' })
    await t.disconnect()
  })

  it('learns the reply route from inbound traffic, so a raw vendor id also sends', async () => {
    const posts: string[] = []
    const fetchImpl = (async (url: string) => {
      posts.push(String(url))
      if (String(url).includes('/gateway/connections/open')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ endpoint: 'wss://dt.example/ws', ticket: 'T' }),
          text: async () => ''
        }
      }
      if (String(url).includes('/oauth2/accessToken')) {
        return { ok: true, status: 200, json: async () => ({ accessToken: 'AT', expireIn: 7200 }), text: async () => '' }
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
    }) as unknown as typeof fetch
    const { socket, wsFactory } = harness()
    const t = createDingTalkTransport(CREDS, { fetchImpl, wsFactory })
    await t.connect(async () => {})
    socket.push(botFrame(groupText()))
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    // 'cidABC==' is the raw vendor id, unprefixed — routable now that it was seen.
    await expect(t.send('cidABC==', 'hi')).resolves.toBeUndefined()
    expect(posts.some((u) => u.includes('/robot/groupMessages/send'))).toBe(true)
    await t.disconnect()
  })

  it('warns and acks an unexpected callback topic instead of hot-looping on it', async () => {
    const { socket, wsFactory } = harness()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = createDingTalkTransport(CREDS, { fetchImpl: gatewayFetch(), wsFactory })
    await t.connect(async () => {})
    socket.push({
      type: 'CALLBACK',
      headers: { topic: '/v1.0/card/instances/callback', messageId: 'c-1' },
      data: '{}'
    })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    expect(console.warn).toHaveBeenCalled()
    await t.disconnect()
  })
})

describe('lifecycle', () => {
  it('capabilities are empty — nothing beyond send/receive is actually supported', () => {
    expect(createDingTalkTransport(CREDS).capabilities()).toEqual([])
  })

  it('exposes the stable platform id', () => {
    expect(createDingTalkTransport(CREDS).id).toBe('dingtalk')
  })

  it('disconnect is safe when never connected', async () => {
    await expect(createDingTalkTransport(CREDS).disconnect()).resolves.toBeUndefined()
  })

  it('connect throws without credentials rather than reporting a live channel', async () => {
    await expect(
      createDingTalkTransport({ appKey: '', appSecret: '' }).connect(async () => {})
    ).rejects.toThrow(/not configured/)
  })

  it('does not reconnect after an explicit disconnect', async () => {
    const { socket, wsFactory, urls } = harness()
    const t = createDingTalkTransport(CREDS, { fetchImpl: gatewayFetch(), wsFactory })
    await t.connect(async () => {})
    await t.disconnect()
    socket.onclose?.() // a late close from the socket teardown
    await new Promise((r) => setTimeout(r, 20))
    expect(urls).toHaveLength(1)
  })
})
