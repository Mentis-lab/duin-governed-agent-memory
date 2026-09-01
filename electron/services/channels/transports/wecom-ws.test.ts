import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parseWeComCallback,
  shouldRefreshToken,
  reconnectDelay,
  createWeComTransport,
  WECOM_API_BASE,
  type WeComCallbackBody,
  type MinimalWebSocket,
  type WebSocketCtor
} from './wecom-ws'
import type { TransportMessage } from './transport'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── payload → TransportMessage ──────────────────────────────────────────────

const cb = (over: Partial<WeComCallbackBody> = {}): WeComCallbackBody => ({
  msgid: 'MSG1',
  aibotid: 'BOT1',
  chattype: 'single',
  from: { userid: 'zhangsan' },
  msgtype: 'text',
  text: { content: 'hello' },
  ...over
})

describe('parseWeComCallback — id selection', () => {
  it('uses the STABLE userid as the pairing subject', () => {
    const msg = parseWeComCallback(cb())
    expect(msg?.userId).toBe('zhangsan')
    expect(msg?.text).toBe('hello')
    expect(msg?.messageId).toBe('MSG1')
  })

  it('addresses a SINGLE chat by userid — WeCom omits chatid there', () => {
    // The callback for a 1:1 chat carries no chatid at all, and WeCom's own send API
    // defines the single-chat conversation id as the userid. Leaving conversationId
    // empty would make every reply undeliverable.
    expect(parseWeComCallback(cb({ chattype: 'single', chatid: undefined }))?.conversationId).toBe('zhangsan')
  })

  it('addresses a GROUP chat by chatid, never by the sender', () => {
    const msg = parseWeComCallback(cb({ chattype: 'group', chatid: 'wrGROUP1' }))
    expect(msg?.conversationId).toBe('wrGROUP1')
    expect(msg?.userId).toBe('zhangsan') // still the person, for the pairing gate
  })

  it('drops a group callback with no chatid — there is nothing to reply to', () => {
    expect(parseWeComCallback(cb({ chattype: 'group', chatid: undefined }))).toBeNull()
  })

  it('never claims a threadId (the AI-bot surface is flat)', () => {
    expect(parseWeComCallback(cb())?.threadId).toBeUndefined()
  })
})

describe('parseWeComCallback — what counts as text', () => {
  it('takes voice, which WeCom delivers already transcribed', () => {
    const msg = parseWeComCallback(cb({ msgtype: 'voice', text: undefined, voice: { content: '开个会' } }))
    expect(msg?.text).toBe('开个会')
  })

  it('takes the text items out of a mixed (image+text) post', () => {
    const msg = parseWeComCallback(
      cb({
        msgtype: 'mixed',
        text: undefined,
        mixed: {
          msg_item: [
            { msgtype: 'text', text: { content: 'look at' } },
            { msgtype: 'image' },
            { msgtype: 'text', text: { content: 'this' } }
          ]
        }
      })
    )
    expect(msg?.text).toBe('look at this')
  })

  it('drops payloads with no usable text or no sender', () => {
    expect(parseWeComCallback(cb({ msgtype: 'image', text: undefined }))).toBeNull()
    expect(parseWeComCallback(cb({ text: { content: '   ' } }))).toBeNull()
    expect(parseWeComCallback(cb({ from: undefined }))).toBeNull()
  })
})

// ── token refresh decision ──────────────────────────────────────────────────

describe('shouldRefreshToken', () => {
  const now = 1_700_000_000_000

  it('refreshes when there is no token', () => {
    expect(shouldRefreshToken(null, now)).toBe(true)
    expect(shouldRefreshToken({ token: '', expiresAt: now + 7_200_000 }, now)).toBe(true)
  })

  it('keeps a healthy token (no re-fetch per call — WeCom rate-limits gettoken)', () => {
    expect(shouldRefreshToken({ token: 'T', expiresAt: now + 7_200_000 }, now)).toBe(false)
  })

  it('refreshes EARLY, inside the margin, not at the exact expiry second', () => {
    // A call started at T-1s can land after expiry and fail with 42001 for a reason no
    // operator can act on. 5 minutes of margin is the whole point of the decision.
    expect(shouldRefreshToken({ token: 'T', expiresAt: now + 4 * 60_000 }, now)).toBe(true)
    expect(shouldRefreshToken({ token: 'T', expiresAt: now + 6 * 60_000 }, now)).toBe(false)
  })

  it('refreshes an already-expired token', () => {
    expect(shouldRefreshToken({ token: 'T', expiresAt: now - 1 }, now)).toBe(true)
  })
})

describe('reconnectDelay', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect(reconnectDelay(0)).toBe(1_000)
    expect(reconnectDelay(1)).toBe(2_000)
    expect(reconnectDelay(4)).toBe(16_000)
    expect(reconnectDelay(5)).toBe(30_000) // 32s clamped
    expect(reconnectDelay(50)).toBe(30_000)
  })
})

// ── socket lifecycle, with the network faked ────────────────────────────────

interface SentFrame {
  cmd?: string
  headers?: { req_id?: string }
  body?: Record<string, unknown>
}

/** A scriptable stand-in for the global WebSocket. Nothing dials out. */
class FakeSocket implements MinimalWebSocket {
  static last: FakeSocket | null = null
  sent: SentFrame[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  /** Per-cmd ack errcode; absent ⇒ no automatic ack. */
  autoAck: Record<string, number> = {}

  constructor(public url: string) {
    FakeSocket.last = this
  }
  send(data: string): void {
    const frame = JSON.parse(data) as SentFrame
    this.sent.push(frame)
    const code = frame.cmd ? this.autoAck[frame.cmd] : undefined
    if (code === undefined) return
    queueMicrotask(() => this.recv({ headers: { req_id: frame.headers?.req_id }, errcode: code, errmsg: 'ack' }))
  }
  close(): void {
    this.closed = true
  }
  recv(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  lastOf(cmd: string): SentFrame | undefined {
    return [...this.sent].reverse().find((f) => f.cmd === cmd)
  }
}

const Ctor = FakeSocket as unknown as WebSocketCtor

function transport(over: { botId?: string; secret?: string } = {}): ReturnType<typeof createWeComTransport> {
  return createWeComTransport({
    corpId: 'ww_corp',
    secret: 'BOT_SECRET',
    botId: 'BOT1',
    webSocket: Ctor,
    ...over
  })
}

/** Bring a transport up: dial → open → ack the subscribe. */
async function connected(
  sink: (m: TransportMessage) => Promise<void> = async () => undefined
): Promise<{ t: ReturnType<typeof createWeComTransport>; sock: FakeSocket }> {
  const t = transport()
  const p = t.connect(sink)
  const sock = FakeSocket.last as FakeSocket
  sock.onopen?.()
  await Promise.resolve()
  const sub = sock.lastOf('aibot_subscribe')
  sock.recv({ headers: { req_id: sub?.headers?.req_id }, errcode: 0, errmsg: 'ok' })
  await p
  return { t, sock }
}

describe('connect — the long connection is the only inbound model', () => {
  it('REFUSES to run without a botId instead of falling back to a callback URL', async () => {
    // The whole reason WeCom is usable at this tier is that (b) needs no public HTTPS
    // endpoint. Quietly building the webhook path would defeat that, so this is a
    // deliberate dead end.
    await expect(transport({ botId: undefined }).connect(async () => undefined)).rejects.toThrow(
      /botId is required.*long connection/s
    )
  })

  it('authenticates in-band with bot_id + secret (no corpid, no access_token)', async () => {
    const { t, sock } = await connected()
    const sub = sock.lastOf('aibot_subscribe')
    expect(sub?.body).toEqual({ bot_id: 'BOT1', secret: 'BOT_SECRET' })
    await t.disconnect()
  })

  it('does NOT resolve before the subscribe is acked', async () => {
    const t = transport()
    let resolved = false
    const p = t.connect(async () => undefined).then(() => {
      resolved = true
    })
    const sock = FakeSocket.last as FakeSocket
    sock.onopen?.()
    await Promise.resolve()
    // Socket is open and the frame is written, but WeCom has not accepted us yet.
    expect(resolved).toBe(false)
    const sub = sock.lastOf('aibot_subscribe')
    sock.recv({ headers: { req_id: sub?.headers?.req_id }, errcode: 0, errmsg: 'ok' })
    await p
    expect(resolved).toBe(true)
    await t.disconnect()
  })

  it('throws when WeCom rejects the credentials', async () => {
    const t = transport()
    const p = t.connect(async () => undefined)
    const sock = FakeSocket.last as FakeSocket
    sock.onopen?.()
    await Promise.resolve()
    const sub = sock.lastOf('aibot_subscribe')
    sock.recv({ headers: { req_id: sub?.headers?.req_id }, errcode: 40001, errmsg: 'invalid secret' })
    await expect(p).rejects.toThrow(/40001.*invalid secret/)
  })
})

describe('capabilities', () => {
  it('claims nothing it cannot do — no threads, no directory picker', () => {
    expect(transport().capabilities()).toEqual([])
    expect(transport().id).toBe('wecom')
    expect(transport().sendFile).toBeUndefined()
  })
})

describe('inbound callbacks reach the sink', () => {
  it('delivers a parsed message and remembers the chat kind', async () => {
    const seen: TransportMessage[] = []
    const { t, sock } = await connected(async (m) => {
      seen.push(m)
    })
    sock.recv({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'CB1' },
      body: cb({ chattype: 'group', chatid: 'wrGROUP1' })
    })
    await Promise.resolve()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ userId: 'zhangsan', conversationId: 'wrGROUP1', text: 'hello' })
    await t.disconnect()
  })
})

describe('send — resolving must mean delivered', () => {
  it('throws when there is no authenticated connection', async () => {
    await expect(transport().send('zhangsan', 'hi')).rejects.toThrow(/not connected/)
  })

  it('replies in place, against the callback req_id, and waits for the ack', async () => {
    const { t, sock } = await connected()
    sock.recv({ cmd: 'aibot_msg_callback', headers: { req_id: 'CB1' }, body: cb() })
    await Promise.resolve()
    sock.autoAck = { aibot_respond_msg: 0 }
    await t.send('zhangsan', 'pong')
    const reply = sock.lastOf('aibot_respond_msg')
    expect(reply?.headers?.req_id).toBe('CB1') // echoes the callback, not a fresh id
    expect(reply?.body).toMatchObject({ msgtype: 'stream', stream: { finish: true, content: 'pong' } })
    await t.disconnect()
  })

  it('pushes proactively when no callback is outstanding, with the right chat_type', async () => {
    const { t, sock } = await connected()
    sock.recv({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'CB1' },
      body: cb({ chattype: 'group', chatid: 'wrGROUP1' })
    })
    await Promise.resolve()
    // A reply that fails its window falls through to the push frame rather than
    // reporting a delivery that did not happen.
    sock.autoAck = { aibot_respond_msg: 95000, aibot_send_msg: 0 }
    await t.send('wrGROUP1', 'later')
    expect(sock.lastOf('aibot_send_msg')?.body).toMatchObject({
      chatid: 'wrGROUP1',
      chat_type: 2,
      msgtype: 'markdown',
      markdown: { content: 'later' }
    })
    await t.disconnect()
  })

  it('THROWS when both the reply and the push are rejected', async () => {
    const { t, sock } = await connected()
    sock.recv({ cmd: 'aibot_msg_callback', headers: { req_id: 'CB1' }, body: cb() })
    await Promise.resolve()
    sock.autoAck = { aibot_respond_msg: 95000, aibot_send_msg: 45009 }
    await expect(t.send('zhangsan', 'hi')).rejects.toThrow(/45009/)
    await t.disconnect()
  })

  it('rejects an over-long reply locally, naming the real limit', async () => {
    const { t } = await connected()
    await expect(t.send('zhangsan', 'x'.repeat(20_481))).rejects.toThrow(/20480-byte limit/)
    await t.disconnect()
  })
})

describe('listTargets — the only path that needs an access_token', () => {
  const okToken = { errcode: 0, access_token: 'TOKEN1', expires_in: 7200 }

  it('acquires a token from corpId+secret, then caches it across calls', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url)
      const body = url.includes('/gettoken') ? okToken : { errcode: 0, dept_user: [{ userid: 'zhangsan' }] }
      return { ok: true, status: 200, json: async () => body } as never
    })
    const t = transport()
    expect(await t.listTargets?.()).toEqual([{ id: 'zhangsan', name: 'zhangsan', kind: 'user' }])
    await t.listTargets?.()
    expect(calls[0]).toBe(`${WECOM_API_BASE}/gettoken?corpid=ww_corp&corpsecret=BOT_SECRET`)
    expect(calls.filter((u) => u.includes('/gettoken'))).toHaveLength(1)
  })

  it('surfaces a WeCom errcode instead of returning an empty picker', async () => {
    // An API-mode bot secret is rejected here (40001). An empty list would read as
    // "you have no contacts"; the operator needs the actual reason.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ errcode: 40001, errmsg: 'invalid credential' })
    }) as never)
    await expect(transport().listTargets?.()).rejects.toThrow(/40001.*invalid credential/)
  })
})
