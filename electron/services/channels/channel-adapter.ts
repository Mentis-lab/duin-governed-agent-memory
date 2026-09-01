// Channel adapters — the CONVERSATIONAL half of connectivity. Where a
// SourceAdapter (connectors/source-adapters.ts) PULLs content INTO the brain,
// a ChannelAdapter runs a two-way turn: it receives an inbound message from an
// external surface (Slack DM / Telegram / SMS / …), routes it through the brain
// via the de-privileged channel-runtime, and sends the reply back out.
//
// This is a SIBLING of SourceAdapter, not a superset: a channel is about live
// dialogue + delivery, a source is about periodic ingest. A channel MAY also
// expose an `asSource()` when its history is worth ingesting, but that's opt-in.
//
// SECURITY: an inbound channel turn has NO trusted renderer to mint the
// per-launch exec token, so it MUST run de-privileged — see channel-runtime.ts.
// Per-user pairing (pairing-store.ts) is the second gate: an unknown external
// user is 'pending' until the operator approves them, never auto-trusted.

import type { SourceAdapter } from '../connectors/source-adapters'

/** One inbound message from an external surface, normalized. */
export interface InboundMessage {
  /** The adapter id that received this (e.g. 'telegram'). */
  channelId: string
  /** The EXTERNAL user id on that surface (the pairing subject). */
  userId: string
  /** Per-sender continuity key → the brain's threadId (multi-turn memory). */
  threadId: string
  /** The user's message text. */
  text: string
}

/**
 * Wiring handed to `start()` so an adapter can push inbound messages back into
 * the runtime without importing it directly (keeps adapters decoupled + unit-
 * testable). The runtime supplies `onMessage`; the adapter calls it per message.
 */
export interface ChannelContext {
  /** Deliver one inbound message to the runtime (authorize → turn → reply). */
  onMessage: (msg: InboundMessage) => Promise<void>
}

/** Authorization verdict for an external user on a channel. */
export type ChannelAuthorization = 'approved' | 'pending' | 'denied'

/** One operator-supplied value a channel needs before it can connect.
 *
 *  Declared by the adapter rather than hard-coded in the settings pane, because the
 *  adapter is the only thing that knows WHICH keychain entry it reads — and the gap this
 *  closes was exactly that split: `isConfigured()` reported "waiting for credentials"
 *  while the app offered nowhere to put one, so the only way to connect a channel was to
 *  hand-write a keychain entry. A field here is the whole contract: the pane renders it,
 *  the IPC writes it under `keychainKey`, and the adapter's existing getKey() reads it. */
export interface ChannelCredentialField {
  /** The keychain provider string the adapter reads (e.g. 'channel:telegram:token'). */
  keychainKey: string
  label: string
  /** 'secret' is masked and never read back to the renderer; 'text' round-trips its value
   *  (a Feishu watchlist is configuration, not a credential, and is useless write-only). */
  kind: 'secret' | 'text'
  placeholder?: string
  /** One line under the input: where the operator GETS this value. */
  help?: string
}

export interface ChannelAdapter {
  id: string
  label: string
  /** True when the required secret(s) are present, so the UI can show "connect". */
  isConfigured(): boolean
  /** Optional: the values this adapter needs, so Settings can offer them. An adapter
   *  with none (or that authenticates out-of-band, like Feishu's lark-cli login) simply
   *  omits this and the pane shows no inputs. */
  credentials?: ChannelCredentialField[]
  /** Begin listening for inbound messages. Idempotent-safe per adapter. */
  start(ctx: ChannelContext): Promise<void>
  /** Stop listening + release resources. Safe to call when not started. */
  stop(): Promise<void>
  /** Optional: can this adapter SEND right now?
   *
   *  `isConfigured()` answers "may the gateway start this adapter", which is an
   *  INBOUND question, and for at least one adapter the two genuinely differ:
   *  Feishu is configured-for-inbound only when a watchlist exists, while its
   *  egress needs no watchlist at all. Gating egress on isConfigured() therefore
   *  refused every outbound Feishu send on any install without an inbound
   *  watchlist — the common case for outbound-only use — with "channel feishu is
   *  not configured", even though the same send mechanism worked.
   *
   *  Absent ⇒ channelDispatch falls back to isConfigured(), which is correct for
   *  adapters whose single credential governs both directions (telegram, discord). */
  canSend?(): boolean
  /** Send `text` to the external addressee `to` (user/thread id on the surface).
   *
   *  CONTRACT: resolving means DELIVERED. There is no result type here, so a
   *  failure MUST throw — channelDispatch reports `{ ok: true }` on a clean
   *  resolve and has nothing else to go on. An adapter that swallows its own
   *  error and returns makes every caller's retry logic dead code. */
  send(to: string, text: string): Promise<void>
  /** Optional: send `text` WITH file attachments (local paths) to `to`, for
   *  surfaces that support file uploads. When absent, channelDispatch falls back
   *  to a plain `send()` and the attachments are dropped (best-effort delivery). */
  sendFile?(to: string, text: string, filePaths: string[]): Promise<void>
  /** Consult the pairing gate for this external user (deny-first). */
  authorizeUser(userId: string): Promise<ChannelAuthorization>
  /** Optional: expose this channel's history as an ingest source. */
  asSource?(): SourceAdapter

  // ── OPTIONAL CAPABILITIES ────────────────────────────────────────────────────
  //
  // Everything above is what EVERY channel must do. Everything below is what SOME
  // channels can do, and the split is the point: a flat interface cannot say
  // "this one has threads and that one does not", so the settings pane had nothing
  // to render and the operator had no way to learn what a channel supports short of
  // trying it. Declared capabilities let the UI show it and let callers degrade
  // deliberately instead of guessing.
  //
  // Each is OPTIONAL and additive — the three adapters that predate this compile
  // unchanged and simply report no capabilities.

  /** What this channel supports beyond send/receive. Absent ⇒ none. Must agree with
   *  which optional methods are actually implemented; `channelCapabilities()` derives
   *  the honest answer rather than trusting this alone. */
  capabilities?(): ChannelCapability[]

  /** 'directory': conversations this channel can reach, for the target picker.
   *  The reason a picker matters: without one the operator has to know a raw
   *  platform id (a Slack `C…`, a Feishu chat id) to address anything, which is
   *  why the current pane can only talk to whoever talked first. */
  listTargets?(query?: string): Promise<ChannelTarget[]>

  /** 'typing': show/hide a typing indicator. BEST-EFFORT — a platform that rejects
   *  it must never fail the turn, so callers ignore rejections. */
  setTyping?(to: string, on: boolean): Promise<void>

  /** 'reactions': react to a specific message. */
  react?(to: string, messageId: string, emoji: string): Promise<void>

  // DELIBERATELY ABSENT: `resolveTarget` and `validateSetup`.
  //
  // Both were declared here when this contract was written, and a QA pass found each
  // implemented by nothing and called by nothing — speculative surface for a picker and
  // an inline-validation flow that do not exist yet. An optional method nobody provides
  // is not free: `channelCapabilities` reads method presence to decide what the pane may
  // advertise, so every unimplemented hook is one more way for a claim and a capability
  // to drift apart. They come back when something needs them, with the caller in the
  // same change.
}

/** What a channel can do beyond exchanging text. */
export type ChannelCapability =
  | 'threads'
  | 'reactions'
  | 'typing'
  | 'files'
  | 'directory'
  | 'edit'

/** One addressable conversation, for the target picker. */
export interface ChannelTarget {
  id: string
  name: string
  kind: 'user' | 'group' | 'channel'
}

/**
 * What a channel ACTUALLY supports — derived from the methods present, not from the
 * adapter's own claim.
 *
 * An adapter declaring 'directory' without implementing `listTargets` would render a
 * picker that cannot be populated, and the operator would read an empty list as "I have
 * no conversations" rather than "this was never wired". A declaration and an
 * implementation disagreeing is exactly the class of defect this codebase keeps
 * finding — a surface asserting something the code does not do — so the derived set is
 * the intersection: claimed AND implemented.
 *
 * 'files' is the one that cannot be derived from a method alone: `sendFile` is the
 * implementation, so it is included when present regardless of the claim.
 *
 * Pure; exported for test.
 */
export function channelCapabilities(a: ChannelAdapter): ChannelCapability[] {
  const claimed = new Set(a.capabilities?.() ?? [])
  const out: ChannelCapability[] = []
  const keep = (cap: ChannelCapability, implemented: boolean): void => {
    if (implemented && claimed.has(cap)) out.push(cap)
  }
  keep('directory', typeof a.listTargets === 'function')
  keep('typing', typeof a.setTyping === 'function')
  keep('reactions', typeof a.react === 'function')
  // No method of its own — a threading channel expresses it through send()'s
  // addressing, so the claim is all there is to go on.
  keep('threads', true)
  keep('edit', true)
  // 'files' IS CLAIM-GATED LIKE THE REST, and used not to be.
  //
  // It was inferred from `sendFile` being present, on the reasoning that the method IS
  // the implementation. That held while adapters were hand-written. It broke the moment
  // `adapterFromTransport` began defining `sendFile` unconditionally — it falls back to
  // plain send() for a transport that cannot upload, which is the right DELIVERY
  // behaviour and a terrible basis for a capability claim. Measured on the first deploy
  // of the five Tier-A channels: four of them advertised file uploads none of them
  // implements, because the factory's fallback made the inference meaningless.
  //
  // The transports were each careful about this — WeCom's own comment says a fallback
  // "drops the file honestly instead of reporting an upload that never happened" — and
  // the derivation was overriding them. Now a claim needs both halves, as everywhere
  // else here.
  keep('files', typeof a.sendFile === 'function')
  return out
}
