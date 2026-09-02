import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  governDecision,
  runGovernPass,
  __resetKeylessRatifyAnnounce,
  type GovernJury,
  refreshKeylessRatifyCard
} from './operator-govern'
import {
  recordFacts,
  promoteFact,
  noteSession,
  confirmFact,
  getOperatorFacts,
  listByStatus,
  __resetOperatorModel,
  ratifyFact
} from './operator-model'
import { setNoticesPath, listNotices, __resetNotices } from '../proactive/notices-store'

// W3 (posture 2026-08-21, I3 "use is the only promotion currency"): the keyless survival
// branch — no jury, tenure alone — no longer CONFIRMS. It ASKS: outcome 'ratify' holds the
// fact provisional and a single deduped Needs-you card points at the Learning surface where
// promote/revert already exist. The old "keyless can never promote anything" premise died
// when the ratify surface shipped (W2); DUIN_CAUSAL_CREDIT=0 restores legacy confirm.
// This branch is not only fresh installs: on a KEYED install, confidential facts
// firewall-abstain into it (juryPass null), so tenure-only promotion of the most sensitive
// pool is exactly what this closes.

const P = { minSessions: 2, minSessionsKeyless: 4 }
let noticesDir: string

beforeEach(() => {
  __resetOperatorModel()
  __resetNotices()
  __resetKeylessRatifyAnnounce()
  noticesDir = mkdtempSync(join(tmpdir(), 'govern-ratify-'))
  setNoticesPath(noticesDir)
  delete process.env.DUIN_CAUSAL_CREDIT // default = armed
})
afterEach(() => {
  delete process.env.DUIN_CAUSAL_CREDIT
  try { rmSync(noticesDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

function provisionalFact(fact: string, sessions: string[]): string {
  recordFacts([{ fact }])
  const id = getOperatorFacts().find((f) => f.fact === fact)!.id
  promoteFact(id)
  for (const s of sessions) noteSession(s)
  return id
}

const keylessJury: GovernJury = async () => null

describe('governDecision — keyless bar now asks instead of confirming', () => {
  it('keyless at the bar → ratify; below it → hold; a measured block still holds', () => {
    expect(governDecision({ sessionsObserved: 4, juryPass: null }, P)).toBe('ratify')
    expect(governDecision({ sessionsObserved: 3, juryPass: null }, P)).toBe('hold')
    expect(governDecision({ sessionsObserved: 4, juryPass: null, behavioralFlip: false }, P)).toBe('hold')
  })

  it('the keyed path is untouched', () => {
    expect(governDecision({ sessionsObserved: 2, juryPass: true }, P)).toBe('confirm')
    expect(governDecision({ sessionsObserved: 9, juryPass: false }, P)).toBe('revert')
  })
})

describe('runGovernPass — keyless candidates park as a ratify question', () => {
  it('holds the fact provisional, counts awaitingRatify, and files ONE deduped Needs-you card', async () => {
    provisionalFact('keyless survivor', ['s1', 's2', 's3', 's4'])
    const r = await runGovernPass(keylessJury, P)
    expect(r.confirmed).toBe(0)
    expect(r.awaitingRatify).toBe(1)
    expect(listByStatus('provisional').map((f) => f.fact)).toContain('keyless survivor')
    const owed = listNotices().filter((n) => n.needsDecision && n.resolvedAt === null)
    expect(owed).toHaveLength(1)
    expect(owed[0].actionId).toBe('govern:keyless-review')
    expect(owed[0].deepLink).toBe('duin://tool/learning') // W5: Learning has Ratify/Veto now
    // a second pass over the SAME pending set does not stack or re-bump a second card
    const r2 = await runGovernPass(keylessJury, P)
    expect(r2.awaitingRatify).toBe(1)
    expect(listNotices().filter((n) => n.actionId === 'govern:keyless-review')).toHaveLength(1)
  })

  it('clears the card once the operator drains the queue (self-resolving, never a guilt pile)', async () => {
    const id = provisionalFact('keyless survivor', ['s1', 's2', 's3', 's4'])
    await runGovernPass(keylessJury, P)
    confirmFact(id) // the operator promoted it in the Learning surface
    const r = await runGovernPass(keylessJury, P)
    expect(r.awaitingRatify).toBe(0)
    const card = listNotices().find((n) => n.actionId === 'govern:keyless-review')
    expect(card?.resolvedAt).not.toBeNull()
  })

  it('DUIN_CAUSAL_CREDIT=0 restores the legacy keyless confirm, no card', async () => {
    process.env.DUIN_CAUSAL_CREDIT = '0'
    provisionalFact('legacy survivor', ['s1', 's2', 's3', 's4'])
    const r = await runGovernPass(keylessJury, P)
    expect(r.confirmed).toBe(1)
    expect(r.awaitingRatify).toBe(0)
    expect(listByStatus('promoted').map((f) => f.fact)).toContain('legacy survivor')
    expect(listNotices()).toHaveLength(0)
  })
})

// W5 — a ratify or veto from the UI must settle the card AT ONCE, not at the next 30-minute tick.
describe('W5 — refreshKeylessRatifyCard settles the card as soon as the queue drains', () => {
  it('resolves the card right after the operator ratifies the last awaiting fact', async () => {
    const id = provisionalFact('keyless survivor', ['s1', 's2', 's3', 's4'])
    await runGovernPass(keylessJury, P)
    expect(listNotices().find((n) => n.actionId === 'govern:keyless-review')?.resolvedAt).toBeNull()
    expect(ratifyFact(id)).toBe(true)
    expect(refreshKeylessRatifyCard()).toBe(0)
    expect(listNotices().find((n) => n.actionId === 'govern:keyless-review')?.resolvedAt).not.toBeNull()
    expect(listByStatus('promoted').map((f) => f.fact)).toContain('keyless survivor')
  })
})
