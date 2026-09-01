// Regression: saveLedger's size cap must NOT evict operator-ruled rows by array position.
//
// DEFECT: saveLedger capped with `claims.slice(-MAX_LEDGER_CLAIMS)` — pure position, no isPinned
// check, no tombstone, and the write is writeFileSync(tmp)+renameSync (whole-file overwrite). Every
// other stage of the pipeline guards pins explicitly (mergeLedger, runVerdicts,
// applySupersessionGuards, reconcileLedgerForPersist's pin re-injection); the actual WRITER was the
// sole site with none.
//
// WHY THE EXISTING GUARDS DON'T COVER IT: reconcileLedgerForPersist returns
// [...toPersist, ...rescuedPins]. RESCUED pins sit in the tail and survive slice(-5000). A pin that
// DID survive extraction sits at an arbitrary position inside toPersist, and slice(-5000) cuts the
// HEAD of toPersist. Both the wipe-guard and the pin re-injection run strictly before the cap.
//
// UNRECOVERABLE: the claim row is re-derivable from the vault, but `reviewState` is operator-authored
// and exists nowhere else. After the cut the next tick re-extracts the claim unpinned and the
// deterministic pass re-applies exactly the retirement the operator reverted — contradicting
// resolveClaimReview's documented moat-reversibility promise that "the decision survives every tick".
//
// REACHABLE: the wipe-guard comment at claim-extract.ts records this same vault's ledger holding
// 4821 rows (96% of the 5000 cap) after a moat-restore.

import { describe, it, expect, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { rmSync, mkdirSync, existsSync } from 'fs'
import { loadLedger, saveLedger, loadLedgerEvictions, capLedgerClaims } from './claim-ledger'
import { classifyMutability, isPinned, unretire, type Claim } from './claim-metabolism'
import { mergeLedger, resolveClaimReview } from './claim-extract'

const NOW = Date.UTC(2026, 6, 20)
const MAX_LEDGER_CLAIMS = 5000

let dirs: string[] = []
function freshVault(tag: string): string {
  const d = join(tmpdir(), `claim-ledger-cap-${tag}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(d, '.duin', '_state'), { recursive: true })
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

function claim(id: string, over: Partial<Claim> = {}): Claim {
  return {
    id, chunkId: `c-${id}`, notePath: `${id}.md`, subject: `subject-${id}`, relation: 'status',
    object: `object-${id}`, validFrom: NOW, validTo: null, observedAt: NOW, supersededBy: null,
    mutability: classifyMutability('status'), justifications: [], verdict: 'current', verdictBy: null,
    ...over
  }
}

/** An over-cap ledger whose operator-ruled row sits in the HEAD — the region slice(-N) cuts. */
function overCapWithRuledHead(n: number, ruledIndex: number): { ledger: Claim[]; ruledId: string } {
  const ledger = Array.from({ length: n }, (_, i) => claim(`k${i}`))
  const ruled = ledger[ruledIndex]
  unretire(ruled) // exactly what applyClaimResolution('revert') does → reviewState 'reverted'
  expect(isPinned(ruled)).toBe(true)
  return { ledger, ruledId: ruled.id }
}

describe('saveLedger cap — operator-ruled rows', () => {
  it('keeps a head-positioned pinned claim when the ledger is over the cap', () => {
    const dir = freshVault('head-pin')
    const { ledger, ruledId } = overCapWithRuledHead(MAX_LEDGER_CLAIMS + 200, 10)

    saveLedger(dir, ledger, NOW)

    const back = loadLedger(dir)
    expect(back.length).toBe(MAX_LEDGER_CLAIMS) // still capped — this is not "cap removed"
    const survivor = back.find((c) => c.id === ruledId)
    expect(survivor).toBeDefined()
    expect(survivor!.reviewState).toBe('reverted')
    expect(isPinned(survivor!)).toBe(true)
  })

  it('recording the operator ruling does not destroy it (resolve → save on an over-cap ledger)', () => {
    const dir = freshVault('resolve')
    // The sharper scenario: no tick needed. applyClaimResolution = resolveClaimReview + saveLedger.
    const ledger = Array.from({ length: MAX_LEDGER_CLAIMS + 50 }, (_, i) => claim(`m${i}`))
    const target = ledger[3] // head position
    target.validTo = NOW
    target.verdict = 'stale'
    target.verdictBy = 'temporal'

    const res = resolveClaimReview(ledger, 'm3', 'revert')
    expect(res.ok).toBe(true)
    saveLedger(dir, res.ledger, NOW)

    const back = loadLedger(dir)
    const survivor = back.find((c) => c.id === 'm3')
    expect(survivor).toBeDefined()
    expect(survivor!.reviewState).toBe('reverted')
    expect(survivor!.validTo).toBeNull() // the reversal itself survived, not just the row
  })

  it('the pin still suppresses re-retirement on the NEXT tick (mergeLedger carries it)', () => {
    const dir = freshVault('next-tick')
    const { ledger, ruledId } = overCapWithRuledHead(MAX_LEDGER_CLAIMS + 200, 10)
    saveLedger(dir, ledger, NOW)

    // Next tick: fresh extraction presents every claim as un-ruled `current`.
    const fresh = ledger.map((c) => claim(c.id))
    const merged = mergeLedger(loadLedger(dir), fresh)

    const carried = merged.find((c) => c.id === ruledId)
    expect(carried).toBeDefined()
    expect(isPinned(carried!)).toBe(true) // without the fix the row is gone → re-extracted unpinned
  })

  it('protects operatorAuthored rows too', () => {
    const dir = freshVault('operator-authored')
    const ledger = Array.from({ length: MAX_LEDGER_CLAIMS + 100 }, (_, i) => claim(`o${i}`))
    ledger[5].operatorAuthored = true

    saveLedger(dir, ledger, NOW)

    expect(loadLedger(dir).some((c) => c.id === 'o5')).toBe(true)
  })

  it('tombstones what the cap dropped instead of deleting it silently', () => {
    const dir = freshVault('tombstone')
    const ledger = Array.from({ length: MAX_LEDGER_CLAIMS + 3 }, (_, i) => claim(`t${i}`))

    saveLedger(dir, ledger, NOW)

    const log = loadLedgerEvictions(dir)
    expect(log.length).toBe(3)
    expect(log.map((e) => e.claim.id)).toEqual(['t0', 't1', 't2']) // oldest unprotected rows
    expect(log[0].evictedAt).toBe(NOW)
    expect(log[0].reason).toBe('cap')
    expect(log[0].claim.subject).toBe('subject-t0') // full row retained, not just an id
  })

  it('does not write a tombstone file when nothing was evicted', () => {
    const dir = freshVault('no-evict')
    saveLedger(dir, [claim('a'), claim('b')], NOW)
    expect(existsSync(join(dir, '.duin', '_state', 'claim-ledger-evictions.jsonl'))).toBe(false)
    expect(loadLedgerEvictions(dir)).toEqual([])
  })
})

describe('capLedgerClaims — pure cap semantics', () => {
  it('spends the cap on protected rows and trims only the unprotected remainder', () => {
    const claims = Array.from({ length: 10 }, (_, i) => claim(`c${i}`))
    unretire(claims[0])
    unretire(claims[1])
    const { kept, evicted } = capLedgerClaims(claims, 5)
    expect(kept.length).toBe(5)
    expect(kept.map((c) => c.id)).toEqual(['c0', 'c1', 'c7', 'c8', 'c9']) // order preserved
    expect(evicted.map((c) => c.id)).toEqual(['c2', 'c3', 'c4', 'c5', 'c6'])
  })

  it('keeps every protected row even when they alone exceed the cap (capacity is the soft budget)', () => {
    const claims = Array.from({ length: 6 }, (_, i) => claim(`p${i}`))
    for (const c of claims) unretire(c)
    const { kept, evicted } = capLedgerClaims(claims, 3)
    expect(kept.length).toBe(6)
    expect(evicted).toEqual([])
  })

  it('is a no-op under the cap', () => {
    const claims = [claim('x'), claim('y')]
    const { kept, evicted } = capLedgerClaims(claims, 5)
    expect(kept).toBe(claims)
    expect(evicted).toEqual([])
  })
})
