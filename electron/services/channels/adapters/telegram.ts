// Telegram channel adapter — the FIRST concrete ChannelAdapter. Pure outbound
// CONNECTION (no inbound webhook to host): the Bot API is polled with long-poll
// getUpdates, so DUIN never needs a public URL. Each new text message becomes an
// InboundMessage handed to the runtime (authorize → de-privileged turn → reply),
// and the reply is delivered with sendMessage.
//
// SECURITY: authorizeUser() consults the pairing gate (deny-first). An unpaired
// external user is 'pending' and the runtime drops the message BEFORE any turn —
// the adapter never mints trust on its own. The bot token lives in the keychain
// under 'channel:telegram:token', never in settings/plaintext by default.
//
// The response→InboundMessage mapping (parseTelegramUpdates) is PURE so the
// offset/dedup logic is unit-tested with fixtures; the network poll can't be
// exercised without a live bot token (a human-verify item).

import { getKey } from '../../keychain'
import { authorizeStatus } from '../pairing-store'
import { messageOf } from '../../guarded'
import type {
  ChannelAdapter,
  ChannelAuthorization,
  ChannelContext,
  InboundMessage
} from '../channel-adapter'

const CHANNEL_ID = 'telegram'
const TOKEN_KEY = 'channel:telegram:token'
const API_BASE = 'https://api.telegram.org'
/** Long-poll timeout (seconds) handed to getUpdates — the server holds the
 *  connection open until an update arrives or this elapses. */
const POLL_TIMEOUT_S = 25
/** Backoff after a failed poll so a down/blocked network can't hot-loop. */
const ERROR_BACKOFF_MS = 5_000
/** Idle pause after a poll that returned no messages. getUpdates normally blocks
 *  server-side for POLL_TIMEOUT_S, but if a proxy/server ignores the long-poll
 *  timeout and returns instantly, this keeps the loop from busy-spinning. */
const IDLE_BACKOFF_MS = 1_000

// ─────────────────── wire shapes (Bot API getUpdates) ───────────────────

interface TelegramUser {
  id?: number
}
interface TelegramChat {
  id?: number
}
interface TelegramMessage {
  message_id?: number
  text?: string
  from?: TelegramUser
  chat?: TelegramChat
}
interface TelegramUpdate {
  update_id?: number
  message?: TelegramMessage
}
export interface TelegramGetUpdates {
  ok?: boolean
  result?: TelegramUpdate[]
}

export interface ParsedUpdates {
  messages: InboundMessage[]
  /** The offset to request NEXT — one past the highest update_id seen, so the
   *  server acks (drops) everything already delivered. Unchanged when empty. */
  nextOffset: number
}

/**
 * PURE mapper: a getUpdates body + the offset we requested → the inbound text
 * messages + the next poll offset. DEDUP is by update_id: any update with
 * `update_id < offset` was already acked and is skipped, and nextOffset advances
 * to max(update_id)+1 so the next long-poll can't re-deliver these.
 *
 * Only messages with text + a sender id + a chat id become InboundMessages
 * (edits, joins, stickers, service messages, etc. are ignored). threadId keys
 * per-CHAT continuity (`tg:<chatId>`); userId is the sender — the pairing subject.
 */
export function parseTelegramUpdates(body: TelegramGetUpdates, offset: number): ParsedUpdates {
  const messages: InboundMessage[] = []
  let maxId = offset - 1
  for (const u of body.result ?? []) {
    const id = typeof u.update_id === 'number' ? u.update_id : null
    if (id === null) continue
    if (id > maxId) maxId = id
    if (id < offset) continue // already acked → dedup
    const m = u.message
    const text = m?.text
    const fromId = m?.from?.id
    const chatId = m?.chat?.id
    if (!text || typeof fromId !== 'number' || typeof chatId !== 'number') continue
    messages.push({
      channelId: CHANNEL_ID,
      userId: String(fromId),
      threadId: `tg:${chatId}`,
      text
    })
  }
  return { messages, nextOffset: maxId + 1 }
}

async function callApi(
  token: string,
  method: string,
  body: unknown,
  fetchImpl: typeof fetch
): Promise<unknown> {
  const res = await fetchImpl(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return res.json()
}

/** Adapter instance. A single running poll loop; stop() cancels it. */
export function createTelegramAdapter(
  deps: { fetchImpl?: typeof fetch } = {}
): ChannelAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch
  let ctx: ChannelContext | null = null
  let running = false
  let offset = 0
  let loop: Promise<void> | null = null

  /** One poll cycle. Returns how many inbound messages were delivered. */
  async function pollOnce(token: string): Promise<number> {
    const body = (await callApi(
      token,
      'getUpdates',
      { offset, timeout: POLL_TIMEOUT_S },
      fetchImpl
    )) as TelegramGetUpdates
    const parsed = parseTelegramUpdates(body, offset)
    offset = parsed.nextOffset
    for (const msg of parsed.messages) {
      // The runtime (via ctx.onMessage) authorizes + de-privileges + replies.
      try {
        await ctx?.onMessage(msg)
      } catch (e) {
        console.debug('[telegram] onMessage failed:', messageOf(e))
      }
    }
    return parsed.messages.length
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  async function runLoop(): Promise<void> {
    while (running) {
      const token = getKey(TOKEN_KEY)
      if (!token) break
      try {
        const delivered = await pollOnce(token)
        if (running && delivered === 0) await sleep(IDLE_BACKOFF_MS)
      } catch (e) {
        console.debug('[telegram] poll error:', messageOf(e))
        await sleep(ERROR_BACKOFF_MS)
      }
    }
  }

  return {
    id: CHANNEL_ID,
    label: 'Telegram',
    credentials: [
      {
        keychainKey: TOKEN_KEY,
        label: 'Bot token',
        kind: 'secret',
        placeholder: '123456789:AA…',
        help: 'From @BotFather in Telegram: /newbot, then copy the token it prints.'
      }
    ],
    isConfigured(): boolean {
      return !!getKey(TOKEN_KEY)
    },
    async start(c: ChannelContext): Promise<void> {
      if (running) return // idempotent
      ctx = c
      running = true
      offset = 0
      loop = runLoop()
    },
    async stop(): Promise<void> {
      running = false
      ctx = null
      // Detach the loop; the in-flight long-poll resolves on its own timeout.
      loop = null
    },
    async send(to: string, text: string): Promise<void> {
      // Resolving means DELIVERED (see ChannelAdapter.send). Returning early on a
      // missing token, or ignoring a Telegram-level `{ ok: false }`, reported a bad
      // token / rate limit / blocked-bot as a successful delivery all the way up
      // through channelDispatch.
      const token = getKey(TOKEN_KEY)
      if (!token) throw new Error('telegram is not configured (no bot token)')
      const res = (await callApi(token, 'sendMessage', { chat_id: to, text }, fetchImpl)) as {
        ok?: boolean
        description?: string
      }
      if (res && res.ok === false) {
        throw new Error(`telegram sendMessage failed: ${res.description || 'unknown error'}`)
      }
    },
    async authorizeUser(userId: string): Promise<ChannelAuthorization> {
      return authorizeStatus(CHANNEL_ID, userId)
    }
  }
}

export const telegramAdapter = createTelegramAdapter()
