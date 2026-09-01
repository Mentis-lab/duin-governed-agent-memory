import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'

// The queue statically imports channelDispatch, which transitively pulls Electron.
// Stub the module so importing delivery-queue stays off Electron; the actual
// attempt outcome is driven per-test via __setDispatcher (the injectable seam).
vi.mock('../channel-dispatch', () => ({
  channelDispatch: async () => ({ ok: false, error: 'unstubbed-dispatch' })
}))

import {
  setDeliveryQueuePath,
  __setDispatcher,
  enqueue,
  redeliverDue,
  getDelivery,
  listDeliveries,
  backoffMs,
  pruneDelivered
} from './delivery-queue'
import type { ChannelRef } from '../channel-dispatch'

const REF: ChannelRef = { kind: 'feishu', target: 'Theo' }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delivery-'))
  setDeliveryQueuePath(dir)
})
afterEach(() => {
  __setDispatcher() // restore default
})

/** A dispatcher whose ok/fail is controlled by a mutable flag. */
function controllable(initialOk: boolean) {
  const state = { ok: initialOk, calls: 0, err: 'boom' }
  __setDispatcher(async () => {
    state.calls++
    return state.ok ? { ok: true } : { ok: false, error: state.err }
  })
  return state
}

describe('delivery-queue — happy path', () => {
  it('enqueue delivers immediately and records a delivered receipt', async () => {
    const s = controllable(true)
    const receipt = await enqueue(REF, 'hello', { now: 1_000 })
    expect(receipt.ok).toBe(true)
    expect(receipt.status).toBe('delivered')
    expect(s.calls).toBe(1)

    const rec = getDelivery(receipt.id)!
    expect(rec.status).toBe('delivered')
    expect(rec.attempts).toBe(1)
    expect(rec.deliveredAt).toBe(1_000)
    expect(rec.nextAttemptAt).toBe(1_000) // never rescheduled
  })

  it('a successful send still leaves a persisted receipt trail', async () => {
    controllable(true)
    const receipt = await enqueue(REF, 'hello')
    expect(existsSync(join(dir, 'deliveries.json'))).toBe(true)
    const saved = JSON.parse(readFileSync(join(dir, 'deliveries.json'), 'utf-8'))
    expect(saved.queue[receipt.id].status).toBe('delivered')
  })
})

describe('delivery-queue — failure persists to the dead-letter queue', () => {
  it('a failed enqueue persists as pending with a backoff-scheduled retry', async () => {
    const s = controllable(false)
    const receipt = await enqueue(REF, 'hello', { now: 10_000 })
    expect(receipt.ok).toBe(false)
    expect(receipt.status).toBe('pending')
    expect(receipt.error).toBe('boom')
    expect(s.calls).toBe(1)

    const rec = getDelivery(receipt.id)!
    expect(rec.status).toBe('pending')
    expect(rec.attempts).toBe(1)
    expect(rec.lastError).toBe('boom')
    // nextAttemptAt = now + backoff(1)
    expect(rec.nextAttemptAt).toBe(10_000 + backoffMs(1))
  })

  it('is durable: reloading the path re-hydrates the pending record', async () => {
    controllable(false)
    const receipt = await enqueue(REF, 'hello')
    setDeliveryQueuePath(dir) // simulate a restart re-reading deliveries.json
    const rec = getDelivery(receipt.id)
    expect(rec?.status).toBe('pending')
  })
})

describe('delivery-queue — redeliverDue', () => {
  it('redelivers a due pending record and marks it delivered', async () => {
    const s = controllable(false)
    const receipt = await enqueue(REF, 'hello', { now: 0 })
    const dueAt = getDelivery(receipt.id)!.nextAttemptAt

    // Flip to success and drive the retry at/after its scheduled time.
    s.ok = true
    const summary = await redeliverDue(dueAt)
    expect(summary).toMatchObject({ attempted: 1, delivered: 1, dead: 0 })
    expect(getDelivery(receipt.id)!.status).toBe('delivered')
  })

  it('does NOT retry a record before its backoff window elapses', async () => {
    controllable(false)
    const receipt = await enqueue(REF, 'hello', { now: 0 })
    const dueAt = getDelivery(receipt.id)!.nextAttemptAt

    const summary = await redeliverDue(dueAt - 1) // one ms too early
    expect(summary.attempted).toBe(0)
    expect(getDelivery(receipt.id)!.attempts).toBe(1) // unchanged
  })

  it('applies exponential backoff across successive failed retries', async () => {
    const s = controllable(false)
    const receipt = await enqueue(REF, 'hello', { now: 0 })
    const id = receipt.id

    // attempt 1 already made at enqueue. Drive attempts 2 and 3, both failing.
    const due = getDelivery(id)!.nextAttemptAt
    expect(due).toBe(backoffMs(1))
    await redeliverDue(due)
    expect(getDelivery(id)!.attempts).toBe(2)
    // Next window uses backoff(2) > backoff(1): strictly increasing.
    const due2 = getDelivery(id)!.nextAttemptAt
    expect(due2 - due).toBe(backoffMs(2))
    expect(backoffMs(2)).toBeGreaterThan(backoffMs(1))

    await redeliverDue(due2)
    expect(getDelivery(id)!.attempts).toBe(3)
    void s
  })

  it('parks a record as a dead letter once maxAttempts is exhausted (never dropped)', async () => {
    controllable(false)
    // maxAttempts:2 → enqueue makes attempt 1, one redelivery exhausts it.
    const receipt = await enqueue(REF, 'hello', { now: 0, maxAttempts: 2 })
    expect(getDelivery(receipt.id)!.status).toBe('pending')

    const due = getDelivery(receipt.id)!.nextAttemptAt
    const summary = await redeliverDue(due)
    expect(summary).toMatchObject({ attempted: 1, delivered: 0, dead: 1 })

    const rec = getDelivery(receipt.id)!
    expect(rec.status).toBe('dead')
    expect(rec.attempts).toBe(2)
    // Dead letters are RETAINED for inspection, not silently lost.
    expect(listDeliveries('dead').map((r) => r.id)).toContain(receipt.id)
  })

  it('maxAttempts:1 dead-letters immediately on a failed enqueue', async () => {
    controllable(false)
    const receipt = await enqueue(REF, 'hello', { maxAttempts: 1 })
    expect(receipt.status).toBe('dead')
    expect(getDelivery(receipt.id)!.status).toBe('dead')
  })

  // Regression: the automations 60s tick fires redeliverDue() fire-and-forget. A pass
  // parked on a hung dispatch (restSend has no timeout — undici can hang for minutes on
  // a half-open socket) leaves the in-flight record STILL 'pending' with nextAttemptAt
  // in the past, because status/attempts are mutated only AFTER the await. Without an
  // overlap guard the next tick re-selects and re-sends that same record: the operator
  // gets the nudge twice and the retry budget burns at double rate. The guard must make
  // an overlapping pass no-op while one is in flight.
  it('an overlapping pass no-ops while the first is parked on a hung dispatch (no double-send)', async () => {
    controllable(false)
    const receipt = await enqueue(REF, 'hello', { now: 0 })
    const dueAt = getDelivery(receipt.id)!.nextAttemptAt

    // Swap in a dispatcher that HANGS (never resolves) and counts entries.
    let dispatchEntries = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    __setDispatcher(async () => {
      dispatchEntries++
      await gate
      return { ok: false, error: 'hang' }
    })

    // First pass parks on the hung dispatch (fire-and-forget, not awaited).
    const first = redeliverDue(dueAt)
    // The dispatcher is entered synchronously up to its first await.
    expect(dispatchEntries).toBe(1)

    // Second overlapping tick MUST NOT re-select the still-pending record.
    const second = await redeliverDue(dueAt)
    expect(second.attempted).toBe(0)
    expect(dispatchEntries).toBe(1) // pre-fix this would be 2 — the double-send

    // Let the first pass complete cleanly and clear the in-flight flag.
    release()
    await first
    expect(getDelivery(receipt.id)!.attempts).toBe(2) // exactly one redelivery attempt
  })
})

describe('delivery-queue — backoff + prune', () => {
  it('backoff is exponential and capped', () => {
    expect(backoffMs(1)).toBe(60_000)
    expect(backoffMs(2)).toBe(120_000)
    expect(backoffMs(3)).toBe(240_000)
    expect(backoffMs(99)).toBe(30 * 60_000) // capped
  })

  it('pruneDelivered removes only old delivered records, never pending/dead', async () => {
    // one delivered (old), one dead (kept), one pending (kept)
    controllable(true)
    const ok = await enqueue(REF, 'ok', { now: 0 })
    __setDispatcher()
    controllable(false)
    const dead = await enqueue(REF, 'dead', { now: 0, maxAttempts: 1 })
    const pending = await enqueue(REF, 'pending', { now: 0, maxAttempts: 6 })

    const pruned = pruneDelivered(1_000, 10_000) // delivered older than 1s
    expect(pruned).toBe(1)
    expect(getDelivery(ok.id)).toBeNull()
    expect(getDelivery(dead.id)?.status).toBe('dead')
    expect(getDelivery(pending.id)?.status).toBe('pending')
  })
})

// Regression: a torn deliveries.json (crash/power-loss mid persist(), which runs on every
// enqueue and after every redeliver batch) must NOT be silently read back as an empty queue.
// Before the fix, setDeliveryQueuePath's `catch { queue = {} }` reset silently and the next
// enqueue's persist() truncate-in-place writeFileSync overwrote the wreckage — every undelivered
// pending/dead proactive send lost with no trace, violating the "never silently dropped" contract.
describe('delivery-queue — torn store is quarantined, not silently emptied', () => {
  it('a corrupt deliveries.json is moved aside to a timestamped .corrupt sidecar and logged', () => {
    // A pre-existing store holding an undelivered dead letter — the bytes we must not lose.
    const undelivered = { queue: { 'dead-1': { id: 'dead-1', status: 'dead', text: 'watch notice' } } }
    const full = JSON.stringify(undelivered, null, 2)
    const torn = full.slice(0, Math.floor(full.length / 2)) // truncated → JSON.parse throws
    writeFileSync(join(dir, 'deliveries.json'), torn, 'utf-8')

    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    setDeliveryQueuePath(dir) // the boot re-read
    const logged = err.mock.calls.map((c) => String(c[0])).join('\n')
    err.mockRestore()

    // The torn bytes survive in a quarantine sidecar — recoverable, not destroyed.
    const sidecars = readdirSync(dir).filter((f) => f.endsWith('.corrupt'))
    expect(sidecars).toHaveLength(1)
    expect(readFileSync(join(dir, sidecars[0]), 'utf-8')).toBe(torn)
    expect(sidecars[0]).toMatch(/deliveries\.json\.\d{4}-\d{2}-\d{2}T[\d-]+Z\.corrupt$/)

    // The loss is loud, not silent.
    expect(logged).toMatch(/delivery-queue/)
    expect(logged).toMatch(/quarantined/i)

    // In-memory queue reset to empty (the only safe state) — but the sidecar preserves recovery.
    expect(getDelivery('dead-1')).toBeNull()
  })

  it('a valid store still loads normally (quarantine only fires on parse failure)', async () => {
    controllable(false)
    const receipt = await enqueue(REF, 'hello') // persist a pending record
    setDeliveryQueuePath(dir) // re-read the well-formed file
    expect(getDelivery(receipt.id)?.status).toBe('pending')
    // No spurious sidecar for a healthy file.
    expect(readdirSync(dir).filter((f) => f.endsWith('.corrupt'))).toHaveLength(0)
  })
})
