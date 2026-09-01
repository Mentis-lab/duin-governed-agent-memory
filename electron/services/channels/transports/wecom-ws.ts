// WeCom (企业微信) transport — the AI-bot LONG CONNECTION, not the callback webhook.
//
// WeCom offers two inbound models and they are not interchangeable:
//
//   (a) 自建应用 self-built app + 接收消息回调 — WeCom POSTs to a URL you host. The
//       docs are explicit that it must be publicly reachable ("企业需要保证回调服务的
//       地址有效"), and it carries the GET echostr handshake plus Token/EncodingAESKey
//       crypto. That is a public HTTPS domain, a tunnel, or nothing.
//   (b) 智能机器人 API 模式 + 长连接 — WE dial OUT to a fixed WSS endpoint and
//       authenticate in-band. No inbound port, no domain, no TLS certificate.
//
// This implements (b), which is the only reason WeCom is viable for this tier: the
// operator needs no infrastructure at all. Building (a) here would have silently
// re-introduced the exact requirement the channel was chosen to avoid, so there is
// deliberately NO callback fallback — connect() throws and names the missing bot id
// rather than degrading into a mode that cannot work without a server.
//
// Reference: developer.work.weixin.qq.com/document/path/101463 (长连接), /101039
// (智能机器人), /91039 (access_token). The frame grammar below matches the official
// @wecom/aibot-node-sdk; the protocol is implemented directly because that package is
// not a dependency of this app and it only wraps ~10 JSON frame shapes.
//
// SECURITY: no keychain, no pairing store, no gateway — credentials arrive as
// arguments (see transport.ts). The pairing subject is `from.userid`, WeCom's stable
// member id, never a display name.
//
// WHAT COULD NOT BE VERIFIED HERE: everything past the wire format. A live socket
// needs a real 智能机器人 provisioned in a WeCom org (工作台 → 智能机器人 → API 模式,
// which a super-admin must first unlock), so the socket lifecycle is a human-verify
// item. The PURE parts — callback → TransportMessage, the token-refresh decision, the
// reconnect delay — are unit-tested.

import { messageOf } from '../../guarded'
import type { ChannelTransport, TransportCapability, TransportMessage, TransportTarget } from './transport'

const TRANSPORT_ID = 'wecom'

/** Fixed for public WeCom. Private deployments get their own address from the admin
 *  console, hence the override — the SDK exposes the same escape hatch. */
export const WECOM_WS_URL = 'wss://openws.work.weixin.qq.com'
/** Corp OpenAPI root. Used ONLY by listTargets(); the long connection itself never
 *  touches HTTP (see the access-token note on createWeComTransport). */
export const WECOM_API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin'

// ── wire commands (WsCmd) ───────────────────────────────────────────────────
const CMD_SUBSCRIBE = 'aibot_subscribe'
const CMD_PING = 'ping'
const CMD_RESPOND = 'aibot_respond_msg'
const CMD_SEND = 'aibot_send_msg'
const CMD_MSG_CALLBACK = 'aibot_msg_callback'
const CMD_EVENT_CALLBACK = 'aibot_event_callback'

/** 30s is the documented recommendation; longer idles get reaped server-side. */
const HEARTBEAT_MS = 30_000
/** Two unanswered pings (60s of silence) before we stop believing the socket. A
 *  half-open TCP connection reports neither close nor error, so the heartbeat is the
 *  only thing that can notice it — without this the transport reports 'connected'
 *  forever while no message can arrive, which is the dishonesty transport.ts's
 *  connect() contract exists to prevent. */
const MAX_MISSED_PINGS = 2
const ACK_TIMEOUT_MS = 10_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/** Streamed reply content cap, from the protocol: 20480 bytes, UTF-8. Checked
 *  locally so an oversized reply fails with the actual reason instead of a bare
 *  server errcode. */
const MAX_REPLY_BYTES = 20_480
/** How long an inbound callback's req_id stays usable for an in-place reply. The docs
 *  quote three different windows for three different things (5s to answer enter_chat,
 *  10min to finish a stream, 24h to reply at all), so this picks the tightest one that
 *  plainly covers a reply and does not depend on guessing: past it, send() uses the
 *  proactive-push frame instead, and a rejected respond falls back to push anyway. */
const RESPOND_WINDOW_MS = 10 * 60_000
/** access_token lives 7200s; refresh 5 min early so an in-flight call never races the
 *  expiry it just checked. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000

// ─────────────────────── wire shapes ───────────────────────

/** Every frame in both directions: `{ cmd, headers: { req_id }, body }`. Acks come
 *  back with no `cmd`, the SAME req_id, and an errcode. */
export interface WeComFrame<T = unknown> {
  cmd?: string
  headers?: { req_id?: string }
  body?: T
  errcode?: number
  errmsg?: string
}

interface WeComTextContent {
  content?: string
}
interface WeComMixedItem {
  msgtype?: string
  text?: WeComTextContent
}
export interface WeComCallbackBody {
  msgid?: string
  aibotid?: string
  /** Present for group chats. A single chat identifies itself by the sender. */
  chatid?: string
  chattype?: 'single' | 'group' | string
  from?: { userid?: string }
  msgtype?: string
  text?: WeComTextContent
  /** Voice arrives already transcribed, so it is text as far as a turn is concerned. */
  voice?: WeComTextContent
  mixed?: { msg_item?: WeComMixedItem[] }
}

interface WeComEventBody {
  event?: { eventtype?: string }
}

/** Minimal WebSocket surface. Node 22+/Electron ship a global WebSocket; typing it
 *  locally avoids pulling the DOM lib into the node tsconfig (same shape discord.ts
 *  uses) and keeps the transport testable with a fake constructor. */
export interface MinimalWebSocket {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: ((err: unknown) => void) | null
}
export type WebSocketCtor = new (url: string) => MinimalWebSocket

// ─────────────────────── pure decisions ───────────────────────

/**
 * PURE mapper: one `aibot_msg_callback` body → a TransportMessage, or null when it is
 * not a routable text turn.
 *
 * ID SELECTION, which is the part that matters for authorization:
 *   · userId is `from.userid` — WeCom's stable member id. Never a display name; the
 *     callback does not even carry one, and a pairing keyed on a name would follow the
 *     name rather than the person.
 *   · conversationId is `chatid` for a group. A SINGLE chat omits chatid entirely, and
 *     WeCom's own send API defines the single-chat conversation id as the userid, so
 *     that is what a reply must be addressed to.
 *
 * No threadId: the AI bot surface is flat. `req_id` correlates a reply to a callback,
 * but it is a per-frame handle, not a conversation the platform would thread on, so
 * claiming it here would make the 'threads' capability a lie.
 */
export function parseWeComCallback(body: WeComCallbackBody): TransportMessage | null {
  const userId = body.from?.userid
  if (!userId) return null
  const isGroup = body.chattype === 'group'
  const conversationId = isGroup ? body.chatid : (body.chatid ?? userId)
  if (!conversationId) return null
  const text = textOf(body)
  if (!text) return null
  return {
    userId,
    conversationId,
    text,
    ...(body.msgid ? { messageId: body.msgid } : {}),
    raw: body
  }
}

/** text / voice (already transcribed) / mixed (the text items of an image+text post).
 *  Everything else — bare image, file, video — has no text for a turn to act on. */
function textOf(body: WeComCallbackBody): string {
  if (body.msgtype === 'text') return (body.text?.content ?? '').trim()
  if (body.msgtype === 'voice') return (body.voice?.content ?? '').trim()
  if (body.msgtype === 'mixed') {
    return (body.mixed?.msg_item ?? [])
      .filter((i) => i.msgtype === 'text')
      .map((i) => i.text?.content ?? '')
      .join(' ')
      .trim()
  }
  return ''
}

export interface TokenCache {
  token: string
  /** ms epoch at which WeCom stops honouring this token. */
  expiresAt: number
}

/**
 * PURE decision: must we fetch a new access_token before the next call?
 *
 * Yes when there is none, when it is already expired, and when it expires within the
 * margin — the last case is the one that matters. WeCom issues a 7200s token and
 * refusing to renew until the exact second it dies means a call started at T-1s can
 * arrive after expiry and fail with 42001 for no reason the operator can act on.
 */
export function shouldRefreshToken(cache: TokenCache | null, now: number): boolean {
  if (!cache || !cache.token) return true
  return cache.expiresAt - now <= TOKEN_REFRESH_MARGIN_MS
}

/** PURE: exponential backoff, 1s doubling to a 30s ceiling. Attempt is 0-based. */
export function reconnectDelay(attempt: number): number {
  const raw = RECONNECT_BASE_MS * 2 ** Math.max(0, attempt)
  return Math.min(raw, RECONNECT_MAX_MS)
}

let reqCounter = 0
function newReqId(prefix: string): string {
  reqCounter += 1
  return `${prefix}_${Date.now()}_${reqCounter}`
}

// ─────────────────────── the transport ───────────────────────

export interface WeComTransportOptions {
  /** Corp id. Used only for the corp OpenAPI (listTargets); the long connection
   *  authenticates with bot_id + secret and never sees it. */
  corpId: string
  /** The 智能机器人 Secret for the long connection. WeCom's docs call this out
   *  explicitly: it is NOT the callback mode's Token/EncodingAESKey, and it is not an
   *  app secret. */
  secret: string
  /** Bot id from 工作台 → 智能机器人 → API 模式. REQUIRED to receive anything. */
  botId?: string
  /** Private-deployment override for the WSS address. */
  wsUrl?: string
  /** Injectable for tests. Defaults to the global WebSocket. */
  webSocket?: WebSocketCtor
}

/**
 * Build a WeCom transport over the AI-bot long connection.
 *
 * ON access_token: the long connection does not use one. Authentication is the
 * in-band `aibot_subscribe` frame carrying bot_id + secret, and every message — inbound
 * callback, reply, proactive push, even media upload — travels over the same socket.
 * The official SDK says the same thing in its one HTTP file ("消息收发均走 WebSocket
 * 通道"). So the classic `gettoken?corpid=&corpsecret=` token is needed for exactly one
 * thing this transport can do: enumerating conversations for the target picker. It is
 * acquired lazily there, cached, and refreshed early — the transport owns it, nothing
 * else in the app does — and it is never on the receive path, so a corp API that
 * refuses these credentials cannot stop messages from arriving.
 */
export function createWeComTransport(opts: WeComTransportOptions): ChannelTransport {
  const wsUrl = opts.wsUrl ?? WECOM_WS_URL

  let sink: ((msg: TransportMessage) => Promise<void>) | null = null
  let ws: MinimalWebSocket | null = null
  let running = false
  let authed = false
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let missedPings = 0
  let attempt = 0
  let token: TokenCache | null = null

  /** Frames we have written and not yet seen an ack for, keyed by req_id. */
  const pending = new Map<
    string,
    { resolve: (f: WeComFrame) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  /** The most recent inbound callback per conversation, so a reply can go back as a
   *  response to that message rather than as an unrelated push. */
  const lastCallback = new Map<string, { reqId: string; at: number }>()
  /** chattype per conversation, for the push frame's chat_type. */
  const chatKind = new Map<string, 'single' | 'group'>()
  /** Sends are serialised: WeCom caps a conversation at 30 msg/min, and the protocol
   *  keys acks on req_id — two replies in flight against the same callback would race
   *  for the same ack. */
  let sendChain: Promise<unknown> = Promise.resolve()

  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = sendChain.then(fn, fn)
    sendChain = run.catch(() => undefined)
    return run
  }

  /** Resolve/reject whichever write was waiting on this frame's req_id. */
  function settleAck(frame: WeComFrame): boolean {
    const reqId = frame.headers?.req_id
    if (!reqId) return false
    const p = pending.get(reqId)
    if (!p) return false
    pending.delete(reqId)
    clearTimeout(p.timer)
    if (typeof frame.errcode === 'number' && frame.errcode !== 0) {
      p.reject(new Error(`wecom errcode ${frame.errcode}: ${frame.errmsg ?? 'unknown'}`))
    } else {
      p.resolve(frame)
    }
    return true
  }

  function rejectAllPending(reason: string): void {
    for (const [reqId, p] of pending) {
      clearTimeout(p.timer)
      p.reject(new Error(`wecom: ${reason} (req ${reqId})`))
    }
    pending.clear()
  }

  /** Write a frame and wait for its ack. Rejecting is the whole point: it is what lets
   *  send() honour "resolving means DELIVERED". */
  function request(cmd: string, reqId: string, body?: unknown, timeoutMs = ACK_TIMEOUT_MS): Promise<WeComFrame> {
    const sock = ws
    if (!sock) return Promise.reject(new Error('wecom: socket is not open'))
    return new Promise<WeComFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId)
        reject(new Error(`wecom: no ack for ${cmd} within ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(reqId, { resolve, reject, timer })
      const frame: WeComFrame = body === undefined ? { cmd, headers: { req_id: reqId } } : { cmd, headers: { req_id: reqId }, body }
      try {
        sock.send(JSON.stringify(frame))
      } catch (e) {
        pending.delete(reqId)
        clearTimeout(timer)
        reject(new Error(`wecom: socket write failed: ${messageOf(e)}`, { cause: e }))
      }
    })
  }

  function stopHeartbeat(): void {
    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
  }

  function startHeartbeat(): void {
    stopHeartbeat()
    missedPings = 0
    heartbeat = setInterval(() => {
      request(CMD_PING, newReqId(CMD_PING)).then(
        () => {
          missedPings = 0
        },
        (e: unknown) => {
          missedPings += 1
          console.debug('[wecom] heartbeat unanswered:', messageOf(e))
          if (missedPings >= MAX_MISSED_PINGS) dropAndReconnect('heartbeat lost')
        }
      )
    }, HEARTBEAT_MS)
  }

  function closeSocket(): void {
    stopHeartbeat()
    authed = false
    const sock = ws
    ws = null
    if (!sock) return
    sock.onopen = null
    sock.onmessage = null
    sock.onclose = null
    sock.onerror = null
    try {
      sock.close()
    } catch (e) {
      console.debug('[wecom] close failed:', messageOf(e))
    }
  }

  function dropAndReconnect(reason: string): void {
    closeSocket()
    rejectAllPending(reason)
    if (running) scheduleReconnect(reason)
  }

  function scheduleReconnect(reason: string): void {
    if (retryTimer) return
    const delay = reconnectDelay(attempt)
    attempt += 1
    console.debug(`[wecom] reconnecting in ${delay}ms (${reason})`)
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!running) return
      dial().catch((e: unknown) => {
        console.debug('[wecom] reconnect failed:', messageOf(e))
        if (running) scheduleReconnect('reconnect failed')
      })
    }, delay)
  }

  function handleFrame(frame: WeComFrame): void {
    // Acks carry no cmd, only the req_id they answer. Auth, heartbeat and every reply
    // land here first.
    if (settleAck(frame)) return
    if (frame.cmd === CMD_MSG_CALLBACK) {
      const body = (frame.body ?? {}) as WeComCallbackBody
      const msg = parseWeComCallback(body)
      if (!msg) return
      const reqId = frame.headers?.req_id
      if (reqId) lastCallback.set(msg.conversationId, { reqId, at: Date.now() })
      chatKind.set(msg.conversationId, body.chattype === 'group' ? 'group' : 'single')
      void sink?.(msg).catch((e: unknown) => console.debug('[wecom] onMessage failed:', messageOf(e)))
      return
    }
    if (frame.cmd === CMD_EVENT_CALLBACK) {
      const kind = ((frame.body ?? {}) as WeComEventBody).event?.eventtype
      if (kind === 'disconnected_event') {
        // Another client authenticated as this bot and WeCom is evicting us: the
        // protocol allows exactly one live connection per bot. Racing back in would
        // ping-pong the two clients forever, so jump straight to the backoff ceiling
        // and let the operator's other process win or die.
        attempt = Math.ceil(Math.log2(RECONNECT_MAX_MS / RECONNECT_BASE_MS))
        dropAndReconnect('evicted by another connection for this bot')
      }
      return
    }
  }

  /** Open the socket and authenticate. Resolves only after WeCom acks the subscribe —
   *  before that, no message can arrive, and resolving early would make the gateway
   *  report a dead channel as running. */
  function dial(): Promise<void> {
    const Ctor = opts.webSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket
    if (!Ctor) throw new Error('wecom: no WebSocket implementation available in this runtime')
    const botId = opts.botId
    if (!botId) throw new Error('wecom: botId is required — see createWeComTransport')

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (err?: Error): void => {
        if (settled) return
        settled = true
        if (err) reject(err)
        else resolve()
      }

      let sock: MinimalWebSocket
      try {
        sock = new Ctor(wsUrl)
      } catch (e) {
        finish(new Error(`wecom: could not open ${wsUrl}: ${messageOf(e)}`, { cause: e }))
        return
      }
      ws = sock

      sock.onopen = (): void => {
        const reqId = newReqId(CMD_SUBSCRIBE)
        request(CMD_SUBSCRIBE, reqId, { bot_id: botId, secret: opts.secret }).then(
          () => {
            authed = true
            attempt = 0
            startHeartbeat()
            finish()
          },
          (e: unknown) => {
            // A rejected subscribe is terminal for THIS socket: bad bot id or secret
            // will not fix itself on a retry, so surface it rather than looping.
            closeSocket()
            finish(new Error(`wecom: subscribe rejected: ${messageOf(e)}`, { cause: e }))
          }
        )
      }
      sock.onmessage = (ev): void => {
        try {
          handleFrame(JSON.parse(String(ev.data)) as WeComFrame)
        } catch (e) {
          console.debug('[wecom] bad frame:', messageOf(e))
        }
      }
      sock.onerror = (err): void => {
        console.debug('[wecom] socket error:', messageOf(err))
        finish(new Error(`wecom: socket error: ${messageOf(err)}`))
      }
      sock.onclose = (): void => {
        const wasAuthed = authed
        authed = false
        stopHeartbeat()
        if (ws === sock) ws = null
        rejectAllPending('socket closed')
        finish(new Error('wecom: socket closed before subscribe was acked'))
        // Only a connection that had come up gets retried here; a close during dial is
        // already the caller's error, and connect() must not leave a retry loop behind
        // a promise it rejected.
        if (wasAuthed && running) scheduleReconnect('socket closed')
      }
    })
  }

  /** Lazily acquire + cache the corp access_token. Only listTargets needs this. */
  async function accessToken(): Promise<string> {
    if (!shouldRefreshToken(token, Date.now())) return (token as TokenCache).token
    const url = `${WECOM_API_BASE}/gettoken?corpid=${encodeURIComponent(opts.corpId)}&corpsecret=${encodeURIComponent(opts.secret)}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`wecom gettoken failed: HTTP ${res.status}`)
    const body = (await res.json()) as { errcode?: number; errmsg?: string; access_token?: string; expires_in?: number }
    if (body.errcode || !body.access_token) {
      throw new Error(`wecom gettoken failed: errcode ${body.errcode ?? -1}: ${body.errmsg ?? 'no access_token'}`)
    }
    token = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 7200) * 1000 }
    return token.token
  }

  async function push(conversationId: string, text: string): Promise<void> {
    const kind = chatKind.get(conversationId) ?? 'single'
    await request(CMD_SEND, newReqId(CMD_SEND), {
      chatid: conversationId,
      chat_type: kind === 'group' ? 2 : 1,
      msgtype: 'markdown',
      markdown: { content: text }
    })
  }

  return {
    id: TRANSPORT_ID,

    capabilities(): TransportCapability[] {
      // Nothing beyond send/receive. No threads (the surface is flat), no reactions, no
      // typing indicator, and sendFile is omitted rather than faked — media needs the
      // 3-frame chunked upload, and an adapter falling back to plain send() drops the
      // file honestly instead of reporting an upload that never happened.
      //
      // 'directory' is deliberately NOT declared even though listTargets() exists: it
      // reaches the corp contact API, which rejects an API-mode bot secret. Declaring
      // it would put a target picker in the UI that always errors for the credentials
      // this transport is actually configured with — the same enabled-vs-running lie
      // the connect() contract exists to prevent. listTargets stays callable for an
      // install whose secret IS a corp app secret with contact-read scope.
      return []
    },

    async connect(onMessage: (msg: TransportMessage) => Promise<void>): Promise<void> {
      if (running) return
      if (!opts.botId) {
        // Deliberate dead end. The alternative WeCom offers is the self-built-app
        // callback, which needs a public HTTPS endpoint — the exact dependency this
        // channel exists to avoid. Failing loudly here is the honest outcome.
        throw new Error(
          'wecom: botId is required. This transport uses the 智能机器人 long connection (API 模式); ' +
            'the callback/webhook model is not implemented because it needs a public HTTPS callback URL. ' +
            'Create an API-mode bot in 工作台 → 智能机器人 and use its Bot ID + Secret.'
        )
      }
      if (!opts.secret) throw new Error('wecom: secret is required (the bot Secret, not an app secret)')
      sink = onMessage
      running = true
      try {
        await dial()
      } catch (e) {
        running = false
        sink = null
        throw e instanceof Error ? e : new Error(messageOf(e), { cause: e })
      }
    },

    async disconnect(): Promise<void> {
      running = false
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      closeSocket()
      rejectAllPending('transport disconnected')
      lastCallback.clear()
      chatKind.clear()
      sink = null
      attempt = 0
    },

    async send(conversationId: string, text: string): Promise<void> {
      if (!authed || !ws) throw new Error('wecom: not connected (no authenticated long connection)')
      const bytes = Buffer.byteLength(text, 'utf8')
      if (bytes > MAX_REPLY_BYTES) {
        throw new Error(`wecom: reply is ${bytes} bytes, over the ${MAX_REPLY_BYTES}-byte limit`)
      }
      await serialize(async () => {
        const recent = lastCallback.get(conversationId)
        const fresh = recent && Date.now() - recent.at < RESPOND_WINDOW_MS && !pending.has(recent.reqId)
        if (fresh && recent) {
          try {
            await request(CMD_RESPOND, recent.reqId, {
              msgtype: 'stream',
              stream: { id: newReqId('stream'), finish: true, content: text }
            })
            return
          } catch (e) {
            // The reply window is the one number the docs give three answers for, so a
            // rejected respond is expected rather than exceptional: fall through to the
            // proactive push, which has no window. If THAT fails, send() throws.
            console.debug('[wecom] respond rejected, falling back to push:', messageOf(e))
            lastCallback.delete(conversationId)
          }
        }
        await push(conversationId, text)
      })
    },

    async listTargets(query?: string): Promise<TransportTarget[]> {
      // The one call the long connection cannot serve, and the only reason this
      // transport takes corpId at all. Requires the credential pair to be a corp app
      // secret with contact-read scope; an API-mode bot secret is rejected by WeCom
      // (errcode 40001) and that error is surfaced, not swallowed into an empty list —
      // an empty picker would read as "you have no contacts".
      const t = await accessToken()
      const res = await fetch(`${WECOM_API_BASE}/user/list_id?access_token=${encodeURIComponent(t)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limit: 1000 })
      })
      if (!res.ok) throw new Error(`wecom listTargets failed: HTTP ${res.status}`)
      const body = (await res.json()) as {
        errcode?: number
        errmsg?: string
        dept_user?: { userid?: string }[]
      }
      if (body.errcode) throw new Error(`wecom listTargets failed: errcode ${body.errcode}: ${body.errmsg ?? ''}`.trim())
      const q = (query ?? '').trim().toLowerCase()
      return (body.dept_user ?? [])
        .map((u) => u.userid)
        .filter((id): id is string => !!id)
        .filter((id) => !q || id.toLowerCase().includes(q))
        .map((id) => ({ id, name: id, kind: 'user' as const }))
    }
  }
}
