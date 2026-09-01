// Feishu (Lark) transport — 长连接 / WebSocket event mode.
//
// WHY THE WEBSOCKET MODE AND NOT THE WEBHOOK ONE. Feishu offers two ways to receive
// events. The webhook mode needs a publicly reachable HTTPS URL and makes the receiver
// responsible for the URL-verification challenge, the `Encrypt` AES envelope and the
// signature check. DUIN is a desktop app behind whatever NAT the operator happens to be
// on, so there is no URL to give Feishu — and webhook-server.ts exists precisely because
// hosting one is a cost we pay only when we must. The 长连接 mode dials OUT: the app
// authenticates ONCE with appId/appSecret at connect time, and every event afterwards
// arrives plaintext over that already-authenticated socket. No public URL, no encrypt
// key, no per-event signature verification.
//
// CREDENTIALS ARRIVE AS ARGUMENTS. Per transport.ts, nothing here reads the keychain,
// the pairing store or the gateway. `open_id` is handed up as TransportMessage.userId
// and the authorization decision is made exactly once, elsewhere.
//
// THE THREE VENDOR CONSTRAINTS THAT SHAPED THIS FILE — each verified against
// @larksuiteoapi/node-sdk 1.73.0 rather than assumed:
//
//   1. `WSClient.start()` is `async` but does NOT await the connection. Its last
//      statement is a bare `this.reConnect(true)` — no `await`. So `await start()`
//      resolves while the socket is still dialling, which is exactly the optimistic
//      resolve transport.ts forbids. connect() therefore waits on the SDK's `onReady`
//      callback instead, and start() is fired without awaiting it.
//
//   2. Feishu re-pushes an event the app does not acknowledge within 3 SECONDS
//      (SDK README: "developers need to complete processing within 3 seconds after
//      receiving a message, otherwise, a timeout re-push will be triggered"). The SDK
//      sends the ack frame only AFTER the registered handler's promise settles. A DUIN
//      turn takes far longer than 3s, so awaiting the sink inside the handler would make
//      Feishu re-deliver every single message and run the turn again. The handler acks
//      immediately and the sink runs detached — see dispatch().
//
//   3. The SDK's axios response interceptor returns `resp.data` for ANY 2xx, and Feishu
//      answers HTTP 200 with `{code: <non-zero>, msg}` for application-level refusals
//      (bot not in the chat, no permission, bad receive_id, rate limit). So a failed
//      send RESOLVES. This is the same trap adapters/feishu.ts already documents for
//      sendFeishuMessage; assertOk() below is what keeps `send` resolving == delivered.

import { messageOf } from '../../guarded'
import type {
  ChannelTransport,
  TransportCapability,
  TransportMessage
} from './transport'

const TRANSPORT_ID = 'feishu'

/** Feishu app ids are `cli_` + 16 hex. WSClient.start() checks this same shape and,
 *  on a mismatch, logs and RETURNS — no throw, no callback, ever. Pre-checking here
 *  turns a typo'd appId into an immediate, readable error instead of a connect() that
 *  hangs for CONNECT_TIMEOUT_MS and then blames the network. */
const APP_ID_RE = /^cli_[0-9a-fA-F]{16}$/

/** How long connect() waits for the first successful handshake before giving up.
 *  A ceiling is REQUIRED, not defensive: with autoReconnect on, a refused or stuck
 *  handshake feeds the SDK's retry loop rather than `onError`, and the server-pushed
 *  `reconnectCount` may be negative, meaning retry forever. Without this, a channel
 *  with revoked credentials would sit in "connecting" and never report a failure. */
const CONNECT_TIMEOUT_MS = 30_000

/** Handed to the SDK so one stuck TCP/TLS handshake (dead proxy, black-holed DNS)
 *  aborts and re-enters the retry loop instead of hanging. Deliberately well under
 *  CONNECT_TIMEOUT_MS so the first attempt still leaves room for a second. */
const HANDSHAKE_TIMEOUT_MS = 12_000

/** Outer restart backoff, used only after the SDK's OWN reconnect loop gives up.
 *  transport.ts puts reconnection on the transport; the SDK covers the common drop
 *  with server-supplied intervals, and this covers the terminal case it reports via
 *  `onError` — otherwise the channel would stay silently dead with nothing watching. */
const RESTART_BACKOFF_MIN_MS = 5_000
const RESTART_BACKOFF_MAX_MS = 300_000

/** Recently handled message ids, for de-duplication. Bounded because this is a
 *  long-lived desktop process: an unbounded set is a slow leak. Sized well past any
 *  plausible re-push burst — Feishu retries an unacked event a handful of times, not
 *  thousands. */
const DEDUP_MAX = 2_000

// The SDK is NOT yet a dependency of this app (see the report/README note). Holding the
// specifier as a widened `string` — not a string literal — keeps both `tsc` and the
// bundler from trying to resolve it at build time, so this file neither breaks the
// typecheck nor the build while it is unwired. A missing package then surfaces at
// connect()/send() as an actionable install message instead of a build failure for every
// lane. Same treatment as slack-socket.ts.
const LARK_PKG: string = '@larksuiteoapi/node-sdk'

// ─────────────────── wire shapes (im.message.receive_v1) ───────────────────
// Narrowed to the fields actually read. Every one of these is optional-in-practice
// except message_id / chat_id / content, which the SDK's own event typing marks
// required — so the mapper still guards them rather than trusting the annotation.

export interface FeishuMention {
  /** The literal placeholder that appears inside the message text, e.g. `@_user_1`. */
  key: string
  id?: { open_id?: string; union_id?: string; user_id?: string }
  name?: string
}

export interface FeishuMessageEvent {
  event_id?: string
  sender?: {
    sender_id?: { open_id?: string; union_id?: string; user_id?: string }
    /** 'user' for a human, 'app' for another bot. */
    sender_type?: string
  }
  message?: {
    message_id?: string
    /** Root of the reply chain. Absent on a top-level message. */
    root_id?: string
    /** The message directly replied to. Not used for threading — see the mapper. */
    parent_id?: string
    chat_id?: string
    /** Topic-group thread. Deliberately unused — see the mapper. */
    thread_id?: string
    chat_type?: string
    message_type?: string
    /** JSON string whose shape depends on message_type. */
    content?: string
    mentions?: FeishuMention[]
  }
}

// ─────────────────── pure mapping ───────────────────

/** One row element of a `post` (rich text) message. */
interface PostRun {
  tag?: string
  text?: string
  href?: string
  user_name?: string
}

/**
 * Substitute each `@_user_N` placeholder with `@<display name>`.
 *
 * Feishu does NOT inline mention names into the text: a group message reading
 * "@DUIN summarise this" arrives as `"@_user_1 summarise this"` plus a mentions array.
 * Left alone, the model is asked to answer a prompt containing an opaque token.
 *
 * Replacement runs LONGEST KEY FIRST. `@_user_1` is a prefix of `@_user_10`, so naive
 * in-order replacement would rewrite the first ten characters of the eleventh mention
 * and leave a stray `0` behind. A mention with no name loses just the placeholder —
 * printing a bare `@` would read as a real, empty mention.
 */
export function resolveFeishuMentions(text: string, mentions?: FeishuMention[]): string {
  if (!mentions?.length || !text) return text
  const ordered = [...mentions].filter((m) => !!m?.key).sort((a, b) => b.key.length - a.key.length)
  let out = text
  for (const m of ordered) {
    out = out.split(m.key).join(m.name ? `@${m.name}` : '')
  }
  return out.trim()
}

/**
 * PURE: pull plain text out of a Feishu message body.
 *
 * `content` is a JSON STRING whose schema is chosen by `message_type`, so this is a
 * parse-and-narrow, not a field read. Only the two types that actually carry prose are
 * decoded: `text` and `post` (rich text). Everything else — image, file, audio, media,
 * sticker, interactive card, share_chat — has no prose to extract and returns ''.
 *
 * Malformed JSON returns '' rather than throwing: a single unparseable message must not
 * be able to take down the read loop, and the caller drops empty-text messages anyway.
 */
export function extractFeishuText(messageType: string | undefined, content: string | undefined): string {
  if (!content) return ''
  let body: unknown
  try {
    body = JSON.parse(content)
  } catch {
    return ''
  }
  if (!body || typeof body !== 'object') return ''

  if (messageType === 'text') {
    const t = (body as { text?: unknown }).text
    return typeof t === 'string' ? t : ''
  }

  if (messageType === 'post') {
    // A received post is `{title?, content: [[run, …], …]}`. A post built for SENDING is
    // wrapped in a locale key (`{zh_cn: {title, content}}`), and the same shape has been
    // observed on the receive side, so unwrap one locale level before reading.
    let post = body as { title?: unknown; content?: unknown }
    if (!Array.isArray(post.content)) {
      const first = Object.values(body as Record<string, unknown>).find(
        (v) => !!v && typeof v === 'object' && Array.isArray((v as { content?: unknown }).content)
      )
      if (first) post = first as { title?: unknown; content?: unknown }
    }
    if (!Array.isArray(post.content)) return ''
    const lines: string[] = []
    for (const row of post.content as unknown[]) {
      if (!Array.isArray(row)) continue
      const parts: string[] = []
      for (const run of row as PostRun[]) {
        if (!run || typeof run !== 'object') continue
        // `a` carries the link text in `text` and the target in `href`; `at` carries the
        // mentioned person in `user_name`. Both are prose to a reader, so both are kept.
        if (typeof run.text === 'string' && run.text) parts.push(run.text)
        else if (run.tag === 'at' && typeof run.user_name === 'string') parts.push(`@${run.user_name}`)
      }
      if (parts.length) lines.push(parts.join(''))
    }
    const title = typeof post.title === 'string' ? post.title.trim() : ''
    const bodyText = lines.join('\n').trim()
    return title && bodyText ? `${title}\n${bodyText}` : title || bodyText
  }

  return ''
}

/**
 * PURE: one `im.message.receive_v1` event → a TransportMessage, or null to drop it.
 *
 * DROPPED, and why each one:
 *   · sender_type !== 'user' — an 'app' sender is another bot (or this one). Turning a
 *     bot's message into a turn is how two bots in one group talk to each other forever.
 *   · no stable sender id — userId becomes the PAIRING SUBJECT (transport.ts), so a
 *     message we cannot attribute to a stable id must not reach the authorization gate
 *     at all. There is nothing to key an approval on.
 *   · no chat_id / message_id — no address to reply to, no id to de-duplicate by.
 *   · empty text — image/file/sticker messages carry no prose. Synthesising a stand-in
 *     ("[image]") would hand the model a prompt the human never wrote.
 *
 * ID SELECTION. `open_id` first: it is stable for one (person, app) pair and is what
 * this transport's own credentials address. `union_id` is the fallback — also stable,
 * scoped to the developer rather than the app. `user_id` is last: tenant-scoped and only
 * present when the app holds the extra scope for it. A display name is never used; it is
 * the sender's to change, and an approval keyed on it would follow the name.
 *
 * CONVERSATION vs SENDER. conversationId is `chat_id`, never the sender's open_id. They
 * coincide in spirit for a p2p chat but not in a group, where replying to the open_id
 * would send the answer as a private DM to whoever asked.
 *
 * THREADING is `root_id` only, matching transport.ts ("Slack thread_ts, Feishu root_id …
 * absent means the platform is flat or the message is top-level"). `parent_id` is the
 * immediate parent, which would splinter one conversation into a chain of separate
 * threads. `thread_id` (topic groups) is not a message id and cannot be passed to
 * im.message.reply, so it is carried in `raw` rather than pretended to be a threadId.
 */
export function feishuEventToMessage(event: FeishuMessageEvent): TransportMessage | null {
  const sender = event?.sender
  const message = event?.message
  if (!message) return null

  // sender_type is absent on some replayed/legacy payloads; only an explicit non-'user'
  // is treated as a bot, so an unlabelled human message is not silently discarded.
  if (sender?.sender_type && sender.sender_type !== 'user') return null

  const ids = sender?.sender_id
  const userId = ids?.open_id || ids?.union_id || ids?.user_id
  if (!userId) return null

  const conversationId = message.chat_id
  const messageId = message.message_id
  if (!conversationId || !messageId) return null

  const text = resolveFeishuMentions(
    extractFeishuText(message.message_type, message.content),
    message.mentions
  ).trim()
  if (!text) return null

  const out: TransportMessage = { userId, conversationId, text, messageId, raw: event }
  if (message.root_id) out.threadId = message.root_id
  return out
}

// ─────────────────── SDK seam ───────────────────
// Structural interfaces rather than `typeof import(…)`, for two reasons. It pins in one
// place the FOUR SDK members this file is allowed to touch, so a future edit cannot
// quietly start depending on more of the vendor surface. And it lets the unit tests
// drive connect/send with a fake, so the pure mapping above is not the only thing that
// can be tested without a live Feishu app.

export interface FeishuEventDispatcher {
  register(handles: Record<string, (data: never) => unknown>): FeishuEventDispatcher
}

export interface FeishuWsClient {
  start(params: { eventDispatcher: FeishuEventDispatcher }): Promise<void> | void
  close(params?: { force?: boolean }): void
}

/** The Feishu response envelope. `code: 0` is success; anything else is a refusal
 *  delivered over HTTP 200 (see constraint 3 in the file header). */
export interface FeishuResponse {
  code?: number
  msg?: string
  data?: unknown
}

export interface FeishuApiClient {
  im: {
    message: {
      create(payload: {
        params: { receive_id_type: 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id' }
        data: { receive_id: string; msg_type: string; content: string }
      }): Promise<FeishuResponse | null>
      reply(payload: {
        path: { message_id: string }
        data: { content: string; msg_type: string; reply_in_thread?: boolean }
      }): Promise<FeishuResponse | null>
    }
    image: {
      create(payload: {
        data: { image_type: 'message' | 'avatar'; image: Buffer }
      }): Promise<(FeishuResponse & { image_key?: string }) | null>
    }
    file: {
      create(payload: {
        data: { file_type: string; file_name: string; file: Buffer }
      }): Promise<(FeishuResponse & { file_key?: string }) | null>
    }
  }
}

export interface FeishuWsClientOptions {
  appId: string
  appSecret: string
  autoReconnect?: boolean
  handshakeTimeoutMs?: number
  onReady?: () => void
  onError?: (err: Error) => void
  onReconnecting?: () => void
  onReconnected?: () => void
}

export interface FeishuSdk {
  WSClient: new (opts: FeishuWsClientOptions) => FeishuWsClient
  Client: new (opts: { appId: string; appSecret: string }) => FeishuApiClient
  EventDispatcher: new (opts: Record<string, never>) => FeishuEventDispatcher
}

export interface FeishuTransportDeps {
  /** Test seam. Production passes nothing and gets the real SDK, loaded LAZILY so that
   *  merely constructing the transport — what the settings pane does just to ask
   *  `isConfigured()` — never pays for the vendor package's module graph, and so an
   *  absent package is a connect-time message rather than an import-time crash. */
  loadSdk?: () => Promise<FeishuSdk>
}

// ─────────────────── helpers ───────────────────

/** Throws unless Feishu reported success. See constraint 3: `code` is non-zero on a
 *  refusal that arrived as HTTP 200, so a resolved promise is NOT proof of delivery. */
function assertOk(res: FeishuResponse | null | undefined, what: string): void {
  if (res && typeof res.code === 'number' && res.code !== 0) {
    throw new Error(`feishu ${what} failed: ${res.msg || 'unknown error'} (code ${res.code})`)
  }
}

/** Feishu's upload endpoints accept a closed set of `file_type` values; `stream` is the
 *  documented catch-all for anything not in the list. Images are NOT valid here — they
 *  go through im.image.create instead (see sendFile). */
const FILE_TYPE_BY_EXT: Record<string, string> = {
  opus: 'opus',
  mp4: 'mp4',
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  xls: 'xls',
  xlsx: 'xls',
  ppt: 'ppt',
  pptx: 'ppt'
}

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'ico', 'tiff', 'heic'])

function extOf(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

function baseNameOf(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() || 'file'
}

/**
 * Load the real SDK. One cast, at exactly one boundary: the vendor's own types are far
 * wider than the structural interfaces above, and narrowing here is what keeps the rest
 * of this file honest about the four members it touches.
 *
 * `WSClient` is a TOP-LEVEL named export (`export { WSClient } from './ws-client'`),
 * not a `ws.Client` namespace member — verified against the published 1.73.0 type
 * bundle, so reaching for `lark.ws.Client` would be undefined at runtime.
 */
async function loadFeishuSdk(): Promise<FeishuSdk> {
  try {
    return (await import(LARK_PKG)) as unknown as FeishuSdk
  } catch (e) {
    // Separated from construction below so a constructor error (e.g. a rejected appId)
    // is never mislabelled as a missing package.
    throw new Error(`feishu transport requires its SDK — run: npm i ${LARK_PKG} (${messageOf(e)})`, {
      cause: e
    })
  }
}

// ─────────────────── transport ───────────────────

export function createFeishuTransport(
  opts: { appId: string; appSecret: string },
  deps: FeishuTransportDeps = {}
): ChannelTransport {
  const loadSdk = deps.loadSdk ?? loadFeishuSdk

  let sdk: FeishuSdk | null = null
  let api: FeishuApiClient | null = null
  let ws: FeishuWsClient | null = null
  let sink: ((msg: TransportMessage) => Promise<void>) | null = null
  /** Set by disconnect(). Stops the outer restart loop from re-arming a socket the
   *  caller has explicitly torn down — otherwise a disconnect racing a dying connection
   *  leaves a reconnect scheduled against a transport nobody owns any more. */
  let stopped = true
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let restartDelay = RESTART_BACKOFF_MIN_MS

  const seen = new Set<string>()
  /** One promise chain PER CHAT. Constraint 2 forbids awaiting the sink inside the
   *  event handler, which also throws away the natural back-pressure the Telegram
   *  adapter gets from its serial poll loop: two quick messages would start two
   *  concurrent turns and the replies could land out of order. Chaining per chat_id
   *  restores ordering within a conversation while still acking instantly, and keeps
   *  separate chats independent of each other. */
  const chains = new Map<string, Promise<void>>()

  async function ensureSdk(): Promise<FeishuSdk> {
    if (!sdk) sdk = await loadSdk()
    return sdk
  }

  /** The outbound API client is built independently of the WebSocket, and lazily.
   *  Ingress and egress are DIFFERENT readiness questions — adapters/feishu.ts already
   *  carries that distinction for the same platform. Requiring connect() before send()
   *  would refuse every outbound-only delivery, and the REST client needs no socket:
   *  it authenticates per request with the same appId/appSecret. */
  async function ensureApi(): Promise<FeishuApiClient> {
    if (!api) {
      const s = await ensureSdk()
      api = new s.Client({ appId: opts.appId, appSecret: opts.appSecret })
    }
    return api
  }

  /** true if this message id was already handled. Feishu re-pushes an unacked event,
   *  and a reconnect can replay one that was acked mid-flight, so the dedup is on the
   *  message id — the key that means "one message, one turn" regardless of how many
   *  times the platform delivers it. */
  function isDuplicate(messageId: string): boolean {
    if (seen.has(messageId)) return true
    seen.add(messageId)
    if (seen.size > DEDUP_MAX) {
      const oldest = seen.values().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
    return false
  }

  function enqueue(conversationId: string, msg: TransportMessage): void {
    const prev = chains.get(conversationId) ?? Promise.resolve()
    const next = prev
      .then(() => sink?.(msg))
      .then(
        () => undefined,
        (e: unknown) => {
          // Swallowed ON PURPOSE, and only here. This runs detached from the ack, so
          // there is no caller to throw to; rejecting would surface as an unhandled
          // rejection and, in Electron main, take the process down over one bad turn.
          console.debug('[feishu-ws] onMessage failed:', messageOf(e))
        }
      )
    chains.set(conversationId, next)
    void next.then(() => {
      // Drop the chain entry once it drains, so a process that talks to many chats over
      // a long session does not accumulate one settled promise per chat forever.
      if (chains.get(conversationId) === next) chains.delete(conversationId)
    })
  }

  /** The registered event handler. Returns immediately — see constraint 2. */
  function dispatch(event: FeishuMessageEvent): void {
    const msg = feishuEventToMessage(event)
    if (!msg || !msg.messageId) return
    if (isDuplicate(msg.messageId)) return
    enqueue(msg.conversationId, msg)
  }

  function clearRestart(): void {
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
  }

  /** Re-arm after the SDK's own reconnect loop reported terminal failure. Exponential
   *  so a revoked secret or a suspended app backs off to one attempt per five minutes
   *  instead of hammering Feishu's auth endpoint forever. */
  function scheduleRestart(): void {
    if (stopped || restartTimer) return
    const delay = restartDelay
    restartDelay = Math.min(restartDelay * 2, RESTART_BACKOFF_MAX_MS)
    restartTimer = setTimeout(() => {
      restartTimer = null
      if (stopped) return
      void openSocket().catch((e) => {
        console.debug('[feishu-ws] restart failed:', messageOf(e))
        scheduleRestart()
      })
    }, delay)
  }

  /**
   * Build a WSClient and resolve only once the FIRST handshake has succeeded.
   *
   * `onReady` is the SDK's "the socket is open" signal, and waiting on it is what makes
   * connect() honest: start() itself resolves while still dialling (constraint 1), so
   * awaiting start() would report a channel as running before any event could arrive.
   *
   * The timeout is not belt-and-braces. With autoReconnect on, a rejected handshake goes
   * back into the SDK's retry loop rather than to `onError`, and the server-supplied
   * `reconnectCount` can be negative — retry forever. Without a ceiling, bad credentials
   * would never produce a thrown error, only a permanent "connecting".
   */
  function openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null

      const finish = (err?: Error): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (err) {
          // Tear the client down before rejecting. The SDK keeps retrying on its own
          // schedule, so abandoning the reference here would leak a reconnect loop that
          // outlives the failed connect() — and a later disconnect() would have nothing
          // to close.
          try {
            ws?.close({ force: true })
          } catch {
            // Already dead or never opened; nothing to release.
          }
          ws = null
          reject(err)
        } else {
          restartDelay = RESTART_BACKOFF_MIN_MS
          resolve()
        }
      }

      void (async () => {
        try {
          const s = await ensureSdk()
          const dispatcher = new s.EventDispatcher({}).register({
            // Named exactly as Feishu emits it. The dispatcher keys on the event name,
            // so a typo here is a silent no-op: connected, acking, never delivering.
            'im.message.receive_v1': (data: never) => {
              dispatch(data as FeishuMessageEvent)
              // Resolved value is what the SDK puts in the ack frame; undefined means
              // "handled, nothing to return", which is what Feishu expects.
              return undefined
            }
          })

          ws = new s.WSClient({
            appId: opts.appId,
            appSecret: opts.appSecret,
            autoReconnect: true,
            handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
            onReady: () => finish(),
            onError: (err: Error) => {
              if (!settled) {
                finish(new Error(`feishu websocket connect failed: ${messageOf(err)}`, { cause: err }))
                return
              }
              // Post-connect: the SDK's reconnect loop is exhausted. transport.ts puts
              // reconnection on the transport, so re-arm rather than going quiet.
              console.debug('[feishu-ws] connection lost permanently:', messageOf(err))
              ws = null
              scheduleRestart()
            },
            onReconnecting: () => console.debug('[feishu-ws] reconnecting'),
            onReconnected: () => {
              restartDelay = RESTART_BACKOFF_MIN_MS
              console.debug('[feishu-ws] reconnected')
            }
          })

          timer = setTimeout(
            () => finish(new Error(`feishu websocket did not connect within ${CONNECT_TIMEOUT_MS}ms`)),
            CONNECT_TIMEOUT_MS
          )

          // NOT awaited, on purpose: start() resolves before the socket is up
          // (constraint 1), so its promise says nothing about readiness. `onReady` /
          // `onError` / the timeout above are the only three ways out of here.
          await ws.start({ eventDispatcher: dispatcher })
        } catch (e) {
          finish(new Error(`feishu websocket start failed: ${messageOf(e)}`, { cause: e }))
        }
      })()
    })
  }

  /** Upload one local file and return the message content Feishu expects for it.
   *  Images and non-images take DIFFERENT endpoints — im.file.create rejects image
   *  types outright — so the split is by extension, not a single generic upload. */
  async function uploadAttachment(
    client: FeishuApiClient,
    filePath: string
  ): Promise<{ msgType: string; content: string }> {
    const { readFile } = await import('node:fs/promises')
    const buf = await readFile(filePath)
    const ext = extOf(filePath)

    if (IMAGE_EXTS.has(ext)) {
      const res = await client.im.image.create({ data: { image_type: 'message', image: buf } })
      assertOk(res, 'image upload')
      // The upload endpoints return the key UNWRAPPED (`{image_key}`), not inside the
      // usual `{code, msg, data}` envelope — so both shapes are read before deciding
      // the upload failed.
      const key = res?.image_key ?? (res?.data as { image_key?: string } | undefined)?.image_key
      if (!key) throw new Error(`feishu image upload returned no image_key for ${filePath}`)
      return { msgType: 'image', content: JSON.stringify({ image_key: key }) }
    }

    const res = await client.im.file.create({
      data: {
        file_type: FILE_TYPE_BY_EXT[ext] ?? 'stream',
        file_name: baseNameOf(filePath),
        file: buf
      }
    })
    assertOk(res, 'file upload')
    const key = res?.file_key ?? (res?.data as { file_key?: string } | undefined)?.file_key
    if (!key) throw new Error(`feishu file upload returned no file_key for ${filePath}`)
    return { msgType: 'file', content: JSON.stringify({ file_key: key }) }
  }

  async function post(
    conversationId: string,
    msgType: string,
    content: string,
    threadId: string | undefined,
    what: string
  ): Promise<void> {
    const client = await ensureApi()
    // im.message.create has no thread parameter at all; joining a thread is a different
    // ENDPOINT, keyed on the message being replied to. Absent a threadId this is a
    // top-level message in the chat, which is what a flat reply should be.
    const res = threadId
      ? await client.im.message.reply({ path: { message_id: threadId }, data: { content, msg_type: msgType } })
      : await client.im.message.create({
          // chat_id addresses both p2p and group chats, and is exactly the id the
          // inbound event carried as conversationId — so a reply always goes back to
          // the conversation the message came from, not to the person who sent it.
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: conversationId, msg_type: msgType, content }
        })
    assertOk(res, what)
  }

  return {
    id: TRANSPORT_ID,

    capabilities(): TransportCapability[] {
      // Only what is actually implemented below. 'reactions' and 'typing' exist on the
      // Feishu API but are not wired here, and declaring a capability the UI would then
      // render a control for is worse than not having it.
      return ['threads', 'files']
    },

    async connect(onMessage: (msg: TransportMessage) => Promise<void>): Promise<void> {
      if (!APP_ID_RE.test(opts.appId)) {
        throw new Error(`feishu appId must look like cli_<16 hex>, got '${opts.appId}'`)
      }
      if (!opts.appSecret) throw new Error('feishu appSecret is required')

      sink = onMessage
      if (ws) return // idempotent; the sink above is refreshed either way

      stopped = false
      clearRestart()
      restartDelay = RESTART_BACKOFF_MIN_MS
      try {
        await openSocket()
      } catch (e) {
        stopped = true
        sink = null
        throw e
      }
    },

    async disconnect(): Promise<void> {
      stopped = true
      clearRestart()
      sink = null
      const client = ws
      ws = null
      if (client) {
        try {
          client.close({ force: true })
        } catch (e) {
          // Safe to call when not connected (transport.ts). A close that throws because
          // the socket is already gone is the state we wanted anyway.
          console.debug('[feishu-ws] close failed:', messageOf(e))
        }
      }
      seen.clear()
      chains.clear()
    },

    async send(conversationId: string, text: string, sendOpts?: { threadId?: string }): Promise<void> {
      await post(conversationId, 'text', JSON.stringify({ text }), sendOpts?.threadId, 'send')
    },

    async sendFile(conversationId: string, text: string, filePaths: string[]): Promise<void> {
      // Feishu has no "text plus attachments" message: a file message carries a file_key
      // and nothing else. So the caption is its own message, sent FIRST so it arrives
      // above the files and reads as a caption rather than an afterthought.
      if (text.trim()) await post(conversationId, 'text', JSON.stringify({ text }), undefined, 'send')
      const client = await ensureApi()
      for (const filePath of filePaths) {
        const { msgType, content } = await uploadAttachment(client, filePath)
        await post(conversationId, msgType, content, undefined, 'sendFile')
      }
    }
  }
}
