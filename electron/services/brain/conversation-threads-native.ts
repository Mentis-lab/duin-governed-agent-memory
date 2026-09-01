// conversation-threads-native — TS port of server.py:conversation_threads. Channel-centric
// swept-comms view: each conversation enriched from its profile note (channel/summary/updated/
// status), FILTERED to threads with real swept messages (a DM count / channel / source line —
// a profile drafted from an org chart is a contact, not a thread). Pure read over
// listConversations + profile notes.
import { readFileSync } from 'fs'
import { join } from 'path'
import { listConversations } from './conversations-native'

const CHANNEL_PATTERNS: [string, RegExp][] = [
  ['WeChat', /weflow|wechat|微信/i],
  ['Feishu', /feishu|飞书|lark/i],
  ['Email', /\bemail\b|gmail|邮件|outlook/i],
  ['Slack', /slack/i]
]
function inferChannel(text: string): string {
  for (const [name, pat] of CHANNEL_PATTERNS) if (pat.test(text || '')) return name
  return 'Other'
}
const readOrEmpty = (p: string): string => {
  try {
    return readFileSync(p, 'utf-8').replace(/\r\n?/g, '\n')
  } catch {
    return ''
  }
}

const MSG_RE = /\d+\s*条[^，。\n]{0,12}(?:消息|DM|\/\s*\d+\s*d|\d+\s*d)|DM\s*通道|DM\s*消息|聊天记录|会话时间线/
const SRC_MSG_RE = /(weflow|飞书|feishu)[^。\n]{0,40}(消息|DM|message|对话)/i

interface Thread {
  person: string
  org: string
  channel: string
  title: string
  summary: string
  updated: string
  messages: string
  owed: string
  awaiting: boolean
  status: string
  open: number
  total: number
  profile: string
  followups: unknown[]
}

export function conversationThreads(vaultDir: string | null): { threads: Thread[]; channels: { name: string; count: number }[] } {
  if (!vaultDir) return { threads: [], channels: [] }
  const threads: Thread[] = []
  for (const c of listConversations(vaultDir).conversations as unknown as Array<Record<string, unknown>>) {
    const prof = (c.profile as string) || ''
    const txt = readOrEmpty(join(vaultDir, prof.replace(/^\//, '')))
    let fm = ''
    let summary = ''
    let updated = ''
    let status = ''
    let title = (c.person as string) || ''
    if (txt) {
      const m = /^---\n([\s\S]*?)\n---/.exec(txt)
      fm = m ? m[1] : ''
      const fmEnd = m ? m[0].length : 0
      for (const line of fm.split('\n')) {
        if (line.startsWith('updated:')) updated = line.split(':').slice(1).join(':').trim()
        else if (line.startsWith('status:')) status = line.split(':').slice(1).join(':').trim()
        else if (line.startsWith('title:')) title = line.split(':').slice(1).join(':').trim().replace(/^"|"$/g, '')
      }
      const sm = />\s*\*\*概要[：:]\*\*\s*(.+)/.exec(txt)
      if (sm) {
        summary = sm[1].replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1').trim()
      } else {
        const body = m ? txt.slice(fmEnd) : txt
        for (const para of body.split(/\n\n+/)) {
          const p = para.trim()
          if (p && !'#>|-'.includes(p[0]) && p.length > 20) {
            summary = p
            break
          }
        }
      }
    }
    // require REAL swept messages, else it's a contact not a thread
    const head = `${fm}\n${txt.slice(0, 2000)}`
    const msg = MSG_RE.exec(head)
    const srcMsg = SRC_MSG_RE.test(head)
    if (!(msg || srcMsg)) continue
    let channel = inferChannel(fm)
    if (channel === 'Other') channel = inferChannel(txt.slice(0, 1500))
    const fups = (c.followups as Array<Record<string, unknown>>) || []
    const open = (c.open as number) || 0
    const owed = open > 0 ? ((fups[0]?.text as string) || '').replace(/\{\{[^}]*\}\}/g, '').trim() : ''
    threads.push({
      person: (c.person as string) || '',
      org: (c.org as string) || '',
      channel,
      title,
      summary: summary.replace(/\s+/g, ' ').slice(0, 280),
      updated,
      messages: msg ? msg[0] : 'swept',
      owed: owed.slice(0, 160),
      awaiting: open > 0,
      status,
      open,
      total: (c.total as number) || 0,
      profile: prof,
      followups: fups.slice(0, 3)
    })
  }
  // sort by (open>0, updated) reverse — open threads first, then newest
  threads.sort((a, b) => {
    const oa = a.open > 0 ? 1 : 0
    const ob = b.open > 0 ? 1 : 0
    if (oa !== ob) return ob - oa
    return a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0
  })
  // Counter.most_common: count desc, ties in first-seen order
  const order: string[] = []
  const counts = new Map<string, number>()
  for (const t of threads) {
    if (!counts.has(t.channel)) order.push(t.channel)
    counts.set(t.channel, (counts.get(t.channel) ?? 0) + 1)
  }
  const channels = order
    .map((name) => ({ name, count: counts.get(name)! }))
    .sort((a, b) => b.count - a.count) // stable → ties keep first-seen order
  return { threads, channels }
}
