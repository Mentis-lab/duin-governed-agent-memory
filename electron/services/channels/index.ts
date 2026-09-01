// Channel registry — the single place channels are enumerated, mirroring the
// source-adapters ADAPTERS/listAdapters/getAdapter ergonomics: adding a channel
// is ONE new file (a ChannelAdapter) + ONE entry in the CHANNELS array below.
//
// Stage 2 (reach) wires the first concrete channels — Telegram, Discord, Feishu.
// Each is deny-first (pairing gate) and disabled by default (channels-store),
// so appending them here does NOT auto-connect anything: the gateway only
// start()s channels an operator has explicitly enabled AND that are configured.

import type { ChannelAdapter } from './channel-adapter'
import { telegramAdapter } from './adapters/telegram'
import { discordAdapter } from './adapters/discord'
import { feishuAdapter } from './adapters/feishu'
import { TIER_A_ADAPTERS } from './adapters/tier-a'

/** The registered channels. Add a channel by appending its adapter here.
 *
 *  Registering one connects NOTHING: the gateway starts only channels the operator has
 *  explicitly enabled AND that are configured, and every one ships disabled. So this
 *  list growing from three to eight changes what an operator can CHOOSE, not what runs. */
const CHANNELS: ChannelAdapter[] = [
  telegramAdapter,
  discordAdapter,
  feishuAdapter,
  ...TIER_A_ADAPTERS
]

/**
 * Pure registry factory over an adapter list — extracted so the wiring is
 * unit-testable with fake adapters (no live creds), independent of whatever
 * concrete channels CHANNELS currently holds.
 */
export function makeChannelRegistry(adapters: ChannelAdapter[]): {
  list: () => ChannelAdapter[]
  get: (id: string) => ChannelAdapter | undefined
} {
  const byId = new Map(adapters.map((a) => [a.id, a]))
  return {
    list: () => adapters,
    get: (id: string) => byId.get(id)
  }
}

const registry = makeChannelRegistry(CHANNELS)

export function listChannels(): ChannelAdapter[] {
  return registry.list()
}
export function getChannel(id: string): ChannelAdapter | undefined {
  return registry.get(id)
}
