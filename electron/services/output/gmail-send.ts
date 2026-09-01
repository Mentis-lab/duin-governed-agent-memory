// gmail-send.ts — DUIN's "hands" for email OUTPUT. Builds an RFC822 MIME message
// (pure, unit-tested: `buildMimeMessage`) and POSTs it, base64url-encoded, to the
// Gmail REST API `users.messages.send` endpoint with a fresh Bearer token from the
// shared Google OAuth freshness gate (google-auth.ensureFreshGoogleToken).
//
// SCOPE NOTE: the existing Google OAuth grant already includes the full
// `https://mail.google.com/` scope (ipc/mcp.ts SCOPES), so Gmail SEND is already
// authorized — no re-consent needed for this path. Calendar WRITE is a separate,
// not-yet-granted scope and is out of scope for this module.
//
// SECURITY: sending an email is an IRREVERSIBLE external side effect. The tool that
// wraps sendGmail (output-tool-pack `send_email`) is registered GATED — a
// de-privileged inbound turn (execToken:null) is denied at the brain's deny-first
// gate before it can ever reach this code. This module itself carries no authority:
// it only shapes + posts the request when a caller hands it a live token path.

import { basename, extname } from 'path'
import { readFileSync } from 'fs'
import { ensureFreshGoogleToken } from '../google-auth'
import { messageOf } from '../guarded'

const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
const CRLF = '\r\n'

/** One MIME attachment part. `content` is either raw bytes (Buffer), a UTF-8
 *  string (base64:false), or an already-base64 string (base64:true). */
export interface MailAttachment {
  filename: string
  content: Buffer | string
  /** MIME type; defaults to a best-effort guess from the filename extension. */
  contentType?: string
  /** When true, a string `content` is treated as pre-encoded base64. */
  base64?: boolean
}

export interface MimeMessageInput {
  to: string | string[]
  subject: string
  body: string
  /** Render the body as text/html instead of text/plain. */
  html?: boolean
  cc?: string | string[]
  from?: string
  attachments?: MailAttachment[]
  /** Test seam: pin the multipart boundary so output is deterministic. */
  boundary?: string
}

export interface SendGmailResult {
  ok: boolean
  /** The Gmail message id on success. */
  id?: string
  /** The Gmail thread id on success. */
  threadId?: string
  error?: string
}

/** URL-safe base64 (RFC 4648 §5): `+`→`-`, `/`→`_`, strip `=` padding. Accepts a
 *  string (encoded as UTF-8) or a Buffer. PURE. */
export function base64UrlEncode(input: string | Buffer): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Wrap a base64 blob into 76-character lines joined by CRLF, per RFC 2045. */
function wrapBase64(b64: string): string {
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76))
  return lines.join(CRLF)
}

/** Strip the characters that could break a header out of a header value: CR, LF,
 *  and NUL. This is the CRLF-injection guard — without it a `\r\n` embedded in a
 *  recipient, Cc, From, or (ASCII) Subject value would let a caller inject arbitrary
 *  extra headers (e.g. a hidden `Bcc:` for silent exfiltration) or split the body.
 *  PURE. Applied to EVERY value that lands unquoted on a header line. */
export function sanitizeHeaderValue(value: string): string {
  // Remove CR, LF and NUL — the characters that could terminate or inject a header line.
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\r\n\u0000]/g, '')
}

/** RFC 2047 encode a header value when it contains non-ASCII, else pass it
 *  through. Uses the "B" (base64) encoding of the UTF-8 bytes. Always strips
 *  CR/LF/NUL first so the ASCII pass-through path can never carry an injected
 *  header break. PURE. */
export function encodeHeaderWord(value: string): string {
  const clean = sanitizeHeaderValue(value)
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(clean)) return clean
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}

/** Sanitize a filename for use inside a quoted header parameter
 *  (`name="…"` / `filename="…"`): strip CR/LF/NUL (injection) and neutralize the
 *  characters that would break out of the quoted-string (`"` and `\`). Non-ASCII is
 *  then RFC2047-encoded by the caller via encodeHeaderWord. PURE. */
export function sanitizeFilename(filename: string): string {
  return sanitizeHeaderValue(filename).replace(/["\\]/g, '_')
}

/** Normalize a `string | string[]` address field to a single header value, with
 *  each address CRLF-sanitized so no recipient can smuggle a header break. */
function addressList(v: string | string[] | undefined): string {
  if (!v) return ''
  const parts = Array.isArray(v) ? v : [v]
  return parts.filter(Boolean).map((a) => sanitizeHeaderValue(String(a))).join(', ')
}

/** Best-effort MIME content type from a filename extension. */
export function contentTypeForFile(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case '.pdf':
      return 'application/pdf'
    case '.html':
    case '.htm':
      return 'text/html'
    case '.txt':
      return 'text/plain'
    case '.csv':
      return 'text/csv'
    case '.json':
      return 'application/json'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.md':
    case '.markdown':
      return 'text/markdown'
    default:
      return 'application/octet-stream'
  }
}

/** Turn an attachment's `content` into a wrapped base64 body. */
function attachmentBase64(a: MailAttachment): string {
  let b64: string
  if (Buffer.isBuffer(a.content)) b64 = a.content.toString('base64')
  else if (a.base64) b64 = a.content.replace(/\s+/g, '')
  else b64 = Buffer.from(a.content, 'utf8').toString('base64')
  return wrapBase64(b64)
}

/**
 * Build a raw RFC822 MIME message string (CRLF line endings). When there are no
 * attachments the body is a single text/plain|text/html part; with attachments the
 * message is multipart/mixed with the body as the first part. The body is always
 * base64-transfer-encoded so arbitrary UTF-8 survives intact. PURE — no I/O.
 */
export function buildMimeMessage(input: MimeMessageInput): string {
  const to = addressList(input.to)
  const cc = addressList(input.cc)
  const bodyType = input.html ? 'text/html' : 'text/plain'
  const bodyB64 = wrapBase64(Buffer.from(input.body ?? '', 'utf8').toString('base64'))

  const headers: string[] = []
  if (input.from) headers.push(`From: ${sanitizeHeaderValue(input.from)}`)
  headers.push(`To: ${to}`)
  if (cc) headers.push(`Cc: ${cc}`)
  headers.push(`Subject: ${encodeHeaderWord(input.subject ?? '')}`)
  headers.push('MIME-Version: 1.0')

  const attachments = input.attachments ?? []
  if (attachments.length === 0) {
    headers.push(`Content-Type: ${bodyType}; charset="UTF-8"`)
    headers.push('Content-Transfer-Encoding: base64')
    return headers.join(CRLF) + CRLF + CRLF + bodyB64 + CRLF
  }

  const boundary = input.boundary ?? `=_duin_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)

  const parts: string[] = []
  // Body part.
  parts.push(
    `--${boundary}` +
      CRLF +
      `Content-Type: ${bodyType}; charset="UTF-8"` +
      CRLF +
      'Content-Transfer-Encoding: base64' +
      CRLF +
      CRLF +
      bodyB64
  )
  // Attachment parts.
  for (const a of attachments) {
    const ct = sanitizeHeaderValue(a.contentType || contentTypeForFile(a.filename)).replace(/["\\;]/g, '_')
    const name = encodeHeaderWord(sanitizeFilename(a.filename))
    parts.push(
      `--${boundary}` +
        CRLF +
        `Content-Type: ${ct}; name="${name}"` +
        CRLF +
        'Content-Transfer-Encoding: base64' +
        CRLF +
        `Content-Disposition: attachment; filename="${name}"` +
        CRLF +
        CRLF +
        attachmentBase64(a)
    )
  }

  return headers.join(CRLF) + CRLF + CRLF + parts.join(CRLF) + CRLF + `--${boundary}--` + CRLF
}

/** Read a file path into a MailAttachment (bytes + inferred type + basename). */
export function loadAttachment(path: string): MailAttachment {
  const content = readFileSync(path)
  const filename = basename(path)
  return { filename, content, contentType: contentTypeForFile(filename) }
}

/**
 * Send an email through Gmail. Loads a fresh Google token, builds the MIME message,
 * and POSTs it. `attachments` may be file paths (read here) or pre-built
 * MailAttachments. Never throws — always resolves a structured result.
 */
export async function sendGmail(
  to: string | string[],
  subject: string,
  body: string,
  opts: {
    html?: boolean
    cc?: string | string[]
    from?: string
    attachments?: Array<string | MailAttachment>
  } = {}
): Promise<SendGmailResult> {
  if (!to || (Array.isArray(to) && to.length === 0)) return { ok: false, error: 'a recipient (to) is required' }
  let token: string | null
  try {
    token = await ensureFreshGoogleToken()
  } catch (e) {
    return { ok: false, error: `Google auth failed: ${messageOf(e)}` }
  }
  if (!token) return { ok: false, error: 'Google is not connected (no usable access token) — connect Google in Settings.' }

  let attachments: MailAttachment[] | undefined
  try {
    attachments = (opts.attachments ?? []).map((a) => (typeof a === 'string' ? loadAttachment(a) : a))
  } catch (e) {
    return { ok: false, error: `could not read attachment: ${messageOf(e)}` }
  }

  const raw = buildMimeMessage({ to, subject, body, html: opts.html, cc: opts.cc, from: opts.from, attachments })

  try {
    const resp = await fetch(GMAIL_SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: base64UrlEncode(raw) })
    })
    if (!resp.ok) {
      let detail = ''
      try {
        detail = (await resp.text()).slice(0, 500)
      } catch (e) {
        detail = messageOf(e)
      }
      return { ok: false, error: `Gmail send failed (HTTP ${resp.status}): ${detail}` }
    }
    const data = (await resp.json()) as { id?: string; threadId?: string }
    return { ok: true, id: data.id, threadId: data.threadId }
  } catch (e) {
    return { ok: false, error: `Gmail send error: ${messageOf(e)}` }
  }
}
