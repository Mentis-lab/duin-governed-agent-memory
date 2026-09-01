// CALL-SITE coverage for `govern:audit` / `govern:improvements` / `govern:undo`
// (electron/ipc/settings.ts).
//
// THE GAP these tests close: GET /state/govern-audit, GET /state/improvements and
// POST /state/undo all return real content and had ZERO renderer callers. The
// governor's own record — which rules it confirmed or reverted, what it would
// like to retire, which of its writes are still reversible — was reachable by an
// AGENT over HTTP and not by the OPERATOR the record is about.
//
// These drive the REAL registered ipcMain handlers. operator-model and
// improvement-proposer are the REAL modules (reset per test), so the audit rows
// are the real audit rows. action-ledger is mocked because what is under test is
// the HANDLER's contract — which record a bare undo targets, and that it refuses
// rather than silently no-opping when there is nothing to undo — not the ledger's
// own inverse-dispatch machinery, which action-ledger.test.ts already owns.
//
// POWER CONTROL: deleting any one of the three handlers fails its 'is registered'
// test plus every behavioural test under it. Making `govern:undo` target
// listActions().at(-1) instead of implicitUndoTarget() fails 'a bare undo skips
// the machine-originated record' — which is the exact edge that would fire a
// capability demote the operator never asked for.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let userDataDir = ''

type Handler = (event: unknown, ...args: any[]) => Promise<any>
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    },
    on: () => {}
  },
  app: { getPath: () => userDataDir, getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '' }
}))

// A fake ledger with the two record classes that matter: an ordinary reversible
// action, and a machine-originated RSI record that a BARE undo must skip.
const RSI_CAP = 'rsi-tunable-apply'
interface FakeAction {
  id: string
  ts: number
  actionKind: string
  capabilityId: string
  status: 'applied' | 'reverted' | 'closed'
}
let ledger: FakeAction[] = []
const revertSpy = vi.fn((id: string) => {
  const rec = ledger.find((a) => a.id === id)
  if (!rec) return { ok: false, error: 'action not found' }
  rec.status = 'reverted'
  return { ok: true }
})
vi.mock('../services/ans/action-ledger', () => ({
  listActions: (filter?: { status?: string }) =>
    ledger.filter((a) => !filter?.status || a.status === filter.status),
  // Mirrors the real implicitUndoTarget: last APPLIED record that is not the RSI's own.
  implicitUndoTarget: () =>
    ledger.filter((a) => a.status === 'applied' && a.capabilityId !== RSI_CAP).at(-1)?.id,
  revertAction: (id: string) => revertSpy(id)
}))

import { registerSettingsHandlers } from './settings'
import {
  __resetOperatorModel,
  setOperatorModelPath,
  recordFacts,
  getOperatorFacts,
  recordGovernProvenance,
  listByStatus,
  promoteFact,
  revertFact
} from '../services/brain/operator-model'

beforeEach(() => {
  handlers.clear()
  revertSpy.mockClear()
  ledger = []
  userDataDir = mkdtempSync(join(tmpdir(), 'duin-govern-ud-'))
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({}), 'utf8')
  setOperatorModelPath(userDataDir)
  __resetOperatorModel()
  registerSettingsHandlers()
})

afterEach(() => {
  if (userDataDir && existsSync(userDataDir)) rmSync(userDataDir, { recursive: true, force: true })
})

describe('govern:audit — the governor is made to show its record to the operator', () => {
  it('is registered', () => {
    expect(handlers.has('govern:audit')).toBe(true)
  })

  it('returns the same rows GET /state/govern-audit does, newest-first', async () => {
    recordFacts([{ fact: 'Alpha' }, { fact: 'Beta' }, { fact: 'Gamma' }])
    const fa = getOperatorFacts().find((f) => f.fact === 'Alpha')!
    const fb = getOperatorFacts().find((f) => f.fact === 'Beta')!
    recordGovernProvenance(fa.id, {
      juryModelId: 'm1', juryProvider: 'deepseek', crossModel: true,
      verdict: 'confirm', behavioralFlip: true, ts: 100
    })
    recordGovernProvenance(fb.id, {
      juryModelId: 'm2', juryProvider: 'google', crossModel: false,
      verdict: 'revert', behavioralFlip: false, ts: 200
    })

    const res = await handlers.get('govern:audit')!({})
    expect(res.success).toBe(true)
    const facts = res.data.facts as { fact: string; govern?: { verdict: string } }[]
    // Gamma was never decided, so it is not in the record. Beta (ts 200) leads.
    expect(facts.map((f) => f.fact)).toEqual(['Beta', 'Alpha'])
    expect(facts[0].govern!.verdict).toBe('revert')
  })

  // The undo affordance is only honest if the operator can see WHAT it will
  // undo before confirming, so the audit carries the reversible-action list and
  // names the record a bare undo would target.
  it('carries the still-reversible actions and names the bare-undo target', async () => {
    ledger = [
      { id: 'a1', ts: 1, actionKind: 'restore-file', capabilityId: 'cap-x', status: 'applied' },
      { id: 'a2', ts: 2, actionKind: 'restore-file', capabilityId: RSI_CAP, status: 'applied' },
      { id: 'a3', ts: 3, actionKind: 'restore-file', capabilityId: 'cap-y', status: 'reverted' }
    ]
    const res = await handlers.get('govern:audit')!({})
    expect(res.success).toBe(true)
    expect((res.data.actions as { id: string }[]).map((a) => a.id)).toEqual(['a1', 'a2'])
    expect(res.data.undoTarget).toBe('a1') // NOT a2 — a bare undo skips the RSI record
  })
})

describe('govern:improvements — the shadow proposals the operator never saw', () => {
  it('is registered', () => {
    expect(handlers.has('govern:improvements')).toBe(true)
  })

  it('reports the shadow flag, so nothing here reads as already applied', async () => {
    const res = await handlers.get('govern:improvements')!({})
    expect(res.success).toBe(true)
    expect(res.data.shadow).toBe(true)
    expect(Array.isArray(res.data.proposals)).toBe(true)
  })

  it('proposes retiring a fact the govern loop has repeatedly reverted', async () => {
    recordFacts([{ fact: 'The operator always ships on Fridays' }])
    const f = getOperatorFacts()[0]
    // Two jury auto-reverts — the proposer's minReverts is 2, because one revert
    // can be noise and a repeat is a pattern. revertFact only moves a
    // provisional/promoted fact, so it is re-promoted between the two.
    promoteFact(f.id)
    revertFact(f.id)
    promoteFact(f.id)
    revertFact(f.id)
    expect(listByStatus('reverted').length).toBeGreaterThan(0)

    const res = await handlers.get('govern:improvements')!({})
    expect(res.success).toBe(true)
    const proposals = res.data.proposals as { targetId: string; type: string }[]
    expect(proposals.some((p) => p.targetId === f.id)).toBe(true)
  })
})

describe('govern:undo — the one write, and it must be deliberate', () => {
  it('is registered', () => {
    expect(handlers.has('govern:undo')).toBe(true)
  })

  it('a bare undo skips the machine-originated record and takes the last human-facing one', async () => {
    ledger = [
      { id: 'a1', ts: 1, actionKind: 'restore-file', capabilityId: 'cap-x', status: 'applied' },
      { id: 'a2', ts: 2, actionKind: 'restore-file', capabilityId: RSI_CAP, status: 'applied' }
    ]
    const res = await handlers.get('govern:undo')!({})
    expect(res.success).toBe(true)
    expect(revertSpy).toHaveBeenCalledWith('a1')
    expect(revertSpy).toHaveBeenCalledTimes(1)
  })

  it('an explicit id still reaches the RSI record — the default changed, not the reach', async () => {
    ledger = [
      { id: 'a1', ts: 1, actionKind: 'restore-file', capabilityId: 'cap-x', status: 'applied' },
      { id: 'a2', ts: 2, actionKind: 'restore-file', capabilityId: RSI_CAP, status: 'applied' }
    ]
    const res = await handlers.get('govern:undo')!({}, 'a2')
    expect(res.success).toBe(true)
    expect(revertSpy).toHaveBeenCalledWith('a2')
  })

  // Silently reporting success with nothing undone would tell the operator a
  // demote fired when none did.
  it('refuses when there is nothing to undo rather than reporting a phantom success', async () => {
    const res = await handlers.get('govern:undo')!({})
    expect(res.success).toBe(false)
    expect(revertSpy).not.toHaveBeenCalled()
  })

  it('surfaces the ledger refusal instead of swallowing it', async () => {
    ledger = [{ id: 'a1', ts: 1, actionKind: 'restore-file', capabilityId: 'cap-x', status: 'applied' }]
    revertSpy.mockImplementationOnce(() => ({ ok: false, error: 'capability missing — revert refused' }))
    const res = await handlers.get('govern:undo')!({})
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('capability missing')
  })
})
