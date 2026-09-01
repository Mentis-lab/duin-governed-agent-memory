// THE TRANSPORT SEAM — the per-platform half of a channel, and nothing else.
//
// A ChannelAdapter (../channel-adapter.ts) is DUIN-shaped: it knows about the pairing
// gate, the de-privileged runtime, keychain fields, the gateway lifecycle. A transport
// knows none of that. It knows one vendor's wire protocol: how to open a connection,
// how a message arrives, how to send one back.
//
// Splitting them is what makes adding a channel cheap. The adapter layer is ~40 lines of
// the same shape every time; the transport is where the vendor-specific work lives, and
// it can be written and tested against nothing but the vendor's SDK.
//
// RULES FOR A TRANSPORT
//   · It NEVER imports the pairing store, the runtime, the gateway, or the keychain.
//     Credentials arrive as arguments. This is what keeps it unit-testable without a
//     live account and keeps authorization decisions in exactly one place.
//   · `connect` resolves once the connection is established and messages can arrive.
//     It must NOT resolve optimistically before the socket is up, or the gateway will
//     report a channel as running when it is not — the enabled-vs-running distinction
//     the settings pane already makes depends on this being honest.
//   · `send` resolving means DELIVERED. A failure MUST throw. Same contract the
//     adapter's send() carries, for the same reason: the caller has nothing else to
//     go on, and an adapter that swallows its own error makes retry logic dead code.
//   · Reconnection belongs to the transport. A dropped WebSocket is a vendor-protocol
//     concern, and every one of these platforms has its own backoff and resume rules.

/** One inbound message, normalized. Deliberately the same shape the adapter forwards. */
export interface TransportMessage {
  /** The sender's id ON THAT PLATFORM. This becomes the pairing subject, so it must be
   *  a STABLE id, never a display name — a name can be changed by the sender, and an
   *  authorization keyed on it would follow the name rather than the person. */
  userId: string
  /** Conversation/chat id, for continuity and for addressing the reply. */
  conversationId: string
  /** Plain text of the message. */
  text: string
  /** Vendor message id, when the platform supplies one (reactions, threading, dedup). */
  messageId?: string
  /** Native thread id for platforms with real threading (Slack thread_ts, Feishu
   *  root_id). Absent means the platform is flat or the message is top-level. */
  threadId?: string
  /** Anything the adapter may need that does not fit above. Never logged wholesale. */
  raw?: unknown
}

/** What a transport can do beyond the base, declared so the UI can render it and the
 *  adapter can expose it conditionally. Mirrors the optional-capability split that
 *  makes a flat interface unable to say "this one supports threads". */
export type TransportCapability =
  | 'threads'
  | 'reactions'
  | 'typing'
  | 'files'
  | 'directory'
  | 'edit'

export interface TransportTarget {
  id: string
  name: string
  kind: 'user' | 'group' | 'channel'
}

/**
 * The contract every platform transport implements.
 *
 * `connect` receives the sink rather than returning a stream so the transport owns its
 * own read loop and reconnection — the caller never has to know whether the underlying
 * mechanism is a WebSocket, a long-poll, IMAP IDLE or a subprocess.
 */
export interface ChannelTransport {
  /** Stable platform id: 'feishu', 'slack', 'dingtalk', … */
  readonly id: string
  /** What this transport supports beyond send/receive. */
  capabilities(): TransportCapability[]
  /** Open the connection and begin delivering messages to `onMessage`.
   *  Resolves only once messages can actually arrive. Throws if it cannot connect. */
  connect(onMessage: (msg: TransportMessage) => Promise<void>): Promise<void>
  /** Close and release everything. Safe to call when not connected. */
  disconnect(): Promise<void>
  /** Send text to a conversation. Resolving means delivered; failure throws. */
  send(conversationId: string, text: string, opts?: { threadId?: string }): Promise<void>
  /** Optional: send with local file attachments. Absent ⇒ caller falls back to send(). */
  sendFile?(conversationId: string, text: string, filePaths: string[]): Promise<void>
  /** Optional ('directory'): list reachable conversations, for the target picker. */
  listTargets?(query?: string): Promise<TransportTarget[]>
  /** Optional ('typing'): show/hide a typing indicator. Best-effort; never throws
   *  fatally — a platform that rejects it must not fail the turn. */
  setTyping?(conversationId: string, on: boolean): Promise<void>
  /** Optional ('reactions'): react to a message. */
  react?(conversationId: string, messageId: string, emoji: string): Promise<void>
}

/** Health of a transport connection, for the status line. Distinguishes the states the
 *  pane already refuses to conflate: not-configured, configured-but-down, and live. */
export type TransportState = 'disconnected' | 'connecting' | 'connected' | 'error'
