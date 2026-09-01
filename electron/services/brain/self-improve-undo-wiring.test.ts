// self-improve-undo-wiring.test.ts — the PRODUCER side of the safe-undo ledger (item 23/24).
//
// The 2026-07-25 evaluation confessed this as a GAP: recordAction had no production caller, so the
// undo/demote safety net (route + snapshot capture + inverse revert, all built and tested) had
// nothing to undo. action-ledger.test.ts proved the ledger works when a TEST writes to it; nothing
// proved that DUIN's one autonomous graduated file-write — applyChange, reached from the
// autonomy-gated self-improve tick via rsi-proposer — produces a revertable record.
//
// This suite is that proof: drive the real applyChange and then revert the change through the real
// revertAction, asserting the file comes back and the capability takes the demote signal.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let vault = ''

// action-ledger confines every revert target to the vault root (localBrainNotesDir) or the ledger's
// own userData base. Point settings at the fixture vault so <vault>/.duin/... is confined the same
// way it is in production, rather than only passing via the userData fallback.
vi.mock('../settings-helper', () => ({
  readSettings: () => ({ localBrainNotesDir: vault }),
  patchSettings: () => {}
}))

import { applyChange, rollbackChange } from './self-improve-loop'
import { rsiTunablesPath } from './rsi-tunables'
import type { InflightChange } from './self-improve-registry'
import {
  setActionLedgerPath,
  listActions,
  revertAction,
  recordAction,
  implicitUndoTarget,
  __resetActionLedger
} from '../ans/action-ledger'
import {
  setCapabilityLedgerPath,
  seedCapabilities,
  getCapability,
  RSI_APPLY_CAP_ID,
  __resetCapabilityLedger
} from '../ans/capability-ledger'
import { classifyAction } from '../governance/action-class'

const NOW = '2026-07-25T00:00:00.000Z'

let userData = ''

const change = (over: Partial<InflightChange> = {}): InflightChange => ({
  id: 'chg-1',
  changeClass: 'kind-weight',
  engine: 'risk',
  targetPath: rsiTunablesPath(vault),
  beforeBytes: '',
  afterBytes: '{\n  "namedSkillTopK": 5\n}\n',
  proposedAt: NOW,
  status: 'proposed',
  ...over
})

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'duin-rsi-undo-vault-'))
  userData = mkdtempSync(join(tmpdir(), 'duin-rsi-undo-ud-'))
  mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
  __resetCapabilityLedger()
  setCapabilityLedgerPath(userData)
  seedCapabilities()
  setActionLedgerPath(userData)
  __resetActionLedger()
})

afterEach(() => {
  rmSync(vault, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

describe('RSI apply → safe-undo ledger (the missing producer)', () => {
  it('seeds a capability for the apply path, so the demote signal has somewhere to land', () => {
    // revertAction REFUSES when the capability row is missing (it would silently lose the demote),
    // so the producer is only usable if boot seeds this id.
    expect(getCapability(RSI_APPLY_CAP_ID)).toBeDefined()
  })

  it('records a revertable action when the autonomous executor writes', () => {
    const rec = applyChange(vault, change(), NOW)

    const actions = listActions({ status: 'applied' })
    expect(actions).toHaveLength(1)
    expect(actions[0].capabilityId).toBe(RSI_APPLY_CAP_ID)
    expect(actions[0].inverseSpec).toEqual({ kind: 'restore-file', path: rec.targetPath })
    // The scope guard in recordAction throws on anything the taxonomy doesn't rate B/grad, so the
    // actionKind the executor passes must classify as a reversible Tier-B edit.
    const cls = classifyAction(actions[0].actionKind)
    expect(cls.tier).toBe('B')
    expect(cls.disposition).toBe('grad')
  })

  it('restores the prior bytes on undo and fires the demote signal', () => {
    const target = rsiTunablesPath(vault)
    const prior = '{\n  "namedSkillTopK": 3\n}\n'
    writeFileSync(target, prior)

    applyChange(vault, change({ beforeBytes: prior }), NOW)
    expect(readFileSync(target, 'utf-8')).toContain('"namedSkillTopK": 5')

    const id = listActions({ status: 'applied' })[0].id
    expect(revertAction(id)).toEqual({ ok: true })

    expect(readFileSync(target, 'utf-8')).toBe(prior)
    // A human undo tightens future autonomy — the load-bearing invariant of the ledger.
    expect(getCapability(RSI_APPLY_CAP_ID)!.reverts).toBe(1)
  })

  it('undoes a first-write by DELETING the file (prior content is null, not empty)', () => {
    const target = rsiTunablesPath(vault)
    expect(existsSync(target)).toBe(false)

    applyChange(vault, change(), NOW)
    expect(existsSync(target)).toBe(true)

    const id = listActions({ status: 'applied' })[0].id
    expect(revertAction(id)).toEqual({ ok: true })
    // '' would restore an EMPTY tunables file; null is the honest inverse of "there was no file".
    expect(existsSync(target)).toBe(false)
  })
})

// ── The machine taking its OWN change back is not a human undo ──
//
// rollbackChange restored the bytes and marked its InflightChange 'rolled-back', but never touched
// the action ledger — so the ActionRecord stayed 'applied' forever and remained a live /state/undo
// target after the change was already gone. A later bare undo then re-restored already-restored
// bytes (a near-no-op) AND fired recordFeedback('revert'), tightening autonomy on the strength of a
// human objection that never happened. Nothing asserted anything about the record after a rollback,
// which is why it survived.
describe('RSI auto-rollback closes its own undo record, without a demote', () => {
  it('leaves no applied action behind, and does not demote', () => {
    const target = rsiTunablesPath(vault)
    const prior = '{\n  "namedSkillTopK": 3\n}\n'
    writeFileSync(target, prior)

    const applied = applyChange(vault, change({ beforeBytes: prior }), NOW)
    expect(listActions({ status: 'applied' })).toHaveLength(1)
    expect(applied.actionId).toBeTruthy() // the only link between the two ledgers

    rollbackChange(vault, applied)

    expect(readFileSync(target, 'utf-8')).toBe(prior)
    expect(listActions({ status: 'applied' })).toHaveLength(0)
    const closed = listActions({ status: 'closed' })
    expect(closed).toHaveLength(1)
    expect(closed[0].closedBy).toBe('auto-rollback')
    // The whole point: nobody objected, so autonomy must NOT tighten.
    expect(getCapability(RSI_APPLY_CAP_ID)!.reverts).toBe(0)
  })

  it('a closed record is inert — reverting it is a no-op that still cannot demote', () => {
    const applied = applyChange(vault, change(), NOW)
    const id = applied.actionId!
    rollbackChange(vault, applied)

    // revertAction is idempotent on a non-'applied' record, so even an EXPLICIT undo of the closed
    // id cannot re-restore stale bytes or fire the demote.
    expect(revertAction(id)).toEqual({ ok: true })
    expect(getCapability(RSI_APPLY_CAP_ID)!.reverts).toBe(0)
  })

  it('a bare undo never targets an RSI record, even when it is the most recent', () => {
    // The route's implicit target used to be `listActions({status:'applied'}).at(-1)`. With the RSI
    // writing every ~15 minutes, "the last applied action" is almost always the BRAIN's, so an
    // operator typing undo to take back their own last action would instead revert an autonomous
    // tunable change AND demote the capability for it.
    recordAction({
      actionKind: 'write a note to the vault', // Tier-B/grad, like any operator-driven durable write
      capabilityId: 'some-user-capability',
      inverseSpec: { kind: 'restore-file', path: join(vault, '.duin', 'user-thing.json') },
      priorContent: '{}'
    })
    applyChange(vault, change(), NOW) // RSI record, and it is NEWER

    const picked = implicitUndoTarget()
    const rsiId = listActions({ status: 'applied' }).find((a) => a.capabilityId === RSI_APPLY_CAP_ID)!.id
    expect(picked).toBeDefined()
    expect(picked).not.toBe(rsiId)
    expect(listActions({ status: 'applied' }).find((a) => a.id === picked)!.capabilityId).toBe(
      'some-user-capability'
    )
  })

  it('an RSI record is still reachable by EXPLICIT id (nothing became unreachable)', () => {
    applyChange(vault, change(), NOW)
    const rsiId = listActions({ status: 'applied' })[0].id
    expect(implicitUndoTarget()).toBeUndefined() // nothing else applied
    expect(revertAction(rsiId)).toEqual({ ok: true }) // explicit still works, and still demotes
    expect(getCapability(RSI_APPLY_CAP_ID)!.reverts).toBe(1)
  })

  it('a human undo of a DIFFERENT applied change still demotes (the invariant is intact)', () => {
    // Guard against over-correcting: closing auto-rollbacks must not blunt the real signal.
    const target = rsiTunablesPath(vault)
    const prior = '{\n  "namedSkillTopK": 3\n}\n'
    writeFileSync(target, prior)
    applyChange(vault, change({ beforeBytes: prior }), NOW)

    const id = listActions({ status: 'applied' })[0].id
    expect(revertAction(id)).toEqual({ ok: true })
    expect(getCapability(RSI_APPLY_CAP_ID)!.reverts).toBe(1)
  })
})
