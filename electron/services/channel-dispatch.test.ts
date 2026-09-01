import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChannelAdapter } from './channels/channel-adapter'

// channelDispatch routes {kind,target} to OS push / a ChannelAdapter / the Feishu
// fallback. We mock every downstream so the routing decision is tested in
// isolation — no electron, no lark-cli, no live channel.

const pushNotification = vi.fn()
const getChannel = vi.fn()
const sendFeishuMessage = vi.fn()
const sendGmail = vi.fn()

vi.mock('./notifications-service', () => ({
  pushNotification: (...args: unknown[]) => pushNotification(...args)
}))
vi.mock('./channels/index', () => ({
  getChannel: (id: string) => getChannel(id)
}))
vi.mock('./brain/feishu-comms-native', () => ({
  sendFeishuMessage: (...args: unknown[]) => sendFeishuMessage(...args)
}))
vi.mock('./lark-exec', () => ({ larkExec: () => async () => ({ stdout: '', stderr: '', code: 0 }) }))
vi.mock('./output/gmail-send', () => ({
  sendGmail: (...args: unknown[]) => sendGmail(...args)
}))

import { channelDispatch, deriveSubject } from './channel-dispatch'

function fakeAdapter(over: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    id: 'x',
    label: 'X',
    isConfigured: () => true,
    start: async () => {},
    stop: async () => {},
    send: vi.fn(async () => {}),
    authorizeUser: async () => 'approved',
    ...over
  }
}

beforeEach(() => {
  pushNotification.mockReset()
  getChannel.mockReset()
  sendFeishuMessage.mockReset()
  sendGmail.mockReset()
})

describe('channelDispatch', () => {
  it('routes push/os/notification kinds to an OS notification', async () => {
    pushNotification.mockReturnValue({ shown: true })
    for (const kind of ['push', 'os', 'notification', 'notify']) {
      const r = await channelDispatch({ kind, target: '' }, 'hi')
      expect(r).toEqual({ ok: true, kind, error: undefined })
    }
    expect(pushNotification).toHaveBeenCalledTimes(4)
    expect(pushNotification).toHaveBeenLastCalledWith({ title: 'DUIN', body: 'hi' })
    expect(getChannel).not.toHaveBeenCalled()
  })

  it('reports push failure reason', async () => {
    pushNotification.mockReturnValue({ shown: false, reason: 'notifications unsupported' })
    const r = await channelDispatch({ kind: 'push', target: '' }, 'hi')
    expect(r).toEqual({ ok: false, kind: 'push', error: 'notifications unsupported' })
  })

  it('routes a registered channel through adapter.send(target, text)', async () => {
    const send = vi.fn(async () => {})
    getChannel.mockReturnValue(fakeAdapter({ id: 'telegram', send }))
    const r = await channelDispatch({ kind: 'telegram', target: 'u123' }, 'ping')
    expect(getChannel).toHaveBeenCalledWith('telegram')
    expect(send).toHaveBeenCalledWith('u123', 'ping')
    expect(r).toEqual({ ok: true, kind: 'telegram' })
    expect(sendFeishuMessage).not.toHaveBeenCalled()
  })

  it('refuses an unconfigured channel without sending', async () => {
    const send = vi.fn(async () => {})
    getChannel.mockReturnValue(fakeAdapter({ id: 'discord', isConfigured: () => false, send }))
    const r = await channelDispatch({ kind: 'discord', target: 'c1' }, 'ping')
    expect(send).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not configured/)
  })

  it('falls back to sendFeishuMessage when no feishu adapter is registered', async () => {
    getChannel.mockReturnValue(undefined)
    sendFeishuMessage.mockResolvedValue({ ok: true, to: 'Theo' })
    const r = await channelDispatch({ kind: 'feishu', target: 'Theo' }, 'yo')
    expect(sendFeishuMessage).toHaveBeenCalledWith('Theo', 'yo', false, expect.any(Object))
    expect(r).toEqual({ ok: true, kind: 'feishu', error: undefined })
  })

  it('surfaces a feishu send error', async () => {
    getChannel.mockReturnValue(undefined)
    sendFeishuMessage.mockResolvedValue({ ok: false, error: 'no chat' })
    const r = await channelDispatch({ kind: 'feishu', target: 'Nobody' }, 'yo')
    expect(r).toEqual({ ok: false, kind: 'feishu', error: 'no chat' })
  })

  it('errors on an unknown channel kind', async () => {
    getChannel.mockReturnValue(undefined)
    const r = await channelDispatch({ kind: 'carrier-pigeon', target: '' }, 'yo')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/unknown channel kind: carrier-pigeon/)
  })

  it('rejects an empty message before any dispatch', async () => {
    const r = await channelDispatch({ kind: 'push', target: '' }, '   ')
    expect(r).toEqual({ ok: false, kind: 'push', error: 'empty message' })
    expect(pushNotification).not.toHaveBeenCalled()
  })

  it('normalizes kind casing/whitespace', async () => {
    pushNotification.mockReturnValue({ shown: true })
    const r = await channelDispatch({ kind: '  Push  ', target: '' }, 'hi')
    expect(r.ok).toBe(true)
    expect(r.kind).toBe('push')
  })

  it('routes an email/gmail kind to sendGmail with attachments', async () => {
    sendGmail.mockResolvedValue({ ok: true, id: 'm1' })
    const r = await channelDispatch(
      { kind: 'email', target: 'a@b.com' },
      'Body here',
      { attachments: ['/tmp/report.pdf'], subject: 'Q3', html: true, cc: 'c@d.com' }
    )
    expect(sendGmail).toHaveBeenCalledWith(
      'a@b.com',
      'Q3',
      'Body here',
      { html: true, cc: 'c@d.com', attachments: ['/tmp/report.pdf'] }
    )
    expect(r).toEqual({ ok: true, kind: 'email', error: undefined })
    expect(pushNotification).not.toHaveBeenCalled()
  })

  it('derives the email subject from the body when none is given', async () => {
    sendGmail.mockResolvedValue({ ok: true, id: 'm2' })
    await channelDispatch({ kind: 'gmail', target: 'a@b.com' }, 'First line\nSecond line')
    expect(sendGmail).toHaveBeenCalledWith(
      'a@b.com',
      'First line',
      'First line\nSecond line',
      expect.objectContaining({ attachments: [] })
    )
  })

  it('refuses an email with no recipient', async () => {
    const r = await channelDispatch({ kind: 'email', target: '' }, 'hi')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/recipient/)
    expect(sendGmail).not.toHaveBeenCalled()
  })

  it('surfaces a gmail send failure', async () => {
    sendGmail.mockResolvedValue({ ok: false, error: 'Google not connected' })
    const r = await channelDispatch({ kind: 'email', target: 'a@b.com' }, 'hi')
    expect(r).toEqual({ ok: false, kind: 'email', error: 'Google not connected' })
  })

  it('uses adapter.sendFile when attachments are present and supported', async () => {
    const send = vi.fn(async () => {})
    const sendFile = vi.fn(async () => {})
    getChannel.mockReturnValue(fakeAdapter({ id: 'telegram', send, sendFile }))
    const r = await channelDispatch({ kind: 'telegram', target: 'u1' }, 'here', {
      attachments: ['/tmp/a.pdf']
    })
    expect(sendFile).toHaveBeenCalledWith('u1', 'here', ['/tmp/a.pdf'])
    expect(send).not.toHaveBeenCalled()
    expect(r).toEqual({ ok: true, kind: 'telegram' })
  })

  it('falls back to send() when the adapter cannot carry files', async () => {
    const send = vi.fn(async () => {})
    getChannel.mockReturnValue(fakeAdapter({ id: 'telegram', send })) // no sendFile
    const r = await channelDispatch({ kind: 'telegram', target: 'u1' }, 'here', {
      attachments: ['/tmp/a.pdf']
    })
    expect(send).toHaveBeenCalledWith('u1', 'here')
    expect(r).toEqual({ ok: true, kind: 'telegram' })
  })
})

describe('deriveSubject', () => {
  it('prefers an explicit subject', () => {
    expect(deriveSubject('body', 'Explicit')).toBe('Explicit')
  })
  it('uses the first non-empty body line', () => {
    expect(deriveSubject('\n\n  Hello world\nmore')).toBe('Hello world')
  })
  it('truncates a very long first line', () => {
    const long = 'x'.repeat(200)
    const s = deriveSubject(long)
    expect(s.length).toBeLessThanOrEqual(120)
    expect(s.endsWith('…')).toBe(true)
  })
  it('falls back to a default for an empty body', () => {
    expect(deriveSubject('   ')).toBe('Message from DUIN')
  })
})

// ── backlog findings 33 + 34 ────────────────────────────────────────────────

describe('adapter delivery is reported honestly (finding 33)', () => {
  it('a throwing send is reported as a failure, not as delivered', async () => {
    // The adapter contract has no result type: resolving means delivered, failing
    // means throwing. This branch returned `{ ok: true }` unconditionally, and all
    // three shipped adapters swallowed their own errors and returned — so a bad
    // token / rate limit / blocked bot reported as delivered and every caller's
    // retry logic was dead code.
    const adapter = fakeAdapter({
      send: vi.fn(async () => {
        throw new Error('telegram sendMessage failed: bot was blocked by the user')
      })
    })
    getChannel.mockReturnValue(adapter)
    const r = await channelDispatch({ kind: 'telegram', target: 'u1' }, 'hi')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/blocked by the user/)
  })

  it('a clean resolve is still reported as delivered', async () => {
    const adapter = fakeAdapter({ send: vi.fn(async () => {}) })
    getChannel.mockReturnValue(adapter)
    expect((await channelDispatch({ kind: 'telegram', target: 'u1' }, 'hi')).ok).toBe(true)
  })

  it('a throwing sendFile is reported as a failure too', async () => {
    const adapter = fakeAdapter({
      sendFile: vi.fn(async () => {
        throw new Error('upload rejected')
      })
    })
    getChannel.mockReturnValue(adapter)
    const r = await channelDispatch({ kind: 'telegram', target: 'u1' }, 'hi', {
      attachments: ['C:/tmp/a.txt']
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/upload rejected/)
  })
})

describe('egress readiness is asked separately from inbound readiness (finding 34)', () => {
  it('sends when canSend() is true even though isConfigured() is false', async () => {
    // Feishu's isConfigured() means "is there an INBOUND watchlist". Gating egress on
    // it refused every outbound Feishu delivery on any install without one — the
    // common outbound-only case — with "channel feishu is not configured", while the
    // same send mechanism worked.
    const send = vi.fn(async () => {})
    getChannel.mockReturnValue(fakeAdapter({ isConfigured: () => false, canSend: () => true, send }))
    const r = await channelDispatch({ kind: 'feishu', target: 'Alice' }, 'hi')
    expect(r.ok).toBe(true)
    expect(send).toHaveBeenCalledWith('Alice', 'hi')
  })

  it('still refuses when canSend() says no', async () => {
    const send = vi.fn(async () => {})
    getChannel.mockReturnValue(fakeAdapter({ isConfigured: () => true, canSend: () => false, send }))
    const r = await channelDispatch({ kind: 'feishu', target: 'Alice' }, 'hi')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not configured/)
    expect(send).not.toHaveBeenCalled()
  })

  it('falls back to isConfigured() for adapters that do not define canSend', async () => {
    // telegram/discord: one credential governs both directions, so today's answer stands.
    const send = vi.fn(async () => {})
    getChannel.mockReturnValue(fakeAdapter({ isConfigured: () => false, send }))
    const r = await channelDispatch({ kind: 'telegram', target: 'u1' }, 'hi')
    expect(r.ok).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})
