import { describe, it, expect, beforeEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import type { ChannelRef } from '../channel-dispatch'
import type { DeliveryReceipt } from './delivery-queue'
import type { OperatorIdentity } from './approval-roundtrip'
import {
  setPendingInteractionsPath,
  getInteraction,
  resolveByReply,
  sweepExpired,
  type PendingInteraction
} from './pending-interactions'
import {
  sendNudge,
  handleNudgeReply,
  parseNudgeAnswer,
  pendingNudgeCount,
  __resetNudges
} from './nudges'

const OP: OperatorIdentity = { channelId: 'telegram', userId: 'op-1' }
const REF: ChannelRef = { kind: 'telegram', target: 'op-1' }

/** A spy enqueue that always delivers. */
function okEnqueue() {
  const calls: { ref: ChannelRef; text: string; meta: Record<string, unknown> }[] = []
  const fn = async (ref: ChannelRef, text: string, meta: Record<string, unknown>): Promise<DeliveryReceipt> => {
    calls.push({ ref, text, meta })
    return { id: `d${calls.length}`, ok: true, status: 'delivered' }
  }
  return { calls, fn }
}

beforeEach(() => {
  setPendingInteractionsPath(mkdtempSync(join(tmpdir(), 'nudge-')))
  __resetNudges()
})

describe('parseNudgeAnswer', () => {
  it('maps yes/no lexicon to yes/no, else other', () => {
    expect(parseNudgeAnswer('Y')).toBe('yes')
    expect(parseNudgeAnswer('yes please')).toBe('yes')
    expect(parseNudgeAnswer('no thanks')).toBe('no')
    expect(parseNudgeAnswer('maybe later')).toBe('other')
    expect(parseNudgeAnswer(42)).toBe('other')
  })
})

describe('sendNudge — fail-closed + create', () => {
  it('sends nothing with no operator configured', async () => {
    const enq = okEnqueue()
    const res = await sendNudge({ question: 'ping?' }, { operator: null, ref: REF, onReply: () => {}, enqueue: enq.fn })
    expect(res.sent).toBe(false)
    expect(res.skipped).toBe('no-operator')
    expect(enq.calls).toHaveLength(0)
    expect(pendingNudgeCount()).toBe(0)
  })

  it('creates a nudge interaction bound to the operator and dispatches the question', async () => {
    const enq = okEnqueue()
    const res = await sendNudge(
      { question: '3 forecasts due — want the digest? reply Y', nudgeType: 'forecast-due' },
      { operator: OP, ref: REF, onReply: () => {}, enqueue: enq.fn, now: 1_000, ttlMs: 5_000 }
    )
    expect(res.sent).toBe(true)
    expect(res.interactionId).toBeTruthy()
    const rec = getInteraction(res.interactionId!)!
    expect(rec.kind).toBe('nudge')
    expect(rec.channelId).toBe('telegram')
    expect(rec.userId).toBe('op-1')
    expect(rec.expiresAt).toBe(6_000)
    expect(rec.payload).toMatchObject({ nudgeType: 'forecast-due' })
    expect(enq.calls[0].meta).toMatchObject({ source: 'nudge', interactionId: res.interactionId })
    expect(pendingNudgeCount()).toBe(1)
  })

  it('cancels the interaction + handler if the dispatch seam throws', async () => {
    const res = await sendNudge(
      { question: 'ping?' },
      { operator: OP, ref: REF, onReply: () => {}, enqueue: async () => { throw new Error('net down') } }
    )
    expect(res.sent).toBe(false)
    expect(res.skipped).toBe('error')
    // interaction was cancelled (expired), no live handler left dangling
    expect(getInteraction(res.interactionId!)?.status).toBe('expired')
    expect(pendingNudgeCount()).toBe(0)
  })
})

describe('handleNudgeReply — reply drives the follow-up', () => {
  it('a Y reply invokes the follow-up and returns its custom ack', async () => {
    const enq = okEnqueue()
    let seen: string | null = null
    const res = await sendNudge(
      { question: 'want the digest? Y' },
      {
        operator: OP,
        ref: REF,
        enqueue: enq.fn,
        onReply: (ctx) => {
          seen = ctx.answer
          return 'Sending your brief now.'
        }
      }
    )
    // Simulate the inbound reply arriving on the same (channel,user): the runtime
    // resolves it, then drives the follow-up.
    const resolved = resolveByReply('telegram', 'op-1', 'Y') as PendingInteraction
    expect(resolved.id).toBe(res.interactionId)
    const ack = await handleNudgeReply(resolved, 'Y')
    expect(seen).toBe('yes')
    expect(ack).toBe('Sending your brief now.')
    // single-use: handler is consumed
    expect(pendingNudgeCount()).toBe(0)
  })

  it('a non-yes reply still runs the follow-up with answer=no/other', async () => {
    const enq = okEnqueue()
    let answer: string | null = null
    const res = await sendNudge({ question: 'q' }, { operator: OP, ref: REF, enqueue: enq.fn, onReply: (ctx) => { answer = ctx.answer } })
    const resolved = resolveByReply('telegram', 'op-1', 'nah') as PendingInteraction
    const ack = await handleNudgeReply(resolved, 'nah')
    expect(answer).toBe('no')
    expect(ack).toBe('Got it — thanks, recorded.') // default ack when handler returns void
    void res
  })

  it('a second reply after resolution drives nothing (single-use handler + interaction)', async () => {
    const enq = okEnqueue()
    let calls = 0
    const res = await sendNudge({ question: 'q' }, { operator: OP, ref: REF, enqueue: enq.fn, onReply: () => { calls++ } })
    const first = resolveByReply('telegram', 'op-1', 'Y') as PendingInteraction
    await handleNudgeReply(first, 'Y')
    expect(calls).toBe(1)
    // interaction is now resolved; a second inbound reply resolves nothing
    expect(resolveByReply('telegram', 'op-1', 'Y')).toBeNull()
    // and even a replayed handleNudgeReply on the old record finds no handler
    const ack = await handleNudgeReply(first, 'Y')
    expect(calls).toBe(1)
    expect(ack).toBe('Got it — thanks, recorded.')
    void res
  })

  it('a follow-up that throws is swallowed and yields a neutral ack', async () => {
    const enq = okEnqueue()
    const res = await sendNudge({ question: 'q' }, { operator: OP, ref: REF, enqueue: enq.fn, onReply: () => { throw new Error('boom') } })
    const resolved = resolveByReply('telegram', 'op-1', 'Y') as PendingInteraction
    const ack = await handleNudgeReply(resolved, 'Y')
    expect(ack).toBe('Got it — thanks, recorded.')
    void res
  })
})

describe('nudge expiry', () => {
  it('an expired nudge can never resolve, so its follow-up never fires', async () => {
    const enq = okEnqueue()
    let fired = false
    await sendNudge(
      { question: 'q' },
      { operator: OP, ref: REF, enqueue: enq.fn, onReply: () => { fired = true }, now: 1_000, ttlMs: 1_000 }
    )
    // sweep past expiry, then a late reply matches nothing
    sweepExpired(3_000)
    const resolved = resolveByReply('telegram', 'op-1', 'Y', 3_000)
    expect(resolved).toBeNull()
    expect(fired).toBe(false)
  })

  it('a different user cannot resolve the operator-bound nudge', async () => {
    const enq = okEnqueue()
    let fired = false
    await sendNudge({ question: 'q' }, { operator: OP, ref: REF, enqueue: enq.fn, onReply: () => { fired = true } })
    // an inbound from a DIFFERENT user id on the same channel resolves nothing
    expect(resolveByReply('telegram', 'someone-else', 'Y')).toBeNull()
    expect(fired).toBe(false)
  })
})
