// comms-tool-pack.ts — the ONE outbound-messaging tool: `send_message`. Mirrors
// notifications-tool-pack.ts's registerNative shape, but instead of only an OS
// notification it dispatches {channel, text} through channelDispatch, so a turn
// (or an unattended cron agent) can reach Feishu / Telegram / Discord / OS push.
//
// APPROVAL GATE: sending a message is an external side effect, so unattended
// sends are gated behind the `backgroundAutonomy` kill switch. When autonomy is
// ON the tool sends without a modal (autonomous); when OFF the descriptor sets
// requiresApproval so an interactive turn must confirm each send. The flag is
// read at registration (startup) — flipping backgroundAutonomy takes effect on
// the next launch, consistent with how the descriptor is a static publication.
//
// Omit `channel` to fall back to the configured HOME channel
// (settings.homeChannel), so the common "just tell me" case needs no wiring.

import { channelDispatch, type ChannelRef } from './channel-dispatch'
import { readSettings } from './settings-helper'
import { toolRegistry } from './tool-registry'

/** Resolve the configured home channel, defaulting to OS push (no creds). */
function homeChannel(): ChannelRef {
  const raw = readSettings().homeChannel
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    return { kind: String(o.kind ?? 'push'), target: String(o.target ?? '') }
  }
  return { kind: 'push', target: '' }
}

// Reflects the startup value of the autonomy kill switch (see file header).
const autonomyOn = readSettings().backgroundAutonomy === true

toolRegistry.registerNative(
  {
    id: 'send_message',
    name: 'send_message',
    title: 'Send message',
    description:
      'Send a message to the user through a channel (OS notification, Feishu, Telegram, Discord). ' +
      'Omit `channel` to use the configured home channel. Use for proactive nudges, digests, and replies.',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message body to send.' },
        channel: {
          type: 'string',
          description:
            "Channel kind: 'push' (OS notification), 'feishu', 'telegram', or 'discord'. Omit for the home channel."
        },
        target: {
          type: 'string',
          description:
            'Surface-specific addressee (chat name / user id / thread id). Ignored for OS push.'
        }
      },
      required: ['text'],
      additionalProperties: false
    },
    risks: ['write', 'network'],
    requiresApproval: !autonomyOn,
    enabled: true
  },
  async (args) => {
    const text = String(args.text ?? '')
    const home = homeChannel()
    const kind =
      typeof args.channel === 'string' && args.channel.trim() ? args.channel.trim() : home.kind
    const target =
      typeof args.target === 'string' && args.target.trim() ? args.target.trim() : home.target
    const result = await channelDispatch({ kind, target }, text)
    return JSON.stringify(result)
  }
)
