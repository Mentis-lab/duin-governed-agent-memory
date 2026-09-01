import { describe, it, expect } from 'vitest'
import { applyClaimFreshness, claimRecallEnabled, ledgerStaleThresholdMs, ledgerUpdatedAt, activeClaimsForHits } from './claim-recall'
import { classifyMutability, FRESH_FLOOR, type Claim } from './claim-metabolism'

const DAY = 86_400_000
const NOW = 1_000 * DAY

function claim(p: Partial<Claim> & Pick<Claim, 'id' | 'subject' | 'relation' | 'object'>): Claim {
  return {
    chunkId: `c-${p.id}`, notePath: `${p.id}.md`,
    validFrom: NOW - 30 * DAY, validTo: null, observedAt: NOW - 30 * DAY, supersededBy: null,
    mutability: classifyMutability(p.relation), justifications: [], verdict: 'current', verdictBy: null,
    ...p
  }
}
type Hit = { file: string; snippet?: string; score: number }
const hit = (file: string, score: number, snippet = ''): Hit => ({ file, score, snippet })

describe('claim-recall — applyClaimFreshness', () => {
  it('demotes a hit whose note matches a RETIRED claim by basename join, re-ranking below a fresh peer', () => {
    const retired = claim({ id: 'DUIN/notes/deadline', subject: 'x', relation: 'status', object: 'old', notePath: 'DUIN/notes/deadline.md', validTo: NOW, verdict: 'stale' })
    const hits = [hit('DUIN/notes/deadline.md', 0.9), hit('fresh.md', 0.6)] // stale scores higher pre-demotion
    const out = applyClaimFreshness(hits, [retired], NOW)
    expect(out.map((h) => h.file)).toEqual(['fresh.md', 'DUIN/notes/deadline.md']) // fresh now wins
    expect(out.find((h) => h.file.includes('deadline'))!.score).toBeCloseTo(0.9 * FRESH_FLOOR, 5) // demoted, clamped
  })

  it('never drops the demoted hit — it stays in the list', () => {
    const retired = claim({ id: 'a', subject: 'x', relation: 'status', object: 'v', notePath: 'a.md', validTo: NOW })
    const out = applyClaimFreshness([hit('a.md', 0.9), hit('b.md', 0.5)], [retired], NOW)
    expect(out).toHaveLength(2)
    expect(out.map((h) => h.file).sort()).toEqual(['a.md', 'b.md'])
  })

  it('an ACTIVE (non-retired) claim does not demote', () => {
    const active = claim({ id: 'a', subject: 'x', relation: 'status', object: 'v', notePath: 'a.md' }) // validTo null
    const hits = [hit('a.md', 0.9), hit('b.md', 0.6)]
    expect(applyClaimFreshness(hits, [active], NOW)).toBe(hits) // untouched, same reference
  })

  it('demotes when the hit COVERS the claim (alias join, basenames differ)', () => {
    const retired = claim({ id: 'r', subject: 'Beacon dashboard', relation: 'status', object: 'cancelled', notePath: 'somewhere/r.md', validTo: NOW })
    // Snippet carries the whole claim (beacon + dashboard + cancelled) ⇒ coverage 1.0 ⇒ demote.
    const out = applyClaimFreshness([hit('projects/overview.md', 0.9, 'the Beacon dashboard was cancelled'), hit('other.md', 0.6)], [retired], NOW)
    expect(out[0].file).toBe('other.md') // the Beacon hit sank below the fresh peer
  })

  // REPLACES an older test that asserted a single shared ≥5-char token was enough to demote. That
  // shortcut was measured to be the dominant false-match source on the live ledger: with it, the
  // demoter fired on 84.8% of top-5 hits (83.9% of CJK ones) — an indiscriminate demoter is the same
  // as no demoter. The rule is now coverage-based, so one incidental shared word must NOT fire.
  it('does NOT demote on a single strong (≥5-char) shared token — coverage too low', () => {
    const retired = claim({ id: 'r', subject: 'Beacon dashboard', relation: 'status', object: 'cancelled', notePath: 'somewhere/r.md', validTo: NOW })
    const hits = [hit('projects/overview.md', 0.9, 'notes on the Beacon rollout'), hit('other.md', 0.6)]
    expect(applyClaimFreshness(hits, [retired], NOW)).toBe(hits) // 1 of 3 claim tokens ⇒ untouched
  })

  it('does NOT demote on two incidental shared tokens against a large claim (coverage guard)', () => {
    const retired = claim({
      id: 'r', subject: '厦门渠道方会议', relation: 'status', object: '4399 好游快爆 改期',
      notePath: 'somewhere/r.md', validTo: NOW
    })
    // A dev log that happens to mention 厦门 and 4399 shares only a fraction of the claim's bigrams.
    const hits = [hit('DUIN/Planning/2026-05-25.md', 0.9, '厦门出差、4399 的事情待定'), hit('other.md', 0.6)]
    expect(applyClaimFreshness(hits, [retired], NOW)).toBe(hits)
  })

  it('demotes a CJK hit that restates the claim under a different filename', () => {
    const retired = claim({
      id: 'r', subject: '风暴模拟器合作', relation: 'status', object: '终止',
      notePath: '渠道/雷电.md', validTo: NOW
    })
    const out = applyClaimFreshness(
      [hit('北澜/09 Reports/商务双周报.md', 0.9, '风暴模拟器合作已终止，转低优先级'), hit('other.md', 0.6)],
      [retired], NOW
    )
    expect(out[0].file).toBe('other.md')
  })

  it('does NOT demote on a weak single short-token coincidence (precision guard)', () => {
    const retired = claim({ id: 'r', subject: 'the a', relation: 'status', object: 'x', notePath: 'r.md', validTo: NOW })
    const hits = [hit('unrelated.md', 0.9, 'a the of'), hit('b.md', 0.6)]
    expect(applyClaimFreshness(hits, [retired], NOW)).toBe(hits) // 2-char tokens filtered → no match → untouched
  })

  it('empty ledger / single hit → untouched', () => {
    const hits = [hit('a.md', 0.9), hit('b.md', 0.6)]
    expect(applyClaimFreshness(hits, [], NOW)).toBe(hits)
    expect(applyClaimFreshness([hit('a.md', 0.9)], [claim({ id: 'a', subject: 'x', relation: 'r', object: 'o', notePath: 'a.md', validTo: NOW })], NOW)).toHaveLength(1)
  })
})

// FRESHNESS GATE: never demote a LIVE hit on a verdict from a FROZEN ledger. The metabolism froze
// for 2+ days (its shrink-floor deadlocked); a stale "retired" flag must not keep penalizing live
// retrieval. When the ledger's newest write-time stamp is older than the threshold, skip demotion.
describe('claim-recall — freshness gate (stale ledger must not demote)', () => {
  // A retired claim whose write-time stamps are all N days old ⇒ the ledger was last metabolized N
  // days ago (observedAt/validTo are re-stamped each healthy tick, so old = frozen).
  const staleRetired = (ageDays: number): Claim => {
    const t = NOW - ageDays * DAY
    return claim({
      id: 'DUIN/notes/deadline', subject: 'Beacon deadline', relation: 'status', object: 'old',
      notePath: 'DUIN/notes/deadline.md', validFrom: t, observedAt: t, validTo: t
    })
  }
  const hits = () => [hit('DUIN/notes/deadline.md', 0.9), hit('fresh.md', 0.6)]

  it('SKIPS demotion when the ledger is stale beyond the threshold (a 3-day-frozen ledger)', () => {
    const out = applyClaimFreshness(hits(), [staleRetired(3)], NOW) // 3d > 24h default → skip
    expect(out).toEqual(hits()) // untouched: the stale hit keeps its higher score, order unchanged
    expect(out[0].file).toBe('DUIN/notes/deadline.md')
  })

  it('APPLIES demotion when the ledger is fresh (retired 1h ago, well within the window)', () => {
    const fresh = staleRetired(0)
    fresh.validTo = NOW - 1 * 3_600_000 // retired an hour ago → fresh ledger
    fresh.observedAt = NOW - 1 * 3_600_000
    fresh.validFrom = NOW - 1 * 3_600_000
    const out = applyClaimFreshness(hits(), [fresh], NOW)
    expect(out[0].file).toBe('fresh.md') // demoted below the fresh peer
  })

  it('an explicit ledgerUpdatedAt override forces the gate deterministically (stale → skip)', () => {
    const out = applyClaimFreshness(hits(), [staleRetired(0)], NOW, { ledgerUpdatedAt: NOW - 5 * DAY })
    expect(out).toEqual(hits()) // overridden to 5-day-old → skip regardless of claim stamps
  })

  it('staleThresholdMs=Infinity (gate disabled) demotes even a very old ledger', () => {
    const out = applyClaimFreshness(hits(), [staleRetired(30)], NOW, { staleThresholdMs: Number.POSITIVE_INFINITY })
    expect(out[0].file).toBe('fresh.md') // gate off → demotion applies as before
  })

  it('unknown ledger age (empty stamps) demotes — the conservative default preserves the moat', () => {
    const noStamps = claim({ id: 'r', subject: 'Beacon deadline', relation: 'status', object: 'v', notePath: 'DUIN/notes/deadline.md', validTo: NOW })
    // Force all timestamps to 0 so ledgerUpdatedAt → null (cannot judge staleness).
    noStamps.observedAt = 0; noStamps.validFrom = 0; noStamps.validTo = 0
    ;(noStamps as Claim).lastUsefulAt = undefined
    expect(ledgerUpdatedAt([noStamps])).toBeNull()
    const out = applyClaimFreshness(hits(), [noStamps], NOW)
    // validTo=0 is falsy-but-set... it's a retired claim (validTo !== null) with unknown age → demote.
    expect(out[0].file).toBe('fresh.md')
  })
})

describe('claim-recall — ledgerStaleThresholdMs env flag', () => {
  const ENV = 'DUIN_CLAIM_RECALL_STALE_H'
  it('defaults to 24h; a positive override scales; 0/off disables the gate', () => {
    delete process.env[ENV]
    expect(ledgerStaleThresholdMs()).toBe(24 * 3_600_000)
    process.env[ENV] = '6'
    expect(ledgerStaleThresholdMs()).toBe(6 * 3_600_000)
    process.env[ENV] = '0'
    expect(ledgerStaleThresholdMs()).toBe(Number.POSITIVE_INFINITY)
    process.env[ENV] = 'off'
    expect(ledgerStaleThresholdMs()).toBe(Number.POSITIVE_INFINITY)
    delete process.env[ENV]
  })
})

describe('claim-recall — flag gate', () => {
  const ENV = 'DUIN_CLAIM_RECALL'
  it('claimRecallEnabled reflects the flag (default ON; only "0" disables)', () => {
    delete process.env[ENV]
    expect(claimRecallEnabled()).toBe(true) // default ON (validated live)
    process.env[ENV] = '1'
    expect(claimRecallEnabled()).toBe(true)
    process.env[ENV] = '0'
    expect(claimRecallEnabled()).toBe(false)
    delete process.env[ENV]
  })
})

describe('claim-recall — activeClaimsForHits (reinforce-arm symmetric read)', () => {
  it('returns ACTIVE claims whose note survived in the hits; excludes retired + unmatched', () => {
    const a = claim({ id: 'a', subject: 'wafer map', relation: 'about', object: 'calib', notePath: 'notes/wafer-map.md' })
    const r = claim({ id: 'r', subject: 'wafer map', relation: 'about', object: 'x', notePath: 'notes/wafer-map.md', validTo: NOW })
    const u = claim({ id: 'u', subject: 'zzz unrelated', relation: 'about', object: 'yyy', notePath: 'notes/other.md' })
    const hits = [hit('vault/notes/wafer-map.md', 0.9, 'wafer map calibration')]
    const got = activeClaimsForHits(hits, [a, r, u])
    expect(got.map((x) => x.id)).toEqual(['a']) // 'r' retired, 'u' no matching hit
    expect(got[0].base).toBe('wafer-map.md')
  })
  it('empty hits or empty ledger → []', () => {
    expect(activeClaimsForHits([], [claim({ id: 'a', subject: 's', relation: 'about', object: 'o' })])).toEqual([])
    expect(activeClaimsForHits([hit('x.md', 1)], [])).toEqual([])
  })
})
