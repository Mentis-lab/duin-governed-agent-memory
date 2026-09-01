import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setActionLedgerPath, recordAction, revertAction, listActions, MAX_ACTIONS, __resetActionLedger } from './action-ledger'
import { setCapabilityLedgerPath, registerCapability, getCapability, __resetCapabilityLedger } from './capability-ledger'

let ud: string
beforeEach(() => {
  ud = mkdtempSync(join(tmpdir(), 'duin-undo-'))
  __resetCapabilityLedger() // fresh dir has no file, so setPath won't reset the module store on its own
  setCapabilityLedgerPath(ud)
  registerCapability({ id: 'file-writer', title: 'Write a file', rung: 'stage' })
  setActionLedgerPath(ud)
  __resetActionLedger()
})
afterEach(() => rmSync(ud, { recursive: true, force: true }))

describe('action-ledger safe-undo (item 23)', () => {
  it('restore-file reverts to the prior bytes on disk', () => {
    const f = join(ud, 'note.md')
    writeFileSync(f, 'ORIGINAL')
    const rec = recordAction({
      actionKind: 'edit note.md',
      capabilityId: 'file-writer',
      inverseSpec: { kind: 'restore-file', path: f },
      priorContent: 'ORIGINAL'
    })
    writeFileSync(f, 'CHANGED') // the action mutated it
    expect(revertAction(rec.id).ok).toBe(true)
    expect(readFileSync(f, 'utf-8')).toBe('ORIGINAL')
    expect(listActions({ status: 'reverted' })).toHaveLength(1)
  })

  it('fires the demote signal EXACTLY once even if reverted twice', () => {
    const f = join(ud, 'a.md')
    writeFileSync(f, 'x')
    const rec = recordAction({
      actionKind: 'edit a.md',
      capabilityId: 'file-writer',
      inverseSpec: { kind: 'restore-file', path: f },
      priorContent: 'x'
    })
    revertAction(rec.id)
    revertAction(rec.id) // idempotent no-op
    expect(getCapability('file-writer')!.reverts).toBe(1) // recordFeedback('revert') fired once
  })

  it('restore of a null snapshot (file did not exist) deletes the file', () => {
    const f = join(ud, 'created.md')
    const rec = recordAction({
      actionKind: 'create a note',
      capabilityId: 'file-writer',
      inverseSpec: { kind: 'restore-file', path: f },
      priorContent: null
    })
    writeFileSync(f, 'NEW')
    revertAction(rec.id)
    expect(existsSync(f)).toBe(false)
  })

  it('refuses a non-Tier-B (outward/irreversible) action — the scope guard', () => {
    expect(() =>
      recordAction({
        actionKind: 'send email to the whole team',
        capabilityId: 'file-writer',
        inverseSpec: { kind: 'delete-file', path: 'x' },
        priorContent: null
      })
    ).toThrow(/refuse|Tier/i)
  })

  // P1 — path confinement: a record whose inverse path escapes the approved root(s) must be refused
  // (no write, no unlink), and the action must stay 'applied'.
  it('P1: refuses a revert whose target escapes the confinement root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'duin-evil-'))
    const victim = join(outside, 'victim.md')
    writeFileSync(victim, 'DO-NOT-TOUCH')
    try {
      const rec = recordAction({
        actionKind: 'edit victim.md',
        capabilityId: 'file-writer',
        inverseSpec: { kind: 'delete-file', path: victim }, // outside `ud` (the confinement base)
        priorContent: null
      })
      const r = revertAction(rec.id)
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/outside|refused|vault/i)
      expect(existsSync(victim)).toBe(true) // untouched
      expect(readFileSync(victim, 'utf-8')).toBe('DO-NOT-TOUCH')
      expect(listActions({ status: 'applied' })).toHaveLength(1) // not flipped
      expect(getCapability('file-writer')!.reverts).toBe(0) // demote NOT fired
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  // C2/P3 — the demote signal is load-bearing. If the capability row is gone, the revert must FAIL
  // (stay 'applied', don't touch disk) rather than silently no-op the demote with ok:true.
  it('C2/P3: refuses (keeps applied) when the capability that must be demoted is missing', () => {
    const f = join(ud, 'orphan.md')
    writeFileSync(f, 'ORIGINAL')
    const rec = recordAction({
      actionKind: 'edit orphan.md',
      capabilityId: 'file-writer',
      inverseSpec: { kind: 'restore-file', path: f },
      priorContent: 'ORIGINAL'
    })
    writeFileSync(f, 'CHANGED')
    __resetCapabilityLedger() // the capability row vanishes (e.g. registry rebuilt)
    const r = revertAction(rec.id)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/missing|demote|capability/i)
    expect(readFileSync(f, 'utf-8')).toBe('CHANGED') // disk NOT reverted
    expect(listActions({ status: 'applied' })).toHaveLength(1) // retryable, not lost
  })

  // C3 — the prior-content snapshot is deleted after a SUCCESSFUL revert (no unbounded growth).
  it('C3: deletes the consumed snapshot after a successful revert', () => {
    const f = join(ud, 'snap.md')
    writeFileSync(f, 'ORIGINAL')
    const rec = recordAction({
      actionKind: 'edit snap.md',
      capabilityId: 'file-writer',
      inverseSpec: { kind: 'restore-file', path: f },
      priorContent: 'ORIGINAL'
    })
    const ref = rec.priorSnapshotRef!
    const snapFile = join(ud, 'ans-undo', 'snapshots', `${ref}.json`)
    expect(existsSync(snapFile)).toBe(true)
    writeFileSync(f, 'CHANGED')
    expect(revertAction(rec.id).ok).toBe(true)
    expect(existsSync(snapFile)).toBe(false) // snapshot cleaned up
  })

  // C3 — the in-memory ring is capped; overflow rotates out the oldest.
  it('C3: caps store.actions at MAX_ACTIONS, rotating the oldest out', () => {
    for (let i = 0; i < MAX_ACTIONS + 5; i++) {
      recordAction({
        actionKind: `edit n${i}.md`,
        capabilityId: 'file-writer',
        inverseSpec: { kind: 'restore-file', path: join(ud, `n${i}.md`) },
        priorContent: null
      })
    }
    expect(listActions()).toHaveLength(MAX_ACTIONS)
  })
})
