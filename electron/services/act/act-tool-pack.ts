// act-tool-pack.ts — DUIN's OUTBOUND external-write native tools ("hands"), each
// published through `registerExternalAction` so the SHARED consequence-tier + exec-token
// gate + operator-approval + audit pipeline (external-action.ts) applies uniformly:
//
//   • calendar_create_event   — Google Calendar create        (write-reversible)
//   • calendar_update_event   — Google Calendar patch          (write-reversible)
//   • calendar_delete_event   — Google Calendar delete         (IRREVERSIBLE → approval)
//   • drive_upload_file       — Google Drive create/upload     (write-reversible)
//   • feishu_create_doc       — Feishu docx create via lark-cli(write-reversible)
//   • feishu_base_add_record  — Feishu Bitable record create   (write-reversible)
//
// SECURITY: registerExternalAction records each tool's tier in the pure registry the
// dispatch gate reads (agui-gate → decideAguiGate), so a de-privileged inbound turn
// (execToken:null) is DENIED any of these writes BEFORE the handler runs; the delete
// (irreversible) additionally requires explicit operator approval on a privileged turn.
// This module only shapes descriptors + wires handlers to the connectors.
//
// SCOPE / LIVE-VERIFY notes:
//   - Calendar WRITE needs the full `.../auth/calendar` scope (added to ipc/mcp.ts
//     SCOPES in stage 5). Users who connected earlier must RECONNECT Google to
//     re-consent; until then create/update/delete return HTTP 403. (human-verify)
//   - Drive scope is already granted; only a live token is needed. (human-verify: live)
//   - Feishu writes shell out to lark-cli — exact CLI verbs are human-verify.

import { registerExternalAction } from './external-action'
import { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from './gcal-write'
import { uploadDriveFile } from './gdrive-write'
import { feishuCreateDoc, feishuBaseAddRecord } from './feishu-write'
import { messageOf } from '../guarded'
import { assertInsideRoots, permittedLocalRoots } from '../path-jail'

/**
 * Was this argument actually SUPPLIED by the model?
 *
 * `undefined` and `null` are BOTH "not provided" — the convention the shared validator
 * sets (tool-schema-validator.ts:210, "Null is technically an object but we treat it as
 * a missing value"). It only *tolerates* a null though; it returns the parsed object
 * with the null still in place, so `{eventId, start, description: null}` — a very
 * common LLM spelling of "leave the description alone" — reaches a handler with the key
 * present. A bare `args.x !== undefined` then reads that as "provide x", and `str(null)`
 * turns it into `''`: the update tool would PATCH an empty string over the user's
 * hand-written agenda and report plain success.
 *
 * Every optional-arg guard in this file goes through here so no call site can skip it.
 */
function provided<T>(v: T): v is Exclude<T, null | undefined> {
  return v !== undefined && v !== null
}

/** Coerce an unknown arg to a trimmed string (empty when the value is not a string).
 *  NOTE: only meaningful once `provided()` says the caller supplied the field — this
 *  collapses absent and empty, and for a PATCH those mean no-op vs. delete. */
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Parse a string|string[] attendee/parents field into a clean list. */
function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === 'string') {
    return v
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return []
}

// ─────────────────────── calendar_create_event (write-reversible) ───────────────────────
registerExternalAction({
  id: 'calendar_create_event',
  title: 'Create Google Calendar event',
  tier: 'write-reversible',
  description:
    'Create an event on the connected Google Calendar. Provide `summary`, `start`, and `end` (each an RFC3339 date-time like "2026-07-20T15:00:00+08:00", or a "YYYY-MM-DD" date for an all-day event). Optional: `description`, `location`, `attendees` (email list), `timeZone` (IANA, e.g. "Asia/Shanghai"), `calendarId` (defaults to primary). Creating an event is reversible (it can be updated or deleted).',
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Event title.' },
      start: { type: 'string', description: 'Start: RFC3339 date-time, or YYYY-MM-DD for all-day.' },
      end: { type: 'string', description: 'End: RFC3339 date-time, or YYYY-MM-DD for all-day.' },
      description: { type: 'string', description: 'Optional event description/body.' },
      location: { type: 'string', description: 'Optional location text.' },
      attendees: { type: 'array', items: { type: 'string' }, description: 'Optional attendee email addresses.' },
      timeZone: { type: 'string', description: 'Optional IANA timezone for timed start/end.' },
      calendarId: { type: 'string', description: 'Optional calendar id (defaults to "primary").' }
    },
    required: ['summary', 'start', 'end'],
    additionalProperties: false
  },
  handler: async (args) => {
    const r = await createCalendarEvent(
      {
        summary: str(args.summary),
        start: str(args.start),
        end: str(args.end),
        description: provided(args.description) ? str(args.description) : undefined,
        location: provided(args.location) ? str(args.location) : undefined,
        attendees: provided(args.attendees) ? strList(args.attendees) : undefined,
        timeZone: provided(args.timeZone) ? str(args.timeZone) : undefined
      },
      { calendarId: str(args.calendarId) || undefined }
    )
    if (!r.ok) return { result: `Error: ${r.error ?? 'calendar create failed'}`, status: 'error' }
    return { result: `Created calendar event (id ${r.id ?? 'unknown'})${r.htmlLink ? ` — ${r.htmlLink}` : ''}.`, status: 'done' }
  }
})

// ─────────────────────── calendar_update_event (write-reversible) ───────────────────────
registerExternalAction({
  id: 'calendar_update_event',
  title: 'Update Google Calendar event',
  tier: 'write-reversible',
  description:
    'Update (patch) an existing Google Calendar event by `eventId`. Only the fields you provide are changed — OMIT a field (or pass null) to leave it exactly as it is; never pass an empty string as a way of saying "unchanged", because an empty string is taken as a deliberate request to CLEAR that field. Optional fields: `summary`, `start`, `end`, `description`, `location`, `attendees`, `timeZone`, `calendarId`. Updating is reversible: a cleared field\'s prior text is snapshotted to the event log before the write.',
  inputSchema: {
    type: 'object',
    properties: {
      eventId: { type: 'string', description: 'The id of the event to update.' },
      summary: { type: 'string' },
      start: { type: 'string', description: 'RFC3339 date-time or YYYY-MM-DD.' },
      end: { type: 'string', description: 'RFC3339 date-time or YYYY-MM-DD.' },
      description: { type: 'string' },
      location: { type: 'string' },
      attendees: {
        type: 'array',
        items: { type: 'string' },
        description:
          'REPLACES the whole guest list — pass the complete set of attendees the event should end up with, or omit the field entirely to leave the existing guests untouched. An empty list is ignored, never treated as "remove everyone".'
      },
      timeZone: { type: 'string' },
      calendarId: { type: 'string' }
    },
    required: ['eventId'],
    additionalProperties: false
  },
  handler: async (args) => {
    const patch: Record<string, unknown> = {}
    if (provided(args.summary)) patch.summary = str(args.summary)
    if (provided(args.start)) patch.start = str(args.start)
    if (provided(args.end)) patch.end = str(args.end)
    if (provided(args.description)) patch.description = str(args.description)
    if (provided(args.location)) patch.location = str(args.location)
    if (provided(args.attendees)) patch.attendees = strList(args.attendees)
    if (provided(args.timeZone)) patch.timeZone = str(args.timeZone)
    const r = await updateCalendarEvent(str(args.eventId), patch, { calendarId: str(args.calendarId) || undefined })
    if (!r.ok) return { result: `Error: ${r.error ?? 'calendar update failed'}`, status: 'error' }
    const note = r.notice ? ` ${r.notice}` : ''
    return { result: `Updated calendar event ${r.id ?? str(args.eventId)}.${note}`, status: 'done' }
  }
})

// ─────────────────────── calendar_delete_event (IRREVERSIBLE) ───────────────────────
registerExternalAction({
  id: 'calendar_delete_event',
  title: 'Delete Google Calendar event',
  tier: 'irreversible',
  description:
    'Delete an event from the connected Google Calendar by `eventId`. This is IRREVERSIBLE — a deleted event cannot be restored — so it always requires operator approval. Optional `calendarId` (defaults to "primary").',
  inputSchema: {
    type: 'object',
    properties: {
      eventId: { type: 'string', description: 'The id of the event to delete.' },
      calendarId: { type: 'string', description: 'Optional calendar id (defaults to "primary").' }
    },
    required: ['eventId'],
    additionalProperties: false
  },
  handler: async (args) => {
    const r = await deleteCalendarEvent(str(args.eventId), { calendarId: str(args.calendarId) || undefined })
    if (!r.ok) return { result: `Error: ${r.error ?? 'calendar delete failed'}`, status: 'error' }
    return { result: `Deleted calendar event ${str(args.eventId)}.`, status: 'done' }
  }
})

// ─────────────────────── drive_upload_file (write-reversible) ───────────────────────
registerExternalAction({
  id: 'drive_upload_file',
  title: 'Upload file to Google Drive',
  tier: 'write-reversible',
  description:
    'Create/upload a file to the connected Google Drive. Provide `name` (the filename to create) and either `content` (inline text) or `path` (an absolute local file to upload). Optional: `mimeType`, `parents` (folder ids), `description`. Uploading is reversible (the file can be trashed).',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The filename to create in Drive.' },
      content: { type: 'string', description: 'Inline text content for the file (use this OR path).' },
      path: { type: 'string', description: 'Absolute local file path to upload (use this OR content).' },
      mimeType: { type: 'string', description: 'Optional MIME type (guessed from the name otherwise).' },
      parents: { type: 'array', items: { type: 'string' }, description: 'Optional parent folder ids.' },
      description: { type: 'string', description: 'Optional file description metadata.' }
    },
    required: ['name'],
    additionalProperties: false
  },
  handler: async (args) => {
    // JAIL the local path. This read any absolute path the OS user could open and
    // shipped it to the operator's real Google Drive, at `write-reversible` tier —
    // which action-tier.ts only requires approval for when it is `irreversible`. So a
    // single "Always allow" on any other network-risk prompt pre-approved this too, by
    // the documented risk-class fan-out, and a poisoned document could then name
    // ~/.ssh/id_rsa or a keychain file and exfiltrate it with no prompt anywhere.
    // Inline `content` is unaffected — it was never a filesystem read.
    const localPath = str(args.path)
    const jailed = localPath
      ? assertInsideRoots(permittedLocalRoots(), localPath, 'drive_upload_file')
      : undefined
    const r = await uploadDriveFile({
      name: str(args.name),
      content: typeof args.content === 'string' ? args.content : undefined,
      path: jailed,
      mimeType: str(args.mimeType) || undefined,
      parents: provided(args.parents) ? strList(args.parents) : undefined,
      description: provided(args.description) ? str(args.description) : undefined
    })
    if (!r.ok) return { result: `Error: ${r.error ?? 'drive upload failed'}`, status: 'error' }
    return { result: `Uploaded "${r.name ?? str(args.name)}" to Drive (id ${r.id ?? 'unknown'})${r.webViewLink ? ` — ${r.webViewLink}` : ''}.`, status: 'done' }
  }
})

// ─────────────────────── feishu_create_doc (write-reversible) ───────────────────────
registerExternalAction({
  id: 'feishu_create_doc',
  title: 'Create Feishu document',
  tier: 'write-reversible',
  description:
    'Create a new Feishu (Lark) document from markdown content via lark-cli. Provide `title` and `markdown`. Optional `folderToken` to place it in a folder. Creating a doc is reversible.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The document title.' },
      markdown: { type: 'string', description: 'The document content as markdown.' },
      folderToken: { type: 'string', description: 'Optional destination folder token.' }
    },
    required: ['title', 'markdown'],
    additionalProperties: false
  },
  handler: async (args) => {
    try {
      const r = await feishuCreateDoc({
        title: str(args.title),
        markdown: typeof args.markdown === 'string' ? args.markdown : '',
        folderToken: str(args.folderToken) || undefined
      })
      if (!r.ok) return { result: `Error: ${r.error ?? 'feishu doc create failed'}`, status: 'error' }
      return { result: `Created Feishu doc${r.id ? ` (${r.id})` : ''}${r.info ? ` — ${r.info}` : ''}.`, status: 'done' }
    } catch (e) {
      return { result: `Error: ${messageOf(e)}`, status: 'error' }
    }
  }
})

// ─────────────────────── feishu_base_add_record (write-reversible) ───────────────────────
registerExternalAction({
  id: 'feishu_base_add_record',
  title: 'Add Feishu Base record',
  tier: 'write-reversible',
  description:
    'Append a record to a Feishu (Lark) Base (Bitable) table via lark-cli. Provide `appToken` (the Base app token), `tableId`, and `fields` (an object mapping field name → value). Adding a record is reversible.',
  inputSchema: {
    type: 'object',
    properties: {
      appToken: { type: 'string', description: 'The Base (Bitable) app token.' },
      tableId: { type: 'string', description: 'The table id within the Base.' },
      fields: { type: 'object', description: 'Field name → value map for the new record.', additionalProperties: true }
    },
    required: ['appToken', 'tableId', 'fields'],
    additionalProperties: false
  },
  handler: async (args) => {
    try {
      const fields = args.fields && typeof args.fields === 'object' ? (args.fields as Record<string, unknown>) : {}
      const r = await feishuBaseAddRecord({ appToken: str(args.appToken), tableId: str(args.tableId), fields })
      if (!r.ok) return { result: `Error: ${r.error ?? 'feishu record create failed'}`, status: 'error' }
      return { result: `Added Feishu Base record${r.id ? ` (${r.id})` : ''}.`, status: 'done' }
    } catch (e) {
      return { result: `Error: ${messageOf(e)}`, status: 'error' }
    }
  }
})
