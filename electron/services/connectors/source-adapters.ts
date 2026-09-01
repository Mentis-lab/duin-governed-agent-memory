// Source adapters — the INGEST half of integrations. Each adapter PULLs recent
// content from a connector (Slack / Gmail / Google Calendar / …) and feeds it
// into the brain via ingestFromSource, where it becomes searchable + graphed +
// foresight-visible alongside the user's notes. This is the walled-data-garden
// moat: the brain reasons over the operator's private comms, locally.
//
// Design: token-gated + graceful (no token → []), bounded windows, and a PURE
// response→IngestDoc mapper per source (unit-tested with fixtures; the network
// fetch can't be exercised without live creds).

import { existsSync } from 'fs'
import { join } from 'path'
import { getKey } from '../keychain'
import { ensureFreshGoogleToken } from '../google-auth'
import { ingestFromSource, type IngestDoc } from '../local-brain/index-store'
import { readSettings } from '../settings-helper'
import { larkExec } from '../lark-exec'
import { feishuText } from '../brain/feishu-comms-native'
import { messageOf } from '../guarded'
import { elideMiddle } from '../elide-middle'

export interface SourceAdapter {
  id: string
  label: string
  /** True when the required secret(s) are present, so the UI can show "connect". */
  isConfigured(): boolean
  /** Fetch recent docs (bounded). Graceful [] when not configured / on error. */
  pull(opts?: { sinceMs?: number; limit?: number }): Promise<IngestDoc[]>
}

const DEFAULT_LIMIT = 200
const stripHtml = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

// ──────────────────── backfill window helpers (sinceMs → per-source param) ────────────────────
// The `sinceMs` wire was dead — every adapter ignored it, so backfillSource(id, days)
// couldn't reach further back than the adapter's hard-coded default window. These pure
// helpers translate an optional epoch-ms floor into each API's native filter so the same
// pull() serves both the rolling 30-min sync (no sinceMs) and a deep backfill (sinceMs set).

/** Gmail `q` — `after:<unixSeconds>` when backfilling, else the rolling 14-day window. */
export function gmailQuery(sinceMs?: number): string {
  if (sinceMs && sinceMs > 0) return `after:${Math.floor(sinceMs / 1000)} -in:spam`
  return 'newer_than:14d -in:spam'
}
/** Slack conversations.history `oldest` (epoch seconds) or '' for the source default. */
export function slackOldest(sinceMs?: number): string {
  return sinceMs && sinceMs > 0 ? String(Math.floor(sinceMs / 1000)) : ''
}
/** Calendar `timeMin` ISO — the backfill floor when set, else 30 days back. */
export function calendarTimeMin(sinceMs?: number, now: number = Date.now()): string {
  const ms = sinceMs && sinceMs > 0 ? sinceMs : now - 30 * 86_400_000
  return new Date(ms).toISOString()
}
/** True when `whenMs` is at/after the backfill floor (or no floor given). Shared by the
 *  client-side-filtered sources (Feishu / RSS / Notion) whose APIs lack a clean date param. */
function withinWindow(whenMs: number, sinceMs?: number): boolean {
  if (!sinceMs || sinceMs <= 0) return true
  return !Number.isFinite(whenMs) || whenMs >= sinceMs
}

// ──────────────────── Slack ────────────────────

interface SlackMessage {
  ts?: string
  text?: string
  user?: string
  channel?: string
}
/** Pure: Slack conversations.history messages → IngestDoc[]. */
export function mapSlackMessages(messages: SlackMessage[], channel: string): IngestDoc[] {
  return messages
    .filter((m) => (m.text ?? '').trim().length > 0)
    .map((m) => ({
      id: `${channel}-${m.ts ?? ''}`,
      text: (m.text ?? '').trim(),
      title: `#${channel}`,
      date: m.ts ? new Date(Math.floor(Number(m.ts) * 1000)).toISOString().slice(0, 10) : undefined,
      kind: 'event',
      people: m.user ? [m.user] : undefined,
      url: undefined
    }))
}

const slackAdapter: SourceAdapter = {
  id: 'slack',
  label: 'Slack',
  isConfigured: () => !!getKey('slack-token'),
  async pull(opts) {
    const token = getKey('slack-token')
    if (!token) return [] // not configured → graceful empty (not an error)
    const limit = opts?.limit ?? DEFAULT_LIMIT
    const auth = { Authorization: `Bearer ${token}` }
    // A real auth/permission failure THROWS so syncOne records lastError (visible in the UI),
    // instead of masquerading as "no new messages". A genuinely empty workspace still returns [].
    const convResp = await fetch('https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=50', {
      headers: auth,
      signal: AbortSignal.timeout(15000)
    })
    if (!convResp.ok) throw new Error(`Slack conversations.list HTTP ${convResp.status}`)
    const conv = (await convResp.json()) as { ok?: boolean; error?: string; channels?: { id: string; name: string; is_member?: boolean }[] }
    if (!conv.ok) throw new Error(`Slack API error: ${conv.error ?? 'unknown'} (check the token's scopes)`)
    const channels = (conv.channels ?? []).filter((c) => c.is_member).slice(0, 10)
    const docs: IngestDoc[] = []
    const per = Math.max(10, Math.floor(limit / Math.max(1, channels.length)))
    const oldest = slackOldest(opts?.sinceMs) // backfill floor → history `oldest`
    for (const ch of channels) {
      try {
        const histResp = await fetch(`https://slack.com/api/conversations.history?channel=${ch.id}&limit=${per}${oldest ? `&oldest=${oldest}` : ''}`, {
          headers: auth,
          signal: AbortSignal.timeout(15000)
        })
        if (!histResp.ok) continue // tolerate a single channel failing, keep the rest
        const hist = (await histResp.json()) as { ok?: boolean; messages?: SlackMessage[] }
        if (hist.ok && hist.messages) docs.push(...mapSlackMessages(hist.messages, ch.name))
      } catch {
        /* one channel's fetch failed — skip it, don't fail the whole sync */
      }
    }
    return docs.slice(0, limit)
  }
}

// ──────────────────── Google Calendar ────────────────────

interface GCalEvent {
  id?: string
  summary?: string
  description?: string
  start?: { dateTime?: string; date?: string }
  attendees?: { email?: string; displayName?: string }[]
  htmlLink?: string
}
/** Pure: Calendar events.list items → IngestDoc[]. Events become dated nodes
 *  → the foresight engine sees upcoming deadlines/meetings. */
export function mapCalendarEvents(events: GCalEvent[]): IngestDoc[] {
  return events
    .filter((e) => (e.summary ?? '').trim().length > 0)
    .map((e) => {
      const when = e.start?.dateTime ?? e.start?.date
      return {
        id: e.id ?? (e.summary ?? '').slice(0, 40),
        text: `${e.summary ?? ''}\n${e.description ?? ''}`.trim(),
        title: e.summary,
        date: when ? when.slice(0, 10) : undefined,
        kind: 'event',
        people: (e.attendees ?? []).map((a) => a.displayName || a.email || '').filter(Boolean),
        url: e.htmlLink
      }
    })
}

const calendarAdapter: SourceAdapter = {
  id: 'gcal',
  label: 'Google Calendar',
  isConfigured: () => !!getKey('google-access-token'),
  async pull(opts) {
    const token = await ensureFreshGoogleToken()
    if (!token) return []
    const limit = opts?.limit ?? DEFAULT_LIMIT
    // window: 30d back (or the backfill floor) .. 60d forward (foresight wants upcoming).
    const timeMin = calendarTimeMin(opts?.sinceMs)
    const timeMax = new Date(Date.now() + 60 * 86_400_000).toISOString()
    const url =
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime` +
      `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=${Math.min(limit, 250)}`
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) })
    // 403 here almost always means the Google grant lacks the Calendar scope — say so, don't
    // silently ingest 0 forever. The error surfaces on the connection card via syncOne.
    if (!r.ok) throw new Error(`Google Calendar HTTP ${r.status}${r.status === 403 ? ' — reconnect Google to grant Calendar access' : ''}`)
    const data = (await r.json()) as { items?: GCalEvent[] }
    return mapCalendarEvents(data.items ?? []).slice(0, limit)
  }
}

// ──────────────────── Gmail ────────────────────

/** One MIME node of a Gmail message. `parts` nests: multipart/alternative inside
 *  multipart/mixed is the ordinary shape for any mail with both text and HTML. */
interface GmailPart {
  mimeType?: string
  body?: { data?: string; size?: number; attachmentId?: string }
  parts?: GmailPart[]
}
interface GmailFullMessage {
  id?: string
  snippet?: string
  internalDate?: string
  payload?: GmailPart & { headers?: { name?: string; value?: string }[] }
}
function header(m: GmailFullMessage, name: string): string {
  return (m.payload?.headers ?? []).find((h) => (h.name ?? '').toLowerCase() === name.toLowerCase())?.value ?? ''
}

/** How much of one mail body is indexed. Mail is repetitive — quoted threads and
 *  signatures — so the whole of a long chain is rarely worth its index weight, but
 *  the ~150-char snippet this replaces was not enough to answer anything. */
export const GMAIL_BODY_MAX_CHARS = 4000

/** Guard against a pathological or hostile MIME tree; real mail nests 2–3 deep. */
const GMAIL_MAX_MIME_DEPTH = 8

/** Gmail encodes part bodies as base64url. Returns '' on anything undecodable
 *  rather than throwing — one malformed part must not lose the whole message. */
function decodeGmailPart(data?: string): string {
  if (!data) return ''
  try {
    return Buffer.from(data, 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Pure: the readable text of a Gmail message, walking the MIME tree.
 *
 * Prefers every `text/plain` part, falling back to `text/html` (tag-stripped) only when no
 * plain part carried content — the two are alternative renderings of the same body, so
 * concatenating both would index everything twice. Attachments are skipped: their bytes live
 * behind `attachmentId` rather than `body.data`, and a base64 PDF is not text.
 */
export function gmailBodyText(payload?: GmailPart): string {
  if (!payload) return ''
  const plain: string[] = []
  const html: string[] = []
  const walk = (p: GmailPart | undefined, depth: number): void => {
    if (!p || depth > GMAIL_MAX_MIME_DEPTH) return
    const mime = (p.mimeType ?? '').toLowerCase()
    const text = decodeGmailPart(p.body?.data)
    if (text) {
      if (mime === 'text/plain' || mime === '') plain.push(text)
      else if (mime === 'text/html') html.push(text)
    }
    for (const child of p.parts ?? []) walk(child, depth + 1)
  }
  walk(payload, 0)
  const body = plain.length > 0 ? plain.join('\n') : stripHtml(html.join('\n'))
  return body.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Pure: Gmail messages.get(full) → IngestDoc[].
 *
 * Indexes the actual BODY. This adapter used to request `format=metadata`, which by
 * definition cannot return one, and then read only `snippet` — so every ingested email was a
 * subject plus Gmail's ~150-character server preview, stored as a complete note. Everything
 * that made the mail worth keeping (the decision, the number, the ask) was permanently
 * unindexed, and nothing said so. The snippet remains as the fallback for a message whose
 * body genuinely does not decode.
 */
export function mapGmailMessages(messages: GmailFullMessage[]): IngestDoc[] {
  return messages
    .filter((m) => !!m.id)
    .map((m) => {
      const subject = header(m, 'Subject')
      const from = header(m, 'From')
      const date = m.internalDate ? new Date(Number(m.internalDate)).toISOString().slice(0, 10) : undefined
      const body = elideMiddle(gmailBodyText(m.payload), GMAIL_BODY_MAX_CHARS)
      const text = `${subject}\n${body || stripHtml(m.snippet ?? '')}`.trim()
      return {
        id: m.id as string,
        text: text || subject || '(no content)',
        title: subject || '(no subject)',
        date,
        kind: 'note',
        people: from ? [from] : undefined
      }
    })
}

const gmailAdapter: SourceAdapter = {
  id: 'gmail',
  label: 'Gmail',
  isConfigured: () => !!getKey('google-access-token'),
  async pull(opts) {
    const token = await ensureFreshGoogleToken()
    if (!token) return []
    const limit = Math.min(opts?.limit ?? DEFAULT_LIMIT, 100)
    const auth = { Authorization: `Bearer ${token}` }
    const listResp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}&q=${encodeURIComponent(gmailQuery(opts?.sinceMs))}`,
      { headers: auth, signal: AbortSignal.timeout(15000) }
    )
    if (!listResp.ok) throw new Error(`Gmail messages.list HTTP ${listResp.status}`)
    const list = (await listResp.json()) as { messages?: { id: string }[] }
    const ids = (list.messages ?? []).slice(0, limit)
    const msgs: GmailFullMessage[] = []
    for (const { id } of ids) {
      try {
        const mResp = await fetch(
          // `full`, not `metadata`. metadata returns headers and the snippet and CANNOT return
          // a body, so the payload.body/parts this adapter declared were never populated and
          // every mail was indexed as subject + a 150-char preview.
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
          { headers: auth, signal: AbortSignal.timeout(15000) }
        )
        if (!mResp.ok) continue // tolerate a single message fetch failing
        const m = (await mResp.json()) as GmailFullMessage
        if (m && m.id) msgs.push(m)
      } catch {
        /* skip one message, keep the batch */
      }
    }
    return mapGmailMessages(msgs)
  }
}

// ──────────────────── Feishu (lark-cli subprocess) ────────────────────
// Folds the ad-hoc pullFeishuMessages (feishu-comms-native) INTO the ingest
// framework: instead of pulling ONE named contact's thread on demand, the
// adapter walks the recent chat list and graphs every thread, so Feishu comms
// become auto-synced + foresight-visible like Slack/Gmail. Reuses feishuText
// (the battle-tested content→plaintext port) as the message renderer.

interface FeishuChat {
  chat_id?: string
  p2p_target_id?: string
  name?: string
}
interface FeishuRawMessage {
  message_id?: string
  msg_type?: string
  content?: unknown
  create_time?: string
  sender?: { id?: string }
}

/** True when lark-cli is resolvable. On Windows we can probe the npm-global
 *  `.cmd` synchronously; on POSIX we assume it's on PATH (a real spawn failure
 *  surfaces via syncOne's lastError). Mirrors resolveLarkCli's resolution. */
function larkConfigured(): boolean {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA
    return !!(appdata && existsSync(join(appdata, 'npm', 'lark-cli.cmd')))
  }
  return true
}

/** Pure: Feishu chat-messages-list items → IngestDoc[] for one chat. Drops empty
 *  and bare `[msgType]` placeholders, and (when `sinceMs` set) messages older than
 *  the backfill floor. create_time is epoch-ms (lark-cli passes it through as a string). */
export function mapFeishuMessages(
  messages: FeishuRawMessage[],
  chat: { name?: string; id?: string },
  sinceMs?: number
): IngestDoc[] {
  const chatName = (chat.name || chat.id || 'feishu').trim()
  return messages
    .map((m) => {
      const whenMs = Number(m.create_time)
      const text = feishuText(m.content, String(m.msg_type ?? '')).trim()
      return {
        whenMs,
        doc: {
          id: `${chat.id ?? chatName}-${m.message_id ?? m.create_time ?? ''}`,
          text,
          title: chatName,
          date: Number.isFinite(whenMs) && whenMs > 0 ? new Date(whenMs).toISOString().slice(0, 10) : undefined,
          kind: 'event',
          people: m.sender?.id ? [m.sender.id] : undefined
        } as IngestDoc
      }
    })
    // drop empty + placeholder-only ("[image]", "[post]") — no searchable content
    .filter((x) => x.doc.text.length > 0 && !/^\[[^\]]*\]$/.test(x.doc.text))
    .filter((x) => withinWindow(x.whenMs, sinceMs))
    .map((x) => x.doc)
}

const feishuAdapter: SourceAdapter = {
  id: 'feishu',
  label: 'Feishu',
  isConfigured: () => larkConfigured(),
  async pull(opts) {
    if (!larkConfigured()) return []
    const exec = larkExec()
    const limit = opts?.limit ?? DEFAULT_LIMIT
    let chats: FeishuChat[]
    try {
      const r = await exec(['im', '+chat-list', '--types', 'p2p,group', '--page-size', '50'])
      const data = (JSON.parse(r.stdout || '{}') as { data?: { items?: FeishuChat[]; chats?: FeishuChat[] } }).data ?? {}
      chats = data.items ?? data.chats ?? []
    } catch (e) {
      throw new Error(`Feishu chat-list failed: ${messageOf(e)}`, { cause: e })
    }
    const recent = chats.slice(0, 10)
    const per = Math.max(10, Math.min(50, Math.floor(limit / Math.max(1, recent.length))))
    const docs: IngestDoc[] = []
    for (const ch of recent) {
      const target = ch.p2p_target_id
      const sel = target ? ['--user-id', target] : ['--chat-id', String(ch.chat_id)]
      try {
        const r = await exec(['im', '+chat-messages-list', ...sel, '--page-size', String(per), '--sort', 'desc', '--no-reactions'])
        const data = (JSON.parse(r.stdout || '{}') as { data?: { items?: FeishuRawMessage[]; messages?: FeishuRawMessage[] } }).data ?? {}
        const items = data.items ?? data.messages ?? []
        docs.push(...mapFeishuMessages(items, { name: ch.name, id: ch.chat_id ?? target }, opts?.sinceMs))
      } catch {
        /* one chat failed to page — skip it, keep the rest */
      }
    }
    return docs.slice(0, limit)
  }
}

// ──────────────────── Notion ────────────────────
// keychain('notion-token') (a Notion internal-integration secret). Search →
// recent pages, then block-children → body text. Mirrors slackAdapter shape.

interface NotionRichText {
  plain_text?: string
}
interface NotionProp {
  type?: string
  title?: NotionRichText[]
}
interface NotionPage {
  id?: string
  url?: string
  created_time?: string
  last_edited_time?: string
  properties?: Record<string, NotionProp>
}
interface NotionBlock {
  type?: string
  [k: string]: unknown
}

/** Pure: the plain-text title of a Notion page (the sole `type: 'title'` property). */
export function notionPageTitle(page: NotionPage): string {
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop?.type === 'title' && Array.isArray(prop.title)) {
      return prop.title.map((t) => t.plain_text ?? '').join('').trim()
    }
  }
  return ''
}

/** Pure: block-children → newline-joined text. Any block whose `type` payload
 *  carries a `rich_text` array contributes a line (paragraph, headings, lists,
 *  quotes, callouts, to-dos — all share that shape). Unknown blocks are skipped. */
export function notionBlocksText(blocks: NotionBlock[]): string {
  const lines: string[] = []
  for (const b of blocks) {
    const t = b.type
    if (!t) continue
    const body = (b as Record<string, unknown>)[t] as { rich_text?: NotionRichText[] } | undefined
    if (Array.isArray(body?.rich_text)) {
      const line = body.rich_text.map((r) => r.plain_text ?? '').join('').trim()
      if (line) lines.push(line)
    }
  }
  return lines.join('\n')
}

/** Pure: Notion search pages (+ per-page block text) → IngestDoc[]. Drops id-less
 *  pages and (when `sinceMs` set) pages last-edited before the backfill floor. */
export function mapNotionPages(
  pages: NotionPage[],
  textById: Record<string, string> = {},
  sinceMs?: number
): IngestDoc[] {
  return pages
    .filter((p) => !!p.id)
    .filter((p) => withinWindow(p.last_edited_time ? Date.parse(p.last_edited_time) : NaN, sinceMs))
    .map((p) => {
      const title = notionPageTitle(p) || '(untitled)'
      const body = (textById[p.id as string] ?? '').trim()
      const when = p.last_edited_time || p.created_time
      return {
        id: p.id as string,
        text: `${title}\n${body}`.trim(),
        title,
        date: when ? when.slice(0, 10) : undefined,
        kind: 'note',
        url: p.url
      }
    })
}

const NOTION_VERSION = '2022-06-28'

/** Notion's own maximum for a children request. */
const NOTION_BLOCK_PAGE_SIZE = 100
/** Total blocks fetched per page, across pagination AND nesting. A bound, not a design
 *  target — it exists so one enormous page cannot spend the whole sync. */
export const NOTION_MAX_BLOCKS_PER_PAGE = 400
/** Toggles, columns and list children live one or two levels down. Deeper than this is
 *  almost always layout scaffolding rather than prose. */
export const NOTION_MAX_BLOCK_DEPTH = 3

interface NotionChildrenResponse {
  results?: NotionBlock[]
  has_more?: boolean
  next_cursor?: string | null
}

/** Fetch one children page. Injected so the walk below is testable without network. */
export type NotionChildrenFetcher = (
  blockId: string,
  cursor: string | undefined,
  pageSize: number
) => Promise<NotionChildrenResponse | null>

/**
 * Collect a Notion page's blocks: every page of children, and the children of any block that
 * has them, in document order.
 *
 * The previous request was a bare `?page_size=50` with no cursor loop, so block 51 onward
 * simply did not exist locally — a long page was silently indexed as its first screenful, and
 * anything inside a toggle or a column was never fetched at all. Both are the same defect:
 * content that exists, that the API will return, that nothing ever asked for.
 *
 * Ordering matters for the text that comes out of this, so a block's children are appended
 * immediately after it rather than after the whole page.
 */
export async function collectNotionBlocks(
  rootId: string,
  fetchChildren: NotionChildrenFetcher,
  opts?: { maxBlocks?: number; maxDepth?: number }
): Promise<NotionBlock[]> {
  const budget = { left: opts?.maxBlocks ?? NOTION_MAX_BLOCKS_PER_PAGE }
  const maxDepth = opts?.maxDepth ?? NOTION_MAX_BLOCK_DEPTH

  const walk = async (blockId: string, depth: number): Promise<NotionBlock[]> => {
    if (depth > maxDepth || budget.left <= 0) return []
    const out: NotionBlock[] = []
    let cursor: string | undefined
    do {
      const size = Math.min(NOTION_BLOCK_PAGE_SIZE, budget.left)
      if (size <= 0) break
      const data = await fetchChildren(blockId, cursor, size)
      if (!data) break // one failed request must not lose the blocks already collected
      const results = data.results ?? []
      for (const b of results) {
        if (budget.left <= 0) break
        out.push(b)
        budget.left--
        const id = typeof b.id === 'string' ? b.id : null
        if (b.has_children === true && id) out.push(...(await walk(id, depth + 1)))
      }
      cursor = data.has_more === true && data.next_cursor ? data.next_cursor : undefined
    } while (cursor && budget.left > 0)
    return out
  }

  return walk(rootId, 0)
}
const notionAdapter: SourceAdapter = {
  id: 'notion',
  label: 'Notion',
  isConfigured: () => !!getKey('notion-token'),
  async pull(opts) {
    const token = getKey('notion-token')
    if (!token) return []
    const limit = Math.min(opts?.limit ?? DEFAULT_LIMIT, 100)
    const headers = {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    }
    const searchResp = await fetch('https://api.notion.com/v1/search', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        filter: { property: 'object', value: 'page' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: limit
      }),
      signal: AbortSignal.timeout(15000)
    })
    // A bad/expired integration token or a page-share gap → surface it, don't ingest 0 forever.
    if (!searchResp.ok) throw new Error(`Notion search HTTP ${searchResp.status}${searchResp.status === 401 ? ' — check the notion-token' : ''}`)
    const data = (await searchResp.json()) as { results?: NotionPage[] }
    const pages = (data.results ?? [])
      .filter((p) => withinWindow(p.last_edited_time ? Date.parse(p.last_edited_time) : NaN, opts?.sinceMs))
      .slice(0, limit)
    const textById: Record<string, string> = {}
    for (const p of pages) {
      if (!p.id) continue
      try {
        const blocks = await collectNotionBlocks(p.id, async (blockId, cursor, pageSize) => {
          const url = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`)
          url.searchParams.set('page_size', String(pageSize))
          if (cursor) url.searchParams.set('start_cursor', cursor)
          const bResp = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(15000) })
          if (!bResp.ok) return null // tolerate one request failing; keep what we have
          return (await bResp.json()) as NotionChildrenResponse
        })
        textById[p.id] = notionBlocksText(blocks)
      } catch {
        /* skip one page's body, keep its title */
      }
    }
    return mapNotionPages(pages, textById, opts?.sinceMs)
  }
}

// ──────────────────── RSS ────────────────────
// No auth — fetches the configured `rssFeeds` setting (a list of feed URLs) and
// parses RSS 2.0 <item> + Atom <entry> with a tolerant regex reader (no XML dep).

interface RssItem {
  title?: string
  link?: string
  summary?: string
  date?: string
  id?: string
}

/** Configured RSS feed URLs from settings (empty when unset / malformed). */
function rssFeeds(): string[] {
  const raw = (readSettings() as { rssFeeds?: unknown }).rssFeeds
  if (!Array.isArray(raw)) return []
  return raw.filter((f): f is string => typeof f === 'string' && f.trim().length > 0).map((f) => f.trim())
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
function firstTag(block: string, name: string): string {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block)
  return m ? decodeEntities(m[1]).trim() : ''
}

/** Pure: RSS/Atom XML → RssItem[]. Tolerant of both dialects; no external parser. */
export function parseRssXml(xml: string): RssItem[] {
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) ?? []
  return blocks.map((block) => {
    let link = firstTag(block, 'link')
    if (!link) {
      const lm = /<link[^>]*href="([^"]+)"/i.exec(block) // Atom: <link href="…"/>
      link = lm ? decodeEntities(lm[1]) : ''
    }
    const summary = stripHtml(firstTag(block, 'description') || firstTag(block, 'summary') || firstTag(block, 'content'))
    return {
      title: firstTag(block, 'title'),
      link,
      summary,
      date: firstTag(block, 'pubDate') || firstTag(block, 'published') || firstTag(block, 'updated'),
      id: firstTag(block, 'guid') || firstTag(block, 'id') || link
    }
  })
}

/** Pure: RssItem[] → IngestDoc[]. Drops content-less items and (when `sinceMs`
 *  set) items published before the backfill floor. */
export function mapRssItems(items: RssItem[], feedUrl: string, sinceMs?: number): IngestDoc[] {
  return items
    .filter((it) => (it.title ?? '').trim().length > 0 || (it.summary ?? '').trim().length > 0)
    .filter((it) => withinWindow(it.date ? Date.parse(it.date) : NaN, sinceMs))
    .map((it) => {
      const ms = it.date ? Date.parse(it.date) : NaN
      return {
        id: it.id || it.link || `${feedUrl}-${(it.title ?? '').slice(0, 40)}`,
        text: `${it.title ?? ''}\n${it.summary ?? ''}`.trim(),
        title: it.title || '(untitled)',
        date: Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined,
        kind: 'note',
        url: it.link || undefined
      }
    })
}

const rssAdapter: SourceAdapter = {
  id: 'rss',
  label: 'RSS',
  isConfigured: () => rssFeeds().length > 0,
  async pull(opts) {
    const feeds = rssFeeds()
    if (!feeds.length) return []
    const limit = opts?.limit ?? DEFAULT_LIMIT
    const docs: IngestDoc[] = []
    for (const feed of feeds) {
      try {
        const r = await fetch(feed, { headers: { 'User-Agent': 'DUIN/1.0 (+rss-ingest)' }, signal: AbortSignal.timeout(15000) })
        if (!r.ok) continue // one dead feed shouldn't fail the whole sync
        const xml = await r.text()
        docs.push(...mapRssItems(parseRssXml(xml), feed, opts?.sinceMs))
      } catch {
        /* one feed unreachable — skip it */
      }
    }
    return docs.slice(0, limit)
  }
}

// ──────────────────── registry + orchestrator ────────────────────

const ADAPTERS: SourceAdapter[] = [slackAdapter, calendarAdapter, gmailAdapter, feishuAdapter, notionAdapter, rssAdapter]
const byId = new Map(ADAPTERS.map((a) => [a.id, a]))

export function listAdapters(): SourceAdapter[] {
  return ADAPTERS
}
export function getAdapter(id: string): SourceAdapter | undefined {
  return byId.get(id)
}

/** Pull one source and ingest it into the brain. Returns # docs ingested. */
export async function syncSource(id: string, opts?: { sinceMs?: number; limit?: number }): Promise<number> {
  const adapter = byId.get(id)
  if (!adapter) throw new Error(`unknown source: ${id}`)
  const docs = await adapter.pull(opts)
  if (!docs.length) {
    // nothing to ingest, but DON'T wipe the existing source window on an empty
    // pull (e.g. transient API error returned []); leave prior rows in place.
    return 0
  }
  return ingestFromSource(id, docs)
}
