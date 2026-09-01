import { describe, it, expect } from 'vitest'
import {
  mapSlackMessages,
  mapCalendarEvents,
  mapGmailMessages,
  gmailBodyText,
  GMAIL_BODY_MAX_CHARS,
  collectNotionBlocks,
  mapFeishuMessages,
  mapNotionPages,
  notionPageTitle,
  notionBlocksText,
  mapRssItems,
  parseRssXml,
  gmailQuery,
  slackOldest,
  calendarTimeMin
} from './source-adapters'
import { synthNoteText } from '../local-brain/index-store'

describe('mapSlackMessages', () => {
  it('maps messages → dated IngestDocs, drops empty', () => {
    const docs = mapSlackMessages(
      [
        { ts: '1700000000.000100', text: 'shipping Friday', user: 'U1' },
        { ts: '1700000100.000200', text: '   ', user: 'U2' } // empty → dropped
      ],
      'general'
    )
    expect(docs.length).toBe(1)
    expect(docs[0].id).toBe('general-1700000000.000100')
    expect(docs[0].text).toBe('shipping Friday')
    expect(docs[0].title).toBe('#general')
    expect(docs[0].kind).toBe('event')
    expect(docs[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(docs[0].people).toEqual(['U1'])
  })
})

describe('mapCalendarEvents', () => {
  it('maps events → dated event docs with attendees, drops untitled', () => {
    const docs = mapCalendarEvents([
      {
        id: 'evt1',
        summary: 'Launch review',
        description: 'go/no-go',
        start: { dateTime: '2026-07-01T10:00:00Z' },
        attendees: [{ displayName: 'Alice' }, { email: 'bob@x.com' }],
        htmlLink: 'https://cal/evt1'
      },
      { id: 'evt2', summary: '', start: { date: '2026-07-02' } } // no summary → dropped
    ])
    expect(docs.length).toBe(1)
    expect(docs[0].id).toBe('evt1')
    expect(docs[0].date).toBe('2026-07-01')
    expect(docs[0].kind).toBe('event')
    expect(docs[0].people).toEqual(['Alice', 'bob@x.com'])
    expect(docs[0].url).toBe('https://cal/evt1')
  })
  it('handles all-day events (start.date)', () => {
    const docs = mapCalendarEvents([{ id: 'e', summary: 'Holiday', start: { date: '2026-12-25' } }])
    expect(docs[0].date).toBe('2026-12-25')
  })
})

describe('mapGmailMessages', () => {
  it('maps messages → docs using subject + snippet + from, drops id-less', () => {
    const docs = mapGmailMessages([
      {
        id: 'm1',
        snippet: 'Please review the <b>deck</b> before Monday',
        internalDate: '1700000000000',
        payload: {
          headers: [
            { name: 'Subject', value: 'Deck review' },
            { name: 'From', value: 'boss@x.com' }
          ]
        }
      },
      { snippet: 'no id' } as never // no id → dropped
    ])
    expect(docs.length).toBe(1)
    expect(docs[0].id).toBe('m1')
    expect(docs[0].title).toBe('Deck review')
    expect(docs[0].text).toContain('Deck review')
    expect(docs[0].text).toContain('Please review the deck before Monday') // html stripped
    expect(docs[0].people).toEqual(['boss@x.com'])
    expect(docs[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('mapFeishuMessages', () => {
  const chat = { name: 'Theo （工作）', id: 'oc_123' }
  it('maps messages → dated event docs, renders content via feishuText, drops placeholders', () => {
    const docs = mapFeishuMessages(
      [
        { message_id: 'm1', msg_type: 'text', content: JSON.stringify({ text: 'ship it Friday' }), create_time: '1700000000000', sender: { id: 'ou_a' } },
        { message_id: 'm2', msg_type: 'image', content: '', create_time: '1700000100000', sender: { id: 'ou_b' } } // → "[image]" placeholder → dropped
      ],
      chat
    )
    expect(docs.length).toBe(1)
    expect(docs[0].id).toBe('oc_123-m1')
    expect(docs[0].text).toBe('ship it Friday')
    expect(docs[0].title).toBe('Theo （工作）')
    expect(docs[0].kind).toBe('event')
    expect(docs[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(docs[0].people).toEqual(['ou_a'])
  })
  it('honors sinceMs — drops messages older than the backfill floor', () => {
    const msgs = [
      { message_id: 'old', msg_type: 'text', content: JSON.stringify({ text: 'last month' }), create_time: '1600000000000' },
      { message_id: 'new', msg_type: 'text', content: JSON.stringify({ text: 'today' }), create_time: '1700000000000' }
    ]
    const docs = mapFeishuMessages(msgs, chat, 1650000000000)
    expect(docs.map((d) => d.id)).toEqual(['oc_123-new'])
  })
})

describe('notionPageTitle + notionBlocksText', () => {
  it('extracts the title property plain_text', () => {
    const t = notionPageTitle({
      id: 'p',
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'Q3 ' }, { plain_text: 'Roadmap' }] },
        Status: { type: 'select' }
      }
    })
    expect(t).toBe('Q3 Roadmap')
  })
  it('joins rich_text across supported block types, skips unknown', () => {
    const text = notionBlocksText([
      { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'hello ' }, { plain_text: 'world' }] } },
      { type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Title' }] } },
      { type: 'image', image: {} }, // no rich_text → skipped
      { type: 'divider' } // unknown/empty → skipped
    ])
    expect(text).toBe('hello world\nTitle')
  })
})

describe('mapNotionPages', () => {
  const pages = [
    {
      id: 'p1',
      url: 'https://notion/p1',
      last_edited_time: '2026-07-01T12:00:00.000Z',
      properties: { Name: { type: 'title', title: [{ plain_text: 'Launch plan' }] } }
    },
    { id: '', properties: {} } // id-less → dropped
  ] as Parameters<typeof mapNotionPages>[0]
  it('maps pages → note docs with title + block body, drops id-less', () => {
    const docs = mapNotionPages(pages, { p1: 'body line one\nbody line two' })
    expect(docs.length).toBe(1)
    expect(docs[0].id).toBe('p1')
    expect(docs[0].title).toBe('Launch plan')
    expect(docs[0].text).toContain('Launch plan')
    expect(docs[0].text).toContain('body line one')
    expect(docs[0].date).toBe('2026-07-01')
    expect(docs[0].kind).toBe('note')
    expect(docs[0].url).toBe('https://notion/p1')
  })
  it('falls back to (untitled) and honors sinceMs on last_edited_time', () => {
    const docs = mapNotionPages(
      [
        { id: 'a', last_edited_time: '2026-01-01T00:00:00.000Z', properties: {} },
        { id: 'b', last_edited_time: '2026-07-01T00:00:00.000Z', properties: {} }
      ],
      {},
      Date.parse('2026-06-01T00:00:00.000Z')
    )
    expect(docs.map((d) => d.id)).toEqual(['b'])
    expect(docs[0].title).toBe('(untitled)')
  })
})

describe('parseRssXml + mapRssItems', () => {
  const rss = `<?xml version="1.0"?><rss><channel>
    <item><title>First post</title><link>https://blog/1</link>
      <description><![CDATA[<p>Hello &amp; welcome</p>]]></description>
      <pubDate>Wed, 01 Jul 2026 10:00:00 GMT</pubDate><guid>g-1</guid></item>
    <item><title>Second</title><link>https://blog/2</link><description>plain</description>
      <pubDate>Tue, 01 Jul 2025 10:00:00 GMT</pubDate></item>
  </channel></rss>`
  const atom = `<feed><entry><title>Atom entry</title>
    <link href="https://site/a"/><summary>an atom summary</summary>
    <updated>2026-07-02T00:00:00Z</updated><id>urn:a</id></entry></feed>`

  it('parses RSS items (CDATA + entities stripped)', () => {
    const items = parseRssXml(rss)
    expect(items.length).toBe(2)
    expect(items[0].title).toBe('First post')
    expect(items[0].link).toBe('https://blog/1')
    expect(items[0].summary).toBe('Hello & welcome')
    expect(items[0].id).toBe('g-1')
  })
  it('parses Atom entries (href link + summary + id)', () => {
    const items = parseRssXml(atom)
    expect(items.length).toBe(1)
    expect(items[0].title).toBe('Atom entry')
    expect(items[0].link).toBe('https://site/a')
    expect(items[0].summary).toBe('an atom summary')
    expect(items[0].id).toBe('urn:a')
  })
  it('maps items → note docs with url + date', () => {
    const docs = mapRssItems(parseRssXml(rss), 'https://blog/feed')
    expect(docs.length).toBe(2)
    expect(docs[0].id).toBe('g-1')
    expect(docs[0].title).toBe('First post')
    expect(docs[0].text).toContain('Hello & welcome')
    expect(docs[0].kind).toBe('note')
    expect(docs[0].url).toBe('https://blog/1')
    expect(docs[0].date).toBe('2026-07-01')
  })
  it('honors sinceMs — drops items published before the floor', () => {
    const docs = mapRssItems(parseRssXml(rss), 'f', Date.parse('2026-01-01T00:00:00Z'))
    expect(docs.map((d) => d.title)).toEqual(['First post']) // the 2025 item is dropped
  })
})

describe('sinceMs → per-source query params', () => {
  it('gmailQuery uses after: when backfilling, else the rolling window', () => {
    expect(gmailQuery()).toBe('newer_than:14d -in:spam')
    expect(gmailQuery(0)).toBe('newer_than:14d -in:spam')
    expect(gmailQuery(1_700_000_000_000)).toBe('after:1700000000 -in:spam')
  })
  it('slackOldest is epoch-seconds when set, else empty', () => {
    expect(slackOldest()).toBe('')
    expect(slackOldest(1_700_000_000_000)).toBe('1700000000')
  })
  it('calendarTimeMin is the floor when set, else 30d back', () => {
    const now = Date.parse('2026-07-01T00:00:00.000Z')
    expect(calendarTimeMin(Date.parse('2026-06-15T00:00:00.000Z'), now)).toBe('2026-06-15T00:00:00.000Z')
    expect(calendarTimeMin(undefined, now)).toBe('2026-06-01T00:00:00.000Z') // 30d before
  })
})

describe('synthNoteText', () => {
  it('prepends frontmatter (type/date/tags/url) + H1 so graph-derive types it', () => {
    const t = synthNoteText(
      { id: 'x', text: 'body here', title: 'Launch review', date: '2026-07-01', kind: 'event', people: ['Alice'], url: 'https://u' },
      'gcal'
    )
    expect(t).toMatch(/^---\n/)
    expect(t).toContain('type: event')
    expect(t).toContain('date: 2026-07-01')
    expect(t).toContain('tags: [gcal, Alice]')
    expect(t).toContain('url: https://u')
    expect(t).toContain('# Launch review')
    expect(t).toContain('body here')
  })
  it('omits absent fields and the H1 when no title', () => {
    const t = synthNoteText({ id: 'x', text: 'just text' }, 'slack')
    expect(t).toContain('tags: [slack]')
    expect(t).not.toContain('type:')
    expect(t).not.toContain('# ')
    expect(t).toContain('just text')
  })
})

// --------------- Gmail: the BODY, which was never ingested at all ---------------
// The adapter requested `format=metadata`, which by definition cannot return a body, and
// then read only `snippet`. Every ingested email was a subject plus Gmail's ~150-char
// server preview, stored as a complete note - the decision, the number and the ask were
// permanently unindexed, and nothing said so.
const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')

describe('gmailBodyText', () => {
  it('decodes a base64url text/plain body', () => {
    expect(gmailBodyText({ mimeType: 'text/plain', body: { data: b64url('The budget is 920.') } }))
      .toBe('The budget is 920.')
  })

  it('walks a nested multipart tree - the ordinary shape of real mail', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64url('plain wins') } },
            { mimeType: 'text/html', body: { data: b64url('<p>html loses</p>') } }
          ]
        }
      ]
    }
    const out = gmailBodyText(payload)
    expect(out).toBe('plain wins')
    // The two are alternative renderings of the SAME body - indexing both would duplicate it.
    expect(out).not.toContain('html loses')
  })

  it('falls back to tag-stripped HTML when no plain part carried content', () => {
    const out = gmailBodyText({
      mimeType: 'multipart/alternative',
      parts: [{ mimeType: 'text/html', body: { data: b64url('<p>Decision: <b>ship it</b></p>') } }]
    })
    expect(out).toContain('Decision: ship it')
    expect(out).not.toContain('<b>')
  })

  it('skips attachments - their bytes are behind attachmentId, and a PDF is not text', () => {
    const out = gmailBodyText({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('see attached') } },
        { mimeType: 'application/pdf', body: { attachmentId: 'att-1', size: 900000 } }
      ]
    })
    expect(out).toBe('see attached')
  })

  it('is empty, not throwing, for undecodable or absent payloads', () => {
    expect(gmailBodyText(undefined)).toBe('')
    expect(gmailBodyText({ mimeType: 'text/plain', body: {} })).toBe('')
  })
})

describe('mapGmailMessages - body ingestion', () => {
  it('indexes the BODY, not the 150-char snippet', () => {
    const body = 'Approved 920 for the BW booth. Kill the 4399 track.'
    const docs = mapGmailMessages([
      {
        id: 'm9',
        snippet: 'Approved 920 for the BW boo',
        internalDate: '1700000000000',
        payload: {
          headers: [{ name: 'Subject', value: 'Budget' }, { name: 'From', value: 'boss@x.com' }],
          mimeType: 'text/plain',
          body: { data: b64url(body) }
        }
      }
    ])
    expect(docs[0].text).toContain('Kill the 4399 track.') // past where the snippet ended
    expect(docs[0].text).toContain('Budget')
  })

  it('still falls back to the snippet when a body genuinely does not decode', () => {
    const docs = mapGmailMessages([
      { id: 'm10', snippet: 'preview only', payload: { headers: [{ name: 'Subject', value: 'S' }] } }
    ])
    expect(docs[0].text).toContain('preview only')
  })

  it('bounds a very long body, and says it elided rather than cutting silently', () => {
    const huge = 'x'.repeat(GMAIL_BODY_MAX_CHARS * 3)
    const docs = mapGmailMessages([
      {
        id: 'm11',
        payload: {
          headers: [{ name: 'Subject', value: 'Long' }],
          mimeType: 'text/plain',
          body: { data: b64url(huge) }
        }
      }
    ])
    expect(docs[0].text.length).toBeLessThan(GMAIL_BODY_MAX_CHARS + 200)
    expect(docs[0].text).toContain('elided from the middle')
  })
})

// --------------- Notion: blocks 51+ never existed locally ---------------
describe('collectNotionBlocks', () => {
  const para = (id: string, text: string, hasChildren = false) => ({
    id,
    type: 'paragraph',
    has_children: hasChildren,
    paragraph: { rich_text: [{ plain_text: text }] }
  })

  it('follows the cursor - a page is no longer just its first screenful', async () => {
    const calls: Array<string | undefined> = []
    const blocks = await collectNotionBlocks('root', async (_id, cursor) => {
      calls.push(cursor)
      if (!cursor) return { results: [para('a', 'first')], has_more: true, next_cursor: 'c1' }
      if (cursor === 'c1') return { results: [para('b', 'second')], has_more: true, next_cursor: 'c2' }
      return { results: [para('c', 'third')], has_more: false, next_cursor: null }
    })
    expect(blocks.map((b) => b.id)).toEqual(['a', 'b', 'c'])
    expect(calls).toEqual([undefined, 'c1', 'c2'])
  })

  it('descends into children, and keeps them in document order', async () => {
    const blocks = await collectNotionBlocks('root', async (id) => {
      if (id === 'root') {
        return {
          results: [para('p1', 'before'), para('toggle', 'toggle', true), para('p2', 'after')],
          has_more: false,
          next_cursor: null
        }
      }
      if (id === 'toggle') {
        return { results: [para('inner', 'hidden inside')], has_more: false, next_cursor: null }
      }
      return { results: [], has_more: false, next_cursor: null }
    })
    // A child belongs immediately after its parent, not after the whole page.
    expect(blocks.map((b) => b.id)).toEqual(['p1', 'toggle', 'inner', 'p2'])
    expect(notionBlocksText(blocks)).toContain('hidden inside')
  })

  it('respects the total block budget across pagination', async () => {
    const blocks = await collectNotionBlocks(
      'root',
      async () => ({
        results: [para('x', 'x'), para('y', 'y'), para('z', 'z')],
        has_more: true,
        next_cursor: 'next'
      }),
      { maxBlocks: 5 }
    )
    expect(blocks.length).toBeLessThanOrEqual(5)
  })

  it('keeps what it already collected when a later request fails', async () => {
    let n = 0
    const blocks = await collectNotionBlocks('root', async () => {
      n++
      if (n === 1) return { results: [para('kept', 'kept')], has_more: true, next_cursor: 'c1' }
      return null // request failed
    })
    expect(blocks.map((b) => b.id)).toEqual(['kept'])
  })

  it('does not recurse forever on a self-referencing tree', async () => {
    const blocks = await collectNotionBlocks(
      'root',
      async () => ({ results: [para('loop', 'loop', true)], has_more: false, next_cursor: null }),
      { maxBlocks: 50 }
    )
    expect(blocks.length).toBeLessThanOrEqual(50)
  })
})
