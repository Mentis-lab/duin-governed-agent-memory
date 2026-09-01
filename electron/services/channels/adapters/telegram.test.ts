import { describe, it, expect, vi, afterEach } from 'vitest'

// Keychain is Electron-backed; stub it so isConfigured/send can be exercised
// off-Electron and we can flip token presence per test.
let token: string | null = 'BOT-TOKEN'
vi.mock('../../keychain', () => ({ getKey: () => token }))
// Pairing gate — default deny-first; individual tests override.
let authVerdict: 'approved' | 'pending' | 'denied' = 'pending'
vi.mock('../pairing-store', () => ({ authorizeStatus: () => authVerdict }))

import {
  parseTelegramUpdates,
  createTelegramAdapter,
  type TelegramGetUpdates
} from './telegram'

afterEach(() => {
  token = 'BOT-TOKEN'
  authVerdict = 'pending'
  vi.restoreAllMocks()
})

const upd = (id: number, text: string, fromId = 100, chatId = 100): NonNullable<TelegramGetUpdates['result']> => [
  { update_id: id, message: { message_id: id, text, from: { id: fromId }, chat: { id: chatId } } }
]

describe('parseTelegramUpdates — mapping + offset + dedup', () => {
  it('maps text messages to InboundMessages and advances offset past the highest id', () => {
    const body: TelegramGetUpdates = {
      ok: true,
      result: [...upd(5, 'hello'), ...upd(6, 'world', 200, 200)]
    }
    const { messages, nextOffset } = parseTelegramUpdates(body, 0)
    expect(nextOffset).toBe(7) // max(update_id) + 1
    expect(messages).toEqual([
      { channelId: 'telegram', userId: '100', threadId: 'tg:100', text: 'hello' },
      { channelId: 'telegram', userId: '200', threadId: 'tg:200', text: 'world' }
    ])
  })

  it('DEDUP: updates below the requested offset are dropped (already acked)', () => {
    // We already acked through update_id 5 (offset 6); a re-delivery of 5 must
    // not produce a message, but a fresh 7 must.
    const body: TelegramGetUpdates = { ok: true, result: [...upd(5, 'stale'), ...upd(7, 'fresh')] }
    const { messages, nextOffset } = parseTelegramUpdates(body, 6)
    expect(messages.map((m) => m.text)).toEqual(['fresh'])
    expect(nextOffset).toBe(8)
  })

  it('empty result leaves the offset unchanged', () => {
    expect(parseTelegramUpdates({ ok: true, result: [] }, 42)).toEqual({
      messages: [],
      nextOffset: 42
    })
  })

  it('skips non-text / malformed updates (no text, no sender, no chat)', () => {
    const body: TelegramGetUpdates = {
      ok: true,
      result: [
        { update_id: 1, message: { from: { id: 1 }, chat: { id: 1 } } }, // no text
        { update_id: 2, message: { text: 'hi', chat: { id: 1 } } }, // no sender
        { update_id: 3, message: { text: 'hi', from: { id: 1 } } }, // no chat
        { update_id: 4 } // no message at all
      ]
    }
    const { messages, nextOffset } = parseTelegramUpdates(body, 0)
    expect(messages).toEqual([])
    expect(nextOffset).toBe(5) // offset still advances past service updates
  })
})

describe('createTelegramAdapter — config + poll loop wiring', () => {
  it('isConfigured reflects token presence', () => {
    const a = createTelegramAdapter()
    expect(a.isConfigured()).toBe(true)
    token = null
    expect(a.isConfigured()).toBe(false)
  })

  it('start() polls getUpdates and delivers each new message to ctx.onMessage once', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: { body?: string }) => {
      // First poll returns two updates; subsequent polls return nothing so the
      // loop idles (we stop() before its idle backoff elapses).
      const call = fetchMock.mock.calls.length
      const result = call === 1 ? [...upd(5, 'a'), ...upd(6, 'b')] : []
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 })
    })
    const fetchImpl = fetchMock as unknown as typeof fetch

    const seen: string[] = []
    const adapter = createTelegramAdapter({ fetchImpl })
    await adapter.start({ onMessage: async (m) => void seen.push(m.text) })
    // Let the loop run a couple of ticks, then stop.
    await new Promise((r) => setTimeout(r, 20))
    await adapter.stop()

    expect(seen).toEqual(['a', 'b'])
    // The second poll must request offset 7 (deduped past 6) — assert the body.
    const firstBody = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
    expect(firstBody.offset).toBe(0)
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body)
    expect(secondBody.offset).toBe(7)
  })

  it('authorizeUser defers to the pairing gate (deny-first)', async () => {
    const a = createTelegramAdapter()
    authVerdict = 'pending'
    expect(await a.authorizeUser('100')).toBe('pending')
    authVerdict = 'approved'
    expect(await a.authorizeUser('100')).toBe('approved')
  })
})

// ── backlog finding 33, at the adapter ──────────────────────────────────────

describe('telegram send — resolving must mean delivered', () => {
  const jsonFetch = (payload: unknown) =>
    (async () => ({ json: async () => payload })) as unknown as typeof fetch

  it('throws when Telegram answers ok:false, instead of reporting a delivery', async () => {
    // callApi returns res.json() and never inspects it, so a bot blocked by the
    // user / bad chat id / rate limit resolved cleanly and channelDispatch reported
    // `{ ok: true }`. Every caller's retry logic keyed off that.
    const a = createTelegramAdapter({
      fetchImpl: jsonFetch({ ok: false, description: 'Forbidden: bot was blocked by the user' })
    })
    await expect(a.send('100', 'hi')).rejects.toThrow(/blocked by the user/)
  })

  it('throws when there is no bot token, instead of returning silently', async () => {
    token = null
    const a = createTelegramAdapter({ fetchImpl: jsonFetch({ ok: true }) })
    await expect(a.send('100', 'hi')).rejects.toThrow(/not configured/)
  })

  it('resolves on a successful send', async () => {
    const a = createTelegramAdapter({ fetchImpl: jsonFetch({ ok: true, result: {} }) })
    await expect(a.send('100', 'hi')).resolves.toBeUndefined()
  })
})
