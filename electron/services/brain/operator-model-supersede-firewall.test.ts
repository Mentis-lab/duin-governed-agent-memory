// realSupersedeJudge — confidential-lane firewall on the auto-supersession judge.
//
// runAutoSupersede is an AUTONOMOUS background send: learnFromTurn fires it on every TRUSTED capturing
// turn, and its pool is getOperatorFacts() — EVERY active fact (promoted, provisional, candidate). The
// judge POSTed that pool verbatim to routeModel('extraction') with no firewallClear, while its sibling
// 150 lines up in the same file (verifyPool) filters the same corpus for the same provider. That is
// exactly what confidential-firewall.ts declares a hard block for: "any cloud call the operator didn't
// explicitly drive".
//
// The trigger is the ORDINARY path, not an edge case: a denylisted fact reaches the judge precisely when
// it clears the deterministic referent-overlap floor against the new fact — i.e. when the operator
// corrects THAT SAME SUBJECT, which is the only reason supersession runs at all. And it fires more often
// than the leak already fixed in verifyPool: every capturing turn, not only when a candidate pool exists.
//
// What made it invisible: this module already imports firewallClear and already applies it in verifyPool,
// so the guard's presence in the file made the module look covered; and every surface that REPORTS
// firewall activity (the govern jury, judgment-measure-live) redacts these same rows, so an operator
// watching those saw the firewall working.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const chatOnce = vi.fn()
vi.mock('../providers/registry', () => ({
  chatOnce: (...a: unknown[]) => chatOnce(...a),
  routeModel: () => ({ id: 'test-model', provider: 'test' }),
  routeDistinctModel: () => null,
  routeDistinctModels: () => []
}))

import { setOperatorModelPath, recordFacts, learnFromTurn, getAllOperatorFacts, __resetOperatorModel } from './operator-model'
import { setActiveDenylist } from '../governance/confidential-firewall'

type Msg = { role: string; content: string }
type Meta = { purpose: string; role: string }

/** Route the three model calls learnFromTurn makes by their `role` audit tag: extraction contributes
 *  nothing (keyless capture drives these turns), the dual-verifier echoes back whatever it was shown
 *  (so no pruning muddies the assertions), and the supersession judge answers `judgeReply`. */
const wireModel = (judgeReply: string): void => {
  chatOnce.mockImplementation((msgs: Msg[], _model: unknown, _sig: unknown, meta: Meta) => {
    if (meta?.role === 'operator-supersede') return Promise.resolve({ content: judgeReply })
    if (meta?.role === 'operator-verify') {
      const shown = msgs.find((m) => m.role === 'user')!.content.split('\n\nCANDIDATES:\n')[1] ?? ''
      return Promise.resolve({ content: JSON.stringify(shown.split('\n').filter(Boolean)) })
    }
    return Promise.resolve({ content: '[]' }) // operator-learning: no model-extracted facts
  })
}

/** Only what the SUPERSESSION judge put on the wire. */
const judgeCalls = (): Msg[][] =>
  chatOnce.mock.calls.filter((c) => (c[3] as Meta)?.role === 'operator-supersede').map((c) => c[0] as Msg[])
const judgeWire = (): string =>
  judgeCalls().map((msgs) => msgs.map((m) => m.content).join('\n')).join('\n')

const factByText = (text: string): { invalidatedAt?: number } | undefined =>
  getAllOperatorFacts().find((f) => f.fact === text)

// The overlap floor is deterministic (≥2 shared content tokens), so every fixture below shares
// "deployment"/"dashboard" or "rollout"/"paused" with the fact the turn teaches — that is what puts it
// in front of the judge in the first place.
const NEW_QUERY = 'my deployment dashboard is now hosted on Vercel'
const NEW_FACT = 'deployment dashboard is now hosted on Vercel'
const SECRET = 'Operator tracks the acme-secret deployment dashboard every Monday'
const CLEAR_A = 'Operator reviews the deployment dashboard before every release'
const CLEAR_B = 'Operator ships the deployment dashboard notes each Monday'

describe('realSupersedeJudge — confidential-lane firewall (autonomous egress)', () => {
  beforeEach(() => {
    setOperatorModelPath(join(mkdtempSync(join(tmpdir(), 'duin-sj-')), 'operator-model.json'))
    __resetOperatorModel()
    chatOnce.mockReset()
    // Pin the ACTIVE lane rather than depending on whatever vault the host machine has configured —
    // the shipped default denylist is deliberately EMPTY (cold-start A3).
    setActiveDenylist(['acme-secret'])
  })
  afterEach(() => setActiveDenylist(null))

  it('never puts a confidential active fact on the wire, and still sends the clear ones', async () => {
    recordFacts([CLEAR_A, SECRET].map((fact) => ({ fact, kind: 'context' })))
    wireModel('NONE')

    await learnFromTurn(NEW_QUERY, 'ok')

    expect(judgeCalls()).toHaveLength(1) // the judge did run — this is a filter, not an off-switch
    expect(judgeWire()).not.toContain('acme-secret')
    expect(judgeWire()).toContain(CLEAR_A)
    expect(judgeWire()).toContain(NEW_FACT)
  })

  it('abstains entirely when the NEW fact itself is confidential (it leaks just by being the prompt)', async () => {
    const CLEAR_NEIGHBOUR = 'Operator paused the migration rollout after the review'
    recordFacts([{ fact: CLEAR_NEIGHBOUR, kind: 'context' }])
    wireModel('1')

    // "from now on …" is the keyless teaching path; the taught fact carries the denylisted term.
    await learnFromTurn('from now on the acme-secret rollout is paused', 'ok')

    expect(judgeCalls()).toHaveLength(0) // no external call at all, so nothing to leak
    expect(factByText(CLEAR_NEIGHBOUR)?.invalidatedAt).toBeUndefined() // and abstain means retire nothing
  })

  it('opens no external call when every overlap candidate is confidential', async () => {
    recordFacts([{ fact: SECRET, kind: 'context' }])
    wireModel('1')

    await learnFromTurn(NEW_QUERY, 'ok')

    expect(judgeCalls()).toHaveLength(0)
    expect(factByText(SECRET)?.invalidatedAt).toBeUndefined()
  })

  // The back-map is the sharp edge of the fix. Filtering the payload while still resolving the judge's
  // number against the UNFILTERED list retires the wrong fact: here the withheld SECRET sorts first, so
  // a reply of "1" meant SECRET under the old indexing even though the model was shown only CLEAR_A.
  // autoSupersede's "may only pick a candidate we offered" guard checks the unfiltered list, so it waves
  // that id straight through — an egress fix that stopped here would have become a data-corruption bug.
  it('resolves the judge\'s number against the list it was actually SHOWN', async () => {
    recordFacts([CLEAR_A, SECRET].map((fact) => ({ fact, kind: 'context' }))) // store order: SECRET, CLEAR_A
    wireModel('1')

    await learnFromTurn(NEW_QUERY, 'ok')

    expect(judgeWire()).toContain('1. ' + CLEAR_A) // the only row the model saw was numbered 1
    expect(factByText(CLEAR_A)?.invalidatedAt).toBeGreaterThan(0)
    expect(factByText(SECRET)?.invalidatedAt).toBeUndefined() // the withheld row is untouched
  })

  it('still supersedes normally when the whole pool is clear (the firewall is not a kill-switch)', async () => {
    recordFacts([CLEAR_A, CLEAR_B].map((fact) => ({ fact, kind: 'context' }))) // store order: CLEAR_B, CLEAR_A
    wireModel('1')

    await learnFromTurn(NEW_QUERY, 'ok')

    expect(judgeWire()).toContain('1. ' + CLEAR_B)
    expect(judgeWire()).toContain('2. ' + CLEAR_A)
    expect(factByText(CLEAR_B)?.invalidatedAt).toBeGreaterThan(0)
    expect(factByText(CLEAR_A)?.invalidatedAt).toBeUndefined()
  })
})
