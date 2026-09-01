import { describe, it, expect, vi, afterEach } from 'vitest'

let watch: string | null = 'Alice, Bob'
vi.mock('../../keychain', () => ({ getKey: () => watch }))
vi.mock('../pairing-store', () => ({ authorizeStatus: () => 'approved' }))
// Don't spawn lark-cli during import of the module's default adapter.
vi.mock('../../lark-exec', () => ({ larkExec: () => async () => ({ stdout: '', stderr: '', code: 0 }) }))

const sendFeishuMessage = vi.fn(async () => ({ ok: true }) as { ok: boolean; error?: string })
vi.mock('../../brain/feishu-comms-native', () => ({
  sendFeishuMessage: (...a: unknown[]) => sendFeishuMessage(...(a as [])),
  pullFeishuMessages: vi.fn()
}))

import { parseWatchlist, feishuAwaitingToInbound, createFeishuAdapter } from './feishu'
import type { PullResult } from '../../brain/feishu-comms-native'

afterEach(() => {
  watch = 'Alice, Bob'
  vi.restoreAllMocks()
})

describe('parseWatchlist', () => {
  it('splits on commas/newlines and trims, dropping blanks', () => {
    expect(parseWatchlist('Alice, Bob\n Carol ,')).toEqual(['Alice', 'Bob', 'Carol'])
    expect(parseWatchlist(null)).toEqual([])
    expect(parseWatchlist('   ')).toEqual([])
  })
})

const pull = (over: Partial<PullResult>): PullResult => ({
  ok: true,
  awaiting: true,
  chat: 'Alice',
  chat_id: 'oc_1',
  messages: [{ mine: false, text: 'ping', time: '2000' }],
  ...over
})

describe('feishuAwaitingToInbound — cursored inbound decision', () => {
  it('fires when awaiting and the last message is newer than the cursor', () => {
    expect(feishuAwaitingToInbound(pull({}), '1000')).toEqual({ text: 'ping', time: '2000' })
  })

  it('does NOT fire when not awaiting (last message is ours)', () => {
    const p = pull({ awaiting: false, messages: [{ mine: true, text: 'answered', time: '2000' }] })
    expect(feishuAwaitingToInbound(p, '1000')).toBeNull()
  })

  it('does NOT re-fire when the newest inbound message is at/behind the cursor', () => {
    expect(feishuAwaitingToInbound(pull({}), '2000')).toBeNull() // equal time
    expect(feishuAwaitingToInbound(pull({}), '3000')).toBeNull() // older than cursor
  })

  it('does NOT fire on a failed pull or empty thread', () => {
    expect(feishuAwaitingToInbound(pull({ ok: false }), '0')).toBeNull()
    expect(feishuAwaitingToInbound(pull({ messages: [] }), '0')).toBeNull()
  })

  it('fires on first contact (empty cursor)', () => {
    expect(feishuAwaitingToInbound(pull({}), '')).toEqual({ text: 'ping', time: '2000' })
  })
})

// ── backlog findings 33 + 34, at the adapter ────────────────────────────────

describe('feishu adapter — send reports failure, and egress does not need a watchlist', () => {
  const adapter = () => createFeishuAdapter({ exec: (async () => ({ stdout: '', stderr: '', code: 0 })) as never })

  it('throws when the native send reports a failure (finding 33)', async () => {
    // sendFeishuMessage reports failure in its RETURN value and never throws. The
    // adapter discarded it, so an unknown chat or a logged-out lark-cli travelled up
    // as a delivered message.
    sendFeishuMessage.mockResolvedValueOnce({ ok: false, error: 'no chat matched "Nobody"' })
    await expect(adapter().send('Nobody', 'hi')).rejects.toThrow(/no chat matched/)
  })

  it('resolves when the native send succeeds', async () => {
    sendFeishuMessage.mockResolvedValueOnce({ ok: true })
    await expect(adapter().send('Alice', 'hi')).resolves.toBeUndefined()
  })

  it('canSend() does not require an inbound watchlist, isConfigured() still does (finding 34)', async () => {
    watch = null
    const a = adapter()
    // Inbound: nothing to poll, so the gateway must not start it. Unchanged.
    expect(a.isConfigured()).toBe(false)
    // Egress: needs no watchlist. Gating sends on isConfigured() refused every
    // outbound Feishu delivery on an outbound-only install.
    expect(a.canSend?.()).toBe(true)
  })
})
