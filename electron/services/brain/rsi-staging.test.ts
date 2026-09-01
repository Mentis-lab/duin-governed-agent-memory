import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Split-gate posture (R3, 2026-08-22): the engage tick applies at earned tier only when
// backgroundAutonomy is on, via autonomyOn() → readSettings(). Mock it so the graduated-class
// tests control the master switch deterministically; default false (staging posture).
let mockBackgroundAutonomy = false
vi.mock('../settings-helper', () => ({
  readSettings: () => ({ backgroundAutonomy: mockBackgroundAutonomy })
}))
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { proposeChange, proposeNextRsiKnob, type RsiChangeSpec } from './rsi-proposer'
import { readRsiTunables, rsiTunablesPath } from './rsi-tunables'
import { loadInflight, inflightForEngine, recordVerdict, tierFor, GRADUATE_N, upsertInflight, type InflightChange } from './self-improve-registry'
import { adjudicateInflight, ratifyProposed, dismissProposed, applyChange } from './self-improve-loop'
import { selfImproveEngageTick, __resetEngageDebounce } from './self-improve-tick'
import { setNoticesPath, listNotices, resolveByActionId, __resetNotices } from '../proactive/notices-store'

// W2 "considerate RSI" — posture directive 2026-08-21: below earned tier the loop STAGES
// (ledger row + Needs-you card) and never touches the target file; ratify applies; dismiss
// parks without re-nagging. The loop advances at ENGAGE time, presence being the gate.

const NOW = '2026-08-21T00:00:00.000Z'
let vault: string
const cfg = (): string => join(vault, '.duin', 'rsi-cfg.json')
const spec = (over: Partial<RsiChangeSpec> = {}): RsiChangeSpec => ({
  changeClass: 'grounding-weight', engine: 'risk', targetPath: cfg(), afterBytes: '{"w":0.6}', ...over,
})

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'rsi-stage-'))
  mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
})
afterEach(() => {
  try { rmSync(vault, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('stage-don\'t-apply (posture I1: no self-modification without presence)', () => {
  it('proposeChange with stage:true records a proposed row and does NOT write the target', () => {
    const r = proposeChange(vault, spec(), NOW, { stage: true })
    expect(r.staged).toBe(true)
    expect(r.reason).toMatch(/ratif/i)
    const rows = loadInflight(vault)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('proposed')
    expect(rows[0].appliedAt).toBeUndefined()
    expect(existsSync(cfg())).toBe(false) // the write is the ratify's to make
  })

  it('a staged row still holds the one-in-flight-per-engine slot', () => {
    proposeChange(vault, spec(), NOW, { stage: true })
    const r2 = proposeChange(vault, spec({ changeClass: 'other', afterBytes: '{"w":0.7}' }), NOW)
    expect(r2.staged).toBe(false)
    expect(r2.reason).toMatch(/already has an in-flight/)
  })

  it('a fresh change class (tier propose) STAGES via proposeNextRsiKnob — tunables untouched', () => {
    expect(tierFor(vault, 'named-skill-topk')).toBe('propose')
    const r = proposeNextRsiKnob(vault, NOW)
    expect(r?.staged).toBe(true)
    expect(r?.change?.status).toBe('proposed')
    expect(existsSync(rsiTunablesPath(vault))).toBe(false) // nothing applied while unratified
  })

  it('a graduated class (tier auto) still applies — earned autonomy stays earned', () => {
    for (let i = 0; i < GRADUATE_N; i++) recordVerdict(vault, 'named-skill-topk', true, NOW)
    expect(tierFor(vault, 'named-skill-topk')).toBe('auto')
    const r = proposeNextRsiKnob(vault, NOW)
    expect(r?.change?.changeClass).toBe('named-skill-topk')
    expect(r?.change?.status).toBe('applied')
    expect(readRsiTunables(vault).namedSkillTopK).toBe(1) // QD explore: lowest unexplored ≠ cur
  })

  it('each engine stages at most one card; both staged → proposer rests (I4: no pile-up)', () => {
    const r1 = proposeNextRsiKnob(vault, NOW)
    const r2 = proposeNextRsiKnob(vault, NOW)
    const r3 = proposeNextRsiKnob(vault, NOW)
    expect(r1?.change?.engine).toBe('recall-efficacy:named-skill')
    expect(r2?.change?.engine).toBe('recall-efficacy:failure')
    expect(r3).toBeNull()
    expect(loadInflight(vault).filter((c) => c.status === 'proposed')).toHaveLength(2)
  })

  it('ratifyProposed applies the staged bytes (snapshot taken at ratify time)', () => {
    const r = proposeNextRsiKnob(vault, NOW)
    const done = ratifyProposed(vault, r!.change!.id, NOW)
    expect(done.ok).toBe(true)
    expect(done.change?.status).toBe('applied')
    expect(done.change?.appliedAt).toBe(NOW)
    expect(readRsiTunables(vault).namedSkillTopK).toBe(1)
  })

  it('dismissProposed parks without writing, frees the engine, and is never re-proposed', () => {
    const r = proposeNextRsiKnob(vault, NOW)
    const done = dismissProposed(vault, r!.change!.id)
    expect(done.ok).toBe(true)
    expect(existsSync(rsiTunablesPath(vault))).toBe(false)
    expect(inflightForEngine(vault, 'recall-efficacy:named-skill')).toHaveLength(0)
    // patient, not nagging: the dismissed value (1) is off the table; the next proposal explores 2
    const again = proposeNextRsiKnob(vault, NOW)
    expect(again?.change?.engine).toBe('recall-efficacy:named-skill')
    const proposedCfg = JSON.parse(again!.change!.afterBytes) as { namedSkillTopK: number }
    expect(proposedCfg.namedSkillTopK).toBe(2)
  })

  it('ratify/dismiss refuse a non-proposed row (idempotence guard)', () => {
    const r = proposeNextRsiKnob(vault, NOW)
    ratifyProposed(vault, r!.change!.id, NOW)
    expect(ratifyProposed(vault, r!.change!.id, NOW).ok).toBe(false)
    expect(dismissProposed(vault, r!.change!.id).ok).toBe(false)
    expect(dismissProposed(vault, 'chg-nonexistent000000').ok).toBe(false)
  })

  it('adjudicateInflight leaves staged (proposed) rows untouched', () => {
    proposeNextRsiKnob(vault, NOW)
    const report = adjudicateInflight(vault, new Date('2026-09-30T00:00:00.000Z'))
    expect(report.adjudicated).toHaveLength(0)
    expect(loadInflight(vault)[0].status).toBe('proposed')
  })
})

describe('selfImproveEngageTick (presence-gated, debounced, considerate)', () => {
  let noticesDir: string
  beforeEach(() => {
    __resetNotices()
    noticesDir = mkdtempSync(join(tmpdir(), 'rsi-notices-'))
    setNoticesPath(noticesDir)
    __resetEngageDebounce()
    mockBackgroundAutonomy = false // default staging posture; the ON test opts in explicitly
  })
  afterEach(() => {
    try { rmSync(noticesDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('stages at engage time WITHOUT backgroundAutonomy and records a Needs-you card', () => {
    selfImproveEngageTick(() => vault, Date.parse(NOW))
    const staged = loadInflight(vault).filter((c) => c.status === 'proposed')
    expect(staged).toHaveLength(1)
    expect(existsSync(rsiTunablesPath(vault))).toBe(false)
    const owed = listNotices().filter((n) => n.needsDecision && n.resolvedAt === null)
    expect(owed).toHaveLength(1)
    expect(owed[0].kind).toBe('approval')
    expect(owed[0].actionId).toBe(staged[0].id)
    expect(owed[0].deepLink).toBe('duin://tool/homeStatus')
    expect(owed[0].body).toMatch(/namedSkillTopK/) // says WHAT would change, honestly
  })

  it('debounces: a second engage inside the window does nothing; past it, advances', () => {
    selfImproveEngageTick(() => vault, Date.parse(NOW))
    selfImproveEngageTick(() => vault, Date.parse(NOW) + 5 * 60_000)
    expect(loadInflight(vault)).toHaveLength(1) // still just the first stage
    selfImproveEngageTick(() => vault, Date.parse(NOW) + 31 * 60_000)
    expect(loadInflight(vault)).toHaveLength(2) // second knob staged after the window
  })

  it('answering a staged question clears its Needs-you card (the actionId contract rsi:resolve relies on)', () => {
    selfImproveEngageTick(() => vault, Date.parse(NOW))
    const staged = loadInflight(vault).filter((c) => c.status === 'proposed')[0]
    expect(ratifyProposed(vault, staged.id, NOW).ok).toBe(true)
    resolveByActionId(staged.id)
    expect(listNotices().filter((n) => n.needsDecision && n.resolvedAt === null)).toHaveLength(0)
  })

  it('a graduated class applies at engage (backgroundAutonomy ON) and leaves an FYI, not a decision', () => {
    mockBackgroundAutonomy = true // the master switch permits the autonomous write
    for (let i = 0; i < GRADUATE_N; i++) recordVerdict(vault, 'named-skill-topk', true, NOW)
    selfImproveEngageTick(() => vault, Date.parse(NOW))
    const applied = loadInflight(vault).filter((c) => c.status === 'applied')
    expect(applied).toHaveLength(1)
    const fyi = listNotices().filter((n) => n.actionId === applied[0].id)
    expect(fyi).toHaveLength(1)
    expect(fyi[0].needsDecision).toBe(false)
  })

  it('R3 split gate: a graduated class STAGES (not applies) at engage when backgroundAutonomy is OFF', () => {
    mockBackgroundAutonomy = false // master switch off: earned tier may ASK but not WRITE
    for (let i = 0; i < GRADUATE_N; i++) recordVerdict(vault, 'named-skill-topk', true, NOW)
    selfImproveEngageTick(() => vault, Date.parse(NOW))
    // No autonomous write: the tunables file stays absent, and the row is a proposal, not applied.
    expect(existsSync(rsiTunablesPath(vault))).toBe(false)
    expect(loadInflight(vault).filter((c) => c.status === 'applied')).toHaveLength(0)
    const staged = loadInflight(vault).filter((c) => c.status === 'proposed')
    expect(staged).toHaveLength(1)
    // And it is an owed decision (a card), not a silent hold — the operator can ratify once.
    const owed = listNotices().filter((n) => n.needsDecision && n.actionId === staged[0].id)
    expect(owed).toHaveLength(1)
  })
})

describe('R1: the apply sink refuses a target outside the confinement root', () => {
  // The inflight ledger is an unauthenticated append-only file. A planted row can carry any
  // targetPath. proposeChange guards at propose time, but a row written directly to the ledger
  // (a synced vault, a prompt-injected write, any local process) reaches the write through
  // applyChange — via BOTH the tier-'auto' path and the operator ratify path. applyChange must
  // refuse an escaping target at the sink, symmetric with rollbackChange.
  const escaping = (): InflightChange => ({
    id: 'planted-escape',
    changeClass: 'grounding-weight',
    engine: 'risk',
    // absolute path OUTSIDE <vault>/.duin/ — where a real attacker would aim
    targetPath: join(vault, '..', 'evil.json'),
    beforeBytes: '',
    afterBytes: '{"pwned":true}',
    proposedAt: NOW,
    status: 'proposed'
  })

  it('applyChange quarantines an escaping row and writes nothing', () => {
    upsertInflight(vault, escaping())
    const out = applyChange(vault, loadInflight(vault)[0], NOW)
    expect(out.status).toBe('rolled-back') // quarantined, not applied
    expect(existsSync(join(vault, '..', 'evil.json'))).toBe(false) // nothing written outside .duin
  })

  it('ratifyProposed refuses an escaping row — no success, no write', () => {
    upsertInflight(vault, escaping())
    const out = ratifyProposed(vault, 'planted-escape', NOW)
    expect(out.ok).toBe(false)
    expect(out.reason).toMatch(/escapes|confin/i)
    expect(existsSync(join(vault, '..', 'evil.json'))).toBe(false)
    // and the row is quarantined so a later tick can never re-apply or re-adjudicate it
    expect(loadInflight(vault)[0].status).toBe('rolled-back')
  })

  it('a confined ratify still applies normally (negative control)', () => {
    proposeChange(vault, spec(), NOW, { stage: true })
    const id = loadInflight(vault)[0].id
    const out = ratifyProposed(vault, id, NOW)
    expect(out.ok).toBe(true)
    expect(existsSync(cfg())).toBe(true)
  })
})
