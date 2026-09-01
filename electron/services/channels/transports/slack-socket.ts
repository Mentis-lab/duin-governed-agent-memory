// Slack transport — Socket Mode (outbound WebSocket) for receive, Web API for send.
//
// SOCKET MODE, NOT EVENTS-API WEBHOOKS: the app-level token (`xapp-…`) opens an
// OUTBOUND WebSocket to Slack, so DUIN needs no public URL, no TLS certificate and
// no inbound port. The webhook alternative would need a reachable, signature-verifying
// endpoint — a deployment shape a laptop that changes networks does not have. This is
// the same OUTBOUND-only stance as the Discord and Telegram adapters.
//
// TWO TOKENS, TWO JOBS. `appToken` (xapp-) ONLY opens the socket; `botToken` (xoxb-)
// authenticates every Web API call (send, directory). They are not interchangeable.
// Neither is read from the keychain here — a transport takes credentials as arguments
// (transport.ts), which is what keeps authorization in exactly one place upstream.
//
// WHAT THE SDK OWNS vs WHAT IS ADDED HERE — verified against @slack/socket-mode 3.0.0:
//   SDK   · ping/pong liveness (client 5s / server 30s), Slack's `disconnect` refresh
//           frames, automatic reconnect (`autoReconnectEnabled` defaults true) with
//           linear backoff, re-fetching a fresh WSS URL each attempt, and — via
//           @slack/web-api's default retry policy — 429/5xx retry on Web API calls.
//           Listeners registered once survive reconnects; the emitter outlives the socket.
//   ADDED · (1) a bounded connect timeout. On a RECOVERABLE apps.connections.open
//           failure the SDK retries FOREVER, so `start()` can hang and the channel
//           would sit in "connecting" with nothing reporting it — the enabled-vs-running
//           honesty transport.ts requires. (2) An error normalized out of `start()`'s
//           reject path: it rejects with whatever `emit('disconnected')` carried, which
//           is frequently NOTHING, so the raw rejection is `undefined`. (3) ack-BEFORE-route,
//           so Slack's 3s envelope retry cannot turn one message into three turns.
//           (4) Self-echo filtering — no SDK can do that for us, and without it the bot
//           answers its own reply forever.
//
// UNVERIFIABLE WITHOUT A LIVE WORKSPACE: the socket handshake, scope errors, and whether
// a given workspace's message events carry the fields below. Everything shaped like a
// decision is therefore PURE and unit-tested (parseSlackMessage, toTarget); the socket
// lifecycle is a human-verify item.

import { friendly, messageOf } from '../../guarded'
import type {
  ChannelTransport,
  TransportCapability,
  TransportMessage,
  TransportTarget
} from './transport'

const TRANSPORT_ID = 'slack'

// Bounded because the SDK's own retry is unbounded — see the header. 30s is longer than
// a healthy handshake by an order of magnitude and short enough that a wedged connect
// surfaces as an error the operator can act on.
const CONNECT_TIMEOUT_MS = 30_000
// `disconnect()` resolves on the socket's 'disconnected' event; if that never arrives we
// must not hold app shutdown open. Releasing anyway is safe — we drop every reference.
const DISCONNECT_TIMEOUT_MS = 5_000

const TARGET_TYPES = 'public_channel,private_channel,mpim,im'
const TARGET_PAGE_SIZE = 200
// conversations.list pages at 200; a large workspace has thousands of channels and the
// picker cannot use them all. Capping the walk keeps a directory lookup from becoming a
// multi-minute rate-limited crawl.
const TARGET_MAX_PAGES = 10

// The SDK is NOT yet a dependency of this app (see the report/README note). Holding the
// specifiers as widened `string` — not string literals — keeps both `tsc` and the bundler
// from trying to resolve them at build time, so this file neither breaks the typecheck
// nor the build while it is unwired. A missing package then surfaces at connect() as an
// actionable install message instead of a build failure for every lane.
const SOCKET_MODE_PKG: string = '@slack/socket-mode'
const WEB_API_PKG: string = '@slack/web-api'

// ─────────────────── wire shapes (Slack Events API `message`) ───────────────────

/** The inner `event` of an events_api envelope, for `type: 'message'`. Only the fields
 *  this transport reads; Slack sends many more. */
export interface SlackMessageEvent {
  type?: string
  subtype?: string
  /** Sender id: `U…`, or `W…` on Enterprise Grid. Deliberately NOT prefix-checked. */
  user?: string
  /** Present on anything posted by an app/bot, including our own replies. */
  bot_id?: string
  text?: string
  /** Slack's message id: a per-channel timestamp string like "1712345678.000100". */
  ts?: string
  /** The ROOT message's ts when this message lives in a thread. */
  thread_ts?: string
  /** `C…` public, `G…` legacy private, `D…` DM. */
  channel?: string
  channel_type?: string
}

/** The listener argument @slack/socket-mode emits for an events_api envelope. */
export interface SlackEventArgs {
  /** Acknowledges the envelope. Rejects if the socket died before we called it. */
  ack?: (response?: unknown) => Promise<void>
  event?: SlackMessageEvent
  body?: { event?: SlackMessageEvent }
  retry_num?: number
}

/**
 * Message subtypes that still represent a HUMAN saying something.
 *
 * An ALLOWLIST, not a blocklist of {message_changed, message_deleted}: Slack's subtype
 * set is largely join/leave/topic noise (`channel_join`, `channel_purpose`, …) that
 * arrives with a real `user` and real `text` ("set the channel purpose: …"), so a
 * blocklist routes every one it has not heard of into a turn the operator never asked
 * for. The failure modes are not symmetric — an unknown subtype dropped is a message
 * that goes unanswered, an unknown subtype routed is DUIN talking to a channel event.
 *
 * `undefined` (a plain message) is the common case and is handled separately.
 */
const ROUTABLE_SUBTYPES = new Set(['file_share', 'thread_broadcast', 'me_message'])

/**
 * PURE mapper: one `message` event → a TransportMessage, or null when it is not a
 * routable human message. `selfUserId` comes from auth.test() at connect time.
 *
 * Exported for test — this is where every filtering decision lives.
 */
export function parseSlackMessage(
  event: SlackMessageEvent | undefined,
  selfUserId: string | null
): TransportMessage | null {
  if (!event) return null
  // Defensive: we subscribe to 'message' only, but the same mapper is reachable from a
  // 'slack_event' fan-out and a non-message event has none of the fields below.
  if (event.type && event.type !== 'message') return null
  // message_changed / message_deleted / channel_join / … — see ROUTABLE_SUBTYPES.
  if (event.subtype && !ROUTABLE_SUBTYPES.has(event.subtype)) return null
  // ECHO GUARD, first half: anything an app posted carries bot_id — including the reply
  // we just sent. Routing it would answer ourselves, and each answer would arrive back.
  if (event.bot_id) return null

  const userId = event.user
  const conversationId = event.channel
  const text = event.text
  if (!userId || !conversationId) return null
  // ECHO GUARD, second half: bot_id is absent when a workspace posts through a user
  // token, so the bot's OWN user id is checked too. Cheap, and the loop it prevents is
  // unbounded.
  if (selfUserId && userId === selfUserId) return null
  // A file-only upload arrives as file_share with empty text. There is no turn to run on
  // an empty string, and Slack rejects an empty reply, so it is not routable.
  if (!text || !text.trim()) return null

  return {
    userId,
    conversationId,
    text,
    ...(event.ts ? { messageId: event.ts } : {}),
    // Slack's native threading. Present on every reply in a thread (and on the root once
    // it has replies), where it equals the ROOT's ts — which is exactly what send() must
    // pass back as thread_ts for a reply to land in the same thread. Absent ⇒ top-level.
    ...(event.thread_ts ? { threadId: event.thread_ts } : {}),
    raw: event
  }
}

// ─────────────────── SDK surface (structural, so the package can stay absent) ───────────────────

/** The @slack/socket-mode surface used here. Structural rather than imported: the real
 *  `SocketModeClient` (an EventEmitter) satisfies it, and declaring it locally is what
 *  lets the tests drive this transport with no SDK installed. Same move as discord.ts's
 *  MinimalWebSocket. */
export interface SlackSocketClient {
  on(event: string, listener: (args: SlackEventArgs) => void): unknown
  once?(event: string, listener: (arg?: unknown) => void): unknown
  off?(event: string, listener: (...args: never[]) => void): unknown
  start(): Promise<unknown>
  disconnect(): Promise<void>
}

export interface SlackConversation {
  id?: string
  name?: string
  is_im?: boolean
  is_mpim?: boolean
  is_member?: boolean
  is_archived?: boolean
  is_user_deleted?: boolean
  /** Only on `im` conversations: the other party's user id. */
  user?: string
}

/** The @slack/web-api surface used here. Methods (not properties) on purpose — method
 *  parameter bivariance is what keeps the real WebClient assignable to this. */
export interface SlackWebClient {
  auth: { test(): Promise<{ ok?: boolean; error?: string; user_id?: string; bot_id?: string }> }
  chat: {
    postMessage(args: {
      channel: string
      text: string
      thread_ts?: string
    }): Promise<{ ok?: boolean; error?: string; ts?: string } | undefined>
  }
  conversations: {
    list(args: {
      types?: string
      limit?: number
      cursor?: string
      exclude_archived?: boolean
    }): Promise<{
      ok?: boolean
      error?: string
      channels?: SlackConversation[]
      response_metadata?: { next_cursor?: string }
    }>
  }
}

export interface SlackClients {
  socket: SlackSocketClient
  web: SlackWebClient
}

export interface SlackCredentials {
  /** App-level token, `xapp-…`. Opens the Socket Mode WebSocket. Nothing else. */
  appToken: string
  /** Bot token, `xoxb-…`. Authenticates every Web API call. */
  botToken: string
}

/** Test seam. Production passes nothing and gets the real SDK. */
export interface SlackTransportDeps {
  createClients?: (creds: SlackCredentials) => Promise<SlackClients>
  connectTimeoutMs?: number
}

async function loadSdk(): Promise<{
  SocketModeClient: new (opts: { appToken: string }) => SlackSocketClient
  WebClient: new (token: string) => SlackWebClient
}> {
  try {
    const sm = (await import(SOCKET_MODE_PKG)) as {
      SocketModeClient: new (opts: { appToken: string }) => SlackSocketClient
    }
    const wa = (await import(WEB_API_PKG)) as { WebClient: new (token: string) => SlackWebClient }
    return { SocketModeClient: sm.SocketModeClient, WebClient: wa.WebClient }
  } catch (e) {
    // Separated from construction below so a constructor error (e.g. an empty appToken)
    // is never mislabelled as a missing package.
    throw new Error(
      `slack transport requires its SDK — run: npm i ${SOCKET_MODE_PKG} ${WEB_API_PKG} (${messageOf(e)})`,
      { cause: e }
    )
  }
}

async function defaultCreateClients(creds: SlackCredentials): Promise<SlackClients> {
  const { SocketModeClient, WebClient } = await loadSdk()
  return {
    socket: new SocketModeClient({ appToken: creds.appToken }),
    web: new WebClient(creds.botToken)
  }
}

/** Reject with a real Error after `ms`. The SDK's own promise is left running; the
 *  caller disconnects it, because an abandoned reconnect loop is a live socket nobody
 *  owns. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bell = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} (timed out after ${ms}ms)`)), ms)
  })
  return Promise.race([p, bell]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

/** PURE: one conversations.list entry → a picker target, or null when it is not one we
 *  can actually deliver to. Exported for test. */
export function toTarget(c: SlackConversation): TransportTarget | null {
  if (!c.id) return null
  if (c.is_archived) return null
  // A DM with a deactivated account cannot receive a message.
  if (c.is_im && c.is_user_deleted) return null
  // chat.postMessage answers `not_in_channel` for a public channel the bot has not
  // joined, so offering it would put an undeliverable row in the picker. `is_member` is
  // absent for im/mpim (always reachable), so only an explicit false is excluded.
  if (!c.is_im && !c.is_mpim && c.is_member === false) return null
  const kind: TransportTarget['kind'] = c.is_im ? 'user' : c.is_mpim ? 'group' : 'channel'
  // An `im` has no name — Slack returns the other party's user id instead. Resolving it
  // to a display name would need users:read and a second call per row; the id is at
  // least addressable and stable, which a display name is not.
  return { id: c.id, name: c.name ?? c.user ?? c.id, kind }
}

/**
 * Build a Slack transport. `connect` opens the Socket Mode WebSocket; `send` posts over
 * the Web API. Nothing here reads the keychain, the pairing store or the runtime.
 */
export function createSlackTransport(
  opts: SlackCredentials,
  deps: SlackTransportDeps = {}
): ChannelTransport {
  const createClients = deps.createClients ?? defaultCreateClients
  const connectTimeoutMs = deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS

  let socket: SlackSocketClient | null = null
  let web: SlackWebClient | null = null
  let selfUserId: string | null = null
  let sink: ((msg: TransportMessage) => Promise<void>) | null = null
  // Set SYNCHRONOUSLY at the top of connect(): the whole body is async, so guarding on
  // `socket` alone lets two overlapping calls both get past the check and open two
  // sockets — every message would then arrive, and be answered, twice.
  let opening = false

  /** The Web API half works with no socket — chat.postMessage is plain HTTP — so send()
   *  and listTargets() are not gated on connect(). An outbound-only Slack channel (a
   *  digest, an alert) is a real configuration, and refusing it would be a lie about
   *  what the credential can do. */
  async function ensureWeb(): Promise<SlackWebClient> {
    if (web) return web
    const clients = await createClients(opts)
    web = clients.web
    return web
  }

  async function handleEnvelope(args: SlackEventArgs): Promise<void> {
    // ACK FIRST. Slack re-delivers an envelope that is not acknowledged within 3s, and a
    // DUIN turn takes far longer than that, so acking after routing would turn one user
    // message into a turn per retry. ack() itself rejects when the socket dropped mid-
    // flight — that is Slack's problem to retry, not a reason to drop the message.
    try {
      await args.ack?.()
    } catch (e) {
      console.debug('[slack] ack failed:', messageOf(e))
    }
    // `event` is what the SDK passes for an events_api envelope; `body.event` is the same
    // object one level up, read as a fallback so an SDK shape change degrades to working.
    const msg = parseSlackMessage(args.event ?? args.body?.event, selfUserId)
    if (!msg || !sink) return
    try {
      await sink(msg)
    } catch (e) {
      // A failed turn must not take the socket down with it.
      console.debug('[slack] onMessage:', messageOf(e))
    }
  }

  return {
    id: TRANSPORT_ID,

    capabilities(): TransportCapability[] {
      // 'typing' is deliberately absent: Slack has no Web API method for a bot typing
      // indicator. The RTM `typing` message is legacy and unavailable over Socket Mode,
      // and assistant.threads.setStatus applies only to AI-assistant threads, not to a
      // normal channel or DM. Declaring it would advertise something we can only fake,
      // and channelCapabilities() derives the honest set from the methods present anyway.
      return ['threads', 'directory']
    },

    async connect(onMessage: (msg: TransportMessage) => Promise<void>): Promise<void> {
      // Idempotent, matching the adapter convention.
      if (socket || opening) return
      opening = true
      try {
        const clients = await createClients(opts)
        web = clients.web

        // auth.test BEFORE the socket, for two reasons that both matter. It fails fast on
        // a bad bot token instead of at the first reply — a channel that receives but
        // cannot answer is worse than one that refuses to start — and it is the only way
        // to learn our OWN user id, which parseSlackMessage needs to recognise our echo.
        // The SDK rejects on `ok:false`, so a throw here is the expected failure path.
        const auth = await clients.web.auth.test()
        if (auth.ok === false) {
          throw new Error(`slack auth.test failed: ${auth.error ?? 'unknown error'}`)
        }
        selfUserId = auth.user_id ?? null
        sink = onMessage

        // Subscribe BEFORE start(): the socket can deliver a backlog the instant the
        // handshake completes, and a listener attached afterwards would miss it.
        clients.socket.on('message', (args: SlackEventArgs) => {
          void handleEnvelope(args)
        })

        try {
          // start() resolves on the `hello` frame — i.e. exactly when messages can
          // arrive, which is the contract transport.ts states. The timeout is ours.
          await withTimeout(clients.socket.start(), connectTimeoutMs, 'slack socket mode connect')
        } catch (e) {
          // The SDK's reconnect loop is still running behind a timeout, so releasing it
          // is part of failing. Best-effort: we are already throwing.
          try {
            await clients.socket.disconnect()
          } catch (inner) {
            console.debug('[slack] disconnect after failed connect:', messageOf(inner))
          }
          sink = null
          selfUserId = null
          // start() rejects with whatever `emit('disconnected')` carried, which is often
          // NOTHING — the raw rejection is `undefined` and `messageOf` would render the
          // string "undefined" as the operator-facing reason.
          throw new Error(`slack could not connect: ${friendly(e, 'socket mode did not start')}`, {
            cause: e
          })
        }
        socket = clients.socket
      } finally {
        opening = false
      }
    },

    async disconnect(): Promise<void> {
      const s = socket
      socket = null
      sink = null
      selfUserId = null
      web = null
      if (!s) return
      try {
        // Bounded: disconnect() resolves on the socket's 'disconnected' event, and a
        // half-open socket that never emits it would hold app shutdown open.
        await withTimeout(s.disconnect(), DISCONNECT_TIMEOUT_MS, 'slack disconnect')
      } catch (e) {
        console.debug('[slack] disconnect:', messageOf(e))
      }
    },

    async send(conversationId: string, text: string, sendOpts?: { threadId?: string }): Promise<void> {
      const w = await ensureWeb()
      const res = await w.chat.postMessage({
        channel: conversationId,
        text,
        // Honouring threadId is what keeps a reply in the thread it answers; omitted, the
        // reply lands at the bottom of the channel and the thread looks unanswered.
        ...(sendOpts?.threadId ? { thread_ts: sendOpts.threadId } : {})
      })
      // WebClient already rejects on `ok:false`, but the contract "resolving means
      // DELIVERED" must not depend on an SDK option a caller could flip.
      if (res && res.ok === false) {
        throw new Error(`slack send failed: ${res.error ?? 'unknown error'}`)
      }
    },

    async listTargets(query?: string): Promise<TransportTarget[]> {
      const w = await ensureWeb()
      const out: TransportTarget[] = []
      let cursor: string | undefined
      for (let page = 0; page < TARGET_MAX_PAGES; page++) {
        const res = await w.conversations.list({
          types: TARGET_TYPES,
          limit: TARGET_PAGE_SIZE,
          exclude_archived: true,
          ...(cursor ? { cursor } : {})
        })
        if (res.ok === false) {
          throw new Error(`slack conversations.list failed: ${res.error ?? 'unknown error'}`)
        }
        for (const c of res.channels ?? []) {
          const t = toTarget(c)
          if (t) out.push(t)
        }
        cursor = res.response_metadata?.next_cursor || undefined
        if (!cursor) break
      }
      // conversations.list has no server-side search, so the filter is ours. Substring +
      // case-insensitive, over the paged set only — with the page cap above, a match past
      // TARGET_MAX_PAGES will not be found.
      const needle = query?.trim().toLowerCase()
      return needle ? out.filter((t) => t.name.toLowerCase().includes(needle)) : out
    }
  }
}
