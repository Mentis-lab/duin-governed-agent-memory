import { describe, it, expect, beforeAll } from 'vitest'
import { setUiLanguage } from '@/lib/i18n'
import { autonomyChangeNeedsConfirm, AUTONOMY_CONFIRM_MESSAGE } from './LoopSettings'
import {
  trippedCapabilities,
  breakerLine,
  RUNG_LABEL,
  governFactLine,
  undoConfirmMessage,
  undoableActions,
  type BreakerCap,
  type GovernFactRow,
  type GovernActionRow
} from '../automations/governance-helpers'

// The capability BREAKER and the governor's record. Renderer render tests need jsdom, which this
// repo's node-only vitest env does not provide, so the behaviour is factored into pure exported
// helpers and unit-tested here — the same convention as FoundationsSettings.test.tsx. The helpers
// moved with their surfaces to src/components/automations/governance-helpers.ts on 2026-09-03
// (the breaker and the record are monitoring, so they render in the Governance tab of the
// Automations hub); the autonomy confirm stays with the Settings switch that shows it.
//
// What the breaker exists for: the governor trips a capability the instant one of its actions is
// reverted and NEVER restores one. The restore path had no caller anywhere in the renderer, so a
// tripped capability stayed tripped forever and the only way back was a hand-written POST. Fact
// promotion had been held that way since 2026-07-29 — by an unbuilt button, not a decision.
//
// The helpers render through t()/tf() now, and Node 21+ exposes navigator.language, so the
// dictionary resolves the OS locale even under vitest. These assertions are about the English
// source strings, so pin the language rather than the machine.
beforeAll(() => setUiLanguage('en'))

const cap = (over: Partial<BreakerCap> = {}): BreakerCap => ({
  id: 'operator-fact-promotion',
  title: 'Promote a learned fact to a rule',
  rung: 'hold',
  floorRung: 'reflexive',
  trust: 0.42,
  coldStart: false,
  reverts: 97,
  willTrip: false,
  tripsTo: null,
  canRearm: true,
  ...over
})

describe('capability breaker — which capabilities are offered a re-arm', () => {
  it('offers exactly the ones sitting below their floor', () => {
    const caps = [
      cap({ id: 'tripped', rung: 'hold', floorRung: 'reflexive', canRearm: true }),
      cap({ id: 'armed', rung: 'reflexive', floorRung: 'reflexive', canRearm: false })
    ]
    expect(trippedCapabilities(caps).map((c) => c.id)).toEqual(['tripped'])
  })

  // The filter is deliberately NOT "has reverts". A long revert history is normal for a capability
  // that is currently fully armed, and offering to re-arm something already at its floor would just
  // surface the `already-armed` refusal as a button.
  it('does not offer a re-arm merely because a capability has reverts on record', () => {
    expect(trippedCapabilities([cap({ reverts: 97, canRearm: false })])).toEqual([])
  })

  it('shows nothing when everything is armed', () => {
    expect(trippedCapabilities([cap({ canRearm: false }), cap({ canRearm: false })])).toEqual([])
  })
})

describe('capability breaker — the status line', () => {
  it('states the rung in plain language, the miss count, and the earned trust', () => {
    expect(breakerLine(cap())).toBe('Held — will not act · 97 reverts on record · trust 0.42')
  })

  it('says trust is unearned rather than printing a cold-start floor as a score', () => {
    expect(breakerLine(cap({ coldStart: true, trust: 0.1 }))).toContain('trust not yet earned')
  })

  it('singularises a single revert', () => {
    expect(breakerLine(cap({ reverts: 1 }))).toContain('1 revert on record')
  })

  // A pending miss is worth saying out loud: re-arming now is about to be undone by the next pass.
  it('warns when a new miss is already pending, and names the rung it will drop to', () => {
    expect(breakerLine(cap({ willTrip: true, tripsTo: 'hold' }))).toContain(
      'a new miss is pending and will drop it to hold'
    )
  })

  it('stays quiet about a pending trip when there is none', () => {
    expect(breakerLine(cap())).not.toContain('pending')
  })

  it('labels every rung the ledger can report', () => {
    expect(Object.keys(RUNG_LABEL).sort()).toEqual(['hold', 'reflexive', 'stage'])
  })
})

// ── The background-autonomy confirm gate ──
//
// This one toggle arms the automations runner, the loop runner, the goal-automation bridge AND the
// RSI self-improve loop that rewrites DUIN's own retrieval config under <vault>/.duin/. Only the
// first three were ever legible from the label. The fourth begins about a minute after boot, so an
// operator could flip this expecting "my loops can run now" and get "the program edits itself now".
describe('background autonomy — confirming before the brain may edit its own config', () => {
  it('asks on the way ON', () => {
    expect(autonomyChangeNeedsConfirm(true)).toBe(true)
  })

  it('never asks on the way OFF — a kill switch you argue with is not a kill switch', () => {
    expect(autonomyChangeNeedsConfirm(false)).toBe(false)
  })

  it('names the self-write consequence, not just "runs tools"', () => {
    // The pre-existing toggle copy already said tools may write files in the vault. What it did not
    // say — and what this message exists to say — is that DUIN edits its OWN configuration.
    expect(AUTONOMY_CONFIRM_MESSAGE).toMatch(/own configuration/i)
    expect(AUTONOMY_CONFIRM_MESSAGE).toMatch(/\.duin/)
  })

  it('states WHEN it starts, since "on a timer" reads as distant and it is ~60s', () => {
    expect(AUTONOMY_CONFIRM_MESSAGE).toMatch(/about a minute/i)
  })

  it('states the bounds and the way back, so the disclosure is not just alarming', () => {
    expect(AUTONOMY_CONFIRM_MESSAGE).toMatch(/snapshotted/i)
    expect(AUTONOMY_CONFIRM_MESSAGE).toMatch(/undone/i)
    expect(AUTONOMY_CONFIRM_MESSAGE).toMatch(/turn this off again/i)
  })
})

// ── The Governance section ──
//
// /state/govern-audit, /state/improvements and /state/undo all returned real content and had ZERO
// renderer callers: an agent could query the governor's record over HTTP, and the operator that
// record is ABOUT could not see it.

const fact = (over: Partial<GovernFactRow> = {}): GovernFactRow => ({
  id: 'f1',
  fact: 'The operator ships on Fridays',
  status: 'promoted',
  govern: { verdict: 'confirm', juryProvider: 'deepseek', crossModel: true, ts: 1 },
  ...over
})

describe('govern audit — a rule row says who ruled on it and how hard the check was', () => {
  it('names the verdict in plain language', () => {
    expect(governFactLine(fact())).toMatch(/^Confirmed by the jury/)
    expect(governFactLine(fact({ govern: { verdict: 'revert', juryProvider: null, crossModel: true, ts: 1 } }))).toMatch(
      /^Reverted by the jury/
    )
    expect(governFactLine(fact({ govern: { verdict: 'hold', juryProvider: null, crossModel: true, ts: 1 } }))).toMatch(
      /^Held by the jury/
    )
  })

  // A model grading its own output is a weaker check than a second model doing it, and the audit is
  // the one surface that must not quietly round that up to "verified".
  it('does not let a same-model check read as a cross-model one', () => {
    expect(governFactLine(fact({ govern: { verdict: 'confirm', juryProvider: 'deepseek', crossModel: false, ts: 1 } })))
      .toContain('same-model check')
    expect(governFactLine(fact())).toContain('cross-model')
  })

  it('falls back to the raw status for a row that carries derivation but no verdict', () => {
    expect(governFactLine(fact({ govern: undefined, status: 'provisional' }))).toContain('status provisional')
  })

  it('shows calibrated reliability when the derivation graph produced one', () => {
    expect(governFactLine(fact({ reliability: 0.8125 }))).toContain('reliability 0.81')
  })
})

const action = (over: Partial<GovernActionRow> = {}): GovernActionRow => ({
  id: 'a1',
  ts: 1,
  actionKind: 'restore-file',
  capabilityId: 'rsi-tunable-apply',
  status: 'applied',
  ...over
})

describe('undo — the confirm has to name the consequence the button hides', () => {
  // revertAction does TWO things: restores the bytes AND fires recordFeedback('revert'), which
  // demotes the capability. The demote is invisible from a button labelled "Undo", so a confirm
  // that only says "are you sure?" is a speed bump rather than consent.
  it('says the capability will be demoted, not just that the change will be reverted', () => {
    const msg = undoConfirmMessage(action())
    expect(msg).toMatch(/demote/i)
    expect(msg).toMatch(/less autonomous/i)
  })

  it('names the specific action and capability being undone', () => {
    const msg = undoConfirmMessage(action({ actionKind: 'restore-file', capabilityId: 'cap-x' }))
    expect(msg).toContain('restore-file')
    expect(msg).toContain('cap-x')
  })

  it('still warns about the demote when the target is only known to the main process', () => {
    const msg = undoConfirmMessage(undefined)
    expect(msg).toMatch(/most recent reversible action/i)
    expect(msg).toMatch(/demote/i)
  })

  it('says the undo is itself recorded, so the audit above is the place to check it landed', () => {
    expect(undoConfirmMessage(action())).toMatch(/audit/i)
  })
})

describe('undo — only still-applied actions are offered', () => {
  it('hides an action that has already been reverted', () => {
    expect(
      undoableActions([action({ id: 'a1' }), action({ id: 'a2', status: 'reverted' })]).map((a) => a.id)
    ).toEqual(['a1'])
  })

  // 'closed' means the MACHINE took its own change back (the RSI's auto-rollback). Offering an undo
  // there would fire a demote for an objection nobody made.
  it('hides an action the machine already closed itself', () => {
    expect(undoableActions([action({ id: 'a3', status: 'closed' })])).toEqual([])
  })
})
