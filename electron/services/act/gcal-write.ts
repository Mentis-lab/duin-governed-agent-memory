// gcal-write.ts — DUIN's "hands" for Google Calendar WRITE. Shapes an event resource
// (pure, unit-tested: `buildEventResource`) and calls the Calendar v3 REST API with a
// fresh Bearer token from the shared Google OAuth freshness gate
// (google-auth.ensureFreshGoogleToken):
//
//   • create → POST   calendar/v3/calendars/{calendarId}/events
//   • update → PATCH  calendar/v3/calendars/{calendarId}/events/{eventId}
//   • delete → DELETE calendar/v3/calendars/{calendarId}/events/{eventId}
//
// CONSEQUENCE TIER (enforced where the tools are registered, act-tool-pack.ts):
//   create / update = write-reversible (an event can be edited or removed).
//   delete          = IRREVERSIBLE (a deleted event cannot be restored) → hard gate.
//
// SCOPE NOTE (human-verify): the existing OAuth grant historically only carried
// `.../auth/calendar.readonly`. Stage 5 widens ipc/mcp.ts SCOPES to the full
// `https://www.googleapis.com/auth/calendar` (read+write). A user who authorized
// BEFORE this change must RE-CONSENT (reconnect Google in Settings) before any write
// here succeeds — until then the API returns HTTP 403 insufficientPermissions and the
// connector surfaces that verbatim (it never fakes success).
//
// This module carries no authority: the gate + operator approval sit ABOVE it
// (act-tool-pack → registerExternalAction). `fetchFn` and `token` are injectable so
// the pure request-shaping is unit-tested with no live credentials.

import { ensureFreshGoogleToken } from '../google-auth'
import { messageOf } from '../guarded'

const CAL_BASE = 'https://www.googleapis.com/calendar/v3/calendars'

/** A minimal `fetch` shape (the runtime global, injectable in tests). */
export type FetchLike = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }>

export interface GcalDeps {
  /** Calendar to write to. Defaults to the user's primary calendar. */
  calendarId?: string
  /** Pre-resolved bearer token (tests). Defaults to ensureFreshGoogleToken(). */
  token?: string
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetchFn?: FetchLike
  /** Durable sink for a pre-write snapshot of content this PATCH is about to
   *  erase (see `journalFieldClear`). Injectable in tests; defaults to a
   *  best-effort event-spine row. Never blocks or reverses the write. */
  journal?: (entry: FieldClearJournalEntry) => void
}

/** What a narrowing PATCH is about to overwrite, captured BEFORE it is sent so the
 *  erasure is recoverable and stamped rather than silently reported "done". */
export interface FieldClearJournalEntry {
  eventId: string
  calendarId: string
  /** ISO timestamp of the snapshot (when). */
  at: string
  /** Field name → the value the event carried before this PATCH (what/where it went). */
  prior: Record<string, string>
  /** Why the write narrowed the field: the caller passed an explicit empty string. */
  reason: 'explicit-empty-string'
}

/** A Google Calendar event date-time endpoint: either an all-day `date`
 *  (YYYY-MM-DD) or a timed `dateTime` (RFC3339) with an optional IANA `timeZone`. */
export interface EventDateTime {
  date?: string
  dateTime?: string
  timeZone?: string
}

/** Friendly, connector-level event input. `start`/`end` accept a bare string: a
 *  `YYYY-MM-DD` value is treated as an all-day date; anything else as a timed
 *  RFC3339 dateTime. Or pass a full {date|dateTime,timeZone} object. */
export interface CalendarEventInput {
  summary?: string
  description?: string
  location?: string
  start: string | EventDateTime
  end: string | EventDateTime
  /** Attendee email addresses. */
  attendees?: string[]
  /** IANA timezone applied to string `start`/`end` timed values (e.g. 'Asia/Shanghai'). */
  timeZone?: string
}

const ALL_DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Was this field actually SUPPLIED by the caller?
 *
 * `undefined` and `null` both mean "not provided" — the system-wide convention set by
 * tool-schema-validator ("Null is technically an object but we treat it as a missing
 * value", tool-schema-validator.ts:210). The validator only *tolerates* a null, it does
 * not strip it, so `{description: null}` — a very common LLM shape for "leave this
 * alone" — arrives at the writer with the key still present. Testing `!== undefined`
 * alone therefore reads "leave unchanged" as "set to empty" and erases the field.
 *
 * This generalizes the null-guard `buildEventPatch` already applied to `attendees` to
 * every field, so no single call site can skip it. PURE.
 */
function provided<T>(v: T): v is Exclude<T, null | undefined> {
  return v !== undefined && v !== null
}

/** Clean a raw attendee list into Calendar `{email}` entries, dropping blanks. PURE. */
function cleanAttendees(list: unknown): { email: string }[] {
  if (!Array.isArray(list)) return []
  return list
    .map((e) => String(e).trim())
    .filter(Boolean)
    .map((email) => ({ email }))
}

/**
 * True when the caller supplied an `attendees` key that cleans down to NOTHING
 * (`null`, `[]`, `['', ' ']`) — i.e. an *inferred* empty list rather than a
 * deliberate roster.
 *
 * WHY THIS EXISTS: Google treats `attendees: []` in a PATCH body as a FULL
 * REPLACEMENT of the guest list. It removes every attendee AND emails each of
 * them a cancellation. Their RSVP state (accepted/declined/tentative) lives only
 * server-side, this module never reads the event before writing, and the mailed
 * cancellations cannot be retracted even by re-adding the addresses — so the loss
 * is unrecoverable. A model answering "move the board review to 4pm" with
 * `attendees: null` must therefore never be able to clear the roster as a side
 * effect. `buildEventPatch` omits the field; callers surface this predicate so the
 * suppression is RECORDED rather than silent. PURE.
 */
export function attendeeClearSuppressed(patch: Partial<CalendarEventInput>): boolean {
  const raw = (patch as { attendees?: unknown }).attendees
  if (!('attendees' in patch) || raw === undefined) return false
  return cleanAttendees(raw).length === 0
}

/** Explains a suppressed attendee-clear to the operator (traceability, not silence). */
export const ATTENDEE_CLEAR_NOTICE =
  'The guest list was left UNCHANGED: an empty/blank `attendees` value was ignored because Google treats it ' +
  'as "remove every guest" (it also emails them cancellations, and their RSVPs cannot be restored). ' +
  'To change guests, pass the complete list of attendees the event should end up with.'

/** Normalize a string|EventDateTime endpoint to a Calendar API date-time object. PURE. */
export function normalizeEventDateTime(v: string | EventDateTime, timeZone?: string): EventDateTime {
  if (typeof v === 'string') {
    const s = v.trim()
    if (ALL_DAY_RE.test(s)) return { date: s }
    return timeZone ? { dateTime: s, timeZone } : { dateTime: s }
  }
  // Object form: carry the connector-level timeZone onto a timed value if absent.
  if (v.dateTime && !v.timeZone && timeZone) return { ...v, timeZone }
  return v
}

/**
 * Build a Google Calendar event resource from the friendly input. Omits empty
 * fields so a PATCH only touches what the caller specified. PURE — no I/O.
 */
export function buildEventResource(input: CalendarEventInput): Record<string, unknown> {
  const resource: Record<string, unknown> = {}
  if (provided(input.summary)) resource.summary = input.summary
  if (provided(input.description)) resource.description = input.description
  if (provided(input.location)) resource.location = input.location
  if (provided(input.start)) resource.start = normalizeEventDateTime(input.start, input.timeZone)
  if (provided(input.end)) resource.end = normalizeEventDateTime(input.end, input.timeZone)
  if (input.attendees && input.attendees.length > 0) {
    const attendees = cleanAttendees(input.attendees)
    if (attendees.length > 0) resource.attendees = attendees
  }
  return resource
}

/** Build a PATCH resource for an update: only the provided fields, so unspecified
 *  event properties are left untouched. PURE. */
export function buildEventPatch(patch: Partial<CalendarEventInput>): Record<string, unknown> {
  const resource: Record<string, unknown> = {}
  // `provided` (not `!== undefined`): a null field is NOT provided, so it is omitted
  // and the event keeps whatever it already had. See `provided`.
  if (provided(patch.summary)) resource.summary = patch.summary
  if (provided(patch.description)) resource.description = patch.description
  if (provided(patch.location)) resource.location = patch.location
  if (provided(patch.start)) resource.start = normalizeEventDateTime(patch.start, patch.timeZone)
  if (provided(patch.end)) resource.end = normalizeEventDateTime(patch.end, patch.timeZone)
  // Mirrors buildEventResource's guard: an empty attendee list is OMITTED, never
  // emitted. `attendees: []` on a PATCH is a full replacement that deletes every
  // guest (see attendeeClearSuppressed). Only a non-empty roster is written.
  if (provided(patch.attendees)) {
    const attendees = cleanAttendees(patch.attendees)
    if (attendees.length > 0) resource.attendees = attendees
  }
  return resource
}

/** Text fields a PATCH can NARROW: replacing one with '' destroys the prior text and
 *  Google keeps no revision history to restore it from. */
export const NARROWABLE_TEXT_FIELDS = ['summary', 'description', 'location'] as const
export type NarrowableTextField = (typeof NARROWABLE_TEXT_FIELDS)[number]

/**
 * Which text fields would this patch BLANK? Only an explicit empty string counts —
 * a null/absent field is "leave unchanged" (see `provided`) and never lands here.
 *
 * A deliberate clear is legitimate (the user may really want the description gone), so
 * it is NOT refused; it is snapshotted first (see `journalFieldClear`) so the prior
 * content is recoverable and the change is stamped. PURE.
 */
export function textClearFields(patch: Partial<CalendarEventInput>): NarrowableTextField[] {
  return NARROWABLE_TEXT_FIELDS.filter((f) => {
    const v = patch[f]
    return typeof v === 'string' && v.trim() === ''
  })
}

/** Explains a recorded (not refused) text-field erasure to the operator. */
export function textClearNotice(fields: readonly string[], prior: Record<string, string>): string {
  const detail = fields
    .map((f) => {
      const before = prior[f] ?? ''
      return before ? `${f} (was ${before.length} chars: "${before.slice(0, 120)}${before.length > 120 ? '…' : ''}")` : `${f} (was already empty)`
    })
    .join('; ')
  return `CLEARED to empty: ${detail}. The prior text was snapshotted to the event log before the write, so it can be restored.`
}

/** Explains a text-field erasure that was SUPPRESSED because no snapshot could be taken. */
export function textClearUnsnapshottableNotice(fields: readonly string[], why: string): string {
  return (
    `Left UNCHANGED: ${fields.join(', ')}. Clearing a field destroys text that Google keeps no ` +
    `revision history for, so it is only done once the prior value has been recorded — and the ` +
    `event could not be read first (${why}). Re-try, or pass the replacement text explicitly.`
  )
}

/** Default journal sink → a best-effort event-spine row carrying the pre-write text.
 *  Lazily imports the DB layer so the pure shaping + tests stay light. A journal
 *  failure never blocks the write, but it DOES stop the write from being silent:
 *  the notice is returned to the caller either way.
 *
 *  FIRE-AND-FORGET `import()`, not `require()`. This was a bare
 *  `require('../event-log')`; the bundler emits that call verbatim into
 *  out/main/index.js, where '../event-log' resolves to a path that does not exist,
 *  so it threw on every call and the try/catch swallowed it as a debug line. The
 *  consequence here is worse than a missing audit row: this journal is the entire
 *  reason a destructive clear is permitted at all — per the note above, the prior
 *  value is supposed to be recorded BEFORE text Google keeps no revision history
 *  for is destroyed. Silently writing nothing meant the text was destroyed with no
 *  record anywhere. The sink stays synchronous (its contract) and best-effort, so
 *  the row is enqueued rather than awaited. */
export const defaultFieldClearJournal = (entry: FieldClearJournalEntry): void => {
  void import('../event-log')
    .then(({ recordEvent }) =>
      recordEvent({
        type: 'tool.call.completed',
        actorKind: 'tool',
        severity: 'warning',
        entityKind: 'external-action',
        entityId: `calendar_update_event:${entry.eventId}`,
        redaction: 'preview',
        payload: {
          surface: 'act',
          action: 'calendar_update_event',
          phase: 'field-clear-snapshot',
          eventId: entry.eventId,
          calendarId: entry.calendarId,
          at: entry.at,
          reason: entry.reason,
          prior: entry.prior
        }
      })
    )
    .catch((err) => console.debug('[gcal-write] field-clear journal best-effort:', messageOf(err)))
}

/** GET the event and read back the current value of the fields about to be narrowed. */
async function readPriorFields(
  eventId: string,
  fields: readonly NarrowableTextField[],
  deps: GcalDeps
): Promise<{ ok: true; prior: Record<string, string> } | { ok: false; error: string }> {
  const { token, error } = await resolveToken(deps)
  if (error) return { ok: false, error }
  const fetchFn = deps.fetchFn ?? (globalThis.fetch as unknown as FetchLike)
  try {
    const resp = await fetchFn(eventUrl(eventId, deps.calendarId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status} reading the event` }
    const data = (await resp.json()) as Record<string, unknown>
    const prior: Record<string, string> = {}
    for (const f of fields) prior[f] = typeof data[f] === 'string' ? (data[f] as string) : ''
    return { ok: true, prior }
  } catch (e) {
    return { ok: false, error: messageOf(e) }
  }
}

/** Build the events collection URL for a calendar (create/list). PURE. */
export function eventsUrl(calendarId = 'primary'): string {
  return `${CAL_BASE}/${encodeURIComponent(calendarId)}/events`
}

/** Build a single-event URL (update/delete). PURE. */
export function eventUrl(eventId: string, calendarId = 'primary'): string {
  return `${CAL_BASE}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
}

export interface GcalResult {
  ok: boolean
  /** The event id on create/update success. */
  id?: string
  /** The event's web link on create/update success. */
  htmlLink?: string
  error?: string
  /** Non-fatal note about what the write deliberately did NOT do (e.g. a
   *  suppressed attendee-clear), so the omission is visible, not silent. */
  notice?: string
}

/** Resolve the bearer token (injected, else the shared freshness gate). */
async function resolveToken(deps: GcalDeps): Promise<{ token?: string; error?: string }> {
  if (deps.token) return { token: deps.token }
  let token: string | null
  try {
    token = await ensureFreshGoogleToken()
  } catch (e) {
    return { error: `Google auth failed: ${messageOf(e)}` }
  }
  if (!token) return { error: 'Google is not connected (no usable access token) — connect Google in Settings.' }
  return { token }
}

/** Shared HTTP: attach the bearer, parse an error body into a message. */
async function gcalRequest(
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body: Record<string, unknown> | null,
  deps: GcalDeps
): Promise<GcalResult> {
  const { token, error } = await resolveToken(deps)
  if (error) return { ok: false, error }
  const fetchFn = deps.fetchFn ?? (globalThis.fetch as unknown as FetchLike)
  try {
    const resp = await fetchFn(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    })
    if (!resp.ok) {
      let detail = ''
      try {
        detail = (await resp.text()).slice(0, 500)
      } catch (e) {
        detail = messageOf(e)
      }
      const hint =
        resp.status === 403
          ? ' (HTTP 403 — the Google grant may lack calendar WRITE scope; reconnect Google in Settings to re-consent to the calendar scope.)'
          : ''
      return { ok: false, error: `Calendar ${method} failed (HTTP ${resp.status})${hint}: ${detail}` }
    }
    // DELETE returns 204 with no body.
    if (method === 'DELETE') return { ok: true }
    const data = (await resp.json()) as { id?: string; htmlLink?: string }
    return { ok: true, id: data.id, htmlLink: data.htmlLink }
  } catch (e) {
    return { ok: false, error: `Calendar ${method} error: ${messageOf(e)}` }
  }
}

/** Create a calendar event (write-reversible). Never throws. */
export async function createCalendarEvent(input: CalendarEventInput, deps: GcalDeps = {}): Promise<GcalResult> {
  if (!input || input.start === undefined || input.end === undefined) {
    return { ok: false, error: 'a calendar event requires both start and end' }
  }
  return gcalRequest('POST', eventsUrl(deps.calendarId), buildEventResource(input), deps)
}

/** Update (patch) an existing calendar event (write-reversible). Never throws. */
export async function updateCalendarEvent(
  eventId: string,
  patch: Partial<CalendarEventInput>,
  deps: GcalDeps = {}
): Promise<GcalResult> {
  if (!eventId) return { ok: false, error: 'an eventId is required to update an event' }
  const resource = buildEventPatch(patch)
  const suppressed = attendeeClearSuppressed(patch)
  const notices: string[] = []
  if (suppressed) notices.push(ATTENDEE_CLEAR_NOTICE)

  // TRACEABILITY — a patch that BLANKS hand-written text (summary/description/location)
  // is allowed (the vault/calendar may legitimately be edited) but never silent: the
  // prior value is read and journalled BEFORE the destructive PATCH, so the erasure is
  // recoverable and stamped with what changed, when and where the old text went. If the
  // snapshot cannot be taken, the clearing fields are DROPPED rather than destroyed
  // unrecorded — the same preserve-and-explain shape as the attendee guard above.
  const clearing = textClearFields(patch)
  if (clearing.length > 0) {
    const prior = await readPriorFields(eventId, clearing, deps)
    if (prior.ok) {
      ;(deps.journal ?? defaultFieldClearJournal)({
        eventId,
        calendarId: deps.calendarId ?? 'primary',
        at: new Date().toISOString(),
        prior: prior.prior,
        reason: 'explicit-empty-string'
      })
      notices.push(textClearNotice(clearing, prior.prior))
    } else {
      for (const f of clearing) delete resource[f]
      notices.push(textClearUnsnapshottableNotice(clearing, prior.error))
    }
  }

  const notice = notices.length > 0 ? notices.join(' ') : undefined
  if (Object.keys(resource).length === 0) {
    // A patch that consisted ONLY of a suppressed change (empty attendee list, or an
    // unsnapshottable clear) reaches here: nothing is sent, and the caller is told why
    // rather than being told "no fields".
    return {
      ok: false,
      error: notice ? `no fields to update were provided. ${notice}` : 'no fields to update were provided'
    }
  }
  const r = await gcalRequest('PATCH', eventUrl(eventId, deps.calendarId), resource, deps)
  return notice ? { ...r, notice } : r
}

/** Delete a calendar event (IRREVERSIBLE — gated + operator-approved above). Never throws. */
export async function deleteCalendarEvent(eventId: string, deps: GcalDeps = {}): Promise<GcalResult> {
  if (!eventId) return { ok: false, error: 'an eventId is required to delete an event' }
  return gcalRequest('DELETE', eventUrl(eventId, deps.calendarId), null, deps)
}
