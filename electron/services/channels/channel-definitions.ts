// WHAT A CHANNEL IS, declaratively — so the settings pane is GENERATED rather than
// hand-written per provider.
//
// THE GAP THIS CLOSES. `ChannelsSettings.tsx` renders one generic credential form for
// every channel. That is fine for a channel whose whole setup is "paste a token", and
// wrong for every other kind: it cannot say where to get the value, cannot say what the
// channel will be able to do once connected, cannot distinguish a channel that
// authenticates out-of-band from one that needs two secrets, and cannot offer a picker
// for who to talk to. So the operator pastes a token and hopes — which is exactly the
// experience a competitor beats us on with ~2,900 lines of per-provider UI against our
// 432.
//
// The answer is NOT 2,900 lines of our own. It is to move the per-provider knowledge
// into DATA the pane reads, and keep bespoke components for the handful of channels
// whose connect flow genuinely cannot be a form (an OAuth round-trip, a QR device link,
// a guild picker). Everything else is a definition.
//
// WHY THIS IS SEPARATE FROM THE ADAPTER. The adapter is loaded and running; a definition
// must be readable for a channel that is NOT configured and NOT started — that is
// precisely when the operator needs to know what it is and what it will need. Putting
// this on the adapter would mean you could only learn how to set up a channel after
// setting it up.

import type { ChannelCapability, ChannelCredentialField } from './channel-adapter'

/** How an operator proves the channel is theirs. Drives which UI the pane shows. */
export type ChannelAuthMode =
  /** One or more secrets pasted into a form. The common case. */
  | 'credentials'
  /** A browser round-trip we host. Needs a bespoke component. */
  | 'oauth'
  /** Scan a code / approve on the phone (Signal, WhatsApp Web). Bespoke component. */
  | 'device-link'
  /** Authenticated out-of-band by a tool the operator already runs — nothing to paste.
   *  The current lark-cli Feishu path is this, and it is the mode being retired. */
  | 'external'

/** Where inbound messages come from. The operator-visible consequence is whether this
 *  channel needs public internet infrastructure, which is the single biggest difference
 *  between "works in five minutes" and "set up a tunnel first" — so the pane says it. */
export type ChannelIngress =
  /** We open a socket outward. No public URL. */
  | 'websocket'
  /** We poll the platform. No public URL. */
  | 'poll'
  /** The platform calls US. NEEDS a public HTTPS endpoint. */
  | 'webhook'
  /** A local process or file we watch. No network exposure. */
  | 'local'

export interface ChannelDefinition {
  /** Must match the adapter's `id`. */
  id: string
  label: string
  /** One line: what connecting this actually gets you. */
  description: string
  /** Where this channel is used, so the list can be grouped for an operator who works
   *  across markets rather than alphabetically, which helps nobody. */
  region: 'global' | 'cn' | 'jp' | 'any'
  authMode: ChannelAuthMode
  ingress: ChannelIngress
  /** True when this channel cannot receive without a public HTTPS endpoint. Derived
   *  from `ingress`, kept explicit because it is the thing the operator most needs to
   *  see BEFORE choosing a channel, not after. */
  needsPublicUrl: boolean
  /** What it will be able to do once connected. Shown before setup, so the operator can
   *  choose on capability rather than discovering limits afterwards. */
  capabilities: ChannelCapability[]
  /** The values to collect. Mirrors the adapter's own declaration; the pane renders
   *  these and the IPC writes them under `keychainKey`. */
  credentials: ChannelCredentialField[]
  /** Operator-facing setup steps, in order. Plain sentences, not marketing. */
  setupSteps: string[]
  /** Where the operator creates the app / finds the values. */
  docsUrl?: string
  /** Set when this channel is not yet implemented, so the pane can list it as coming
   *  rather than pretending it works. A definition WITHOUT an adapter must never render
   *  as connectable — that is the "engine built, never connected" failure this codebase
   *  keeps rediscovering, and here it would be visible to the operator as a channel that
   *  accepts a token and then does nothing. */
  status: 'available' | 'planned'
}

/**
 * Does this ingress require the operator to expose an endpoint to the internet?
 *
 * Exported and derived rather than typed by hand on every definition: the two must never
 * disagree, and a hand-set boolean that contradicts its own ingress is a lie the pane
 * would faithfully render.
 */
export function ingressNeedsPublicUrl(ingress: ChannelIngress): boolean {
  return ingress === 'webhook'
}

/** Build a definition, deriving what can be derived. Use this rather than an object
 *  literal so `needsPublicUrl` can never be set inconsistently with `ingress`. */
export function defineChannel(
  d: Omit<ChannelDefinition, 'needsPublicUrl'>
): ChannelDefinition {
  return { ...d, needsPublicUrl: ingressNeedsPublicUrl(d.ingress) }
}

const TELEGRAM = defineChannel({
  id: 'telegram',
  label: 'Telegram',
  description: 'A Telegram bot you message directly. Fastest channel to set up.',
  region: 'global',
  authMode: 'credentials',
  ingress: 'poll',
  capabilities: [],
  credentials: [
    {
      keychainKey: 'channel:telegram:token',
      label: 'Bot token',
      kind: 'secret',
      placeholder: '123456:ABC-DEF…',
      help: 'Create a bot with @BotFather and paste the token it gives you.'
    }
  ],
  setupSteps: [
    'Message @BotFather on Telegram and send /newbot.',
    'Paste the token it returns here.',
    'Message your new bot — the first message will be held for your approval.'
  ],
  docsUrl: 'https://core.telegram.org/bots#how-do-i-create-a-bot',
  status: 'available'
})

const DISCORD = defineChannel({
  id: 'discord',
  label: 'Discord',
  description: 'A Discord bot in your server or DMs.',
  region: 'global',
  authMode: 'credentials',
  ingress: 'websocket',
  capabilities: [],
  credentials: [
    {
      keychainKey: 'channel:discord:token',
      label: 'Bot token',
      kind: 'secret',
      help: 'Discord Developer Portal → your app → Bot → Reset Token.'
    }
  ],
  setupSteps: [
    'Create an application in the Discord Developer Portal.',
    'Add a Bot to it and copy the token here.',
    'Invite the bot to your server with the Message Content intent enabled.'
  ],
  docsUrl: 'https://discord.com/developers/applications',
  status: 'available'
})

// The definition for the CURRENT lark-cli adapter. `external` because there is nothing
// to paste — it borrows the operator's own logged-in lark-cli identity. That is the
// property being retired: it means DUIN speaks as the operator rather than as a bot,
// and it stops working whenever lark-cli's session lapses.
const FEISHU_CLI = defineChannel({
  id: 'feishu',
  label: 'Feishu / Lark (via lark-cli)',
  description:
    'Polls watched chats through your own lark-cli login. Being replaced by the app-credential version alongside.',
  region: 'cn',
  authMode: 'external',
  ingress: 'poll',
  capabilities: [],
  credentials: [
    {
      keychainKey: 'channel:feishu:watch',
      label: 'Watched chats',
      kind: 'text',
      placeholder: '张三, 项目群',
      help: 'Comma-separated chat names to poll. Required — without it this channel stays off.'
    }
  ],
  setupSteps: [
    'Install lark-cli and sign in with your own account.',
    'List the chats to watch, separated by commas.'
  ],
  status: 'available'
})

const SLACK = defineChannel({
  id: 'slack',
  label: 'Slack',
  description: 'A Slack bot in your workspace, over Socket Mode.',
  region: 'global',
  authMode: 'credentials',
  ingress: 'websocket',
  capabilities: ['threads', 'directory'],
  credentials: [
    {
      keychainKey: 'channel:slack:appToken',
      label: 'App-level token',
      kind: 'secret',
      placeholder: 'xapp-…',
      help: 'Basic Information → App-Level Tokens, scope connections:write.'
    },
    {
      keychainKey: 'channel:slack:botToken',
      label: 'Bot token',
      kind: 'secret',
      placeholder: 'xoxb-…',
      help: 'OAuth & Permissions → Bot User OAuth Token.'
    }
  ],
  setupSteps: [
    'Create a Slack app at api.slack.com/apps.',
    'Enable Socket Mode, and create an app-level token with connections:write.',
    'Under OAuth & Permissions add chat:write plus the read scopes for the conversation types you want, then install to the workspace.',
    'Subscribe to the message events you want under Event Subscriptions.',
    'Paste both tokens here.'
  ],
  docsUrl: 'https://api.slack.com/apis/socket-mode',
  status: 'available'
})

// The replacement for FEISHU_CLI, running as a real bot on app credentials rather than
// borrowing the operator's own lark-cli login. Registered ALONGSIDE it, not over it —
// the old path is load-bearing for a live bridge and is retired in its own change.
const FEISHU_APP = defineChannel({
  id: 'feishu-app',
  label: 'Feishu / Lark (app)',
  description:
    'A Feishu bot on your own app credentials, over the 长连接 WebSocket. Replaces the lark-cli path.',
  region: 'cn',
  authMode: 'credentials',
  ingress: 'websocket',
  capabilities: ['threads', 'files'],
  credentials: [
    {
      keychainKey: 'channel:feishu-app:appId',
      label: 'App ID',
      kind: 'text',
      placeholder: 'cli_…',
      help: '凭证与基础信息 on your 自建应用.'
    },
    {
      keychainKey: 'channel:feishu-app:appSecret',
      label: 'App Secret',
      kind: 'secret',
      help: 'Same page as the App ID.'
    }
  ],
  setupSteps: [
    'Create a 自建应用 in the Feishu 开发者后台 and enable its bot capability.',
    'Under 权限管理 grant im:message and im:message.receive.',
    'Under 事件与回调 choose 使用长连接接收事件, and subscribe to im.message.receive_v1.',
    'Copy App ID and App Secret from 凭证与基础信息 into the fields here.',
    'Publish the app version, or events will not be delivered.'
  ],
  docsUrl: 'https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive',
  status: 'available'
})

const WECOM = defineChannel({
  id: 'wecom',
  label: 'WeCom (企业微信)',
  description: 'A WeCom智能机器人 over its long connection. No callback URL.',
  region: 'cn',
  authMode: 'credentials',
  ingress: 'websocket',
  // 'directory' is NOT declared: listTargets exists but its endpoint rejects an
  // API-mode bot secret, so a picker built on it would always error. See the WeCom
  // transport — it made the same refusal for the same reason.
  capabilities: [],
  credentials: [
    {
      keychainKey: 'channel:wecom:botId',
      label: 'Bot ID',
      kind: 'text',
      help: '管理工具 → 智能机器人 → API 模式.'
    },
    { keychainKey: 'channel:wecom:secret', label: 'Bot Secret', kind: 'secret' },
    {
      keychainKey: 'channel:wecom:corpId',
      label: 'Corp ID (optional)',
      kind: 'text',
      help: 'Only needed to browse members. Messaging works without it.'
    }
  ],
  setupSteps: [
    'Ask a super-admin to unlock 管理工具 → 智能机器人 → API 模式 管理.',
    'Create a bot in API mode and copy its Bot ID and Secret.',
    'Paste both here. The long connection authenticates with these alone.',
    'Add the bot to the chats it should answer in.'
  ],
  docsUrl: 'https://developer.work.weixin.qq.com/document/path/101463',
  status: 'available'
})

const DINGTALK = defineChannel({
  id: 'dingtalk',
  label: 'DingTalk (钉钉)',
  description: 'A DingTalk bot over Stream Mode — an outbound WebSocket, no callback URL.',
  region: 'cn',
  authMode: 'credentials',
  ingress: 'websocket',
  capabilities: [],
  credentials: [
    {
      keychainKey: 'channel:dingtalk:appKey',
      label: 'AppKey',
      kind: 'text',
      help: '开放平台 → your app → 凭证与基础信息.'
    },
    { keychainKey: 'channel:dingtalk:appSecret', label: 'AppSecret', kind: 'secret' }
  ],
  setupSteps: [
    'Create an app on the DingTalk 开放平台 and add a 机器人.',
    'Set 消息接收模式 to Stream 模式.',
    'Copy AppKey and AppSecret into the fields here.',
    'PUBLISH the bot online — until you do, inbound messages carry no staff id and nobody can be paired.'
  ],
  docsUrl: 'https://open.dingtalk.com/document/orgapp/stream',
  status: 'available'
})

const EMAIL = defineChannel({
  id: 'email',
  label: 'Email',
  description: 'Any IMAP/SMTP mailbox. Replies thread correctly in the recipient’s client.',
  region: 'any',
  authMode: 'credentials',
  ingress: 'poll',
  // Threads are real here even without a thread id: the transport derives a stable key
  // from the References/In-Reply-To chain, which is what makes a reply continue its own
  // conversation rather than starting a new one. 'files' is deliberately NOT declared —
  // the transport has no sendFile, so an attachment would degrade to text, and promising
  // uploads we cannot perform is the exact claim this model exists to refuse.
  capabilities: ['threads'],
  credentials: [
    { keychainKey: 'channel:email:imapHost', label: 'IMAP host', kind: 'text', placeholder: 'imap.example.com' },
    { keychainKey: 'channel:email:smtpHost', label: 'SMTP host', kind: 'text', placeholder: 'smtp.example.com' },
    { keychainKey: 'channel:email:user', label: 'Address', kind: 'text', placeholder: 'you@example.com' },
    {
      keychainKey: 'channel:email:pass',
      label: 'Password',
      kind: 'secret',
      help: 'Use an app-specific password where the provider offers one.'
    }
  ],
  setupSteps: [
    'Find your provider’s IMAP and SMTP hostnames.',
    'Create an app-specific password if the provider requires one (Gmail and Outlook do).',
    'Fill in all four fields here.',
    'Only UNREAD mail is picked up — reading a message in another client hides it from DUIN.'
  ],
  status: 'available'
})

export const CHANNEL_DEFINITIONS: ChannelDefinition[] = [
  TELEGRAM,
  DISCORD,
  FEISHU_CLI,
  FEISHU_APP,
  SLACK,
  WECOM,
  DINGTALK,
  EMAIL
]

export function listChannelDefinitions(): ChannelDefinition[] {
  return CHANNEL_DEFINITIONS
}

export function getChannelDefinition(id: string): ChannelDefinition | undefined {
  return CHANNEL_DEFINITIONS.find((d) => d.id === id)
}
