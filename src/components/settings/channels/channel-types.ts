// Renderer mirror of the channel contracts. One file so the pane's components share a
// single definition rather than each restating the wire shape — the drift that produces
// a UI field nobody fills and a payload field nobody renders.

/** What a channel supports beyond exchanging text. Mirrors
 *  `electron/services/channels/channel-adapter.ts` ChannelCapability. */
export type ChannelCapability =
  | 'threads'
  | 'reactions'
  | 'typing'
  | 'files'
  | 'directory'
  | 'edit'

export type ChannelAuthMode = 'credentials' | 'oauth' | 'device-link' | 'external'
export type ChannelIngress = 'websocket' | 'poll' | 'webhook' | 'local'
export type ChannelRegion = 'global' | 'cn' | 'jp' | 'any'

export interface ChannelCredentialSpec {
  keychainKey: string
  label: string
  kind: 'secret' | 'text'
  placeholder?: string
  help?: string
}

/** What a channel IS — available before it is configured or started. */
export interface ChannelDefinition {
  id: string
  label: string
  description: string
  region: ChannelRegion
  authMode: ChannelAuthMode
  ingress: ChannelIngress
  needsPublicUrl: boolean
  /** The DERIVED set (claimed AND implemented), stamped by the main process. Never
   *  the definition's own declaration — see channels:listDefinitions. */
  capabilities: ChannelCapability[]
  credentials: ChannelCredentialSpec[]
  setupSteps: string[]
  docsUrl?: string
  status: 'available' | 'planned'
  /** False when no adapter backs this definition. The pane must not offer to
   *  configure it: accepting a token for something that cannot run is the visible
   *  form of "engine built, never connected". */
  installed: boolean
}

/** How a channel is doing RIGHT NOW. */
export interface ChannelSummary {
  id: string
  label: string
  configured: boolean
  enabled: boolean
  lastError: string | null
  startedAt: number | null
}

/** One credential slot with its current state. A secret reports only WHETHER a value is
 *  stored; the value never leaves the main process. */
export interface ChannelCredential extends ChannelCredentialSpec {
  hasValue: boolean
  value?: string
}

/**
 * The four states a channel can be in, as ONE value.
 *
 * The pane already refuses to conflate enabled with running — a channel with no
 * credentials never starts however hard the operator toggles it, and a status reading
 * "on" in that state is a lie discovered only when no message ever arrives. This makes
 * that distinction a type rather than a sentence, so a badge and a status line cannot
 * disagree about it.
 */
export type ChannelState = 'off' | 'needs-setup' | 'connecting' | 'live' | 'failed'

/** Pure: reduce a summary to its single state. Exported for test. */
export function channelState(c: ChannelSummary): ChannelState {
  if (!c.enabled) return 'off'
  if (!c.configured) return 'needs-setup'
  if (c.lastError) return 'failed'
  return c.startedAt ? 'live' : 'connecting'
}
