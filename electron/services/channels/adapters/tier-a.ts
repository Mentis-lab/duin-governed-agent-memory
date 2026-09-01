// The five Tier-A channels — Slack, Feishu (app credentials), WeCom, DingTalk, Email.
//
// Each is a credential declaration plus a transport constructor, because
// `adapterFromTransport` owns everything else. That thinness is the point: the parts
// that must be identical everywhere (the deny-first pairing gate, the keychain read,
// idempotent start, the delivered-means-resolved contract) live in ONE place, so there
// are not five subtly different copies of the security-relevant half.
//
// NOT ONE of these needs a public URL. Slack opens Socket Mode outward, Feishu and WeCom
// and DingTalk open WebSockets outward, Email holds IMAP IDLE — which is why they are
// the tier that ships before any tunnel work.
//
// FEISHU, SPECIFICALLY: this is `feishu-app`, a SECOND channel id alongside the existing
// lark-cli `feishu`. Not a rename. The old adapter runs on the operator's own logged-in
// lark-cli identity and is load-bearing for a live bridge; cutting over in place would
// take that down on a build nobody had proven yet. Both exist, the operator moves when
// ready, and the old one is retired in its own change.

import { adapterFromTransport, readRequired } from './from-transport'
import { createSlackTransport } from '../transports/slack-socket'
import { createFeishuTransport } from '../transports/feishu-ws'
import { createWeComTransport } from '../transports/wecom-ws'
import { createDingTalkTransport } from '../transports/dingtalk-stream'
import { createEmailTransport } from '../transports/email-imap'
import { getKey } from '../../keychain'
import type { ChannelAdapter } from '../channel-adapter'

export const slackAdapter: ChannelAdapter = adapterFromTransport({
  id: 'slack',
  label: 'Slack',
  credentials: [
    {
      keychainKey: 'channel:slack:appToken',
      label: 'App-level token',
      kind: 'secret',
      placeholder: 'xapp-…',
      help: 'Slack app → Basic Information → App-Level Tokens, with the connections:write scope. This is what opens Socket Mode, so no public URL is needed.'
    },
    {
      keychainKey: 'channel:slack:botToken',
      label: 'Bot token',
      kind: 'secret',
      placeholder: 'xoxb-…',
      help: 'Slack app → OAuth & Permissions → Bot User OAuth Token.'
    }
  ],
  readCredentials: () =>
    readRequired({
      appToken: 'channel:slack:appToken',
      botToken: 'channel:slack:botToken'
    }),
  create: (c) => createSlackTransport(c)
})

export const feishuAppAdapter: ChannelAdapter = adapterFromTransport({
  id: 'feishu-app',
  label: 'Feishu / Lark (app)',
  credentials: [
    {
      keychainKey: 'channel:feishu-app:appId',
      label: 'App ID',
      kind: 'text',
      placeholder: 'cli_…',
      help: '开发者后台 → your 自建应用 → 凭证与基础信息. Must be the cli_ form.'
    },
    {
      keychainKey: 'channel:feishu-app:appSecret',
      label: 'App Secret',
      kind: 'secret',
      help: 'Same page as the App ID. Also set 事件与回调 to 长连接 mode, or no events arrive.'
    }
  ],
  readCredentials: () =>
    readRequired({
      appId: 'channel:feishu-app:appId',
      appSecret: 'channel:feishu-app:appSecret'
    }),
  create: (c) => createFeishuTransport(c)
})

export const wecomAdapter: ChannelAdapter = adapterFromTransport({
  id: 'wecom',
  label: 'WeCom (企业微信)',
  credentials: [
    {
      keychainKey: 'channel:wecom:botId',
      label: 'Bot ID',
      kind: 'text',
      help: '管理工具 → 智能机器人 → API 模式. A super-admin must unlock API mode first.'
    },
    {
      keychainKey: 'channel:wecom:secret',
      label: 'Bot Secret',
      kind: 'secret',
      help: 'Issued with the Bot ID. The long connection authenticates with these two alone — no corpid, no access token.'
    }
  ],
  readCredentials: () => {
    const base = readRequired({
      botId: 'channel:wecom:botId',
      secret: 'channel:wecom:secret'
    })
    if (!base) return null
    // OPTIONAL, and only used by listTargets — which is why it is read separately and
    // its absence does not make the channel unconfigured. Requiring it would gate
    // message delivery on a credential the receive path never touches.
    const corpId = getKey('channel:wecom:corpId') ?? ''
    return { ...base, corpId }
  },
  create: (c) => createWeComTransport({ corpId: c.corpId, secret: c.secret, botId: c.botId })
})

export const dingtalkAdapter: ChannelAdapter = adapterFromTransport({
  id: 'dingtalk',
  label: 'DingTalk (钉钉)',
  credentials: [
    {
      keychainKey: 'channel:dingtalk:appKey',
      label: 'AppKey',
      kind: 'text',
      help: '开放平台 → your app → 凭证与基础信息. Set 消息接收模式 to Stream 模式.'
    },
    {
      keychainKey: 'channel:dingtalk:appSecret',
      label: 'AppSecret',
      kind: 'secret',
      help: 'Same page. The bot must also be PUBLISHED ONLINE — until it is, senderStaffId is empty and inbound users cannot be paired.'
    }
  ],
  readCredentials: () =>
    readRequired({
      appKey: 'channel:dingtalk:appKey',
      appSecret: 'channel:dingtalk:appSecret'
    }),
  create: (c) => createDingTalkTransport(c)
})

export const emailAdapter: ChannelAdapter = adapterFromTransport({
  id: 'email',
  label: 'Email',
  credentials: [
    {
      keychainKey: 'channel:email:imapHost',
      label: 'IMAP host',
      kind: 'text',
      placeholder: 'imap.example.com',
      help: 'Port defaults to 993 (implicit TLS).'
    },
    {
      keychainKey: 'channel:email:smtpHost',
      label: 'SMTP host',
      kind: 'text',
      placeholder: 'smtp.example.com',
      help: 'Port defaults to 465 (implicit TLS).'
    },
    {
      keychainKey: 'channel:email:user',
      label: 'Address',
      kind: 'text',
      placeholder: 'you@example.com'
    },
    {
      keychainKey: 'channel:email:pass',
      label: 'Password',
      kind: 'secret',
      help: 'Use an app-specific password where the provider offers one — Gmail and Outlook both require it.'
    }
  ],
  readCredentials: () =>
    readRequired({
      imapHost: 'channel:email:imapHost',
      smtpHost: 'channel:email:smtpHost',
      user: 'channel:email:user',
      pass: 'channel:email:pass'
    }),
  create: (c) => createEmailTransport(c)
})

/** Every Tier-A adapter, in the order the registry lists them. */
export const TIER_A_ADAPTERS: ChannelAdapter[] = [
  slackAdapter,
  feishuAppAdapter,
  wecomAdapter,
  dingtalkAdapter,
  emailAdapter
]
