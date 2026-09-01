import { describe, it, expect, beforeEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import {
  setPendingInteractionsPath,
  createInteraction,
  resolveByReply,
  sweepExpired,
  pruneInteractions,
  getInteraction,
  listInteractions,
  hasOpenInteraction
} from './pending-interactions'

beforeEach(() => {
  setPendingInteractionsPath(mkdtempSync(join(tmpdir(), 'pending-int-')))
})

describe('pending-interactions — create + resolve', () => {
  it('creates an open interaction with an expiry', () => {
    const rec = createInteraction({
      channelId: 'telegram',
      userId: 'u1',
      kind: 'nudge',
      prompt: 'ping?',
      now: 1_000,
      ttlMs: 5_000
    })
    expect(rec.status).toBe('open')
    expect(rec.expiresAt).toBe(6_000)
    expect(hasOpenInteraction('telegram', 'u1', 2_000)).toBe(true)
  })

  it('resolveByReply resolves the open interaction and records the reply', () => {
    const rec = createInteraction({ channelId: 'telegram', userId: 'u1', kind: 'approval', prompt: 'ok?' })
    const resolved = resolveByReply('telegram', 'u1', 'yes')
    expect(resolved?.id).toBe(rec.id)
    expect(resolved?.status).toBe('resolved')
    expect(resolved?.replyText).toBe('yes')
    expect(getInteraction(rec.id)?.status).toBe('resolved')
  })

  it('is single-use: a second reply after resolution finds nothing', () => {
    createInteraction({ channelId: 'telegram', userId: 'u1', kind: 'nudge', prompt: 'p' })
    expect(resolveByReply('telegram', 'u1', 'first')).not.toBeNull()
    expect(resolveByReply('telegram', 'u1', 'second')).toBeNull()
  })
})

describe('pending-interactions — scoping (security)', () => {
  it('a reply only resolves interactions for the SAME (channel, user)', () => {
    const forU1 = createInteraction({ channelId: 'telegram', userId: 'u1', kind: 'approval', prompt: 'p' })
    // A different user on the same channel cannot resolve u1's interaction.
    expect(resolveByReply('telegram', 'u2', 'yes')).toBeNull()
    // A different channel cannot either.
    expect(resolveByReply('slack', 'u1', 'yes')).toBeNull()
    // The rightful user still can.
    expect(resolveByReply('telegram', 'u1', 'yes')?.id).toBe(forU1.id)
  })
})

describe('pending-interactions — oldest-match ordering', () => {
  it('resolves the OLDEST open interaction first (FIFO per user)', () => {
    const a = createInteraction({ channelId: 'tg', userId: 'u1', kind: 'nudge', prompt: 'a', now: 1 })
    const b = createInteraction({ channelId: 'tg', userId: 'u1', kind: 'nudge', prompt: 'b', now: 2 })
    expect(resolveByReply('tg', 'u1', 'r1', 5)?.id).toBe(a.id)
    expect(resolveByReply('tg', 'u1', 'r2', 6)?.id).toBe(b.id)
  })
})

describe('pending-interactions — expiry', () => {
  it('an expired interaction cannot be resolved by a late reply', () => {
    createInteraction({ channelId: 'tg', userId: 'u1', kind: 'approval', prompt: 'p', now: 0, ttlMs: 100 })
    // reply arrives after expiry
    expect(resolveByReply('tg', 'u1', 'too late', 1_000)).toBeNull()
    expect(listInteractions('expired').length).toBe(1)
  })

  it('sweepExpired marks lapsed open interactions expired and persists once', () => {
    createInteraction({ channelId: 'tg', userId: 'u1', kind: 'nudge', prompt: 'p', now: 0, ttlMs: 100 })
    createInteraction({ channelId: 'tg', userId: 'u2', kind: 'nudge', prompt: 'p', now: 0, ttlMs: 10_000 })
    const expired = sweepExpired(500)
    expect(expired.length).toBe(1)
    expect(hasOpenInteraction('tg', 'u1', 500)).toBe(false)
    expect(hasOpenInteraction('tg', 'u2', 500)).toBe(true)
  })

  it('a still-valid reply within the TTL resolves normally', () => {
    createInteraction({ channelId: 'tg', userId: 'u1', kind: 'nudge', prompt: 'p', now: 0, ttlMs: 1_000 })
    expect(resolveByReply('tg', 'u1', 'in time', 500)?.status).toBe('resolved')
  })
})

describe('pending-interactions — pruneInteractions (bounded store growth)', () => {
  it('drops old terminal records but keeps open and recent ones', () => {
    // A resolved record (old), an expired record (old), an OPEN record, and a
    // recently-resolved record.
    const oldResolved = createInteraction({ channelId: 'tg', userId: 'u1', kind: 'nudge', prompt: 'a', now: 0, ttlMs: 10_000 })
    resolveByReply('tg', 'u1', 'r', 100) // resolvedAt = 100
    const oldExpired = createInteraction({ channelId: 'tg', userId: 'u2', kind: 'nudge', prompt: 'b', now: 0, ttlMs: 50 })
    sweepExpired(100) // expiresAt 50 <= 100 → expired, resolvedAt = 100
    const stillOpen = createInteraction({ channelId: 'tg', userId: 'u3', kind: 'nudge', prompt: 'c', now: 0, ttlMs: 10_000_000 })
    const recentResolved = createInteraction({ channelId: 'tg', userId: 'u4', kind: 'nudge', prompt: 'd', now: 9_000, ttlMs: 10_000 })
    resolveByReply('tg', 'u4', 'r', 9_500) // resolvedAt = 9_500

    // Prune terminal records whose resolvedAt is older than 1_000ms, as of now=10_000.
    const pruned = pruneInteractions(1_000, 10_000)
    expect(pruned).toBe(2) // oldResolved (100) + oldExpired (100)
    expect(getInteraction(oldResolved.id)).toBeNull()
    expect(getInteraction(oldExpired.id)).toBeNull()
    // Open windows are NEVER pruned, and recently-terminal ones are retained.
    expect(getInteraction(stillOpen.id)?.status).toBe('open')
    expect(getInteraction(recentResolved.id)?.status).toBe('resolved')
  })

  it('never prunes an open interaction even if it is ancient', () => {
    const rec = createInteraction({ channelId: 'tg', userId: 'u1', kind: 'approval', prompt: 'p', now: 0, ttlMs: 100 })
    // It's lapsed by wall-clock but NOT yet swept → still status 'open', resolvedAt null.
    expect(pruneInteractions(1, 1_000_000)).toBe(0)
    expect(getInteraction(rec.id)?.status).toBe('open')
  })
})
