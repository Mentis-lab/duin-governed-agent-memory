// Feishu channel adapter — reuses the native lark-cli comms (feishu-comms-native)
// rather than any new transport. Feishu has no long-poll/gateway we can dial, so
// ingress is a CURSORED POLL: for each watched chat (by name), pull the recent
// thread and, when the last message is inbound ('awaiting') and NEWER than the
// per-chat cursor, hand it to the runtime. Replies go back through
// sendFeishuMessage (user identity, via lark-cli).
//
// SECURITY: same deny-first pairing gate as every channel. The pairing subject
// (userId) is the watched chat's name/query — the same handle send() uses.
//
// Auth here is the lark-cli's OWN logged-in identity (not a keychain token), and
// the watchlist is an explicit opt-in stored under 'channel:feishu:watch'
// (comma-separated chat names). No watchlist ⇒ not configured ⇒ the gateway
// never starts it. A live poll needs an authenticated lark-cli, so the loop is a
// human-verify item; the cursor decision (feishuAwaitingToInbound) is PURE +
// unit-tested.

import { getKey } from '../../keychain'
import { authorizeStatus } from '../pairing-store'
import { messageOf } from '../../guarded'
import { pullFeishuMessages, sendFeishuMessage, type PullResult, type Exec } from '../../brain/feishu-comms-native'
import { larkExec } from '../../lark-exec'
import type {
  ChannelAdapter,
  ChannelAuthorization,
  ChannelContext,
  InboundMessage
} from '../channel-adapter'

const CHANNEL_ID = 'feishu'
const WATCH_KEY = 'channel:feishu:watch'
/** Poll cadence — Feishu is a courtesy channel, not a chat client; 30s keeps
 *  lark-cli invocations modest while staying responsive enough for replies. */
const POLL_INTERVAL_MS = 30_000

/** Parse the comma/newline-separated watchlist from the keychain. */
export function parseWatchlist(raw: string | null): string[] {
  return (raw ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export interface FeishuInbound {
  text: string
  /** Feishu create_time (ms epoch as string) of the message we're surfacing. */
  time: string
}

/**
 * PURE decision: given a pull result for one chat and the last-seen cursor time,
 * return the newest inbound message to process, or null. Only fires when the
 * thread is 'awaiting' (last message is theirs, not ours) AND that message's
 * time is strictly newer than the cursor — so a chat we've already answered, or
 * re-polled, won't re-trigger a turn.
 */
export function feishuAwaitingToInbound(pull: PullResult, cursorTime: string): FeishuInbound | null {
  if (!pull.ok || !pull.awaiting || pull.messages.length === 0) return null
  const last = pull.messages[pull.messages.length - 1]
  if (last.mine !== false) return null // defensive: 'awaiting' means theirs
  if (!last.text.trim()) return null
  // Numeric compare when both parse (Feishu create_time is ms-epoch); else fall
  // back to plain string inequality so a changed message still fires once.
  const a = Number(last.time)
  const b = Number(cursorTime)
  const newer =
    Number.isFinite(a) && Number.isFinite(b) ? a > b : last.time !== cursorTime
  if (!newer) return null
  return { text: last.text, time: last.time }
}

export function createFeishuAdapter(deps: { exec?: Exec } = {}): ChannelAdapter {
  const exec = deps.exec ?? larkExec()
  let ctx: ChannelContext | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let polling = false
  // Per-chat cursor: the create_time of the last message we've already surfaced.
  const cursor = new Map<string, string>()

  async function pollWatched(): Promise<void> {
    if (polling) return
    polling = true
    try {
      const watch = parseWatchlist(getKey(WATCH_KEY))
      for (const query of watch) {
        let pull: PullResult
        try {
          pull = await pullFeishuMessages(query, { exec })
        } catch (e) {
          console.debug('[feishu] pull failed for', query, messageOf(e))
          continue
        }
        const hit = feishuAwaitingToInbound(pull, cursor.get(query) ?? '')
        if (!hit) continue
        cursor.set(query, hit.time)
        const msg: InboundMessage = {
          channelId: CHANNEL_ID,
          userId: query,
          threadId: `feishu:${pull.chat_id ?? query}`,
          text: hit.text
        }
        try {
          await ctx?.onMessage(msg)
        } catch (e) {
          console.debug('[feishu] onMessage failed:', messageOf(e))
        }
      }
    } finally {
      polling = false
    }
  }

  return {
    id: CHANNEL_ID,
    label: 'Feishu',
    credentials: [
      {
        keychainKey: WATCH_KEY,
        label: 'Inbound watchlist',
        // NOT a secret: it is a list of chat ids, and a write-only watchlist would be
        // uneditable — the operator could never see what they are already watching.
        kind: 'text',
        placeholder: 'oc_abc123, ou_def456',
        help: 'Comma-separated chat/user ids to poll for inbound messages. Sending needs no entry here — it uses lark-cli\'s own login.'
      }
    ],
    isConfigured(): boolean {
      // INBOUND readiness: no watchlist ⇒ nothing to poll ⇒ the gateway must not
      // start this adapter. Deliberate, and unchanged.
      return parseWatchlist(getKey(WATCH_KEY)).length > 0
    },
    canSend(): boolean {
      // EGRESS readiness, which is a different question. Sending needs no watchlist
      // — it goes through lark-cli's own logged-in identity — so gating outbound on
      // isConfigured() refused every DUIN-driven Feishu delivery on an install with
      // no inbound watchlist, the common case for outbound-only use.
      //
      // There is no local credential to inspect: whether lark-cli is authenticated
      // is only knowable by invoking it. So this says yes and lets send() report the
      // real error, which it now does instead of swallowing it.
      return true
    },
    async start(c: ChannelContext): Promise<void> {
      if (timer) return
      ctx = c
      void pollWatched()
      timer = setInterval(() => void pollWatched(), POLL_INTERVAL_MS)
    },
    async stop(): Promise<void> {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      ctx = null
    },
    async send(to: string, text: string): Promise<void> {
      // Resolving means DELIVERED (see ChannelAdapter.send). sendFeishuMessage
      // reports failure in its RETURN value and never throws, so discarding it
      // turned every failed send — unknown chat, lark-cli not logged in, exec
      // failure — into a reported success.
      const r = await sendFeishuMessage(to, text, false, { exec })
      if (!r.ok) throw new Error(r.error || 'feishu send failed')
    },
    async authorizeUser(userId: string): Promise<ChannelAuthorization> {
      return authorizeStatus(CHANNEL_ID, userId)
    }
  }
}

export const feishuAdapter = createFeishuAdapter()
