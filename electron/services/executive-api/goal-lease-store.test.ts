import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  __goalLeaseTest,
  authorizeGoalWrite,
  claimGoalLease,
  getGoalLease,
  recordGoalCreation,
  releaseGoalLease
} from './goal-lease-store'

// The P1 fencing contract, pinned: TTL leases with a monotonic epoch that
// bumps on every change of hands, validated on every write — the Kleppmann
// lesson that expiry-only leases admit stale-holder writes.

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'goal-lease-'))
  __goalLeaseTest.setPath(join(dir, 'leases.json'))
})

afterEach(() => {
  __goalLeaseTest.setPath(null)
  rmSync(dir, { recursive: true, force: true })
})

const T0 = 1_000_000

describe('claim / renew / contention', () => {
  it('first claim grants epoch 1; the holder re-claiming renews without an epoch bump', () => {
    const first = claimGoalLease('g1', 'prin-a', 'alice', 60_000, T0)
    expect(first).toMatchObject({ ok: true, epoch: 1, renewed: false, tookOver: false })
    const again = claimGoalLease('g1', 'prin-a', 'alice', 60_000, T0 + 10_000)
    expect(again).toMatchObject({ ok: true, epoch: 1, renewed: true })
    if (again.ok) expect(again.expiresAt).toBe(T0 + 70_000)
  })

  it('a live lease refuses a second principal with the holder named', () => {
    claimGoalLease('g1', 'prin-a', 'alice', 60_000, T0)
    const contender = claimGoalLease('g1', 'prin-b', 'bob', 60_000, T0 + 5_000)
    expect(contender).toMatchObject({ ok: false, reason: 'held', holder: 'prin-a', holderName: 'alice' })
  })

  it('an EXPIRED lease is taken over: epoch bumps, transitions count', () => {
    claimGoalLease('g1', 'prin-a', 'alice', 60_000, T0)
    const takeover = claimGoalLease('g1', 'prin-b', 'bob', 60_000, T0 + 61_000)
    expect(takeover).toMatchObject({ ok: true, epoch: 2, tookOver: true })
    expect(getGoalLease('g1', T0 + 62_000)).toMatchObject({
      holder: 'prin-b',
      leaseTransitions: 1,
      live: true
    })
  })
})

describe('write fencing', () => {
  it('the holder writes with its epoch and each write renews the lease', () => {
    claimGoalLease('g1', 'prin-a', 'alice', 60_000, T0)
    expect(authorizeGoalWrite('g1', 'prin-a', 1, T0 + 30_000)).toEqual({ ok: true })
    // The write at T0+30s renewed by the CLAIMED ttl (60s) to T0+90s — a
    // check at T0+80s still passes.
    expect(authorizeGoalWrite('g1', 'prin-a', 1, T0 + 80_000)).toEqual({ ok: true })
  })

  it('renew-on-write extends by the TTL the holder claimed under and never shrinks the window', () => {
    // 4h claim; one write 10 minutes in must NOT truncate expiry to the 15m default.
    const fourHours = 4 * 60 * 60 * 1000
    claimGoalLease('g1', 'prin-a', 'alice', fourHours, T0)
    expect(authorizeGoalWrite('g1', 'prin-a', 1, T0 + 10 * 60_000)).toEqual({ ok: true })
    // Well past the 15m default, still inside the granted window:
    expect(authorizeGoalWrite('g1', 'prin-a', 1, T0 + 60 * 60_000)).toEqual({ ok: true })
    // And the renewal moved expiry FORWARD from the claim's horizon:
    expect(getGoalLease('g1', T0 + fourHours + 30 * 60_000).live).toBe(true)
  })

  it('a resurrected stale holder is fenced out by epoch even inside the new lease window', () => {
    claimGoalLease('g1', 'prin-a', 'alice', 60_000, T0)
    claimGoalLease('g1', 'prin-b', 'bob', 60_000, T0 + 61_000) // takeover, epoch 2
    // prin-a wakes up and writes with the epoch it claimed under:
    const stale = authorizeGoalWrite('g1', 'prin-a', 1, T0 + 65_000)
    expect(stale).toMatchObject({ ok: false, reason: 'not-holder', holder: 'prin-b' })
    // …and even the CURRENT holder presenting the OLD epoch is refused:
    const wrongEpoch = authorizeGoalWrite('g1', 'prin-b', 1, T0 + 65_000)
    expect(wrongEpoch).toMatchObject({ ok: false, reason: 'stale-epoch', currentEpoch: 2 })
  })

  it('no lease and expired lease both refuse with named reasons', () => {
    expect(authorizeGoalWrite('never-claimed', 'prin-a', 1, T0)).toMatchObject({
      ok: false,
      reason: 'no-lease'
    })
    claimGoalLease('g1', 'prin-a', 'alice', 60_000, T0)
    expect(authorizeGoalWrite('g1', 'prin-a', 1, T0 + 61_000)).toMatchObject({
      ok: false,
      reason: 'expired'
    })
  })
})

describe('release + attribution + durability', () => {
  it('release requires holder+epoch and frees the goal for a fresh claim (epoch bumps)', () => {
    claimGoalLease('g1', 'prin-a', 'alice', 60_000, T0)
    expect(releaseGoalLease('g1', 'prin-b', 1, T0).ok).toBe(false)
    expect(releaseGoalLease('g1', 'prin-a', 2, T0).ok).toBe(false)
    expect(releaseGoalLease('g1', 'prin-a', 1, T0).ok).toBe(true)
    const next = claimGoalLease('g1', 'prin-b', 'bob', 60_000, T0 + 1_000)
    expect(next).toMatchObject({ ok: true, epoch: 2 })
  })

  it('creation attribution and last-writer stamps persist across a cache drop', () => {
    recordGoalCreation('g1', 'prin-a')
    claimGoalLease('g1', 'prin-a', 'alice', 60_000, T0)
    authorizeGoalWrite('g1', 'prin-a', 1, T0 + 1_000)
    __goalLeaseTest.reset() // restart simulation: reload from disk
    const lease = getGoalLease('g1', T0 + 2_000)
    expect(lease).toMatchObject({ createdBy: 'prin-a', lastWriter: 'prin-a', epoch: 1, live: true })
  })

  it('a corrupt ledger fails CLOSED for writes but open for claims', () => {
    claimGoalLease('g1', 'prin-a', 'alice', 60_000, T0)
    writeFileSync(join(dir, 'leases.json'), '{broken', 'utf-8')
    __goalLeaseTest.reset()
    expect(authorizeGoalWrite('g1', 'prin-a', 1, T0 + 1_000)).toMatchObject({
      ok: false,
      reason: 'no-lease'
    })
    expect(claimGoalLease('g1', 'prin-a', 'alice', 60_000, T0 + 2_000).ok).toBe(true)
    // And the rewritten file is valid again.
    expect(() => JSON.parse(readFileSync(join(dir, 'leases.json'), 'utf-8'))).not.toThrow()
  })
})
