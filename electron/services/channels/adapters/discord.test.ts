import { describe, it, expect, vi, afterEach } from 'vitest'

let token: string | null = 'DISCORD-BOT-TOKEN'
vi.mock('../../keychain', () => ({ getKey: () => token }))
vi.mock('../pairing-store', () => ({ authorizeStatus: () => 'approved' }))

import { parseDiscordMessage, createDiscordAdapter } from './discord'

afterEach(() => {
  token = 'DISCORD-BOT-TOKEN'
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('parseDiscordMessage — MESSAGE_CREATE mapping', () => {
  it('maps a human message to an InboundMessage keyed per-channel', () => {
    expect(
      parseDiscordMessage({ id: 'm1', content: 'hi', channel_id: 'c9', author: { id: 'u7' } })
    ).toEqual({ channelId: 'discord', userId: 'u7', threadId: 'dc:c9', text: 'hi' })
  })

  it('DROPS bot messages (prevents the bot echoing its own reply into a loop)', () => {
    expect(
      parseDiscordMessage({ content: 'hi', channel_id: 'c9', author: { id: 'self', bot: true } })
    ).toBeNull()
  })

  it('drops payloads missing content / author / channel', () => {
    expect(parseDiscordMessage({ channel_id: 'c9', author: { id: 'u7' } })).toBeNull() // no content
    expect(parseDiscordMessage({ content: 'hi', channel_id: 'c9' })).toBeNull() // no author
    expect(parseDiscordMessage({ content: 'hi', author: { id: 'u7' } })).toBeNull() // no channel
  })
})

// ── backlog finding 33, at the adapter ──────────────────────────────────────

describe('discord send — resolving must mean delivered', () => {
  // The adapter opens a DM then POSTs. Neither step's outcome was inspected.
  const stubFetch = (dm: unknown, post: { ok: boolean; status?: number }) => {
    let call = 0
    vi.stubGlobal('fetch', async () => {
      call++
      if (call === 1) return { ok: true, status: 200, json: async () => dm } as never
      return { ok: post.ok, status: post.status ?? 200, statusText: '', json: async () => ({}) } as never
    })
  }

  it('throws when the message POST is rejected, instead of reporting a delivery', async () => {
    stubFetch({ id: 'c1' }, { ok: false, status: 403 })
    await expect(createDiscordAdapter().send('u1', 'hi')).rejects.toThrow(/HTTP 403/)
  })

  it('throws when the DM channel cannot be opened', async () => {
    // openDmChannel catches and returns null; send used to `return` on that, which
    // reported a blocked bot or bad user id as a successful delivery.
    stubFetch({}, { ok: true })
    await expect(createDiscordAdapter().send('u-unknown', 'hi')).rejects.toThrow(/could not open a DM/)
  })

  it('throws when there is no bot token', async () => {
    token = null
    stubFetch({ id: 'c1' }, { ok: true })
    await expect(createDiscordAdapter().send('u1', 'hi')).rejects.toThrow(/not configured/)
  })

  it('resolves on a successful send', async () => {
    stubFetch({ id: 'c1' }, { ok: true })
    await expect(createDiscordAdapter().send('u1', 'hi')).resolves.toBeUndefined()
  })
})
