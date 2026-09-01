// DingTalk (钉钉) transport — STREAM MODE. An OUTBOUND WebSocket, in the same
// sense as the Telegram long-poll and the Discord gateway: DUIN dials out, so
// there is no public callback URL to host and the whole thing works from behind
// NAT. That is the entire reason to prefer stream mode over DingTalk's webhook
// mode, which requires a reachable HTTPS endpoint the vendor can POST to.
//
// Auth is AppKey + AppSecret, NOT a static bot token. Two different credentials
// are derived from that pair and they are not interchangeable:
//   · the GATEWAY handshake posts appKey/appSecret directly and gets back a
//     one-shot {endpoint, ticket} for a single WebSocket connection;
//   · the OpenAPI send path needs an ACCESS TOKEN with a ~2h TTL, refreshed here.
// Token refresh is the transport's own job (see accessToken below) — the
// contract in transport.ts says reconnection belongs to the transport, and a
// token that expires mid-session is the same class of problem.
//
// One token, not two, because this transport only sends text. DingTalk has TWO
// non-interchangeable token domains: api.dingtalk.com v1.0 takes the
// /v1.0/oauth2/accessToken token in an x-acs-dingtalk-access-token header (what
// we use), while the legacy oapi.dingtalk.com endpoints want the
// oapi.dingtalk.com/gettoken token as a query param. The only thing we would
// need the legacy one for is media upload, which is what an outbound-file
// capability would require — and is part of why 'files' is not declared.
//
// NO NODE SDK IS USED, deliberately. `dingtalk-stream` (open-dingtalk's official
// Node SDK) exists and is popular, but (a) it pulls in `ws` + `axios`, neither of
// which this repo depends on — Electron 43 / Node 24 give us a global WebSocket
// and a global fetch; (b) its `connect()` catches every failure and schedules a
// silent retry, so `await connect()` resolves on a connection that never opened,
// which is exactly the dishonesty transport.ts forbids; (c) its message types
// model `msgtype: 'text'` and nothing else, and its callback path emits without
// acking — which is trap 1 below, shipped. The protocol is ~4 frame shapes; it is
// cheaper to implement than to work around.
//
// PROTOCOL SOURCES (all verified against shipping code, not guessed):
//   open-dingtalk/dingtalk-stream-sdk-python  — frames.py, stream.py, handlers.py,
//     chatbot.py (gateway body, ack shapes, reconnect policy, robotCode == appKey)
//   dingtalk-stream@2.1.5 (official Node SDK)  — client.mjs (SYSTEM topic set,
//     the ping reply shape, the 60s server-side redelivery note)
//
// ─────────────────────── THE TWO TRAPS THIS DESIGN AVOIDS ───────────────────────
//
// TRAP 1 — non-text CALLBACKs silently dropped. A PDF or DOCX arrives as a
//   CALLBACK on the same bot topic as text, with `msgtype: 'file'` and no
//   `text.content`. Implementations that pattern-match on `text.content` return
//   null, never dispatch, AND never ack. Both halves hurt: the operator sees a
//   file vanish, and because DingTalk REDELIVERS an unacked stream message for
//   ~60s (documented in the official Node SDK's own socketCallBackResponse note),
//   the drop becomes a redelivery loop. So here: parseBotCallback NEVER returns
//   null for a payload with a usable sender — every msgtype produces a
//   TransportMessage, unknown ones included, with a VISIBLE placeholder and the
//   original payload on `raw`. And ackCallback runs in a `finally`, so a frame is
//   acked even when the sink throws.
//
// TRAP 2 — send() that still wants webhook config while stream is live. The
//   inbound payload carries `sessionWebhook`, and the official Python SDK's
//   reply_text() posts to it. That is a per-message, expiring URL
//   (`sessionWebhookExpiredTime`), so a transport built on it cannot honour
//   `send(conversationId, text)` at all: not after the window closes, not for a
//   conversation it has not just heard from, not after a restart. This transport
//   NEVER reads sessionWebhook. Every send goes through the OpenAPI robot
//   endpoints with the AppKey-derived access token, which is reachable from
//   stream-mode credentials alone.

import { messageOf } from '../../guarded'
import type { ChannelTransport, TransportCapability, TransportMessage } from './transport'

const CHANNEL_ID = 'dingtalk'

const API_BASE = 'https://api.dingtalk.com'
/** Handshake: exchanges appKey/appSecret for a one-shot {endpoint, ticket}. */
const OPEN_CONNECTION_URL = `${API_BASE}/v1.0/gateway/connections/open`
/** OpenAPI access token (v1.0). Pairs with the x-acs-dingtalk-access-token
 *  header; the legacy oapi.dingtalk.com/gettoken token does NOT. */
const ACCESS_TOKEN_URL = `${API_BASE}/v1.0/oauth2/accessToken`
/** 1:1 robot send. Addressed by userIds — NOT by conversation id. */
const OTO_SEND_URL = `${API_BASE}/v1.0/robot/oToMessages/batchSend`
/** Group robot send. Addressed by openConversationId. */
const GROUP_SEND_URL = `${API_BASE}/v1.0/robot/groupMessages/send`

/** The only CALLBACK topic we subscribe to: inbound bot messages. */
const BOT_MESSAGE_TOPIC = '/v1.0/im/bot/messages/get'

/** Reconnect policy, matching the official Python SDK: 1s doubling, ±1s jitter,
 *  capped at 60s. The attempt counter resets on ANY received frame, so a socket
 *  that stayed up for an hour and then dropped retries fast rather than
 *  inheriting the backoff from whatever happened at startup. */
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 60_000
const RECONNECT_JITTER_MS = 1_000

/** How long connect() waits for the socket to open before giving up. Without
 *  this a hung TLS handshake leaves connect() pending forever and the gateway
 *  never learns the channel failed to start. */
const CONNECT_TIMEOUT_MS = 15_000

/** Force a reconnect when NOTHING has arrived for this long. The WHATWG
 *  WebSocket we get from Node has no ping() — unlike the `ws` package the
 *  vendor SDKs use — so we cannot probe the link ourselves. What we can do is
 *  notice silence: DingTalk sends SYSTEM/ping unprompted, so a window several
 *  times the server's own cadence with zero frames means the socket is half
 *  open and close/close-handler-driven reconnect is the only way back. */
const IDLE_TIMEOUT_MS = 180_000

/** Refresh the access token this far before it actually expires, so a send that
 *  starts just under the wire does not race the expiry. Same 5min margin the
 *  official SDKs use. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000

// ─────────────────────────── wire shapes ───────────────────────────

/** Every stream frame, in both directions. NOTE `data` is a JSON *string*, not
 *  an object — a double encoding that is easy to miss and yields `undefined`
 *  field reads rather than a parse error if you skip the inner JSON.parse. */
interface StreamFrame {
  specVersion?: string
  type?: string
  headers?: {
    appId?: string
    connectionId?: string
    contentType?: string
    messageId?: string
    time?: string
    topic?: string
    eventType?: string
    eventId?: string
  }
  data?: string
}

/** The ack we write back. Shape taken from the SDKs' AckMessage; `data` is
 *  double-encoded here too. */
interface AckFrame {
  code: number
  headers: Record<string, string | undefined>
  message: string
  data: string
}

/** Inbound bot message (topic /v1.0/im/bot/messages/get), parsed out of
 *  `frame.data`. Only the fields this transport reads are modelled; everything
 *  else survives on TransportMessage.raw. */
export interface DingTalkBotPayload {
  msgtype?: string
  msgId?: string
  /** STABLE org-scoped user id. This is the pairing subject — see below. */
  senderStaffId?: string
  /** Sender's DingTalk-global id. Stable too, but org-scoped ids are what the
   *  send API and the admin console speak, so senderStaffId is preferred. */
  senderId?: string
  /** Display name. Deliberately NEVER used as an id: the sender can change it. */
  senderNick?: string
  conversationId?: string
  /** '1' = 1:1 chat, '2' = group. Decides the entire send path (see routeOf). */
  conversationType?: string
  conversationTitle?: string
  robotCode?: string
  text?: { content?: string }
  /** Present INSTEAD of a message body when the org's Webhook+Stream message
   *  quota is exhausted: `errorCode: 20001` and no text/content at all. Modelled
   *  so the drop is diagnosed as "out of quota" rather than "unknown msgtype". */
  errorCode?: string | number
  errorMessage?: string
  /** Non-text bodies all land here: downloadCode / fileName / richText / … */
  content?: {
    downloadCode?: string
    fileName?: string
    /** Audio only: DingTalk's own speech-to-text of the clip, when available. */
    recognition?: string
    text?: string
    richText?: Array<{ text?: string; downloadCode?: string }>
    [k: string]: unknown
  }
  [k: string]: unknown
}

// ───────────────────── pure mapping (unit-tested) ─────────────────────

/**
 * Reply address for a conversation, encoded so it survives a restart.
 *
 * DingTalk's two send endpoints take DIFFERENT keys, and for a 1:1 chat the
 * conversationId is not one of them — the endpoint wants the staff id. So a bare
 * conversationId is not a sufficient reply address on this platform, and a
 * transport that emitted one would only be able to answer a conversation it
 * happened to still have in memory. Encoding the routing decision into the id
 * keeps `send(msg.conversationId, …)` working cold: after a restart, after a
 * reconnect, and for a conversation this process never received from.
 *
 * Both halves are stable ids (a staff id, an open conversation id), never a
 * display name — `conversationTitle` and `senderNick` are read by nobody here.
 */
export function conversationAddress(payload: DingTalkBotPayload): string | null {
  // '2' is a group; treat anything else that carries no staff id as a group too,
  // since an openConversationId is then the only thing we could address.
  const isGroup = payload.conversationType === '2'
  if (isGroup) {
    return payload.conversationId ? `group:${payload.conversationId}` : null
  }
  return payload.senderStaffId ? `user:${payload.senderStaffId}` : null
}

/** Parsed reply address → the endpoint + body key it selects. */
export interface DingTalkRoute {
  kind: 'user' | 'group'
  /** staffId for 'user', openConversationId for 'group'. */
  id: string
}

/** Inverse of conversationAddress. Returns null for anything unroutable — the
 *  caller must throw rather than guess, because guessing wrong sends a private
 *  reply into a group or vice versa. */
export function parseAddress(address: string): DingTalkRoute | null {
  if (address.startsWith('user:')) {
    const id = address.slice('user:'.length)
    return id ? { kind: 'user', id } : null
  }
  if (address.startsWith('group:')) {
    const id = address.slice('group:'.length)
    return id ? { kind: 'group', id } : null
  }
  return null
}

/**
 * Human-readable stand-in for a message with no plain text, so a non-text
 * message is VISIBLE downstream instead of vanishing (trap 1).
 *
 * Every branch returns something. The `default` is the important one: a msgtype
 * DingTalk adds after this was written still produces a line the operator can
 * see and act on, rather than a silent drop that also stalls the ack.
 */
export function describeNonText(payload: DingTalkBotPayload): string {
  const c = payload.content ?? {}
  const type = payload.msgtype ?? 'unknown'
  switch (type) {
    case 'text':
      // Reached only when a text message carried no usable content. Say that,
      // rather than falling through to "unsupported type" and misdiagnosing it.
      return '[dingtalk:text] empty text message'
    case 'richText': {
      // richText is a mixed run of text fragments and inline images. The text
      // fragments ARE the message, so join them; note the images so an
      // image-only rich message is not reported as empty.
      const parts = c.richText ?? []
      const text = parts
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .join('')
        .trim()
      const images = parts.filter((p) => p.downloadCode).length
      if (text && images) return `${text}\n[dingtalk:richText] + ${images} image(s)`
      if (text) return text
      return `[dingtalk:richText] ${images} image(s), no text`
    }
    case 'markdown':
      return typeof c.text === 'string' && c.text.trim()
        ? c.text
        : '[dingtalk:markdown] empty markdown message'
    case 'picture':
      return `[dingtalk:picture] image${c.downloadCode ? ` (downloadCode ${c.downloadCode})` : ''}`
    case 'file':
      // The case the competitor lost: a PDF/DOCX drop. Name it, and carry the
      // downloadCode so a handler can fetch it via
      // POST /v1.0/robot/messageFiles/download {downloadCode, robotCode}.
      return `[dingtalk:file] ${c.fileName || 'unnamed file'}${c.downloadCode ? ` (downloadCode ${c.downloadCode})` : ''}`
    case 'audio':
      // DingTalk transcribes voice clips server-side; prefer the transcript.
      return typeof c.recognition === 'string' && c.recognition.trim()
        ? c.recognition
        : `[dingtalk:audio] voice message${c.downloadCode ? ` (downloadCode ${c.downloadCode})` : ''}`
    case 'video':
      return `[dingtalk:video] video${c.downloadCode ? ` (downloadCode ${c.downloadCode})` : ''}`
    default:
      return `[dingtalk:${type}] unsupported message type — not handled by this transport`
  }
}

/**
 * PURE mapper: a bot CALLBACK payload → a TransportMessage.
 *
 * Returns null ONLY when the payload cannot be routed or authorized at all —
 * no sender, or no addressable conversation. That is not a silent drop: the
 * caller logs it and still acks. Every other payload, including msgtypes this
 * transport has never seen, produces a message (trap 1).
 *
 * userId is `senderStaffId` — a stable, org-scoped id, and the value the send
 * API addresses. It becomes the pairing subject, so it must never be senderNick.
 */
export function parseBotCallback(payload: DingTalkBotPayload): TransportMessage | null {
  // senderStaffId ONLY — deliberately no fallback to senderId. The two are
  // different id-spaces (org-scoped vs DingTalk-global), and senderStaffId is
  // "机器人发布上线后生效": it is EMPTY until the bot is published. Falling back
  // would make the same human arrive as senderId before publish and
  // senderStaffId after, silently invalidating a pairing approval keyed on the
  // first one. It is also the only id the 1:1 send endpoint accepts. Refusing,
  // loudly, beats an authorization subject that changes identity.
  const userId = payload.senderStaffId
  if (!userId) return null
  const conversationId = conversationAddress(payload)
  if (!conversationId) return null

  const plain = payload.msgtype === 'text' ? (payload.text?.content ?? '') : ''
  const text = plain.trim() ? plain : describeNonText(payload)

  return {
    userId,
    conversationId,
    text,
    messageId: payload.msgId,
    // No threadId: DingTalk bot conversations are flat. Emitting a synthetic one
    // would tell the adapter this platform has threads when it does not.
    raw: payload
  }
}

/**
 * Why a payload could not become a TransportMessage — the diagnosis attached to
 * the drop log.
 *
 * A drop that says "unroutable" teaches the operator nothing. Each of these has
 * a specific, actionable cause, and two of them are configuration rather than
 * bugs: an unpublished bot and an exhausted quota both arrive as payloads with
 * missing fields, and would otherwise be misreported as a malformed message.
 */
export function explainUndeliverable(payload: DingTalkBotPayload): string {
  if (payload.errorCode !== undefined) {
    // Quota exhaustion (errorCode 20001) replaces the message body entirely.
    return `DingTalk returned errorCode ${payload.errorCode}${
      payload.errorMessage ? ` (${payload.errorMessage})` : ''
    } instead of a message — commonly the org's Webhook+Stream message quota being exhausted`
  }
  if (!payload.senderStaffId) {
    return 'no senderStaffId — the robot is most likely not PUBLISHED yet (senderStaffId is only populated for a published bot), so the sender cannot be paired or replied to'
  }
  if (payload.conversationType === '2' && !payload.conversationId) {
    return 'group message with no conversationId — nothing to address a reply to'
  }
  return `unroutable payload (msgtype=${payload.msgtype} conversationType=${payload.conversationType})`
}

/** Ack for a CALLBACK frame. `data` is the double-encoded {response} envelope
 *  the vendor SDKs send; anything else is treated as a non-response and
 *  redelivered. */
export function buildCallbackAck(messageId: string, response: unknown = 'ok'): AckFrame {
  return {
    code: 200,
    headers: { contentType: 'application/json', messageId },
    message: 'OK',
    data: JSON.stringify({ response })
  }
}

/** Ack for an EVENT frame. SUCCESS means "consumed, do not redeliver"; the
 *  protocol also has LATER, which we never send — we have no retry queue to
 *  defer into, and claiming otherwise would just stall the event. */
export function buildEventAck(messageId: string): AckFrame {
  return {
    code: 200,
    headers: { contentType: 'application/json', messageId },
    message: 'OK',
    data: JSON.stringify({ status: 'SUCCESS' })
  }
}

/** Ack for a SYSTEM frame (ping / disconnect / …). Echoes the frame's own
 *  headers and data back verbatim, which is what the official Node SDK does for
 *  ping and what the gateway matches the pong against. */
export function buildSystemAck(frame: StreamFrame): AckFrame {
  return {
    code: 200,
    headers: { contentType: 'application/json', ...(frame.headers ?? {}) },
    message: 'OK',
    data: frame.data ?? '{}'
  }
}

/** What the robot send endpoints put in a 200 body. */
export interface DingTalkSendResponse {
  processQueryKey?: string
  /** batchSend: recipients the org does not recognise. */
  invalidStaffIdList?: string[]
  /** batchSend: recipients dropped by DingTalk's own flow control. */
  flowControlledStaffIdList?: string[]
  /** Error envelopes, which DingTalk spells two ways depending on API vintage. */
  code?: string
  message?: string
  errcode?: number
  errmsg?: string
  /** IP-ban throttle blob, which is NOT a normal error envelope. */
  status?: number
  punish?: string
  [k: string]: unknown
}

/**
 * PURE: throw unless the body says every recipient was actually accepted.
 *
 * `send` resolving means DELIVERED, and on these endpoints HTTP 200 does not
 * mean that. batchSend reports per-recipient failure INSIDE a 200 body —
 * `invalidStaffIdList` for unknown ids, `flowControlledStaffIdList` for
 * throttled ones — so checking `res.ok` alone reports a message nobody received
 * as sent. Same for the IP-level throttle, which answers with
 * `{status:1111, punish:"deny", wait:5}` rather than an error envelope.
 */
export function assertSendAccepted(body: DingTalkSendResponse | null): void {
  if (!body) return // No body to contradict a 2xx; treat the status as the answer.
  if (body.punish || body.status === 1111) {
    throw new Error(
      `dingtalk send throttled: the caller IP is rate-limited (punish=${body.punish ?? 'deny'}, wait=${body.wait ?? '?'}s)`
    )
  }
  if (typeof body.code === 'string' && body.code) {
    throw new Error(`dingtalk send rejected: ${body.code}${body.message ? ` — ${body.message}` : ''}`)
  }
  if (typeof body.errcode === 'number' && body.errcode !== 0) {
    throw new Error(`dingtalk send rejected: errcode ${body.errcode}${body.errmsg ? ` — ${body.errmsg}` : ''}`)
  }
  const invalid = body.invalidStaffIdList ?? []
  const throttled = body.flowControlledStaffIdList ?? []
  if (invalid.length || throttled.length) {
    const parts: string[] = []
    if (invalid.length) parts.push(`unknown recipients: ${invalid.join(', ')}`)
    if (throttled.length) parts.push(`flow-controlled recipients: ${throttled.join(', ')}`)
    throw new Error(`dingtalk send not delivered to every recipient — ${parts.join('; ')}`)
  }
}

/** Backoff for reconnect attempt N (0-based), jitter injected for testability. */
export function reconnectDelayMs(attempt: number, jitter = Math.random()): number {
  const exponential = RECONNECT_BASE_MS * 2 ** Math.min(attempt, 16)
  return Math.min(exponential + jitter * RECONNECT_JITTER_MS, RECONNECT_MAX_MS)
}

// ───────────────────── minimal WebSocket surface ─────────────────────

// Typed locally rather than pulled from the DOM lib: tsconfig.node.json sets
// `types: ["node"]`, so a DOM WebSocket type is not in scope, and the `ws`
// package is not a dependency. Same approach adapters/discord.ts takes.
interface MinimalWebSocket {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: ((err: unknown) => void) | null
}
type WebSocketFactory = (url: string) => MinimalWebSocket

export interface DingTalkTransportDeps {
  fetchImpl?: typeof fetch
  /** Injected so the socket lifecycle is testable without a live DingTalk org. */
  wsFactory?: WebSocketFactory
  now?: () => number
}

function defaultWsFactory(url: string): MinimalWebSocket {
  const Ctor = (globalThis as { WebSocket?: new (u: string) => MinimalWebSocket }).WebSocket
  if (!Ctor) throw new Error('dingtalk: no WebSocket implementation available')
  return new Ctor(url)
}

// ─────────────────────────── the transport ───────────────────────────

export function createDingTalkTransport(
  opts: {
    appKey: string
    appSecret: string
    /** REQUIRED only when the bot was installed as a 群聊酷应用 — that install
     *  path rejects a send without it (`invalidParameter.robotCode.coolApp`).
     *  Not derivable from the credentials, and harmless to omit otherwise, so
     *  it is optional rather than a fourth thing every operator must find. */
    coolAppCode?: string
  },
  deps: DingTalkTransportDeps = {}
): ChannelTransport {
  const fetchImpl = deps.fetchImpl ?? fetch
  const wsFactory = deps.wsFactory ?? defaultWsFactory
  const now = deps.now ?? (() => Date.now())

  let sink: ((msg: TransportMessage) => Promise<void>) | null = null
  let ws: MinimalWebSocket | null = null
  let running = false
  let attempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let idleTimer: ReturnType<typeof setInterval> | null = null
  let lastFrameAt = 0

  // Access token cache. `inflight` collapses concurrent refreshes: several sends
  // firing at once on a cold cache would otherwise each mint a token, and
  // DingTalk invalidates the previous one on some plan tiers.
  let token: { value: string; expiresAt: number } | null = null
  let inflightToken: Promise<string> | null = null

  // Reply routes learned from inbound traffic, so send() also accepts the raw
  // vendor conversationId a caller may have stored. The prefixed form from
  // conversationAddress() needs no map and works cold; this is the convenience
  // path, never the only path.
  const routes = new Map<string, DingTalkRoute>()

  function clearTimers(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (idleTimer) {
      clearInterval(idleTimer)
      idleTimer = null
    }
  }

  // ── credentials ──────────────────────────────────────────────────

  async function accessToken(force = false): Promise<string> {
    if (!force && token && token.expiresAt > now() + TOKEN_REFRESH_MARGIN_MS) return token.value
    if (inflightToken) return inflightToken
    inflightToken = (async (): Promise<string> => {
      const res = await fetchImpl(ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appKey: opts.appKey, appSecret: opts.appSecret })
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`dingtalk accessToken failed: HTTP ${res.status} ${detail}`.trim())
      }
      const body = (await res.json()) as { accessToken?: string; expireIn?: number }
      if (!body.accessToken) throw new Error('dingtalk accessToken failed: no accessToken in response')
      // expireIn is SECONDS. Defaulting to the documented 7200 rather than 0
      // matters: a 0 would make every single call a cache miss.
      token = { value: body.accessToken, expiresAt: now() + (body.expireIn ?? 7200) * 1000 }
      return body.accessToken
    })().finally(() => {
      inflightToken = null
    })
    return inflightToken
  }

  // ── inbound ──────────────────────────────────────────────────────

  function sendFrame(frame: AckFrame): void {
    try {
      ws?.send(JSON.stringify(frame))
    } catch (e) {
      // A failed ack is not worth tearing the turn down — the frame is already
      // dispatched, and the socket's own close handler drives the reconnect.
      console.debug('[dingtalk] ack write failed:', messageOf(e))
    }
  }

  async function handleCallback(frame: StreamFrame): Promise<void> {
    const messageId = frame.headers?.messageId
    let response: unknown = 'ok'
    try {
      if (frame.headers?.topic !== BOT_MESSAGE_TOPIC) {
        // Subscribed to exactly one callback topic, so this means DingTalk sent
        // something we did not ask for. Say so loudly and still ack — an unacked
        // frame is redelivered for ~60s, turning a surprise into a hot loop.
        console.warn('[dingtalk] unexpected callback topic, ignoring:', frame.headers?.topic)
        return
      }
      const payload = JSON.parse(frame.data ?? '{}') as DingTalkBotPayload
      const msg = parseBotCallback(payload)
      if (!msg) {
        // Only reachable when there is no sender staff id or no addressable
        // conversation. Visible, never silent, and diagnosed — see trap 1.
        console.warn('[dingtalk] dropping bot message:', explainUndeliverable(payload))
        return
      }
      const route = parseAddress(msg.conversationId)
      if (route) {
        routes.set(msg.conversationId, route)
        // Also index the raw vendor conversationId, so a caller holding that
        // value can still reply without knowing our encoding.
        if (payload.conversationId) routes.set(payload.conversationId, route)
      }
      await sink?.(msg)
    } catch (e) {
      console.debug('[dingtalk] callback handling failed:', messageOf(e))
      response = 'error'
    } finally {
      // ALWAYS ack, including on a throwing sink. Skipping this is what turns a
      // handler bug into DingTalk redelivering the same message every 60s.
      if (messageId) sendFrame(buildCallbackAck(messageId, response))
    }
  }

  function handleSystem(frame: StreamFrame): void {
    const topic = frame.headers?.topic
    // ping/KEEPALIVE/CONNECTED/REGISTERED and disconnect all take the same echo
    // ack; only disconnect changes what we do next.
    sendFrame(buildSystemAck(frame))
    if (topic === 'disconnect') {
      // The gateway is retiring this connection (rotation, deploy, idle). The
      // ticket is spent, so the close handler must re-run the whole handshake
      // rather than redial the same URL.
      console.debug('[dingtalk] gateway requested disconnect; reconnecting')
      try {
        ws?.close()
      } catch (e) {
        console.debug('[dingtalk] close after disconnect failed:', messageOf(e))
      }
    }
  }

  function onFrame(raw: unknown): void {
    lastFrameAt = now()
    // Any frame at all proves the link is healthy, so the next drop retries from
    // the base delay instead of inheriting an old backoff.
    attempt = 0
    let frame: StreamFrame
    try {
      frame = JSON.parse(String(raw)) as StreamFrame
    } catch (e) {
      console.debug('[dingtalk] unparseable frame:', messageOf(e))
      return
    }
    switch (frame.type) {
      case 'SYSTEM':
        handleSystem(frame)
        return
      case 'CALLBACK':
        void handleCallback(frame)
        return
      case 'EVENT':
        // We subscribe to EVENT only so the gateway has a live event channel;
        // nothing here consumes org events. Ack SUCCESS so they are not retried.
        if (frame.headers?.messageId) sendFrame(buildEventAck(frame.headers.messageId))
        return
      default:
        console.warn('[dingtalk] unknown frame type, ignoring:', frame.type)
    }
  }

  // ── connection ───────────────────────────────────────────────────

  /** Handshake. Every connection needs its own ticket — it is consumed by the
   *  WebSocket upgrade, so a reconnect that reuses the old URL is rejected. */
  async function openGateway(): Promise<string> {
    const res = await fetchImpl(OPEN_CONNECTION_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        clientId: opts.appKey,
        clientSecret: opts.appSecret,
        // EVENT '*' keeps the gateway's event channel registered; the CALLBACK
        // entry is what actually subscribes us to inbound bot messages. Omitting
        // the CALLBACK subscription is a silent no-messages failure: the socket
        // opens fine and simply never delivers anything.
        subscriptions: [
          { type: 'EVENT', topic: '*' },
          { type: 'CALLBACK', topic: BOT_MESSAGE_TOPIC }
        ],
        ua: 'duin-dingtalk-transport/1.0'
      })
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`dingtalk gateway open failed: HTTP ${res.status} ${detail}`.trim())
    }
    const body = (await res.json()) as { endpoint?: string; ticket?: string }
    if (!body.endpoint || !body.ticket) {
      throw new Error('dingtalk gateway open failed: no endpoint/ticket in response')
    }
    return `${body.endpoint}?ticket=${encodeURIComponent(body.ticket)}`
  }

  /** Open one socket. Resolves on 'open' — at which point the ticket has been
   *  accepted and the subscription is live, so messages really can arrive.
   *  Rejects on error, on close-before-open, and on timeout. */
  function openSocket(url: string): Promise<MinimalWebSocket> {
    return new Promise((resolve, reject) => {
      let settled = false
      let socket: MinimalWebSocket
      try {
        socket = wsFactory(url)
      } catch (e) {
        reject(e instanceof Error ? e : new Error(messageOf(e)))
        return
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          socket.close()
        } catch (e) {
          console.debug('[dingtalk] close after connect timeout failed:', messageOf(e))
        }
        reject(new Error(`dingtalk: WebSocket did not open within ${CONNECT_TIMEOUT_MS}ms`))
      }, CONNECT_TIMEOUT_MS)

      socket.onopen = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(socket)
      }
      socket.onerror = (err): void => {
        console.debug('[dingtalk] socket error:', messageOf(err))
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`dingtalk: WebSocket error: ${messageOf(err)}`))
      }
      socket.onclose = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error('dingtalk: WebSocket closed before it opened'))
      }
      socket.onmessage = (ev): void => onFrame(ev.data)
    })
  }

  function scheduleReconnect(): void {
    if (!running || reconnectTimer) return
    const delay = reconnectDelayMs(attempt)
    attempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void dial().catch((e) => {
        console.debug('[dingtalk] reconnect failed:', messageOf(e))
        scheduleReconnect()
      })
    }, delay)
  }

  /** Full connect cycle: fresh ticket, fresh socket, rearm the watchdog. */
  async function dial(): Promise<void> {
    const url = await openGateway()
    const socket = await openSocket(url)
    ws = socket
    lastFrameAt = now()
    // Swap the connect-phase close handler for the steady-state one, which
    // drives reconnection instead of rejecting a promise nobody is awaiting.
    socket.onclose = (): void => {
      if (ws === socket) ws = null
      if (running) scheduleReconnect()
    }
    if (idleTimer) clearInterval(idleTimer)
    idleTimer = setInterval(() => {
      if (!running || !ws) return
      if (now() - lastFrameAt < IDLE_TIMEOUT_MS) return
      console.warn('[dingtalk] no frames for', IDLE_TIMEOUT_MS, 'ms — recycling socket')
      try {
        ws.close() // close → onclose → scheduleReconnect
      } catch (e) {
        console.debug('[dingtalk] idle close failed:', messageOf(e))
      }
    }, IDLE_TIMEOUT_MS)
  }

  // ── outbound ─────────────────────────────────────────────────────

  /** One POST to a robot send endpoint. Retries ONCE on 401 with a fresh token,
   *  because a token can expire between the cache check and the request. */
  async function postSend(url: string, body: Record<string, unknown>): Promise<void> {
    for (const forceRefresh of [false, true]) {
      const at = await accessToken(forceRefresh)
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-acs-dingtalk-access-token': at
        },
        body: JSON.stringify(body)
      })
      if (res.ok) {
        // A 2xx is NOT proof of delivery on these endpoints — see
        // assertSendAccepted. Parse failures are tolerated (an empty/non-JSON
        // 200 leaves the status as the only signal); a parsed body that reports
        // failure throws.
        const body = (await res.json().catch(() => null)) as DingTalkSendResponse | null
        assertSendAccepted(body)
        return
      }
      if (res.status === 401 && !forceRefresh) {
        token = null
        continue
      }
      const detail = await res.text().catch(() => '')
      throw new Error(`dingtalk send failed: HTTP ${res.status} ${detail}`.trim())
    }
  }

  return {
    id: CHANNEL_ID,

    capabilities(): TransportCapability[] {
      // Nothing beyond send/receive, and saying so is the point. A DingTalk bot
      // has no thread model, no reaction API, no typing indicator, and no
      // directory reachable from stream-mode credentials alone. Outbound files
      // would need the legacy oapi media-upload flow, which is a separate
      // credential path — so 'files' stays off rather than advertising a
      // sendFile() this transport does not implement.
      return []
    },

    async connect(onMessage: (msg: TransportMessage) => Promise<void>): Promise<void> {
      if (running) return // idempotent
      if (!opts.appKey || !opts.appSecret) {
        throw new Error('dingtalk is not configured (appKey/appSecret required)')
      }
      sink = onMessage
      running = true
      try {
        // Awaited, not fired-and-forgotten: resolving before the socket is up
        // would report the channel as running when it is not, which is exactly
        // what the enabled-vs-running distinction in the settings pane relies on
        // being honest about.
        await dial()
      } catch (e) {
        running = false
        sink = null
        clearTimers()
        throw e instanceof Error ? e : new Error(messageOf(e))
      }
    },

    async disconnect(): Promise<void> {
      running = false
      sink = null
      clearTimers()
      try {
        ws?.close()
      } catch (e) {
        console.debug('[dingtalk] disconnect close failed:', messageOf(e))
      }
      ws = null
      // Routes are per-process reply hints, not state worth surviving a stop.
      routes.clear()
    },

    async send(conversationId: string, text: string): Promise<void> {
      if (!opts.appKey || !opts.appSecret) {
        throw new Error('dingtalk is not configured (appKey/appSecret required)')
      }
      // TRAP 2: this path reads no sessionWebhook and consults no channel
      // config. It needs the access token and a route, both derivable from the
      // stream-mode credentials that are already in hand.
      const route = parseAddress(conversationId) ?? routes.get(conversationId) ?? null
      if (!route) {
        // Refusing beats guessing: picking the wrong endpoint would deliver a
        // private reply into a group. Naming the accepted forms makes the fix
        // obvious to whoever is holding a bare id.
        throw new Error(
          `dingtalk: cannot address "${conversationId}" — expected "user:<staffId>" or "group:<openConversationId>", or an id seen on an inbound message`
        )
      }
      // robotCode IS the AppKey for a stream-mode enterprise robot; there is no
      // separate robot code to configure. msgParam is a STRINGIFIED JSON — an
      // object here is rejected as `invalidParameter.msgParam.invalid`.
      // Both endpoints need the `qyapi_robot_sendmsg` scope on the app.
      const common = {
        robotCode: opts.appKey,
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content: text }),
        ...(opts.coolAppCode ? { coolAppCode: opts.coolAppCode } : {})
      }
      if (route.kind === 'group') {
        // NOTE: this endpoint cannot @-mention anyone — DingTalk's own docs say
        // "接口暂不支持 @ 功能". A reply that needs an @ has to go through the
        // per-message sessionWebhook, which is the expiring path trap 2 rules
        // out. Plain group text is the deliberate trade.
        await postSend(GROUP_SEND_URL, { ...common, openConversationId: route.id })
      } else {
        // 1:1 is addressed by staff id, NOT by conversation id — the single most
        // common DingTalk send mistake.
        await postSend(OTO_SEND_URL, { ...common, userIds: [route.id] })
      }
    }
  }
}
