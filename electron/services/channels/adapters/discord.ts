// Discord channel adapter — bot Gateway (WebSocket) receive + REST send. This is
// an OUTBOUND-only CONNECTION in the same sense as Telegram: DUIN dials OUT to
// Discord's gateway, so no public inbound webhook is hosted. Kept deliberately
// MINIMAL — the smallest correct gateway client: HELLO→heartbeat, IDENTIFY, and
// MESSAGE_CREATE dispatch → InboundMessage. Replies go over the REST API.
//
// SECURITY: same deny-first pairing gate as every channel; the runtime drops an
// unpaired sender before any turn. The bot token lives in the keychain under
// 'channel:discord:token'. A live gateway connection needs a real bot token +
// privileged intents, so it CANNOT be verified here — the message mapper
// (parseDiscordMessage) is PURE + unit-tested; the socket lifecycle is a
// human-verify item and the channel stays disabled by default.

import { getKey } from '../../keychain'
import { authorizeStatus } from '../pairing-store'
import { messageOf } from '../../guarded'
import type {
  ChannelAdapter,
  ChannelAuthorization,
  ChannelContext,
  InboundMessage
} from '../channel-adapter'

const CHANNEL_ID = 'discord'
const TOKEN_KEY = 'channel:discord:token'
const API_BASE = 'https://discord.com/api/v10'
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'
// GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15).
// MESSAGE_CONTENT is privileged — must be enabled in the bot's dashboard.
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15)

// Gateway opcodes we handle.
const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

// ─────────────────── wire shapes (Gateway payloads) ───────────────────

interface DiscordAuthor {
  id?: string
  bot?: boolean
}
interface DiscordMessageCreate {
  id?: string
  content?: string
  channel_id?: string
  author?: DiscordAuthor
}
interface GatewayPayload {
  op: number
  d?: unknown
  s?: number | null
  t?: string | null
}

/**
 * PURE mapper: a MESSAGE_CREATE payload → an InboundMessage, or null when it
 * isn't a routable human message. Skips messages from bots (incl. our own echo,
 * which would otherwise loop) and anything missing content / author / channel.
 * threadId keys per-CHANNEL continuity (`dc:<channelId>`); userId is the author.
 */
export function parseDiscordMessage(d: DiscordMessageCreate): InboundMessage | null {
  const content = d.content
  const authorId = d.author?.id
  const channelId = d.channel_id
  if (d.author?.bot) return null
  if (!content || !authorId || !channelId) return null
  return {
    channelId: CHANNEL_ID,
    userId: authorId,
    threadId: `dc:${channelId}`,
    text: content
  }
}

// Minimal WebSocket surface (Node 20+/Electron ship a global WebSocket; typing
// it locally avoids pulling in the DOM lib for the node tsconfig).
interface MinimalWebSocket {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: ((err: unknown) => void) | null
}
type WebSocketCtor = new (url: string) => MinimalWebSocket

async function restSend(token: string, channelId: string, content: string): Promise<void> {
  const res = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content })
  })
  // Resolving means DELIVERED (see ChannelAdapter.send). The status was previously
  // discarded, so a 401/403/429 read as a successful send.
  if (!res.ok) {
    throw new Error(`discord send failed: HTTP ${res.status} ${res.statusText || ''}`.trim())
  }
}

/** Open (or reuse) a DM channel for a user and return its id. */
async function openDmChannel(token: string, userId: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/users/@me/channels`, {
      method: 'POST',
      headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ recipient_id: userId })
    })
    const body = (await res.json()) as { id?: string }
    return body.id ?? null
  } catch (e) {
    console.debug('[discord] openDmChannel failed:', messageOf(e))
    return null
  }
}

const ERROR_BACKOFF_MS = 5_000

export function createDiscordAdapter(): ChannelAdapter {
  let ctx: ChannelContext | null = null
  let ws: MinimalWebSocket | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let seq: number | null = null
  let running = false
  // Remember which channel a user last messaged from, so a reply lands in-place
  // (userId is the pairing subject; the reply target is a channel).
  const channelByUser = new Map<string, string>()

  function clearHeartbeat(): void {
    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
  }

  function handlePayload(token: string, payload: GatewayPayload): void {
    if (typeof payload.s === 'number') seq = payload.s
    if (payload.op === OP_HELLO) {
      const interval = (payload.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 41250
      clearHeartbeat()
      heartbeat = setInterval(() => {
        ws?.send(JSON.stringify({ op: OP_HEARTBEAT, d: seq }))
      }, interval)
      ws?.send(
        JSON.stringify({
          op: OP_IDENTIFY,
          d: { token, intents: INTENTS, properties: { os: 'linux', browser: 'duin', device: 'duin' } }
        })
      )
      return
    }
    if (payload.op === OP_HEARTBEAT) {
      ws?.send(JSON.stringify({ op: OP_HEARTBEAT, d: seq }))
      return
    }
    if (payload.op === OP_HEARTBEAT_ACK) return
    if (payload.op === OP_DISPATCH && payload.t === 'MESSAGE_CREATE') {
      const msg = parseDiscordMessage(payload.d as DiscordMessageCreate)
      if (!msg) return
      const chId = (payload.d as DiscordMessageCreate).channel_id
      if (chId) channelByUser.set(msg.userId, chId)
      void ctx?.onMessage(msg).catch((e) => console.debug('[discord] onMessage:', messageOf(e)))
    }
  }

  function connect(token: string): void {
    const Ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket
    if (!Ctor) {
      console.debug('[discord] no WebSocket implementation available')
      return
    }
    ws = new Ctor(GATEWAY_URL)
    ws.onmessage = (ev): void => {
      try {
        const payload = JSON.parse(String(ev.data)) as GatewayPayload
        handlePayload(token, payload)
      } catch (e) {
        console.debug('[discord] bad gateway frame:', messageOf(e))
      }
    }
    ws.onclose = (): void => {
      clearHeartbeat()
      if (running) setTimeout(() => running && connect(token), ERROR_BACKOFF_MS)
    }
    ws.onerror = (err): void => console.debug('[discord] ws error:', messageOf(err))
  }

  return {
    id: CHANNEL_ID,
    label: 'Discord',
    credentials: [
      {
        keychainKey: TOKEN_KEY,
        label: 'Bot token',
        kind: 'secret',
        placeholder: 'MTA…',
        help: 'Discord Developer Portal → your application → Bot → Reset/Copy Token. The bot also needs the MESSAGE CONTENT intent.'
      }
    ],
    isConfigured(): boolean {
      return !!getKey(TOKEN_KEY)
    },
    async start(c: ChannelContext): Promise<void> {
      if (running) return
      const token = getKey(TOKEN_KEY)
      if (!token) return
      ctx = c
      running = true
      connect(token)
    },
    async stop(): Promise<void> {
      running = false
      clearHeartbeat()
      try {
        ws?.close()
      } catch (e) {
        console.debug('[discord] close:', messageOf(e))
      }
      ws = null
      ctx = null
    },
    async send(to: string, text: string): Promise<void> {
      const token = getKey(TOKEN_KEY)
      if (!token) throw new Error('discord is not configured (no bot token)')
      let channelId = channelByUser.get(to)
      if (!channelId) {
        const dm = await openDmChannel(token, to)
        // Was `return` — an unopenable DM (blocked bot, bad user id) reported as sent.
        if (!dm) throw new Error(`discord could not open a DM channel for "${to}"`)
        channelId = dm
        channelByUser.set(to, dm)
      }
      await restSend(token, channelId, text)
    },
    async authorizeUser(userId: string): Promise<ChannelAuthorization> {
      return authorizeStatus(CHANNEL_ID, userId)
    }
  }
}

export const discordAdapter = createDiscordAdapter()
