import { describe, it, expect, vi } from 'vitest'
import {
  normalizeEventDateTime,
  buildEventResource,
  buildEventPatch,
  attendeeClearSuppressed,
  textClearFields,
  eventsUrl,
  eventUrl,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  type FetchLike
} from './gcal-write'

// Pure request-shaping + mocked-fetch tests. No live Google token: `token` and
// `fetchFn` are injected so nothing touches the network or the keychain.

describe('normalizeEventDateTime', () => {
  it('treats a YYYY-MM-DD string as an all-day date', () => {
    expect(normalizeEventDateTime('2026-07-20')).toEqual({ date: '2026-07-20' })
  })
  it('treats any other string as a timed dateTime, carrying the timeZone', () => {
    expect(normalizeEventDateTime('2026-07-20T15:00:00+08:00', 'Asia/Shanghai')).toEqual({
      dateTime: '2026-07-20T15:00:00+08:00',
      timeZone: 'Asia/Shanghai'
    })
  })
  it('passes an object endpoint through, filling timeZone only when absent', () => {
    expect(normalizeEventDateTime({ dateTime: 'x' }, 'UTC')).toEqual({ dateTime: 'x', timeZone: 'UTC' })
    expect(normalizeEventDateTime({ dateTime: 'x', timeZone: 'PST' }, 'UTC')).toEqual({ dateTime: 'x', timeZone: 'PST' })
  })
})

describe('buildEventResource', () => {
  it('shapes the full event and wraps attendees as {email}', () => {
    const r = buildEventResource({
      summary: 'Sync',
      description: 'notes',
      location: 'Room 1',
      start: '2026-07-20T15:00:00+08:00',
      end: '2026-07-20T16:00:00+08:00',
      attendees: ['a@x.com', ' b@y.com '],
      timeZone: 'Asia/Shanghai'
    })
    expect(r).toEqual({
      summary: 'Sync',
      description: 'notes',
      location: 'Room 1',
      start: { dateTime: '2026-07-20T15:00:00+08:00', timeZone: 'Asia/Shanghai' },
      end: { dateTime: '2026-07-20T16:00:00+08:00', timeZone: 'Asia/Shanghai' },
      attendees: [{ email: 'a@x.com' }, { email: 'b@y.com' }]
    })
  })
  it('omits empty attendees and untouched fields', () => {
    const r = buildEventResource({ summary: 'x', start: '2026-01-01', end: '2026-01-02' })
    expect(r).toEqual({ summary: 'x', start: { date: '2026-01-01' }, end: { date: '2026-01-02' } })
    expect(r.attendees).toBeUndefined()
  })
})

describe('buildEventPatch', () => {
  it('includes only provided fields (partial update)', () => {
    expect(buildEventPatch({ summary: 'new title' })).toEqual({ summary: 'new title' })
  })
  it('is empty for an empty patch', () => {
    expect(buildEventPatch({})).toEqual({})
  })
  it('writes a non-empty attendee roster as {email} entries', () => {
    expect(buildEventPatch({ attendees: ['a@x.com', ' b@y.com '] })).toEqual({
      attendees: [{ email: 'a@x.com' }, { email: 'b@y.com' }]
    })
  })

  // REGRESSION — data loss. Google reads `attendees: []` in a PATCH as a FULL
  // REPLACEMENT: every guest is removed and mailed a cancellation, and their RSVP
  // state (server-side only, never snapshotted here) is gone. So an *inferred*
  // empty list must be omitted, exactly as buildEventResource already does.
  // The production path that produces each of these:
  //   null      → tool-schema-validator treats null as "missing" but keeps the key,
  //               act-tool-pack's `args.attendees !== undefined` is true, strList → []
  //   []        → the model emits an explicit empty array
  //   ['', ' '] → a garbage/paraphrased reply, laundered by filter(Boolean) into []
  it.each([
    ['null', null as unknown as string[]],
    ['an empty array', []],
    ['blank-only entries', ['', '  ']]
  ])('omits attendees rather than emitting a guest-wiping [] for %s', (_label, attendees) => {
    const r = buildEventPatch({ start: '2026-07-20T16:00:00Z', attendees })
    expect(r.attendees).toBeUndefined()
    expect('attendees' in r).toBe(false)
    expect(r).toEqual({ start: { dateTime: '2026-07-20T16:00:00Z' } })
  })
})

// REGRESSION — data loss. `{description: null}` is the common LLM spelling of "leave
// this alone", and tool-schema-validator BLESSES it (null == missing) without stripping
// the key. buildEventPatch must therefore treat null as ABSENT for every field, exactly
// as it already did for `attendees` — otherwise the key survives into the PATCH body and
// Google overwrites the user's hand-written text with ''.
describe('buildEventPatch — null means "not provided", for every field', () => {
  it.each(['summary', 'description', 'location', 'start', 'end'] as const)(
    'omits %s entirely when it is null, rather than emitting an erasing value',
    (field) => {
      const r = buildEventPatch({ start: '2026-07-21T16:00:00+08:00', [field]: null } as never)
      expect(field in r).toBe(false)
    }
  )
  it('keeps the reschedule while dropping a null description (the live scenario)', () => {
    expect(
      buildEventPatch({
        start: '2026-07-21T16:00:00+08:00',
        description: null as unknown as string,
        location: null as unknown as string,
        summary: null as unknown as string
      })
    ).toEqual({ start: { dateTime: '2026-07-21T16:00:00+08:00' } })
  })
  it('still honours a DELIBERATE empty-string clear (null is unchanged, "" is a clear)', () => {
    expect(buildEventPatch({ description: '' })).toEqual({ description: '' })
  })
})

describe('textClearFields', () => {
  it('flags only explicit empty strings, never null/absent/non-empty', () => {
    expect(textClearFields({ description: '', location: '  ' })).toEqual(['description', 'location'])
    expect(textClearFields({ description: null as unknown as string })).toEqual([])
    expect(textClearFields({ description: 'agenda' })).toEqual([])
    expect(textClearFields({})).toEqual([])
  })
})

describe('attendeeClearSuppressed', () => {
  it('flags an inferred-empty attendee list, and only that', () => {
    expect(attendeeClearSuppressed({ attendees: null as unknown as string[] })).toBe(true)
    expect(attendeeClearSuppressed({ attendees: [] })).toBe(true)
    expect(attendeeClearSuppressed({ attendees: ['', ' '] })).toBe(true)
    expect(attendeeClearSuppressed({ attendees: ['a@x.com'] })).toBe(false)
    expect(attendeeClearSuppressed({ summary: 'x' })).toBe(false)
    expect(attendeeClearSuppressed({})).toBe(false)
  })
})

describe('URL builders', () => {
  it('build events + single-event URLs, url-encoding ids', () => {
    expect(eventsUrl()).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events')
    expect(eventUrl('evt 1', 'a@b.com')).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/a%40b.com/events/evt%201'
    )
  })
})

// ──────────────────── mocked-fetch request assembly ────────────────────

function okJson(data: unknown): ReturnType<FetchLike> {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
    json: async () => data
  })
}

describe('createCalendarEvent — POST assembly', () => {
  it('POSTs the event resource with the bearer token to the primary events URL', async () => {
    const fetchFn = vi.fn(() => okJson({ id: 'evt123', htmlLink: 'https://cal/evt123' })) as unknown as FetchLike
    const r = await createCalendarEvent(
      { summary: 'S', start: '2026-07-20T10:00:00Z', end: '2026-07-20T11:00:00Z' },
      { token: 'TOK', fetchFn }
    )
    expect(r).toEqual({ ok: true, id: 'evt123', htmlLink: 'https://cal/evt123' })
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer TOK')
    expect(JSON.parse(init.body).summary).toBe('S')
  })
  it('rejects a call missing start/end without hitting the network', async () => {
    const fetchFn = vi.fn(() => okJson({})) as unknown as FetchLike
    const r = await createCalendarEvent({ summary: 'x' } as never, { token: 'T', fetchFn })
    expect(r.ok).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })
  it('surfaces a 403 with a re-consent hint', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({ ok: false, status: 403, text: async () => 'insufficientPermissions', json: async () => ({}) })
    ) as unknown as FetchLike
    const r = await createCalendarEvent({ summary: 'x', start: '2026-01-01', end: '2026-01-02' }, { token: 'T', fetchFn })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('403')
    expect(r.error).toContain('re-consent')
  })
})

describe('updateCalendarEvent — PATCH assembly', () => {
  it('PATCHes only the provided fields to the single-event URL', async () => {
    const fetchFn = vi.fn(() => okJson({ id: 'e1' })) as unknown as FetchLike
    const r = await updateCalendarEvent('e1', { summary: 'renamed' }, { token: 'T', fetchFn })
    expect(r.ok).toBe(true)
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/e1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ summary: 'renamed' })
  })
  it('refuses an empty patch without a request', async () => {
    const fetchFn = vi.fn(() => okJson({})) as unknown as FetchLike
    const r = await updateCalendarEvent('e1', {}, { token: 'T', fetchFn })
    expect(r.ok).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  // REGRESSION — the live scenario: "move the board review to 4pm" on an 8-guest
  // event, answered with {start,end,attendees:null}. The outbound body must carry
  // the reschedule and NOT an attendees key.
  it('never sends an attendees key when a reschedule carries an inferred-empty list', async () => {
    const fetchFn = vi.fn(() => okJson({ id: 'e1' })) as unknown as FetchLike
    const r = await updateCalendarEvent(
      'e1',
      { start: '2026-07-20T16:00:00Z', end: '2026-07-20T17:00:00Z', attendees: null as unknown as string[] },
      { token: 'T', fetchFn }
    )
    expect(r.ok).toBe(true)
    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse(init.body)
    expect('attendees' in body).toBe(false)
    expect(body).toEqual({
      start: { dateTime: '2026-07-20T16:00:00Z' },
      end: { dateTime: '2026-07-20T17:00:00Z' }
    })
    // The suppression is recorded, not silent.
    expect(r.notice).toContain('guest list was left UNCHANGED')
  })

  it('refuses a lone attendee-clearing patch and says why, without a request', async () => {
    const fetchFn = vi.fn(() => okJson({})) as unknown as FetchLike
    const r = await updateCalendarEvent('e1', { attendees: [] }, { token: 'T', fetchFn })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('guest list was left UNCHANGED')
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('updateCalendarEvent — a narrowing PATCH is snapshotted, never silent', () => {
  it('reads + journals the prior text before PATCHing an explicit clear, and says so', async () => {
    const fetchFn = vi.fn((_url: string, init?: { method?: string }) =>
      init?.method === 'GET' ? okJson({ id: 'e1', description: 'Q3 agenda: 1) budget 2) hiring' }) : okJson({ id: 'e1' })
    ) as unknown as FetchLike
    const journal = vi.fn()
    const r = await updateCalendarEvent('e1', { description: '' }, { token: 'T', fetchFn, journal })

    expect(r.ok).toBe(true)
    // The GET happened FIRST, then the PATCH.
    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0][1].method).toBe('GET')
    expect(calls[1][1].method).toBe('PATCH')
    expect(JSON.parse(calls[1][1].body)).toEqual({ description: '' })
    // What changed, when, and where the prior content went.
    expect(journal).toHaveBeenCalledTimes(1)
    const entry = journal.mock.calls[0][0]
    expect(entry.prior.description).toBe('Q3 agenda: 1) budget 2) hiring')
    expect(entry.eventId).toBe('e1')
    expect(entry.reason).toBe('explicit-empty-string')
    expect(typeof entry.at).toBe('string')
    expect(r.notice).toContain('Q3 agenda')
  })

  it('drops the clearing field rather than destroying text it could not snapshot', async () => {
    const fetchFn = vi.fn((_url: string, init?: { method?: string }) =>
      init?.method === 'GET'
        ? Promise.resolve({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) })
        : okJson({ id: 'e1' })
    ) as unknown as FetchLike
    const journal = vi.fn()
    const r = await updateCalendarEvent(
      'e1',
      { start: '2026-07-21T16:00:00+08:00', description: '' },
      { token: 'T', fetchFn, journal }
    )
    expect(r.ok).toBe(true)
    const patchCall = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[1].method === 'PATCH')!
    const body = JSON.parse(patchCall[1].body)
    expect('description' in body).toBe(false)
    expect(body).toEqual({ start: { dateTime: '2026-07-21T16:00:00+08:00' } })
    expect(journal).not.toHaveBeenCalled()
    expect(r.notice).toContain('Left UNCHANGED')
  })

  // THE DEFECT: the reschedule-with-null-description shape. No GET, no clear, no
  // description key — the agenda survives untouched.
  it('never reads or writes anything for a null description on a reschedule', async () => {
    const fetchFn = vi.fn(() => okJson({ id: 'e1' })) as unknown as FetchLike
    const journal = vi.fn()
    const r = await updateCalendarEvent(
      'e1',
      { start: '2026-07-21T16:00:00+08:00', description: null as unknown as string },
      { token: 'T', fetchFn, journal }
    )
    expect(r.ok).toBe(true)
    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][1].method).toBe('PATCH')
    expect(JSON.parse(calls[0][1].body)).toEqual({ start: { dateTime: '2026-07-21T16:00:00+08:00' } })
    expect(journal).not.toHaveBeenCalled()
  })
})

describe('deleteCalendarEvent — DELETE assembly', () => {
  it('DELETEs the event and treats a 204 (no body) as success', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 204,
        text: async () => '',
        json: async () => {
          throw new Error('no body')
        }
      })
    ) as unknown as FetchLike
    const r = await deleteCalendarEvent('e9', { token: 'T', fetchFn })
    expect(r).toEqual({ ok: true })
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/e9')
    expect(init.method).toBe('DELETE')
  })
  it('requires an eventId', async () => {
    const r = await deleteCalendarEvent('', { token: 'T' })
    expect(r.ok).toBe(false)
  })
})
