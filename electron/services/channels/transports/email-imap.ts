// Email transport — inbound over IMAP IDLE (push), outbound over SMTP.
//
// Every other transport in this directory gets a conversation id for free: Telegram has
// chat_id, Slack has channel+thread_ts, Feishu has chat_id+root_id. EMAIL HAS NO THREAD
// ID. A thread is an emergent property of three headers (Message-ID / In-Reply-To /
// References) that each client fills in slightly differently, and if we get the
// derivation wrong the damage is not cosmetic: every reply looks like a brand-new
// conversation, the runtime starts a fresh turn with no history, and the pairing gate
// re-prompts a user who paired ten minutes ago. So the threading logic here is the
// point of the file, it is PURE, and it is tested far harder than the socket handling.
//
// THE THREE HEADERS, and why the derivation is what it is:
//   RFC 5322 §3.6.4 says a reply's `References` = the parent's `References` + the
//   parent's `Message-ID`, oldest first. That makes References[0] the ROOT of the
//   thread and therefore a stable key that every participant computes identically —
//   including us, including the sender's client, including a third party who was CC'd
//   and whose own reply we later receive. It is the only field in an email that all
//   members of a thread agree on, so it is the conversation id.
//
// WHAT DOES NOT WORK, and was considered:
//   · Subject. "Re: lunch" from two people in the same week is one conversation only by
//     accident, and a renamed subject silently forks a live thread.
//   · The sender's address. That is the USER, not the conversation — a person with two
//     threads open would have them interleaved into one turn history.
//   · The IMAP UID. Per-mailbox, per-message, and reassigned on UIDVALIDITY change.
//
// SECURITY / SCOPE: this module holds no authority. It never imports the pairing store,
// the runtime, the gateway or the keychain (see transport.ts) — credentials arrive as
// arguments. Note it also does NOT reuse the RFC2047/CRLF helpers in
// services/output/gmail-send.ts, close as they are: that module imports google-auth,
// which imports the keychain, and pulling the keychain into a transport's module graph
// is exactly the coupling the seam exists to prevent. The ~30 lines are re-stated here.
//
// DEPENDENCIES: `imapflow` (IMAP client with automatic IDLE) and `nodemailer` (SMTP).
// NEITHER IS INSTALLED in this repo at time of writing. Both are therefore reached
// through the narrow `ImapLike` / `SmtpLike` interfaces below and loaded with a runtime
// dynamic import, so this file type-checks, lints and unit-tests with the packages
// absent, and throws one actionable error naming them if a channel is actually started
// without `npm i imapflow nodemailer`. Everything that can be tested without a live
// mailbox lives above that seam as a pure function.

import type { ChannelTransport, TransportCapability, TransportMessage } from './transport'

const CHANNEL_ID = 'email'

/** Implicit TLS ports. 993/465 rather than 143/587 because a transport that silently
 *  defaults to a cleartext port would ship the password in the clear on a typo. */
const DEFAULT_IMAP_PORT = 993
const DEFAULT_SMTP_PORT = 465
const DEFAULT_MAILBOX = 'INBOX'

/** Reconnect backoff. IDLE drops are ROUTINE, not exceptional: RFC 2177 tells clients to
 *  re-issue IDLE at least every 29 minutes, NAT tables expire sooner, and consumer IMAP
 *  servers cut idle sockets on their own schedule. So the loop is the normal operating
 *  mode, not an error path, and it must never hot-spin against a server that is down. */
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 60_000
/** ±20% jitter so a machine with several email channels does not reconnect them all on
 *  the same tick after a network blip. */
const RECONNECT_JITTER = 0.2

/** Backstop re-scan interval. IDLE is the DELIVERY path — this is not polling for
 *  latency. It exists because the classic IMAP failure is a socket that is dead but not
 *  closed: the server stops sending, no 'close' or 'error' ever fires, and a push-only
 *  client waits forever. A periodic scan both proves the socket is alive (a dead one
 *  throws, which triggers the reconnect) and sweeps up anything that landed during a
 *  reconnect gap. 14 minutes keeps it under the 29-minute RFC 2177 ceiling. */
const LIVENESS_MS = 14 * 60_000

/** Cap on the References chain we emit. Unbounded, a long thread eventually produces a
 *  header that trips a server's line-length limit and the send fails. The convention
 *  (RFC 5537 §3.4.4) is to keep the FIRST id — losing it would re-root the thread for
 *  everyone downstream — and trim from the middle. */
const MAX_REFERENCES = 20

/** How many message-id → thread-key associations to remember. Bounds the stitching index
 *  below so a long-lived channel cannot grow without limit. */
const THREAD_INDEX_MAX = 5_000

/** Prefix on every derived conversation id. Not decoration: `send()` has to tell a
 *  thread key from a bare email address handed in by a caller starting a fresh
 *  conversation, and both contain an '@'. */
const THREAD_PREFIX = 'email:'
/** Prefix for the last-resort key used when a message carries no usable ids at all. */
const SYNTH_PREFIX = 'email:synth:'

// ════════════════════════════════════════════════════════════════════════════
// PURE — header primitives
// ════════════════════════════════════════════════════════════════════════════

/** Message-IDs are bounded in practice; the cap stops a hostile header from becoming an
 *  unbounded map key. */
const MAX_ID_LEN = 512

/**
 * Normalize one Message-ID to its bare `local@domain` form: trim, drop the angle
 * brackets, drop any RFC 5322 comment, collapse internal whitespace left by header
 * folding. Returns null for anything that cannot be an id. PURE.
 *
 * Case is DELIBERATELY preserved. RFC 5322 makes the id an opaque token whose local part
 * is case-sensitive, and servers echo it back verbatim in References; lowercasing here
 * would only matter if some client changed the case, which would break threading in
 * every other mail client too.
 */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  // Strip a trailing comment such as `<a@b> (Alice's mailer)`.
  s = s.replace(/\s*\([^()]*\)\s*$/, '').trim()
  const angled = /^<(.*)>$/s.exec(s)
  if (angled) s = angled[1]
  s = s.replace(/\s+/g, '').trim()
  if (!s || s.length > MAX_ID_LEN) return null
  // An id with no '@' is malformed but common enough in home-grown senders to keep —
  // it is still a stable token, which is all the thread key needs.
  if (s.includes('<') || s.includes('>')) return null
  return s
}

/**
 * Parse a header that holds a LIST of message ids (References, In-Reply-To) into
 * normalized ids, oldest first, deduped. PURE.
 *
 * Angle-bracketed ids are extracted first because that is the only unambiguous form —
 * References is whitespace-separated but real senders emit commas, and a display name
 * can contain spaces. Only when no `<…>` appears at all do we fall back to splitting on
 * whitespace, which rescues the sloppy-sender case without letting it corrupt the
 * normal one.
 */
export function parseMessageIds(raw: string | string[] | null | undefined): string[] {
  if (raw == null) return []
  const parts = Array.isArray(raw) ? raw : [raw]
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    if (typeof part !== 'string') continue
    const angled = part.match(/<[^<>]*>/g)
    const tokens = angled ?? part.split(/[\s,]+/)
    for (const t of tokens) {
      const id = normalizeMessageId(t)
      if (id && !seen.has(id)) {
        seen.add(id)
        out.push(id)
      }
    }
  }
  return out
}

/** Wrap a bare id back into the on-the-wire `<id>` form. */
function angle(id: string): string {
  return `<${id}>`
}

/**
 * Extract the bare address from a From/To header value and lowercase it. PURE.
 *
 * Lowercasing is a deliberate deviation from RFC 5321, which makes the local part
 * case-sensitive. This value becomes `TransportMessage.userId` and therefore the PAIRING
 * SUBJECT: if `Theo@x.com` and `theo@x.com` were two subjects, a user who pairs from one
 * client would be unpaired from another. No mail system in practice treats them as
 * different mailboxes, so stability wins.
 */
export function parseAddress(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  // `Name <a@b>` — the angle form wins, and is checked BEFORE any comma split: a quoted
  // display name legally contains a comma (`"Quill, Theo" <theo@x>`), so splitting first
  // would cut the header in half and lose the address entirely. Only a header with no
  // angle form at all is split, which is the plain `a@x, b@y` list case.
  const angled = /<([^<>]+)>/.exec(raw)
  let addr = (angled ? angled[1] : (raw.split(',')[0] ?? '')).trim()
  // `a@b (Name)` — the other legal ordering.
  addr = addr.replace(/\s*\([^()]*\)\s*/g, '').trim()
  addr = addr.replace(/^["']|["']$/g, '').trim()
  if (!addr || !addr.includes('@') || /\s/.test(addr)) return null
  return addr.toLowerCase()
}

/** Reply/forward prefixes, including the abbreviations used by non-English clients. The
 *  `[n]`/`(n)` counter forms are Outlook and some mobile clients. */
const REPLY_PREFIX =
  /^\s*(?:(?:re|aw|antw|antwort|sv|vs|ref|res|rif|odp|vá|回复|回覆|答复|回信|fw|fwd|wg|tr|rv|enc|转发|轉發|轉寄|轉發)\s*(?:\[\d+\]|\(\d+\))?\s*[:：])\s*/i

/**
 * Strip every stacked reply/forward prefix from a subject and collapse whitespace. PURE.
 * Used for the reply subject and, as a last resort, for the synthetic thread key.
 */
export function stripReplyPrefixes(subject: string | null | undefined): string {
  let s = typeof subject === 'string' ? subject : ''
  // Loop rather than a global regex: prefixes stack ("Re: Fwd: Re: x") and each strip
  // exposes the next one. Bounded so a pathological subject cannot spin.
  for (let i = 0; i < 12; i++) {
    const next = s.replace(REPLY_PREFIX, '')
    if (next === s) break
    s = next
  }
  return s.replace(/\s+/g, ' ').trim()
}

/** The subject to put on a reply: exactly one `Re:`, never "Re: Re: Re:". PURE. */
export function replySubject(subject: string | null | undefined): string {
  const base = stripReplyPrefixes(subject)
  return base ? `Re: ${base}` : 'Re:'
}

/** FNV-1a, 64-bit, hex. Used only to key the synthetic fallback thread id below.
 *  Hand-rolled rather than node:crypto so every pure helper in this file stays
 *  importable with no I/O surface at all; it is a bucketing key, not a security
 *  primitive, and nothing downstream trusts it. PURE. */
function fnv1a(input: string): string {
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < input.length; i++) {
    h = (h ^ BigInt(input.charCodeAt(i) & 0xff)) & mask
    h = (h * prime) & mask
  }
  return h.toString(16).padStart(16, '0')
}

// ════════════════════════════════════════════════════════════════════════════
// PURE — thread key derivation  ← the load-bearing logic
// ════════════════════════════════════════════════════════════════════════════

/** The subset of an email's headers that threading actually depends on. */
export interface ThreadHeaders {
  messageId?: string | null
  inReplyTo?: string | null
  references?: string | string[] | null
  subject?: string | null
  from?: string | null
}

/**
 * Every message id this message associates with its own thread, oldest first: the
 * References chain, then In-Reply-To, then its own Message-ID. PURE.
 *
 * This is the set the stitching index below unions on — any two messages sharing ANY id
 * in these lists are in the same thread by construction.
 */
export function threadChain(h: ThreadHeaders): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of [
    ...parseMessageIds(h.references),
    ...parseMessageIds(h.inReplyTo),
    ...parseMessageIds(h.messageId)
  ]) {
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/**
 * Derive a STABLE conversation id from one message's headers alone. PURE — same headers
 * in, same key out, no state, no clock, no I/O.
 *
 * Precedence, and why each rung is where it is:
 *   1. References[0]. RFC 5322 §3.6.4 builds References as parent-chain + parent-id,
 *      oldest first, so element 0 is the thread ROOT and every participant — us, the
 *      sender, a CC'd third party — computes the identical value from their own copy.
 *      This is the case for essentially all mail from a mainstream client.
 *   2. In-Reply-To[0]. A reply whose sender dropped References (some Exchange paths,
 *      some mobile clients). The parent id is the best root available. NOTE the known
 *      limit this leaves: with References absent for a WHOLE chain, message C→B→A keys
 *      on B while B keys on A. `resolveThreadKey` exists to repair exactly that, and it
 *      is why the transport uses that function and not this one directly.
 *   3. Own Message-ID. Neither reference header present ⇒ this message STARTS a thread,
 *      and its own id is what every future reply will carry as References[0]. So rung 3
 *      and rung 1 agree in advance: the opener and all its replies produce one key.
 *   4. Synthetic. No usable id anywhere — a malformed or hand-rolled sender. Keyed on
 *      sender + de-prefixed subject, which is the same heuristic mail clients fall back
 *      to. It can over-merge two same-subject threads from one sender; that is the
 *      correct direction to fail, since the alternative is a NEW conversation on every
 *      single message and no continuity at all.
 */
export function deriveThreadKey(h: ThreadHeaders): string {
  const refs = parseMessageIds(h.references)
  if (refs.length > 0) return THREAD_PREFIX + refs[0]

  const irt = parseMessageIds(h.inReplyTo)
  if (irt.length > 0) return THREAD_PREFIX + irt[0]

  const own = parseMessageIds(h.messageId)
  if (own.length > 0) return THREAD_PREFIX + own[0]

  const from = parseAddress(h.from) ?? ''
  const subject = stripReplyPrefixes(h.subject).toLowerCase()
  return SYNTH_PREFIX + fnv1a(`${from}\u0000${subject}`)
}

/**
 * Message-id → canonical thread key. Mutable, bounded, and owned by one transport
 * instance.
 *
 * It exists solely to close the rung-2 hole documented above. `deriveThreadKey` is a
 * function of ONE message and cannot know that the id it picked as a root is itself a
 * reply; the index carries that knowledge forward from the messages already seen.
 */
export interface ThreadIndex {
  keyOf: Map<string, string>
  max: number
}

export function createThreadIndex(max: number = THREAD_INDEX_MAX): ThreadIndex {
  return { keyOf: new Map(), max }
}

/** Associate `id` with `key`, evicting oldest-first past the cap. Map preserves
 *  insertion order, so the first key is the oldest association. */
function remember(index: ThreadIndex, id: string, key: string): void {
  if (index.keyOf.has(id)) index.keyOf.delete(id) // re-insert to refresh recency
  index.keyOf.set(id, key)
  while (index.keyOf.size > index.max) {
    const oldest = index.keyOf.keys().next()
    if (oldest.done) break
    index.keyOf.delete(oldest.value)
  }
}

/**
 * The conversation id the transport actually uses: `deriveThreadKey`, corrected against
 * everything already seen. Deterministic given (index, headers); mutates `index`.
 *
 * If ANY id this message mentions is already associated with a thread, that thread's key
 * wins — which is what makes C→B→A land on A's key even when no message in the chain
 * carries References. Otherwise the pure derivation stands. Either way every id in the
 * chain is then associated with the winner, so the next message in the thread resolves
 * on the first rung.
 *
 * Ties (a message that bridges two previously-separate threads, e.g. a reply that CCs in
 * an older conversation) resolve to the association of the EARLIEST id in the chain,
 * which is the id closest to the root — deterministic, and it keeps the older thread's
 * identity rather than minting a third one.
 */
export function resolveThreadKey(index: ThreadIndex, h: ThreadHeaders): string {
  const chain = threadChain(h)
  let key: string | undefined
  for (const id of chain) {
    const known = index.keyOf.get(id)
    if (known) {
      key = known
      break
    }
  }
  if (!key) key = deriveThreadKey(h)
  for (const id of chain) remember(index, id, key)
  return key
}

// ════════════════════════════════════════════════════════════════════════════
// PURE — reply header construction
// ════════════════════════════════════════════════════════════════════════════

/** What we know about the message being replied to. */
export interface ParentRef {
  /** The parent's own Message-ID, bare (no angle brackets). */
  messageId?: string | null
  /** The parent's References chain, bare ids, oldest first. */
  references?: string[] | null
  subject?: string | null
}

export interface ReplyHeaders {
  /** `<id>` form, ready for the header. Absent when there is no parent. */
  inReplyTo?: string
  /** `<id>` forms, oldest first. Absent when the chain is empty. */
  references?: string[]
  subject: string
}

/**
 * Build the headers that make a reply THREAD in the recipient's client rather than open
 * a new conversation. PURE.
 *
 * The rule is RFC 5322 §3.6.4 and it is not optional in either direction:
 *   · `In-Reply-To` = the parent's Message-ID. Alone it is enough for some clients.
 *   · `References` = the parent's References, then the parent's Message-ID. Gmail and
 *     Outlook thread on this, not on In-Reply-To, and they thread on the whole chain —
 *     sending only the parent id re-roots the thread and visibly splits it in the
 *     recipient's mailbox at the exact moment the conversation gets long enough to
 *     matter.
 *   · The subject carries exactly one `Re:`.
 *
 * The parent's id is appended, never assumed to be absent from References: a parent that
 * already listed itself (some clients do) must not appear twice, so the chain is deduped
 * with order preserved.
 */
export function buildReplyHeaders(parent: ParentRef, maxRefs: number = MAX_REFERENCES): ReplyHeaders {
  const chain: string[] = []
  const seen = new Set<string>()
  for (const raw of [...(parent.references ?? []), parent.messageId]) {
    const id = normalizeMessageId(raw)
    if (id && !seen.has(id)) {
      seen.add(id)
      chain.push(id)
    }
  }

  // Trim from the MIDDLE. The first id is the thread root every participant keys on and
  // dropping it would fork the thread for everyone; the most recent ids are what clients
  // use to attach the reply to the right leaf. The middle is the expendable part.
  const trimmed =
    chain.length > maxRefs && maxRefs >= 2
      ? [chain[0], ...chain.slice(chain.length - (maxRefs - 1))]
      : chain

  const parentId = normalizeMessageId(parent.messageId)
  const out: ReplyHeaders = { subject: replySubject(parent.subject) }
  if (parentId) out.inReplyTo = angle(parentId)
  if (trimmed.length > 0) out.references = trimmed.map(angle)
  return out
}

/** Generate a syntactically valid, globally unique Message-ID for a message WE send.
 *  Generated here rather than left to the SMTP library so the value is known before the
 *  send and can be threaded into the conversation's chain for the next reply. */
export function generateMessageId(domain: string, rand: () => string = defaultRand): string {
  const host = /^[A-Za-z0-9.\-_]+$/.test(domain) && domain ? domain : 'duin.local'
  return `<duin.${Date.now().toString(36)}.${rand()}@${host}>`
}

function defaultRand(): string {
  return Math.random().toString(36).slice(2, 12)
}

/** Domain part of an address, for the Message-ID host. */
function domainOf(address: string): string {
  const at = address.lastIndexOf('@')
  return at >= 0 ? address.slice(at + 1) : ''
}

/** Strip the characters that could terminate or inject a header line: CR, LF, NUL. Every
 *  value that lands unquoted on a header line goes through this — without it an address
 *  or subject containing `\r\n` could smuggle in an extra header (a hidden `Bcc:` for
 *  silent exfiltration) or split the body. PURE. */
export function sanitizeHeaderValue(value: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\r\n\u0000]/g, '')
}

// ════════════════════════════════════════════════════════════════════════════
// PURE — quote and signature stripping
// ════════════════════════════════════════════════════════════════════════════
//
// Email quotes the ENTIRE prior conversation into every message. Forwarding that to the
// model each turn costs tokens linearly in thread length and actively confuses it — the
// model re-answers questions it already answered because they are right there in the
// prompt looking like new input.
//
// The bias is explicitly CONSERVATIVE: keeping a quote wastes tokens, dropping real
// content loses the user's actual message. So every rule below either matches an
// unambiguous machine-generated marker, or requires that everything after the cut is
// itself quote-shaped. An inline reply (answers interleaved between `>` lines) is left
// completely untouched, and a strip that would empty the message is discarded.

const QUOTED_LINE = /^\s*>/
/** RFC 3676 §4.3 signature separator: two dashes, optionally a trailing space. */
const SIG_DELIM = /^--\s?$/
/** Header lines inside an Outlook-style quoted block (no `>` prefix anywhere). */
const MAIL_HEADER_LINE = /^\s*(from|to|cc|bcc|sent|date|subject|reply-to|发件人|收件人|抄送|日期|主题|時間|寄件者)\s*[:：]/i
/** Unambiguous machine-generated dividers — everything after one is quoted by
 *  construction, so these cut without needing corroboration. */
const HARD_DIVIDER = [
  /^\s*-{2,}\s*original message\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*forwarded message\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*(原始邮件|原始郵件|转发邮件|轉發郵件)\s*-{2,}\s*$/,
  /^\s*_{10,}\s*$/
]
/** Attribution lines ("On <date>, <who> wrote:"). Weaker than a divider — a human can
 *  legitimately write one — so these only cut with corroboration. */
const ATTRIBUTION = [
  /\bwrote\s*[:：]\s*$/i,
  /\bsent\s+from\b.*\bwrote\s*[:：]\s*$/i,
  /(写道|寫道)\s*[:：]\s*$/,
  /\bschrieb\s*[:：]\s*$/i,
  /\ba\s+écrit\s*[:：]\s*$/i,
  /\bescribió\s*[:：]\s*$/i,
  /\bha\s+scritto\s*[:：]\s*$/i
]

function isBlank(line: string): boolean {
  return line.trim() === ''
}

/** True if the line closes an attribution AND opens one — i.e. looks like the tail of
 *  "On Tue, 3 Sep 2026 at 10:04, Alice <a@b> wrote:", possibly after folding. */
function isAttributionLine(line: string): boolean {
  if (line.length > 400) return false // a real attribution is one wrapped sentence
  return ATTRIBUTION.some((re) => re.test(line))
}

/** An attribution may be wrapped across up to 3 physical lines by the sending client.
 *  Returns the index of its LAST line, or -1. */
function attributionEndsAt(lines: string[], i: number): number {
  for (let span = 0; span < 3 && i + span < lines.length; span++) {
    const joined = lines
      .slice(i, i + span + 1)
      .join(' ')
      .trim()
    // Require the opener to look like an attribution start, so a stray line ending in
    // "wrote:" three lines below something unrelated cannot anchor a cut.
    if (span > 0 && !/^\s*(on|am|le|el|il|在|於)\b/i.test(lines[i])) return -1
    if (isAttributionLine(joined)) return i + span
  }
  return -1
}

/** Index of the next non-blank line at or after `i`, or -1. */
function nextContent(lines: string[], i: number): number {
  for (let j = i; j < lines.length; j++) if (!isBlank(lines[j])) return j
  return -1
}

/** True when every non-blank line from `i` on is quote-shaped: `>`-prefixed, or a bare
 *  mail-header line from a pasted quote block. This is the corroboration a weak
 *  attribution needs, and it is what protects inline replies — real prose after the
 *  attribution makes this false and nothing is cut. */
function tailIsQuoted(lines: string[], i: number): boolean {
  let sawQuote = false
  for (let j = i; j < lines.length; j++) {
    const l = lines[j]
    if (isBlank(l)) continue
    if (QUOTED_LINE.test(l) || MAIL_HEADER_LINE.test(l)) {
      sawQuote = true
      continue
    }
    return false
  }
  return sawQuote
}

/** Start of an Outlook quoted-header block: `From:` corroborated within a few lines by
 *  a Sent/Date AND a To. `From:` alone is not enough — people write it in prose. */
function isOutlookHeaderBlock(lines: string[], i: number): boolean {
  if (!/^\s*(from|发件人|寄件者)\s*[:：]/i.test(lines[i])) return false
  const window = lines.slice(i + 1, i + 6)
  const hasWhen = window.some((l) => /^\s*(sent|date|日期|時間)\s*[:：]/i.test(l))
  const hasTo = window.some((l) => /^\s*(to|收件人)\s*[:：]/i.test(l))
  return hasWhen && hasTo
}

/**
 * Remove the quoted reply chain and trailing signature from a message body. PURE.
 *
 * Returns the original text unchanged whenever stripping would leave nothing — a message
 * that is ONLY a quote is more useful to the runtime than an empty string, and an empty
 * turn is indistinguishable from a bug.
 */
export function stripQuotedReply(text: string | null | undefined): string {
  if (typeof text !== 'string' || text.trim() === '') return ''
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')

  let cut = -1
  for (let i = 0; i < lines.length && cut < 0; i++) {
    const line = lines[i]

    // (a) Machine-generated divider — unambiguous, cut immediately.
    if (HARD_DIVIDER.some((re) => re.test(line))) {
      cut = i
      break
    }

    // (b) Pasted header block with no `>` prefix (Outlook inline forward/reply).
    if (isOutlookHeaderBlock(lines, i)) {
      cut = i
      break
    }

    // (c) Attribution. Cut when the very next content line is quoted (Gmail, Apple Mail,
    //     Thunderbird all emit exactly this shape) or when the whole remainder is
    //     quote-shaped. Both are corroboration; without either, leave it alone.
    const attrEnd = attributionEndsAt(lines, i)
    if (attrEnd >= 0) {
      const after = nextContent(lines, attrEnd + 1)
      const nextIsQuote = after >= 0 && QUOTED_LINE.test(lines[after])
      if (nextIsQuote || tailIsQuoted(lines, attrEnd + 1)) {
        cut = i
        break
      }
    }
  }

  // (d) No attribution found: trim a trailing RUN of quoted lines. Bounded to the tail
  //     so a quote in the middle, answered below, survives untouched.
  if (cut < 0) {
    let j = lines.length
    while (j > 0 && (isBlank(lines[j - 1]) || QUOTED_LINE.test(lines[j - 1]))) j--
    if (j < lines.length && lines.slice(j).some((l) => QUOTED_LINE.test(l))) cut = j
  }

  let kept = cut >= 0 ? lines.slice(0, cut) : lines.slice()

  // (e) Signature. Cut at the LAST `-- ` delimiter, and only when something precedes it,
  //     so a message that opens with the delimiter is not erased.
  const sigIdx = kept.findLastIndex((l) => SIG_DELIM.test(l))
  if (sigIdx > 0) kept = kept.slice(0, sigIdx)

  const result = kept.join('\n').replace(/\s+$/, '').replace(/^\n+/, '')
  return result.trim() === '' ? normalized.trim() : result
}

// ════════════════════════════════════════════════════════════════════════════
// PURE — minimal MIME reader
// ════════════════════════════════════════════════════════════════════════════
//
// `mailparser` would do this and do it better, but it is a third dependency for what the
// transport actually needs: the handful of threading headers and one plain-text body.
// Keeping it here means the tested surface covers parsing too, instead of parsing being
// another thing that only a live mailbox could exercise.

export interface ParsedEmail {
  /** Header names lowercased; folded values unfolded; first occurrence wins. */
  headers: Record<string, string>
  /** Best-effort plain text body, transfer- and charset-decoded. */
  text: string
}

/** Decode the RFC 2047 encoded-words in a header value, e.g. `=?UTF-8?B?…?=`. PURE. */
export function decodeEncodedWords(value: string): string {
  if (!value.includes('=?')) return value
  // Whitespace BETWEEN two adjacent encoded words is a separator, not text (RFC 2047
  // §6.2) — collapsing it first is what stops a long subject split across two words from
  // gaining a phantom space in the middle of a word. Whitespace between an encoded word
  // and ordinary text is real and is left alone.
  const collapsed = value.replace(/\?=\s+=\?/g, '?==?')
  return collapsed.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_match, charset: string, enc: string, payload: string) => {
      let bytes: Buffer
      if (enc.toUpperCase() === 'B') {
        bytes = Buffer.from(payload, 'base64')
      } else {
        // Q encoding: '_' is a space, '=XX' is a hex byte.
        const q = payload
          .replace(/_/g, ' ')
          .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        bytes = Buffer.from(q, 'latin1')
      }
      return decodeBytes(bytes, charset)
    }
  )
}

/** Bytes → string for a named charset, falling back to latin1 (which never throws and
 *  never loses a byte) when the label is unknown to the platform. */
function decodeBytes(bytes: Buffer, charset: string | undefined): string {
  const label = (charset || 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '')
  if (label === 'utf-8' || label === 'utf8') return bytes.toString('utf8')
  if (label === 'us-ascii' || label === 'ascii') return bytes.toString('ascii')
  if (label === 'iso-8859-1' || label === 'latin1') return bytes.toString('latin1')
  try {
    return new TextDecoder(label).decode(bytes)
  } catch {
    return bytes.toString('latin1')
  }
}

/** Decode quoted-printable to bytes. PURE. */
function decodeQuotedPrintable(body: string): Buffer {
  // Soft line breaks first: `=` at end of line means "no break here".
  const joined = body.replace(/=\r?\n/g, '')
  const out: number[] = []
  for (let i = 0; i < joined.length; i++) {
    const c = joined[i]
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      out.push(parseInt(joined.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      out.push(joined.charCodeAt(i) & 0xff)
    }
  }
  return Buffer.from(out)
}

/** Split a raw MIME entity into its unfolded headers and its still-encoded body. */
function splitEntity(raw: string): { headers: Record<string, string>; body: string } {
  const sep = raw.search(/\n[\t ]*\n/)
  const headerBlock = sep >= 0 ? raw.slice(0, sep) : raw
  const body = sep >= 0 ? raw.slice(sep + 1).replace(/^[\t ]*\n/, '') : ''

  const headers: Record<string, string> = {}
  // Unfold: a continuation line starts with whitespace and belongs to the header above.
  const unfolded = headerBlock.replace(/\n[\t ]+/g, ' ')
  for (const line of unfolded.split('\n')) {
    const m = /^([!-9;-~]+)[\t ]*:(.*)$/.exec(line)
    if (!m) continue
    const name = m[1].toLowerCase()
    // First occurrence wins. For the headers this transport reads (Message-ID,
    // References, In-Reply-To, From, Subject) a duplicate is a malformed or spoofed
    // message, and taking the first is what a receiving MTA's own parse would see.
    if (!(name in headers)) headers[name] = m[2].trim()
  }
  return { headers, body }
}

/** `boundary` parameter out of a Content-Type value. */
function boundaryOf(contentType: string): string | null {
  const m = /;\s*boundary\s*=\s*("([^"]*)"|([^;\s]+))/i.exec(contentType)
  return (m?.[2] ?? m?.[3] ?? null) || null
}

/** `charset` parameter out of a Content-Type value. */
function charsetOf(contentType: string): string | undefined {
  const m = /;\s*charset\s*=\s*("([^"]*)"|([^;\s]+))/i.exec(contentType)
  return m?.[2] ?? m?.[3] ?? undefined
}

/** Very small HTML→text, for messages with no text/plain alternative. Keeps the words
 *  and the line structure and drops everything else; it is a fallback, not a renderer. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Decode one leaf entity's body to text using its own CTE + charset. */
function decodeLeaf(headers: Record<string, string>, body: string): string {
  const cte = (headers['content-transfer-encoding'] || '7bit').trim().toLowerCase()
  const charset = charsetOf(headers['content-type'] || '')
  let bytes: Buffer
  if (cte === 'base64') bytes = Buffer.from(body.replace(/\s+/g, ''), 'base64')
  else if (cte === 'quoted-printable') bytes = decodeQuotedPrintable(body)
  else bytes = Buffer.from(body, 'latin1')
  return decodeBytes(bytes, charset)
}

/** Walk a (possibly multipart) entity and return the best text body. Prefers text/plain
 *  at any depth, falls back to a de-tagged text/html. Depth-capped: a malicious or
 *  broken message must not be able to drive unbounded recursion. */
function textOfEntity(raw: string, depth: number): string {
  const { headers, body } = splitEntity(raw)
  const contentType = (headers['content-type'] || 'text/plain').toLowerCase()

  if (contentType.startsWith('multipart/') && depth < 4) {
    const boundary = boundaryOf(headers['content-type'] || '')
    if (boundary) {
      const parts = body.split(new RegExp(`(?:^|\\n)--${escapeRegExp(boundary)}(?:--)?[\\t ]*(?:\\n|$)`))
      // slice(1) drops the preamble; the blank filter drops the epilogue after the
      // closing delimiter, which is not a part and must not be mistaken for the body.
      const rendered = parts
        .slice(1)
        .filter((p) => p.trim() !== '')
        .map((p) => ({ raw: p, ct: splitEntity(p).headers['content-type'] || '' }))
      const plain = rendered.find((p) => Boolean(/^text\/plain/i.test(p.ct) || !p.ct))
      if (plain) {
        const t = textOfEntity(plain.raw, depth + 1)
        if (t.trim()) return t
      }
      for (const p of rendered) {
        const t = textOfEntity(p.raw, depth + 1)
        if (t.trim()) return t
      }
      return ''
    }
  }

  if (contentType.startsWith('text/html')) return htmlToText(decodeLeaf(headers, body))
  if (contentType.startsWith('text/') || !headers['content-type']) return decodeLeaf(headers, body)
  return '' // an attachment-only part contributes no text
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Parse a raw RFC822 message into the headers threading needs plus a plain-text body.
 * PURE.
 *
 * The source is read as latin1 rather than utf8 on purpose: latin1 is the one encoding
 * where every byte maps to exactly one char code, so the structural parse (header
 * folding, MIME boundaries — all ASCII) is byte-exact, and each body part can be turned
 * back into the original bytes with `Buffer.from(part, 'latin1')` before being decoded
 * with its OWN declared charset. Reading the whole message as utf8 up front would
 * corrupt any part that is not utf8, and there is no single correct charset for a
 * multipart message.
 */
export function parseRawMessage(source: Buffer | string): ParsedEmail {
  const buf = Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8')
  const raw = buf.toString('latin1').replace(/\r\n/g, '\n')
  const { headers } = splitEntity(raw)

  // Header VALUES may carry encoded-words; the names and structure never do.
  const decodedHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    decodedHeaders[k] = k === 'subject' || k === 'from' || k === 'to' ? decodeEncodedWords(v) : v
  }

  return { headers: decodedHeaders, text: textOfEntity(raw, 0) }
}

/**
 * Should this inbound message be ignored outright? PURE.
 *
 * An email bot that answers automated mail is a MAIL LOOP: DUIN replies to a vacation
 * autoresponder, which replies to DUIN, forever, at full model cost. RFC 3834 exists
 * precisely so this is detectable, and every mainstream autoresponder sets at least one
 * of these. Cheap to check, expensive to omit.
 */
export function isAutomatedMail(headers: Record<string, string>): boolean {
  const auto = (headers['auto-submitted'] || '').toLowerCase()
  if (auto && auto !== 'no') return true
  const precedence = (headers['precedence'] || '').toLowerCase()
  if (['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) return true
  // NOT X-Auto-Response-Suppress: senders put that on mail they do not want answered
  // automatically, including plenty of legitimate human-originated mail, and treating it
  // as "this is a robot" would silently drop real messages.
  if (headers['x-autoreply'] || headers['x-autorespond']) return true
  if ((headers['x-failed-recipients'] || '').trim()) return true
  // A bounce arrives with an empty envelope sender; the header form is `<>`.
  if ((headers['return-path'] || '').trim() === '<>') return true
  return false
}

// ════════════════════════════════════════════════════════════════════════════
// The vendor seam
// ════════════════════════════════════════════════════════════════════════════
//
// Everything above is pure and fully tested. Everything below talks to a socket. The two
// interfaces here are the line between them: they are the SMALLEST surface of imapflow
// and nodemailer this transport needs, so the untestable-without-a-mailbox part of the
// file is the ~50-line shim that implements them and nothing else.

export interface RawImapMessage {
  uid: number
  /** Full RFC822 source. Kept as bytes — see parseRawMessage on why. */
  source: Buffer
}

export interface ImapLike {
  connect(): Promise<void>
  openMailbox(path: string): Promise<void>
  /** UIDs of UNSEEN messages in the open mailbox, oldest first. */
  searchUnseen(): Promise<number[]>
  fetchByUid(uids: number[]): Promise<RawImapMessage[]>
  /** Set \Seen. This is the cross-restart dedup marker — see handleMessage. */
  markSeen(uids: number[]): Promise<void>
  /** 'exists' fires on new mail while IDLE; 'close'/'error' drive reconnection. */
  on(event: 'exists' | 'close' | 'error', handler: (payload?: unknown) => void): void
  close(): Promise<void>
}

export interface OutboundMail {
  from: string
  to: string
  subject: string
  text: string
  messageId: string
  inReplyTo?: string
  references?: string[]
}

export interface SmtpLike {
  /** Resolving means the server ACCEPTED the message. `rejected` carries per-recipient
   *  refusals, which the transport turns into a throw. */
  send(mail: OutboundMail): Promise<{ rejected?: string[] } | void>
  close(): Promise<void>
}

export interface EmailTransportOptions {
  imapHost: string
  imapPort?: number
  smtpHost: string
  smtpPort?: number
  user: string
  pass: string
  mailbox?: string
}

export interface EmailTransportDeps {
  /** Injected in tests. Absent ⇒ the imapflow shim below. */
  imapFactory?: (opts: EmailTransportOptions) => Promise<ImapLike>
  /** Injected in tests. Absent ⇒ the nodemailer shim below. */
  smtpFactory?: (opts: EmailTransportOptions) => Promise<SmtpLike>
  /** Injected in tests so generated Message-IDs are deterministic. */
  newMessageId?: () => string
  log?: (line: string, detail?: unknown) => void
}

/**
 * Load a package that is NOT a declared dependency of this repo. The specifier is a
 * variable so neither TypeScript nor the bundler tries to resolve it at build time —
 * which is what lets this file compile, lint and unit-test with the packages absent —
 * and the catch turns "module not found" into the one message an operator can act on
 * instead of a stack trace from inside the loader.
 */
async function loadOptional(spec: string): Promise<Record<string, unknown>> {
  try {
    return (await import(/* @vite-ignore */ spec)) as Record<string, unknown>
  } catch (e) {
    throw new Error(
      `the Email channel needs the '${spec}' package, which is not installed. ` +
        `Run: npm i imapflow nodemailer`,
      { cause: e }
    )
  }
}

/** UNVERIFIED SURFACE. imapflow is not installed here, so this shim is written against
 *  its published API and is the one part of the file no test can exercise. It is kept
 *  deliberately thin for that reason: every decision worth getting wrong lives above. */
async function defaultImapFactory(opts: EmailTransportOptions): Promise<ImapLike> {
  const mod = await loadOptional('imapflow')
  const ImapFlow = mod.ImapFlow as new (cfg: Record<string, unknown>) => ImapFlowClient
  const client = new ImapFlow({
    host: opts.imapHost,
    port: opts.imapPort ?? DEFAULT_IMAP_PORT,
    secure: (opts.imapPort ?? DEFAULT_IMAP_PORT) === DEFAULT_IMAP_PORT,
    auth: { user: opts.user, pass: opts.pass },
    // imapflow logs every command at info level, including the literal AUTH line.
    logger: false
  })

  return {
    connect: () => client.connect(),
    openMailbox: async (path) => {
      await client.mailboxOpen(path)
    },
    searchUnseen: async () => {
      const found = await client.search({ seen: false }, { uid: true })
      return Array.isArray(found) ? found : []
    },
    fetchByUid: async (uids) => {
      if (uids.length === 0) return []
      const out: RawImapMessage[] = []
      // A mailbox lock suspends imapflow's automatic IDLE for the duration and releases
      // it in `finally`; without it a fetch racing the IDLE renewal can desync the
      // connection.
      const lock = await client.getMailboxLock(opts.mailbox ?? DEFAULT_MAILBOX)
      try {
        for await (const msg of client.fetch(uids.join(','), { uid: true, source: true }, { uid: true })) {
          if (msg.source) out.push({ uid: msg.uid, source: msg.source })
        }
      } finally {
        lock.release()
      }
      return out
    },
    markSeen: async (uids) => {
      if (uids.length === 0) return
      await client.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true })
    },
    on: (event, handler) => {
      client.on(event, handler)
    },
    close: async () => {
      try {
        await client.logout()
      } catch {
        // A dead socket cannot be logged out of politely; close() is the hard path and
        // must still run or the handle leaks.
        client.close()
      }
    }
  }
}

/** Structural type for the parts of imapflow's client we touch. */
interface ImapFlowClient {
  connect(): Promise<void>
  logout(): Promise<void>
  close(): void
  mailboxOpen(path: string, opts?: Record<string, unknown>): Promise<unknown>
  getMailboxLock(path: string): Promise<{ release(): void }>
  search(query: Record<string, unknown>, opts?: Record<string, unknown>): Promise<number[] | false>
  fetch(
    range: string,
    query: Record<string, unknown>,
    opts?: Record<string, unknown>
  ): AsyncIterable<{ uid: number; source?: Buffer }>
  messageFlagsAdd(range: string, flags: string[], opts?: Record<string, unknown>): Promise<boolean>
  on(event: string, handler: (payload?: unknown) => void): void
}

/** UNVERIFIED SURFACE, same caveat as the IMAP shim. */
async function defaultSmtpFactory(opts: EmailTransportOptions): Promise<SmtpLike> {
  const mod = await loadOptional('nodemailer')
  const nodemailer = (mod.default ?? mod) as {
    createTransport(cfg: Record<string, unknown>): NodemailerTransporter
  }
  const port = opts.smtpPort ?? DEFAULT_SMTP_PORT
  const transporter = nodemailer.createTransport({
    host: opts.smtpHost,
    port,
    // Implicit TLS on 465; STARTTLS on everything else. `requireTLS` makes the
    // non-465 path refuse to fall back to cleartext rather than silently downgrading.
    secure: port === DEFAULT_SMTP_PORT,
    requireTLS: port !== DEFAULT_SMTP_PORT,
    auth: { user: opts.user, pass: opts.pass }
  })
  return {
    send: (mail) => transporter.sendMail(mail),
    close: async () => {
      transporter.close?.()
    }
  }
}

interface NodemailerTransporter {
  sendMail(mail: OutboundMail): Promise<{ rejected?: string[] }>
  close?(): void
}

// ════════════════════════════════════════════════════════════════════════════
// The transport
// ════════════════════════════════════════════════════════════════════════════

/** What `send` needs to reply INTO a thread rather than beside it. Held in memory only:
 *  a transport may not import a store (transport.ts), so this is rebuilt from inbound
 *  mail after a restart. The cost of that is bounded — see `send` for the fallback. */
interface ThreadContext {
  /** Who to reply to: the address of the last inbound message in this thread. */
  to: string
  subject: string
  /** Message-ID of the most recent message in the thread, ours or theirs. */
  lastMessageId: string | null
  /** Full chain, oldest first, bare ids. */
  references: string[]
}

/**
 * Build the Email transport. Credentials are arguments and are never persisted or
 * logged; `deps` is the test seam and is empty in production.
 */
export function createEmailTransport(
  opts: EmailTransportOptions,
  deps: EmailTransportDeps = {}
): ChannelTransport {
  const mailbox = opts.mailbox ?? DEFAULT_MAILBOX
  const selfAddress = parseAddress(opts.user) ?? opts.user.toLowerCase()
  const imapFactory = deps.imapFactory ?? defaultImapFactory
  const smtpFactory = deps.smtpFactory ?? defaultSmtpFactory
  const newMessageId = deps.newMessageId ?? (() => generateMessageId(domainOf(selfAddress)))
  const log = deps.log ?? ((line: string, detail?: unknown) => console.debug(`[email] ${line}`, detail ?? ''))

  let running = false
  let sink: ((msg: TransportMessage) => Promise<void>) | null = null
  let imap: ImapLike | null = null
  let smtp: SmtpLike | null = null

  const threads = createThreadIndex()
  const contexts = new Map<string, ThreadContext>()
  /** Message-IDs already handed to the sink IN THIS PROCESS. The \Seen flag is the
   *  durable dedup marker; this covers the window between "sink accepted it" and "STORE
   *  \Seen landed", and the case where two 'exists' events race the same scan. */
  const processed = new Set<string>()

  /** Both collections above are per-thread/per-message and a channel may run for months,
   *  so both are capped and evict oldest-first. Losing an old context only costs the
   *  ability to reply into a thread nobody has touched in thousands of messages, which
   *  `send`'s unknown-conversation error already reports honestly. */
  function setContext(key: string, ctx: ThreadContext): void {
    if (contexts.has(key)) contexts.delete(key)
    contexts.set(key, ctx)
    while (contexts.size > THREAD_INDEX_MAX) {
      const oldest = contexts.keys().next()
      if (oldest.done) break
      contexts.delete(oldest.value)
    }
  }

  function markProcessed(id: string): void {
    processed.add(id)
    while (processed.size > THREAD_INDEX_MAX) {
      const oldest = processed.values().next()
      if (oldest.done) break
      processed.delete(oldest.value)
    }
  }

  let scanning = false
  let rescanRequested = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let livenessTimer: ReturnType<typeof setInterval> | null = null
  let backoffMs = RECONNECT_MIN_MS

  // ── inbound ───────────────────────────────────────────────────────────────

  async function handleMessage(raw: RawImapMessage): Promise<void> {
    const parsed = parseRawMessage(raw.source)
    const h = parsed.headers
    const from = parseAddress(h['from'])
    const messageId = normalizeMessageId(h['message-id'])

    // Every drop below still marks \Seen. A message we will never act on must not be
    // re-fetched on the next scan forever — that is a hot loop against the server and,
    // for a mail loop, against the model too.
    if (!from) return void log('drop: no parseable From', { uid: raw.uid })
    if (from === selfAddress) return void log('drop: own address (loop guard)', { uid: raw.uid })
    if (isAutomatedMail(h)) return void log('drop: automated mail (loop guard)', { uid: raw.uid })
    if (messageId && processed.has(messageId)) return void log('drop: already processed', { uid: raw.uid })

    const headers: ThreadHeaders = {
      messageId: h['message-id'],
      inReplyTo: h['in-reply-to'],
      references: h['references'],
      subject: h['subject'],
      from: h['from']
    }
    const conversationId = resolveThreadKey(threads, headers)

    // Record the reply target BEFORE the sink runs. The sink's reply comes back through
    // `send()` on this same conversationId, and it must find a context — a turn that
    // answers and then cannot deliver is worse than one that never started.
    const chain = threadChain(headers)
    setContext(conversationId, {
      to: from,
      subject: h['subject'] ?? '',
      lastMessageId: messageId,
      references: chain
    })
    if (messageId) markProcessed(messageId)

    const msg: TransportMessage = {
      userId: from,
      conversationId,
      text: stripQuotedReply(parsed.text),
      messageId: messageId ?? undefined,
      // For email the thread IS the conversation: there is no outer channel containing
      // threads the way Slack has. Both fields carry the same derived key rather than
      // leaving threadId undefined, so a caller that reasons about threads sees one.
      threadId: conversationId,
      raw: { uid: raw.uid, subject: h['subject'], date: h['date'], headers }
    }

    try {
      await sink?.(msg)
    } catch (e) {
      // The sink's failure is the sink's problem — same posture as the Telegram adapter.
      // Rethrowing here would abort the scan and strand the remaining messages, and NOT
      // marking \Seen would re-deliver a poison message on every scan forever.
      log('sink failed', e)
    }
  }

  /** One sweep of UNSEEN mail. Serialized: 'exists' can fire several times while a scan
   *  is in flight, and two concurrent scans would fetch the same UIDs twice. */
  async function runScan(): Promise<void> {
    if (!running || !imap) return
    if (scanning) {
      rescanRequested = true
      return
    }
    scanning = true
    try {
      do {
        rescanRequested = false
        const client = imap
        if (!client) break
        const uids = await client.searchUnseen()
        if (uids.length === 0) continue
        const messages = await client.fetchByUid(uids)
        for (const m of messages) {
          try {
            await handleMessage(m)
          } catch (e) {
            // A message we cannot even parse must not abort the sweep and strand the
            // rest of the batch, and must not be mistaken below for a dead socket.
            log('handleMessage failed', e)
          } finally {
            // AFTER the sink settles, always. Marking before would lose a message to a
            // crash mid-turn; not marking at all would replay it forever. This is
            // at-least-once delivery, and the `processed` set collapses the duplicate
            // within a process lifetime.
            try {
              await client.markSeen([m.uid])
            } catch (e) {
              log('markSeen failed', e)
            }
          }
        }
      } while (rescanRequested && running)
    } catch (e) {
      // A throw here is usually the socket, not the mail: treat it as a disconnect.
      log('scan failed, reconnecting', e)
      scheduleReconnect()
    } finally {
      scanning = false
    }
  }

  // ── connection lifecycle ──────────────────────────────────────────────────

  async function openImap(): Promise<void> {
    const client = await imapFactory(opts)
    // Listeners BEFORE connect/open, or mail that arrives during the open is missed.
    client.on('exists', () => {
      void runScan()
    })
    client.on('close', () => {
      if (running) {
        log('connection closed')
        scheduleReconnect()
      }
    })
    client.on('error', (e) => {
      log('connection error', e)
      if (running) scheduleReconnect()
    })

    try {
      await client.connect()
      await client.openMailbox(mailbox)
    } catch (e) {
      // Close the half-built client before giving up. Without this, every retry against a
      // server that accepts the TCP connection and then rejects the login leaks a socket,
      // and the backoff loop is designed to run indefinitely.
      await client.close().catch(() => undefined)
      throw e
    }
    imap = client
    backoffMs = RECONNECT_MIN_MS // the connection is real; forget the previous failures
  }

  function scheduleReconnect(): void {
    if (!running || reconnectTimer) return
    const dead = imap
    imap = null
    if (dead) void dead.close().catch(() => undefined)

    const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER
    const delay = Math.round(backoffMs * jitter)
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS)
    log(`reconnecting in ${delay}ms`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (!running) return
      void openImap()
        .then(() => {
          // Mail that landed while we were down is UNSEEN and still waiting; the scan is
          // what makes a reconnect lossless.
          void runScan()
        })
        .catch((e) => {
          log('reconnect failed', e)
          scheduleReconnect()
        })
    }, delay)
    reconnectTimer.unref?.()
  }

  // ── outbound ──────────────────────────────────────────────────────────────

  async function ensureSmtp(): Promise<SmtpLike> {
    // Built on first send, not at connect: `connect()`'s contract is about INBOUND
    // ("resolves only once messages can actually arrive"), and failing it on an SMTP
    // problem would report the channel as down when it is receiving fine. The shared
    // credential means a wrong password surfaces at IMAP connect anyway.
    if (!smtp) smtp = await smtpFactory(opts)
    return smtp
  }

  return {
    id: CHANNEL_ID,

    capabilities(): TransportCapability[] {
      // 'threads' is honest here — email threads for real, via References — even though
      // the id is derived rather than handed to us. Nothing else: no reactions, no
      // typing indicator, no directory to enumerate.
      return ['threads']
    },

    async connect(onMessage: (msg: TransportMessage) => Promise<void>): Promise<void> {
      if (running) return // idempotent
      sink = onMessage
      running = true
      try {
        await openImap()
      } catch (e) {
        // The FIRST connect must throw rather than fall into the retry loop. Retrying
        // silently would let the gateway report a channel as running on a wrong password
        // or a typo'd host — exactly the enabled-vs-running lie transport.ts forbids.
        // Only drops AFTER a good connection are the transport's own to absorb.
        running = false
        sink = null
        throw e instanceof Error ? e : new Error(String(e), { cause: e })
      }

      // Backlog first, then the periodic backstop. Deliberately NOT awaited: connect()
      // means "messages can arrive", and awaiting would hold it open for a full model
      // turn per queued message while the gateway waits on a boolean.
      void runScan()
      livenessTimer = setInterval(() => {
        void runScan()
      }, LIVENESS_MS)
      livenessTimer.unref?.()
    },

    async disconnect(): Promise<void> {
      running = false
      sink = null
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (livenessTimer) {
        clearInterval(livenessTimer)
        livenessTimer = null
      }
      const client = imap
      imap = null
      const mailer = smtp
      smtp = null
      // Safe to call when not connected, and a failing close must not throw out of
      // disconnect — the caller's next move is to drop the reference either way.
      if (client) await client.close().catch((e) => log('imap close failed', e))
      if (mailer) await mailer.close().catch((e) => log('smtp close failed', e))
    },

    async send(conversationId: string, text: string, sendOpts?: { threadId?: string }): Promise<void> {
      const ctx = contexts.get(conversationId)

      // A conversationId with no context is either a fresh outbound conversation
      // addressed by email address, or a thread this process never saw (restart). The
      // first is legitimate; the second cannot be threaded and must not be faked — an
      // unaddressable send has to throw, since resolving means DELIVERED.
      //
      // The prefix check is what separates them, and it is the reason THREAD_PREFIX
      // exists: a derived key like `email:abc@host` would otherwise satisfy every test
      // for "looks like an address" and we would post a reply to a nonexistent mailbox
      // named after a Message-ID instead of reporting that the thread is unknown.
      const bareAddress =
        !ctx && !conversationId.startsWith(THREAD_PREFIX) ? parseAddress(conversationId) : null
      if (!ctx && !bareAddress) {
        throw new Error(
          `email: unknown conversation '${conversationId}' — no thread context in this process. ` +
            `Address a new message by passing the recipient's email address as the conversation id.`
        )
      }

      // `threadId` is honored only when it names a specific message to reply to. The
      // transport also puts the thread KEY in TransportMessage.threadId, so a caller
      // echoing that value back is not asking for a different parent.
      const explicitParent =
        sendOpts?.threadId && sendOpts.threadId !== conversationId
          ? normalizeMessageId(sendOpts.threadId)
          : null

      const parent: ParentRef = ctx
        ? {
            messageId: explicitParent ?? ctx.lastMessageId,
            references: ctx.references,
            subject: ctx.subject
          }
        : { messageId: explicitParent, references: [], subject: null }

      const reply = buildReplyHeaders(parent)
      const messageId = newMessageId()
      const to = ctx ? ctx.to : (bareAddress as string)

      const mailer = await ensureSmtp()
      const result = await mailer.send({
        from: sanitizeHeaderValue(opts.user),
        to: sanitizeHeaderValue(to),
        subject: sanitizeHeaderValue(ctx ? reply.subject : 'Message from DUIN'),
        text,
        messageId,
        inReplyTo: reply.inReplyTo,
        references: reply.references
      })
      // nodemailer resolves even when the server refused individual recipients. A
      // per-recipient rejection is a non-delivery, and swallowing it would report a
      // reply the user never got.
      const rejected = result && 'rejected' in result ? result.rejected : undefined
      if (rejected && rejected.length > 0) {
        throw new Error(`email send rejected for: ${rejected.join(', ')}`)
      }

      // Thread our own message into the chain so the NEXT reply — ours or theirs —
      // chains from it. Without this, two consecutive outbound messages would both
      // reply to the same parent, and a reply to our fresh message (whose References
      // root is our id, not the address we keyed on) would open a second conversation.
      const ownId = normalizeMessageId(messageId)
      const nextRefs = ctx ? [...ctx.references] : []
      if (parent.messageId) {
        const p = normalizeMessageId(parent.messageId)
        if (p && !nextRefs.includes(p)) nextRefs.push(p)
      }
      if (ownId && !nextRefs.includes(ownId)) nextRefs.push(ownId)
      setContext(conversationId, {
        to,
        subject: ctx?.subject ?? '',
        lastMessageId: ownId,
        references: nextRefs
      })
      // Index our own id against this conversation too. For a fresh send keyed on a bare
      // address this is the whole mechanism: the recipient's reply will carry References
      // rooted at OUR id, which derives a different key, and only this association makes
      // that reply resolve back to the conversation the caller opened.
      if (ownId) remember(threads, ownId, conversationId)
    }
  }
}
