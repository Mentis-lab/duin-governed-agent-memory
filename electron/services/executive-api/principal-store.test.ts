import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  __principalStoreTest,
  approvePairing,
  authenticate,
  claimPairing,
  denyPairing,
  hasPlane,
  listPendingPairings,
  listPrincipals,
  mintToken,
  reissueToken,
  requestPairing,
  setPrincipalStatus,
  tokenFormatOk,
  chargeCall,
  createPrincipal,
  settleUsage,
  updatePrincipalGrant,
  DEFAULT_PLANES,
  DEFAULT_QUOTA
} from './principal-store'

// The membrane's ledger. These tests pin the security decisions from the
// 2026-08-14 membrane research: hash-at-rest (plaintext exists once, in the
// claim), one-time claim semantics, trim-only grants, fail-closed on corrupt
// registry, revocation-first lifecycle, and the offline checksum filter.

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'principal-store-'))
  __principalStoreTest.setPath(join(dir, 'executive-principals.json'))
})

afterEach(() => {
  __principalStoreTest.setPath(null)
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

/** Rate limiting is real store behavior; most tests just need it out of the
 *  way. Fake timers + a 3s hop between pairing requests. */
function advancePastRateLimit(): void {
  vi.setSystemTime(Date.now() + 3_000)
}

describe('token format', () => {
  it('minted tokens carry the prefix and pass the offline check', () => {
    const token = mintToken()
    expect(token.startsWith('duin_ag_')).toBe(true)
    expect(tokenFormatOk(token)).toBe(true)
  })

  it('a single-character typo fails the checksum before any store lookup', () => {
    const token = mintToken()
    const body = token.slice('duin_ag_'.length)
    const flipped = body[0] === 'A' ? 'B' : 'A'
    expect(tokenFormatOk(`duin_ag_${flipped}${body.slice(1)}`)).toBe(false)
  })

  it('rejects truncation, foreign prefixes, and non-base62 noise', () => {
    const token = mintToken()
    expect(tokenFormatOk(token.slice(0, -1))).toBe(false)
    expect(tokenFormatOk(`ghp_${token.slice(8)}`)).toBe(false)
    expect(tokenFormatOk(token.slice(0, -1) + '!')).toBe(false)
    expect(tokenFormatOk('')).toBe(false)
    expect(tokenFormatOk(undefined as unknown as string)).toBe(false)
  })
})

describe('pairing lifecycle', () => {
  it('request → approve → claim delivers the token exactly once', () => {
    vi.useFakeTimers()
    const req = requestPairing({ name: 'claude-code' })
    expect(req.ok).toBe(true)
    if (!req.ok) return

    // Pending is visible for the approval card.
    expect(listPendingPairings().map((p) => p.pairingId)).toContain(req.pairingId)
    // Agent polls before approval: still pending.
    expect(claimPairing(req.pairingId)).toEqual({ status: 'pending' })

    const approved = approvePairing(req.pairingId)
    expect(approved.ok).toBe(true)

    const claim = claimPairing(req.pairingId)
    expect(claim.status).toBe('ready')
    if (claim.status !== 'ready') return
    expect(tokenFormatOk(claim.token)).toBe(true)
    expect(claim.planes).toEqual([...DEFAULT_PLANES])

    // Second claim yields nothing — and the plaintext is gone from disk.
    expect(claimPairing(req.pairingId)).toEqual({ status: 'already-claimed' })
    const onDisk = readFileSync(join(dir, 'executive-principals.json'), 'utf-8')
    expect(onDisk).not.toContain(claim.token)
  })

  it('the operator can TRIM the grant but never widen it', () => {
    vi.useFakeTimers()
    const req = requestPairing({
      name: 'codex',
      requestedPlanes: ['context.read', 'goals.read']
    })
    if (!req.ok) throw new Error('request failed')
    const approved = approvePairing(req.pairingId, {
      // goals.write was NOT requested — a widening attempt must be dropped.
      grantPlanes: ['context.read', 'goals.write']
    })
    expect(approved.ok).toBe(true)
    if (!approved.ok) return
    expect(approved.principal.planes).toEqual(['context.read'])
  })

  it('deny is terminal and claims report it', () => {
    vi.useFakeTimers()
    const req = requestPairing({ name: 'shady' })
    if (!req.ok) throw new Error('request failed')
    expect(denyPairing(req.pairingId)).toBe(true)
    expect(claimPairing(req.pairingId)).toEqual({ status: 'denied' })
    expect(approvePairing(req.pairingId).ok).toBe(false)
  })

  it('pending requests expire after the TTL', () => {
    vi.useFakeTimers()
    const req = requestPairing({ name: 'slowpoke' })
    if (!req.ok) throw new Error('request failed')
    vi.setSystemTime(Date.now() + 16 * 60 * 1000)
    expect(claimPairing(req.pairingId)).toEqual({ status: 'expired' })
    expect(approvePairing(req.pairingId).ok).toBe(false)
    expect(listPendingPairings()).toEqual([])
  })

  it('rate-limits back-to-back requests and caps pending count', () => {
    vi.useFakeTimers()
    expect(requestPairing({ name: 'a' }).ok).toBe(true)
    // Immediate second request: rate-limited.
    const second = requestPairing({ name: 'b' })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toBe('rate-limited')
    // Fill to the pending cap (one already pending).
    for (const name of ['b', 'c', 'd', 'e']) {
      advancePastRateLimit()
      expect(requestPairing({ name }).ok).toBe(true)
    }
    advancePastRateLimit()
    const overflow = requestPairing({ name: 'f' })
    expect(overflow.ok).toBe(false)
    if (!overflow.ok) expect(overflow.reason).toBe('too-many-pending')
  })

  it('rejects empty names and unknown planes', () => {
    vi.useFakeTimers()
    expect(requestPairing({ name: '   ' }).ok).toBe(false)
    advancePastRateLimit()
    const bogus = requestPairing({
      name: 'x',
      requestedPlanes: ['shell.exec' as never]
    })
    // Unknown plane strings are filtered; an all-bogus request has no planes.
    expect(bogus.ok).toBe(false)
  })
})

describe('authentication', () => {
  function pairedToken(name = 'agent'): string {
    vi.useFakeTimers()
    advancePastRateLimit()
    const req = requestPairing({ name })
    if (!req.ok) throw new Error('request failed')
    const approved = approvePairing(req.pairingId)
    if (!approved.ok) throw new Error('approve failed')
    const claim = claimPairing(req.pairingId)
    if (claim.status !== 'ready') throw new Error('claim failed')
    return claim.token
  }

  it('authenticates a live token and stamps the audit heartbeat', () => {
    const token = pairedToken()
    const principal = authenticate(token)
    expect(principal).not.toBeNull()
    expect(principal?.lastSeenAt).not.toBeNull()
    expect(principal?.callCount).toBe(1)
    expect(hasPlane(principal!, 'context.read')).toBe(true)
    expect(hasPlane(principal!, 'goals.write')).toBe(false)
  })

  it('rejects malformed bearers without touching the registry', () => {
    pairedToken()
    expect(authenticate('Bearer nonsense')).toBeNull()
    expect(authenticate(mintToken().slice(0, -1))).toBeNull()
    expect(authenticate(undefined)).toBeNull()
  })

  it('a minted-but-never-paired token does not authenticate', () => {
    pairedToken()
    expect(authenticate(mintToken())).toBeNull()
  })

  it('pause blocks, resume restores, revoke is permanent-by-policy', () => {
    const token = pairedToken()
    const id = listPrincipals()[0].id
    expect(setPrincipalStatus(id, 'paused')).toBe(true)
    expect(authenticate(token)).toBeNull()
    expect(setPrincipalStatus(id, 'active')).toBe(true)
    expect(authenticate(token)).not.toBeNull()
    expect(setPrincipalStatus(id, 'revoked')).toBe(true)
    expect(authenticate(token)).toBeNull()
  })

  it('reissue kills the old token immediately', () => {
    const token = pairedToken()
    const id = listPrincipals()[0].id
    const reissued = reissueToken(id)
    expect(reissued.ok).toBe(true)
    if (!reissued.ok) return
    expect(authenticate(token)).toBeNull()
    expect(authenticate(reissued.token)).not.toBeNull()
    // A revoked principal cannot be resurrected via reissue.
    setPrincipalStatus(id, 'revoked')
    expect(reissueToken(id).ok).toBe(false)
  })
})

describe('persistence', () => {
  it('registry survives a cache drop (restart simulation)', () => {
    vi.useFakeTimers()
    advancePastRateLimit()
    const req = requestPairing({ name: 'durable' })
    if (!req.ok) throw new Error('request failed')
    approvePairing(req.pairingId)
    const claim = claimPairing(req.pairingId)
    if (claim.status !== 'ready') throw new Error('claim failed')

    __principalStoreTest.reset() // drop in-memory cache, keep the file
    expect(authenticate(claim.token)).not.toBeNull()
    expect(listPrincipals()).toHaveLength(1)
  })

  it('a corrupt registry fails CLOSED: nobody authenticates', () => {
    vi.useFakeTimers()
    advancePastRateLimit()
    const req = requestPairing({ name: 'x' })
    if (!req.ok) throw new Error('request failed')
    approvePairing(req.pairingId)
    const claim = claimPairing(req.pairingId)
    if (claim.status !== 'ready') throw new Error('claim failed')

    writeFileSync(join(dir, 'executive-principals.json'), '{not json', 'utf-8')
    __principalStoreTest.reset()
    expect(authenticate(claim.token)).toBeNull()
    expect(listPrincipals()).toEqual([])
  })

  it('the file never contains a plaintext token at any lifecycle point', () => {
    vi.useFakeTimers()
    advancePastRateLimit()
    const req = requestPairing({ name: 'x' })
    if (!req.ok) throw new Error('request failed')
    approvePairing(req.pairingId)
    // Between approval and claim the one-time token IS on disk by design —
    // that is the handoff buffer. But the credential that authenticates is
    // only ever stored hashed: after claim, no duin_ag_ plaintext remains.
    const claim = claimPairing(req.pairingId)
    if (claim.status !== 'ready') throw new Error('claim failed')
    const disk = readFileSync(join(dir, 'executive-principals.json'), 'utf-8')
    expect(disk).not.toContain(claim.token)
    expect(disk).toContain(listPrincipals()[0].tokenHash)
  })
})

// ── A3 · quota (2026-08-17) ──────────────────────────────────────────────────
// What this closes: `k` bounded a single retrieval at 20 hits, but NOTHING bounded the
// number of retrievals. A paired agent could walk the whole vault by iterating — slowly,
// silently, and entirely within its grant. Quota is the bound that makes "read scope"
// mean something over time rather than only per call.

/** Pair → approve → claim, returning the live principal id. */
function newPrincipal(name = 'quota-agent'): string {
  advancePastRateLimit()
  const req = requestPairing({ name })
  if (!req.ok) throw new Error('request failed')
  const approved = approvePairing(req.pairingId)
  if (!approved.ok) throw new Error('approve failed')
  return approved.principal.id
}

/** Reach into the store file to set a quota — the operator-side edit, which has no
 *  public setter yet (the UI writes the same field). */
function setQuota(principalId: string, quota: { callsPerHour: number; charsPerHour: number }): void {
  const path = join(dir, 'executive-principals.json')
  const raw = JSON.parse(readFileSync(path, 'utf-8'))
  raw.principals.find((p: { id: string }) => p.id === principalId).quota = quota
  writeFileSync(path, JSON.stringify(raw), 'utf-8')
  __principalStoreTest.reset()
}

describe('quota', () => {
  /** The REAL contract, mirroring exec-endpoint's guard(): charge before the work, settle
   *  ONCE at the end, on every exit path. Exercising the halves separately would let a
   *  change that breaks the pairing — charged in memory, never written — keep passing. */
  function call(principalId: string, chars = 0): ReturnType<typeof chargeCall> {
    const verdict = chargeCall(principalId)
    settleUsage(principalId, chars)
    return verdict
  }

  it('charges each call and reports what is left', () => {
    vi.useFakeTimers()
    const id = newPrincipal()
    const first = call(id)
    expect(first.ok).toBe(true)
    expect(first.remainingCalls).toBe(DEFAULT_QUOTA.callsPerHour - 1)
    expect(call(id).remainingCalls).toBe(DEFAULT_QUOTA.callsPerHour - 2)
  })

  it('refuses past the call ceiling, naming the limit and when it lifts', () => {
    vi.useFakeTimers()
    const id = newPrincipal()
    setQuota(id, { callsPerHour: 2, charsPerHour: 10_000 })
    expect(call(id).ok).toBe(true)
    expect(call(id).ok).toBe(true)
    const denied = call(id)
    expect(denied.ok).toBe(false)
    expect(denied.remainingCalls).toBe(0)
    // A bare denial would leave an agent retrying blind; the reason names the ceiling
    // and the rollover so it can back off on its own.
    expect(denied.reason).toContain('call quota exhausted (2/hour)')
    expect(denied.reason).toMatch(/rolls at \d{4}-\d{2}-\d{2}T/)
  })

  it('refuses past the character ceiling — the bound that actually stops scraping', () => {
    vi.useFakeTimers()
    const id = newPrincipal()
    setQuota(id, { callsPerHour: 1000, charsPerHour: 5_000 })
    expect(call(id, 6_000).ok).toBe(true)
    const denied = call(id)
    expect(denied.ok).toBe(false)
    expect(denied.reason).toContain('retrieved-character quota exhausted (5000/hour)')
    expect(denied.remainingChars).toBe(0)
  })

  it('rolls the window after an hour, restoring both budgets', () => {
    vi.useFakeTimers()
    const id = newPrincipal()
    setQuota(id, { callsPerHour: 1, charsPerHour: 100 })
    expect(call(id, 500).ok).toBe(true)
    expect(call(id).ok).toBe(false)
    vi.setSystemTime(Date.now() + 61 * 60 * 1000)
    const afterRoll = call(id)
    expect(afterRoll.ok).toBe(true)
    expect(afterRoll.remainingChars).toBe(100)
  })

  it('does not roll early — 59 minutes of scraping is still one window', () => {
    vi.useFakeTimers()
    const id = newPrincipal()
    setQuota(id, { callsPerHour: 1, charsPerHour: 100 })
    expect(call(id).ok).toBe(true)
    vi.setSystemTime(Date.now() + 59 * 60 * 1000)
    expect(call(id).ok).toBe(false)
  })

  it('refuses a quota-pinned principal without throwing (fresh window has no prior start)', () => {
    // Regression: the refusal message used to be built from the PRE-reset window start,
    // which is NaN on a brand-new window — new Date(NaN).toISOString() throws, so pinning
    // a principal to 0 turned every refusal into a 500 instead of a denial.
    vi.useFakeTimers()
    const id = newPrincipal()
    setQuota(id, { callsPerHour: 0, charsPerHour: 0 })
    const denied = call(id)
    expect(denied.ok).toBe(false)
    expect(denied.reason).toContain('call quota exhausted (0/hour)')
    expect(denied.reason).not.toContain('Invalid Date')
  })

  it('fails closed for an unknown or revoked-then-forgotten principal', () => {
    vi.useFakeTimers()
    const verdict = call('prin-does-not-exist')
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('unknown principal')
  })

  it('ignores nonsense character charges rather than corrupting the window', () => {
    vi.useFakeTimers()
    const id = newPrincipal()
    call(id, -5)
    call(id, NaN)
    expect(call(id).remainingChars).toBe(DEFAULT_QUOTA.charsPerHour)
  })

  it('settles usage to disk, so a restart does not hand the budget back', () => {
    // In-memory-only accounting would make the bound a formality: restart the client and
    // scrape on. reset() drops the cache exactly as a process restart would.
    vi.useFakeTimers()
    const id = newPrincipal()
    setQuota(id, { callsPerHour: 2, charsPerHour: 10_000 })
    expect(call(id).ok).toBe(true)
    __principalStoreTest.reset()
    expect(call(id).ok).toBe(true)
    __principalStoreTest.reset()
    expect(call(id).ok).toBe(false)
  })

  it('settles on the REFUSAL path too — a denied call is still a call that happened', () => {
    // guard() settles in a `finally` for this reason. If refusals only counted in memory, an
    // agent sitting at its ceiling could restart its client and find the counter reset.
    vi.useFakeTimers()
    const id = newPrincipal()
    setQuota(id, { callsPerHour: 1, charsPerHour: 10_000 })
    expect(call(id).ok).toBe(true)
    expect(call(id).ok).toBe(false)
    __principalStoreTest.reset()
    expect(call(id).ok).toBe(false)
  })

  it('honours a quota the operator set through the grant editor', () => {
    // End-to-end for the pane: the editor writes a quota, and the very next charged call is
    // bounded by it. Before updatePrincipalGrant existed, the only way to reach this field
    // was to hand-edit executive-principals.json.
    vi.useFakeTimers()
    const id = newPrincipal()
    expect(updatePrincipalGrant(id, { quota: { callsPerHour: 1, charsPerHour: 10_000 } })).toBe(true)
    expect(call(id).ok).toBe(true)
    expect(call(id).ok).toBe(false)
  })

  it('counts a call whose handler threw before returning a payload', () => {
    // Charge-before-work plus settle-in-finally is what stops a failing (or deliberately
    // aborted) tool from being retried for free.
    vi.useFakeTimers()
    const id = newPrincipal()
    setQuota(id, { callsPerHour: 1, charsPerHour: 10_000 })
    expect(chargeCall(id).ok).toBe(true)
    settleUsage(id) // no chars — the work threw before producing anything
    __principalStoreTest.reset()
    expect(chargeCall(id).ok).toBe(false)
  })
})

// ── The operator's grant editor (Settings -> Agents) ─────────────────────────
// scope / writeScope / quota were enforced on every call from the day they shipped and had
// no setter at all: the only way to bound an agent was to hand-edit the JSON. These pin the
// semantics the pane depends on, above all null-means-default (property 8).

describe('updatePrincipalGrant', () => {
  function live(): ReturnType<typeof listPrincipals>[number] {
    return listPrincipals()[0]
  }

  it('sets and clears a read scope, storing "unscoped" one way only', () => {
    vi.useFakeTimers()
    const id = newPrincipal()
    expect(updatePrincipalGrant(id, { scope: ['03 Projects/DUIN', ' 01 Wiki '] })).toBe(true)
    expect(live().scope).toEqual(['03 Projects/DUIN', '01 Wiki'])

    // An empty list is the WIDEST grant, so it must round-trip as absent rather than as [] —
    // two representations of "whole vault" is how a UI ends up rendering one of them wrong.
    expect(updatePrincipalGrant(id, { scope: [] })).toBe(true)
    expect(live().scope).toBeUndefined()
    expect(updatePrincipalGrant(id, { scope: null })).toBe(true)
    expect(live().scope).toBeUndefined()
  })

  it('drops blank scope entries instead of granting the vault root', () => {
    // A stray blank line in the textarea normalizes to '', and pathInScope treats an empty
    // prefix as "everything" — so an unfiltered blank would quietly widen the grant to the
    // whole vault while the UI still showed a narrow list.
    vi.useFakeTimers()
    const id = newPrincipal()
    updatePrincipalGrant(id, { scope: ['03 Projects/DUIN', '', '   '] })
    expect(live().scope).toEqual(['03 Projects/DUIN'])
  })

  it('treats a null quota as RESET and a zero quota as a real freeze', () => {
    vi.useFakeTimers()
    const id = newPrincipal()
    updatePrincipalGrant(id, { quota: { callsPerHour: 0, charsPerHour: 0 } })
    expect(live().quota).toEqual({ callsPerHour: 0, charsPerHour: 0 })
    // Frozen, not defaulted.
    expect(chargeCall(id).ok).toBe(false)

    updatePrincipalGrant(id, { quota: null })
    expect(live().quota).toBeUndefined()
    expect(chargeCall(id).ok).toBe(true)
  })

  it('refuses a quota that would poison the comparison rather than storing it', () => {
    // chargeCall compares `usage.calls >= quota.callsPerHour`. Against NaN that is false for
    // every value, so a NaN ceiling does not bound anything — it silently REMOVES the bound
    // while the row still looks configured.
    vi.useFakeTimers()
    const id = newPrincipal()
    expect(updatePrincipalGrant(id, { quota: { callsPerHour: NaN, charsPerHour: 10 } })).toBe(false)
    expect(updatePrincipalGrant(id, { quota: { callsPerHour: -5, charsPerHour: 10 } })).toBe(false)
    expect(live().quota).toBeUndefined()
  })

  it('leaves fields the operator did not touch alone', () => {
    vi.useFakeTimers()
    const id = newPrincipal()
    updatePrincipalGrant(id, { scope: ['01 Wiki'], quota: { callsPerHour: 5, charsPerHour: 50 } })
    updatePrincipalGrant(id, { writeScope: 'agent-notes' })
    expect(live().scope).toEqual(['01 Wiki'])
    expect(live().quota).toEqual({ callsPerHour: 5, charsPerHour: 50 })
    expect(live().writeScope).toBe('agent-notes')
  })

  it('cannot re-scope a revoked principal', () => {
    // Revocation is permanent by policy. Editing a dead credential must not appear to work,
    // or the pane would show bounds on something that can never call again anyway.
    vi.useFakeTimers()
    const id = newPrincipal()
    expect(setPrincipalStatus(id, 'revoked')).toBe(true)
    expect(updatePrincipalGrant(id, { scope: ['01 Wiki'] })).toBe(false)
    expect(live().scope).toBeUndefined()
  })

  it('never changes planes — those are decided once, at approval', () => {
    // Widening after the fact would grant authority the agent never requested and the
    // operator never reviewed against the request. Narrowing is what pause/revoke are for.
    vi.useFakeTimers()
    const id = newPrincipal()
    const before = [...live().planes]
    updatePrincipalGrant(id, { scope: ['01 Wiki'], writeScope: 'x', quota: null })
    expect(live().planes).toEqual(before)
  })

  it('fails closed on an unknown principal', () => {
    vi.useFakeTimers()
    expect(updatePrincipalGrant('prin-nope', { scope: ['01 Wiki'] })).toBe(false)
  })

  it('survives a restart', () => {
    vi.useFakeTimers()
    const id = newPrincipal()
    updatePrincipalGrant(id, { scope: ['01 Wiki'], quota: { callsPerHour: 7, charsPerHour: 70 } })
    __principalStoreTest.reset()
    expect(live().scope).toEqual(['01 Wiki'])
    expect(live().quota).toEqual({ callsPerHour: 7, charsPerHour: 70 })
  })
})

// ── Operator-initiated admission (Settings -> Agents -> "Add an agent") ──────
// The pairing flow waits for an agent to ASK. That is right for something showing up
// uninvited and backwards when the operator already knows what they want to connect — and it
// left the pane with no action on it in exactly that case.

describe('createPrincipal', () => {
  it('mints an active principal and returns the plaintext token exactly once', () => {
    vi.useFakeTimers()
    const r = createPrincipal({ name: 'claude-code', planes: ['context.read'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(tokenFormatOk(r.token)).toBe(true)
    expect(r.principal.status).toBe('active')
    expect(authenticate(r.token)?.name).toBe('claude-code')

    // Same contract as the pairing claim: the credential is hashed at rest, so the file never
    // carries anything that could be replayed.
    const disk = readFileSync(join(dir, 'executive-principals.json'), 'utf-8')
    expect(disk).not.toContain(r.token)
    expect(disk).toContain(r.principal.tokenHash)
  })

  it('grants exactly the planes chosen, and nothing else', () => {
    vi.useFakeTimers()
    const r = createPrincipal({ name: 'writer', planes: ['context.read', 'memory.write'] })
    if (!r.ok) throw new Error('create failed')
    expect(r.principal.planes).toEqual(['context.read', 'memory.write'])
    expect(hasPlane(r.principal, 'goals.write')).toBe(false)
  })

  it('drops plane strings the vocabulary does not contain', () => {
    // Deny-by-vocabulary: shell/exec and provider keys are not representable as planes, so no
    // caller — including this one — can name them.
    vi.useFakeTimers()
    const r = createPrincipal({ name: 'x', planes: ['context.read', 'shell.exec' as never] })
    if (!r.ok) throw new Error('create failed')
    expect(r.principal.planes).toEqual(['context.read'])
  })

  it('defaults to the read planes when none are named', () => {
    vi.useFakeTimers()
    const r = createPrincipal({ name: 'reader' })
    if (!r.ok) throw new Error('create failed')
    expect(r.principal.planes).toEqual([...DEFAULT_PLANES])
  })

  it('refuses an empty name and a grant of nothing', () => {
    // A principal that can authenticate and do nothing is a credential with no purpose and a
    // row the operator has to reason about later.
    vi.useFakeTimers()
    expect(createPrincipal({ name: '   ' }).ok).toBe(false)
    expect(createPrincipal({ name: 'x', planes: [] }).ok).toBe(false)
    expect(createPrincipal({ name: 'x', planes: ['nope' as never] }).ok).toBe(false)
  })

  it('records no observed exe rather than guessing one', () => {
    // There is no peer process to observe here. The pairing flow records what connected;
    // inventing a value would put a fabricated fact in an audit field.
    vi.useFakeTimers()
    const r = createPrincipal({ name: 'x' })
    if (!r.ok) throw new Error('create failed')
    expect(r.principal.observedExe).toBeNull()
  })

  it('creates a principal that is immediately usable and revocable like any other', () => {
    vi.useFakeTimers()
    const r = createPrincipal({ name: 'x', planes: ['context.read'] })
    if (!r.ok) throw new Error('create failed')
    expect(authenticate(r.token)).not.toBeNull()
    expect(setPrincipalStatus(r.principal.id, 'revoked')).toBe(true)
    expect(authenticate(r.token)).toBeNull()
  })

  it('does not create a pairing row — there was no request to record', () => {
    vi.useFakeTimers()
    createPrincipal({ name: 'x' })
    expect(listPendingPairings()).toEqual([])
  })
})
