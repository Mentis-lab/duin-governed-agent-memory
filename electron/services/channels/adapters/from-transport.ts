// TURNING A TRANSPORT INTO A CHANNEL — the ~40 lines that are the same every time.
//
// A transport (../transports/transport.ts) knows one vendor's wire protocol and nothing
// about DUIN. A ChannelAdapter knows the pairing gate, the keychain, the gateway
// lifecycle, and the de-privileged runtime. Everything BETWEEN those two is identical
// for every platform, so it is written once here rather than five times with five
// opportunities to get the security-relevant parts subtly different.
//
// WHAT THIS OWNS, and why each belongs here rather than in a transport:
//   · Credentials. A transport takes them as arguments precisely so it never imports
//     the keychain; this is the one place that reads it, so there is exactly one answer
//     to "where does a channel's secret come from".
//   · The pairing gate. `authorizeUser` is deny-first and must be identical everywhere —
//     a per-adapter copy is a per-adapter chance to weaken it.
//   · Lazy construction. The transport is built at start() from the credentials read at
//     that moment, so an operator who pastes a token and enables the channel does not
//     have to restart the app for it to be picked up.
//   · isConfigured(). Derived from the declared credential fields being present, so a
//     channel cannot claim to be configured on a secret nobody declared — which is what
//     made the gateway's "enabled AND configured" check meaningful in the first place.

import { getKey } from '../../keychain'
import { authorizeStatus } from '../pairing-store'
import { messageOf } from '../../guarded'
import type {
  ChannelAdapter,
  ChannelAuthorization,
  ChannelCapability,
  ChannelContext,
  ChannelCredentialField,
  ChannelTarget
} from '../channel-adapter'
import type { ChannelTransport, TransportMessage } from '../transports/transport'

export interface TransportAdapterSpec<C> {
  id: string
  label: string
  /** The values this channel needs. Every one is REQUIRED — see isConfigured. */
  credentials: ChannelCredentialField[]
  /** Assemble the transport's credential object from the keychain. Returns null when
   *  anything required is missing, which is what makes isConfigured() honest. */
  readCredentials(): C | null
  /** Build the transport. Called at start(), never at module load — so a token pasted
   *  a moment ago is used without an app restart. */
  create(creds: C): ChannelTransport
}

/**
 * Wrap a transport as a ChannelAdapter.
 *
 * The inbound path is deliberately thin: the transport hands us a TransportMessage, we
 * reshape it and pass it to the runtime. Authorization is NOT done here — `handleInbound`
 * in channel-runtime consults `authorizeUser` before any turn runs, and duplicating that
 * decision in the adapter would create a second place for it to drift.
 */
export function adapterFromTransport<C>(spec: TransportAdapterSpec<C>): ChannelAdapter {
  let transport: ChannelTransport | null = null
  let starting: Promise<void> | null = null

  const requireTransport = (what: string): ChannelTransport => {
    if (!transport) throw new Error(`${spec.id} is not connected (${what} before start)`)
    return transport
  }

  return {
    id: spec.id,
    label: spec.label,
    credentials: spec.credentials,

    isConfigured(): boolean {
      return spec.readCredentials() !== null
    },

    capabilities(): ChannelCapability[] {
      // The transport is the authority on what the platform can do, but it does not
      // exist until start(). Before then, report nothing rather than guessing — an
      // over-claim here would be rendered by the pane as an affordance that is not
      // there, and `channelCapabilities()` deliberately cannot save us from a claim
      // that is merely premature rather than wrong.
      return (transport?.capabilities() ?? []) as ChannelCapability[]
    },

    async start(ctx: ChannelContext): Promise<void> {
      // Idempotent, and re-entrant-safe: the gateway can call start() again while a
      // slow connect is still in flight (an enable toggled twice, a restart racing a
      // boot). Awaiting the in-flight promise rather than building a SECOND transport
      // is what stops two live sockets fighting over one bot — which on several of
      // these platforms silently disconnects the first.
      if (starting) return starting
      if (transport) return

      const creds = spec.readCredentials()
      if (!creds) throw new Error(`${spec.id} is not configured`)

      const t = spec.create(creds)
      starting = (async () => {
        try {
          await t.connect(async (msg: TransportMessage) => {
            await ctx.onMessage({
              channelId: spec.id,
              // The PAIRING SUBJECT. A stable platform id, never a display name —
              // a name can be changed by its owner, and an approval keyed on one
              // would follow the name rather than the person.
              userId: msg.userId,
              // Continuity key. Native threading wins when the platform has it, so a
              // threaded reply continues its own thread rather than the channel's.
              threadId: msg.threadId ?? msg.conversationId,
              text: msg.text
            })
          })
          transport = t
        } catch (err) {
          // Leave `transport` null so isConfigured/start stay truthful and a retry
          // builds a fresh one. Closing the half-built client prevents a socket leak
          // per failed attempt.
          await t.disconnect().catch(() => {})
          // `cause` carries the vendor's own error through. These transports fail with
          // things only the original object explains — a Slack rejection that is
          // literally `undefined`, a Feishu HTTP 200 whose non-zero code is the real
          // reason — so flattening to a message here would discard the one thing worth
          // reading when a channel will not come up.
          throw new Error(`${spec.id} failed to connect: ${messageOf(err)}`, { cause: err })
        } finally {
          starting = null
        }
      })()
      return starting
    },

    async stop(): Promise<void> {
      const t = transport
      transport = null
      starting = null
      if (t) await t.disconnect().catch(() => {})
    },

    canSend(): boolean {
      // Egress needs a live transport, not merely credentials on disk: these are all
      // connection-oriented, so there is no send path before connect. Distinct from
      // isConfigured() for the reason the ChannelAdapter contract spells out — for at
      // least one existing adapter the two genuinely differ.
      return transport !== null
    },

    async send(to: string, text: string): Promise<void> {
      // Resolving means DELIVERED. The transports already assert this against their
      // own vendor quirks (three of them report per-recipient failure inside an
      // HTTP 200); nothing is swallowed here.
      await requireTransport('send').send(to, text)
    },

    async sendFile(to: string, text: string, filePaths: string[]): Promise<void> {
      const t = requireTransport('sendFile')
      if (!t.sendFile) {
        // Fall back rather than throw: channelDispatch's contract is that a channel
        // without file support degrades to text, and failing the whole delivery would
        // lose the message as well as the attachment.
        await t.send(to, text)
        return
      }
      await t.sendFile(to, text, filePaths)
    },

    async listTargets(query?: string): Promise<ChannelTarget[]> {
      const t = requireTransport('listTargets')
      if (!t.listTargets) return []
      return t.listTargets(query)
    },

    async setTyping(to: string, on: boolean): Promise<void> {
      // BEST-EFFORT by contract: a platform that rejects a typing indicator must never
      // fail the turn it was decorating.
      try {
        await transport?.setTyping?.(to, on)
      } catch {
        /* ignored on purpose */
      }
    },

    async authorizeUser(userId: string): Promise<ChannelAuthorization> {
      return authorizeStatus(spec.id, userId)
    }
  }
}

/** Read a set of required keychain values, returning null if ANY is missing. The
 *  all-or-nothing rule is what makes isConfigured() mean "this can actually connect"
 *  rather than "someone filled in one of the two boxes". */
export function readRequired<K extends string>(keys: Record<K, string>): Record<K, string> | null {
  const out = {} as Record<K, string>
  for (const [field, keychainKey] of Object.entries(keys) as [K, string][]) {
    const v = getKey(keychainKey)
    if (!v) return null
    out[field] = v
  }
  return out
}
