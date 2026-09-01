// gdrive-write.ts — DUIN's "hands" for Google Drive WRITE (create / upload a file).
// Shapes a multipart/related upload body (pure, unit-tested: `buildDriveMetadata` +
// `buildMultipartRelatedBody`) and POSTs it to the Drive v3 media-upload endpoint with
// a fresh Bearer token from the shared Google OAuth freshness gate.
//
//   POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart
//   body: multipart/related — part 1 = file metadata (application/json),
//         part 2 = the media (base64 transfer-encoded so arbitrary bytes survive).
//
// SCOPE NOTE: the existing OAuth grant ALREADY includes `.../auth/drive` (ipc/mcp.ts
// SCOPES), so Drive WRITE needs no re-consent — only a live token to actually run.
//
// CONSEQUENCE TIER: create/upload = write-reversible (the file can be trashed/removed).
// The gate + approval sit ABOVE this module (act-tool-pack → registerExternalAction).
// `fetchFn` / `token` are injectable so the pure shaping is unit-tested with no creds.

import { basename } from 'path'
import { readFileSync } from 'fs'
import { ensureFreshGoogleToken } from '../google-auth'
import { messageOf } from '../guarded'
import type { FetchLike } from './gcal-write'

const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink'

export interface DriveDeps {
  token?: string
  fetchFn?: FetchLike
}

export interface DriveUploadInput {
  /** The file name to create in Drive. */
  name: string
  /** File content: a UTF-8 string, or raw bytes (Buffer). */
  content?: string | Buffer
  /** Read the content from this absolute local path instead of `content`. */
  path?: string
  /** MIME type of the media. Defaults to a guess from the name, else text/plain. */
  mimeType?: string
  /** Parent folder ids to place the file under. */
  parents?: string[]
  /** Optional file description metadata. */
  description?: string
}

/** Build the Drive file metadata object (part 1 of the multipart body). PURE. */
export function buildDriveMetadata(input: {
  name: string
  mimeType?: string
  parents?: string[]
  description?: string
}): Record<string, unknown> {
  const meta: Record<string, unknown> = { name: input.name }
  if (input.mimeType) meta.mimeType = input.mimeType
  if (input.description) meta.description = input.description
  const parents = (input.parents ?? []).map((p) => String(p).trim()).filter(Boolean)
  if (parents.length > 0) meta.parents = parents
  return meta
}

/**
 * Build a multipart/related request body: a JSON metadata part followed by a
 * base64-transfer-encoded media part. Returns the raw body string AND the boundary
 * the caller must echo in the Content-Type header. PURE — no I/O.
 */
export function buildMultipartRelatedBody(
  metadata: Record<string, unknown>,
  media: string | Buffer,
  mediaType: string,
  boundary = `=_duin_drive_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
): { body: string; boundary: string; contentType: string } {
  const mediaB64 = (Buffer.isBuffer(media) ? media : Buffer.from(media, 'utf8')).toString('base64')
  const CRLF = '\r\n'
  // Strip CR/LF/NUL from the media type: it lands unquoted on a `Content-Type` header
  // line, so an embedded newline would otherwise let a caller inject an extra MIME part
  // or header. The metadata part is JSON.stringify'd, so it is already CRLF-safe.
  // eslint-disable-next-line no-control-regex
  const safeMediaType = String(mediaType ?? '').replace(/[\r\n\u0000]/g, '') || 'application/octet-stream'
  const body =
    `--${boundary}${CRLF}` +
    `Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}` +
    `${JSON.stringify(metadata)}${CRLF}` +
    `--${boundary}${CRLF}` +
    `Content-Type: ${safeMediaType}${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    `${mediaB64}${CRLF}` +
    `--${boundary}--`
  return { body, boundary, contentType: `multipart/related; boundary=${boundary}` }
}

/** Best-effort MIME type from a filename extension (mirrors gmail-send's map). PURE. */
export function driveMimeForName(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  switch (ext) {
    case 'pdf':
      return 'application/pdf'
    case 'html':
    case 'htm':
      return 'text/html'
    case 'csv':
      return 'text/csv'
    case 'json':
      return 'application/json'
    case 'md':
    case 'markdown':
      return 'text/markdown'
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'txt':
      return 'text/plain'
    default:
      return 'text/plain'
  }
}

export interface DriveUploadResult {
  ok: boolean
  id?: string
  name?: string
  webViewLink?: string
  error?: string
}

/**
 * Create / upload a file to Google Drive (write-reversible). Loads a fresh token,
 * reads the content (from `content` or `path`), shapes the multipart body and POSTs
 * it. Never throws — always resolves a structured result.
 */
export async function uploadDriveFile(input: DriveUploadInput, deps: DriveDeps = {}): Promise<DriveUploadResult> {
  const name = (input?.name ?? '').trim() || (input?.path ? basename(input.path) : '')
  if (!name) return { ok: false, error: 'a file name is required' }

  // Resolve content bytes.
  let media: string | Buffer
  if (input.content !== undefined) {
    media = input.content
  } else if (input.path) {
    try {
      media = readFileSync(input.path)
    } catch (e) {
      return { ok: false, error: `could not read file: ${messageOf(e)}` }
    }
  } else {
    media = ''
  }

  // Resolve token.
  let token = deps.token
  if (!token) {
    let t: string | null
    try {
      t = await ensureFreshGoogleToken()
    } catch (e) {
      return { ok: false, error: `Google auth failed: ${messageOf(e)}` }
    }
    if (!t) return { ok: false, error: 'Google is not connected (no usable access token) — connect Google in Settings.' }
    token = t
  }

  const mediaType = input.mimeType || driveMimeForName(name)
  const metadata = buildDriveMetadata({ name, mimeType: mediaType, parents: input.parents, description: input.description })
  const { body, contentType } = buildMultipartRelatedBody(metadata, media, mediaType)

  const fetchFn = deps.fetchFn ?? (globalThis.fetch as unknown as FetchLike)
  try {
    const resp = await fetchFn(DRIVE_UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      body
    })
    if (!resp.ok) {
      let detail = ''
      try {
        detail = (await resp.text()).slice(0, 500)
      } catch (e) {
        detail = messageOf(e)
      }
      return { ok: false, error: `Drive upload failed (HTTP ${resp.status}): ${detail}` }
    }
    const data = (await resp.json()) as { id?: string; name?: string; webViewLink?: string }
    return { ok: true, id: data.id, name: data.name, webViewLink: data.webViewLink }
  } catch (e) {
    return { ok: false, error: `Drive upload error: ${messageOf(e)}` }
  }
}
