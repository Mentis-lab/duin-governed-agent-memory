import { messageOf } from '../guarded'
// pull_feishu_messages / send_feishu_message (native) — the outward comms actions via lark-cli
// (user identity). Ports of pull_feishu_messages (server.py:6697) + send_feishu_message (6757) +
// _feishu_text (6673). These are SUBPROCESS integrations (they shell out to lark-cli), and send is
// an EXTERNAL side effect (it sends a real message — the UI gates it behind explicit confirm; dry
// validates without sending). The lark-cli invocation is INJECTED as `exec` so the deterministic
// chat-matching + message parsing are unit-testable; the handler wires the real child_process call.

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
}
export type Exec = (args: string[]) => Promise<ExecResult>

interface Chat {
  chat_id?: string
  p2p_target_id?: string
  name?: string
}

/** Human-readable text from a Feishu message content blob. Port of _feishu_text. */
export function feishuText(content: unknown, msgType: string): string {
  if (!content) return `[${msgType}]`
  const s = (typeof content === 'string' ? content : JSON.stringify(content)).trim()
  if (s.startsWith('<')) {
    const m = /name="([^"]+)"/.exec(s)
    return `[${msgType}${m ? ': ' + m[1] : ''}]`
  }
  if (s.startsWith('{')) {
    try {
      const c = JSON.parse(s) as Record<string, unknown>
      if (c && typeof c === 'object') {
        if (c.text) return String(c.text)
        const rows = (Array.isArray(c.content) ? c.content : []) as unknown[][]
        const segs: string[] = []
        for (const row of rows) {
          for (const seg of row ?? []) {
            if (seg && typeof seg === 'object' && (seg as Record<string, unknown>).text) {
              segs.push(String((seg as Record<string, unknown>).text))
            }
          }
        }
        const joined = (String(c.title ?? '') + ' ' + segs.join(' ')).trim()
        if (joined) return joined
      }
    } catch (e) { console.debug('[feishu-comms-native] fall through:', messageOf(e)) }
    return `[${msgType}]`
  }
  return s.slice(0, 300)
}

const normName = (s: string): string => (s || '').replace(/[\s（）()·\-—|]+/g, '').toLowerCase()

/** Pick the chat whose name best matches the query (core name before any org/suffix). Port of the
 *  _norm + name-match used by pull/resolve. PURE. */
export function pickChat(chats: Chat[], query: string): Chat | null {
  const nq = normName(query.split(/[（(\-—|]/)[0])
  if (!nq || nq.length < 2) return null
  return chats.find((c) => {
    const n = normName(c.name ?? '')
    return n && (n.includes(nq) || nq.includes(n))
  }) ?? null
}

async function listChats(exec: Exec): Promise<Chat[]> {
  const r = await exec(['im', '+chat-list', '--types', 'p2p,group', '--page-size', '50'])
  const data = (JSON.parse(r.stdout || '{}') as { data?: { items?: Chat[]; chats?: Chat[] } }).data ?? {}
  return data.items ?? data.chats ?? []
}

export interface PullResult {
  ok: boolean
  error?: string
  chat?: string
  chat_id?: string
  awaiting?: boolean
  messages: { mine: boolean | null; text: string; time: string }[]
}

/** Pull the recent message thread for a contact by name. Port of pull_feishu_messages. */
export async function pullFeishuMessages(query: string, deps: { exec: Exec; limit?: number }): Promise<PullResult> {
  const limit = deps.limit ?? 10
  let chats: Chat[]
  try {
    chats = await listChats(deps.exec)
  } catch (e) {
    return { ok: false, error: `chat-list failed: ${(e as Error)?.message ?? e}`, messages: [] }
  }
  const chat = pickChat(chats, query)
  if (!chat) return { ok: false, error: `no Feishu chat matched '${query}'`, messages: [] }
  const target = chat.p2p_target_id
  const sel = target ? ['--user-id', target] : ['--chat-id', String(chat.chat_id)]
  let items: Record<string, unknown>[]
  try {
    const r = await deps.exec(['im', '+chat-messages-list', ...sel, '--page-size', String(limit), '--sort', 'desc', '--no-reactions'])
    const data = (JSON.parse(r.stdout || '{}') as { data?: { items?: unknown[]; messages?: unknown[] } }).data ?? {}
    items = (data.items ?? data.messages ?? []) as Record<string, unknown>[]
  } catch (e) {
    return { ok: false, error: `messages-list failed: ${(e as Error)?.message ?? e}`, messages: [] }
  }
  const msgs = items.map((m) => {
    const sid = ((m.sender as Record<string, unknown>)?.id) ?? undefined
    const mine = target ? sid !== target : null
    return { mine, text: feishuText(m.content, String(m.msg_type ?? '')), time: String(m.create_time ?? '') }
  })
  msgs.reverse()
  const awaiting = msgs.length > 0 && msgs[msgs.length - 1].mine === false
  return { ok: true, chat: chat.name ?? query, chat_id: chat.chat_id, awaiting, messages: msgs }
}

export interface SendResult {
  ok: boolean
  error?: string
  to?: string
  preview?: string
}

/** Send a message to a contact via lark-cli (dry validates without sending). Port of
 *  send_feishu_message. EXTERNAL side effect when dry=false. */
export async function sendFeishuMessage(query: string, text: string, dry: boolean, deps: { exec: Exec }): Promise<SendResult> {
  if (!(text || '').trim()) return { ok: false, error: 'empty message' }
  let chats: Chat[]
  try {
    chats = await listChats(deps.exec)
  } catch (e) {
    return { ok: false, error: `chat-list failed: ${(e as Error)?.message ?? e}` }
  }
  const chat = pickChat(chats, query)
  const target = chat?.p2p_target_id
  const chatId = chat?.chat_id
  const name = chat?.name
  if (!target && !chatId) return { ok: false, error: `no Feishu chat for '${query}'` }
  const sel = target ? ['--user-id', target] : ['--chat-id', String(chatId)]
  // `--dry-run` goes BEFORE the caller-controlled text, never after it. A flag placed
  // after the payload can be displaced BY the payload: a newline in `text` terminates
  // the cmd.exe command line, so the trailing `--dry-run` silently fell off and the
  // preview sent for real. escapeCmdArg now refuses line breaks outright, and this
  // ordering means no future payload quirk can cost us the safety flag either.
  const args = ['im', '+messages-send', ...sel, ...(dry ? ['--dry-run'] : []), '--text', text]
  let r: ExecResult
  try {
    r = await deps.exec(args)
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? 'send failed' }
  }
  if (dry) return { ok: r.code === 0, to: name || query, preview: (r.stdout || r.stderr || '').slice(0, 200) }
  let out: Record<string, unknown>
  try {
    out = JSON.parse(r.stdout || '{}') as Record<string, unknown>
  } catch {
    out = {}
  }
  const err = out.error
  const errMsg = err && typeof err === 'object' ? String((err as Record<string, unknown>).message ?? '') : String(err ?? '')
  return { ok: !!out.ok, to: name || query, error: out.ok ? '' : errMsg }
}
