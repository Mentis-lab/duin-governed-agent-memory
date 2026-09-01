// Regression: the `brain:restoreMoat` IPC handler must thread the userData dir into
// restoreLatestMoat, and must never report a PARTIAL restore as a complete one.
//
// The defect: settings.ts called `restoreLatestMoat(notesDir, only)` with TWO args. The
// third parameter (`userDataDir`) is what resolves the three userData-based moat sources —
// operator-model.json, success-traces.json and ans-capabilities.json, which moat-backup.ts
// itself calls "the MOAT ... product moat" (human verdicts + calibration; explicitly NOT a
// rebuildable index). Without it, `udd` is null, `sourcePath()` returns null for every
// base:'userData' source, and the restore loop hits a bare `continue`.
//
// The failure was silent in both directions: backup-runner.ts DOES pass userDataDir, so the
// snapshots exist on disk; listMoatBackups DOES count them, so they are what enables and
// advertises the "Restore memory from backup" button. But the restore returned a non-empty
// `restored` (the vault ledgers) with the three moat labels absent — never restored, never
// errored, never named — so the UI showed `toast.success('Restored: ledger, construction …')`.
// A recoverable clobber became unrecoverable, and the product said it had recovered it.
//
// Pattern A (the guard already existed one call site away): `app.getPath('userData')` is
// imported and used in this same file, including to feed switchMoatVault — the very wipe this
// restore is meant to undo. Pattern B (total guarded, partial not): `restored.length === 0`
// showed "No backup found to restore yet.", but the partial case fires on a NORMAL restore.
//
// These tests drive the REAL registered handler through the same electron mock the
// spine-events suite uses, so they cover the production call site, not just the library
// (moat-backup.test.ts already proves the library restores userData sources when given the
// dir — the capability worked; only the caller omitted it).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const userDataDir = mkdtempSync(join(tmpdir(), 'lamprey-moat-restore-ud-'))
const vaultDir = mkdtempSync(join(tmpdir(), 'lamprey-moat-restore-vault-'))

const ipcRegistered: Map<string, (...args: any[]) => any> = new Map()

vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData') return userDataDir
      throw new Error(`unexpected getPath("${which}") in test`)
    }
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      ipcRegistered.set(channel, handler)
    }
  }
}))

vi.mock('../services/database', () => ({
  getDb: () => ({
    prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined, all: () => [] })
  })
}))
vi.mock('../services/keychain', () => ({
  setKey: vi.fn(),
  deleteKey: vi.fn(),
  isEncryptionAvailable: () => true,
  grantPlaintextConsent: vi.fn(),
  hasPlaintextConsent: () => true
}))
vi.mock('../services/deepseek', () => ({ deepseekClient: { resetClient: vi.fn() } }))
// The handler broadcasts on a successful restore; indexedCount would otherwise open the DB.
vi.mock('../services/local-brain/index-store', () => ({
  reindex: vi.fn(),
  indexedCount: () => 0
}))

import { backupMoatState, restoreLatestMoatDetailed } from '../services/local-brain/moat-backup'

const LEDGER_REL = join('.duin', '_state', 'claim-ledger.jsonl')

/** A ledger big enough to dodge the shrink-guard, deterministic per line count. */
function writeLedger(lines: number): void {
  mkdirSync(join(vaultDir, '.duin', '_state'), { recursive: true })
  const body = Array.from({ length: lines }, (_, i) => JSON.stringify({ id: i, claim: `c${i}` })).join('\n')
  writeFileSync(join(vaultDir, LEDGER_REL), body + '\n')
}

function writeOperatorModel(entries: number): void {
  const body = JSON.stringify({
    verdicts: Array.from({ length: entries }, (_, i) => ({ id: i, verdict: 'keep', calib: i / 100 }))
  })
  writeFileSync(join(userDataDir, 'operator-model.json'), body)
}

async function restoreHandler(): Promise<(...args: any[]) => any> {
  const { registerSettingsHandlers } = await import('./settings')
  registerSettingsHandlers()
  const h = ipcRegistered.get('brain:restoreMoat')
  expect(h, 'brain:restoreMoat handler must be registered').toBeTruthy()
  return h!
}

beforeEach(() => {
  ipcRegistered.clear()
  for (const d of [vaultDir, userDataDir]) {
    for (const name of readdirSync(d)) rmSync(join(d, name), { recursive: true, force: true })
  }
  // settings.ts reads localBrainNotesDir out of a real settings.json in userData.
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({ localBrainNotesDir: vaultDir })
  )
})

describe('brain:restoreMoat restores the userData moat stores', () => {
  it('restores operator-model.json after an in-place clobber (the defect)', async () => {
    writeOperatorModel(200)
    backupMoatState(vaultDir, 'daily', userDataDir) // exactly what backup-runner.ts does
    const good = readFileSync(join(userDataDir, 'operator-model.json'), 'utf-8')

    // In-place clobber: the file still EXISTS, so rehydrateMoatFromVault (which only fills in
    // MISSING files) will never repair it, and flushMoat projects the clobbered copy over the
    // .brain/_moat durable copy within 5 minutes. The .duin/_backups snapshot is the last copy.
    writeFileSync(join(userDataDir, 'operator-model.json'), '{"CLOBBERED":true}')

    const handler = await restoreHandler()
    const res = await handler(undefined, undefined)

    expect(res.success).toBe(true)
    expect(res.data.restored).toContain('operator-model')
    expect(readFileSync(join(userDataDir, 'operator-model.json'), 'utf-8')).toBe(good)
  })

  it('restores all three userData moat stores, not just the vault ledgers', async () => {
    writeLedger(300)
    writeOperatorModel(200)
    writeFileSync(join(userDataDir, 'success-traces.json'), JSON.stringify({ traces: 'x'.repeat(400) }))
    writeFileSync(join(userDataDir, 'ans-capabilities.json'), JSON.stringify({ caps: 'y'.repeat(400) }))
    backupMoatState(vaultDir, 'daily', userDataDir)

    writeFileSync(join(userDataDir, 'operator-model.json'), '{}')
    writeFileSync(join(userDataDir, 'success-traces.json'), '{}')
    writeFileSync(join(userDataDir, 'ans-capabilities.json'), '{}')
    writeFileSync(join(vaultDir, LEDGER_REL), 'CLOBBERED\n')

    const handler = await restoreHandler()
    const res = await handler(undefined, undefined)

    // The old behaviour returned ['ledger'] only — non-empty, so the UI said "Restored: ledger."
    expect(res.data.restored).toEqual(
      expect.arrayContaining(['ledger', 'operator-model', 'success-traces', 'ans-capabilities'])
    )
    for (const f of ['operator-model.json', 'success-traces.json', 'ans-capabilities.json']) {
      expect(readFileSync(join(userDataDir, f), 'utf-8'), `${f} was not written back`).not.toBe('{}')
    }
  })

  it('restores a single userData label when one is requested', async () => {
    writeOperatorModel(200)
    backupMoatState(vaultDir, 'daily', userDataDir)
    const good = readFileSync(join(userDataDir, 'operator-model.json'), 'utf-8')
    writeFileSync(join(userDataDir, 'operator-model.json'), '{"CLOBBERED":true}')

    const handler = await restoreHandler()
    const res = await handler(undefined, 'operator-model')

    expect(res.data.restored).toEqual(['operator-model'])
    expect(readFileSync(join(userDataDir, 'operator-model.json'), 'utf-8')).toBe(good)
  })

  it('never reports a partial restore as an unqualified success', async () => {
    writeLedger(300)
    writeOperatorModel(200)
    backupMoatState(vaultDir, 'daily', userDataDir)
    writeFileSync(join(vaultDir, LEDGER_REL), 'CLOBBERED\n')

    const handler = await restoreHandler()
    const res = await handler(undefined, undefined)

    // Every label that HAS a backup is accounted for: either restored or named in skipped.
    const accounted = new Set([
      ...res.data.restored,
      ...(res.data.skipped ?? []).map((s: { label: string }) => s.label)
    ])
    expect(accounted.has('operator-model')).toBe(true)
    expect(accounted.has('ledger')).toBe(true)
    // and with the userData dir correctly threaded, nothing is skipped at all.
    expect(res.data.skipped).toEqual([])
  })
})

describe('restoreLatestMoatDetailed accounts for what it could not restore', () => {
  it('names a backed-up userData label in skipped when no userDataDir is supplied', () => {
    writeOperatorModel(200)
    backupMoatState(vaultDir, 'daily', userDataDir)
    writeFileSync(join(userDataDir, 'operator-model.json'), '{"CLOBBERED":true}')

    // The old handler's exact call shape. It must no longer look like a clean success.
    const rep = restoreLatestMoatDetailed(vaultDir, undefined)

    expect(rep.restored).not.toContain('operator-model')
    expect(rep.skipped.map((s) => s.label)).toContain('operator-model')
    // and the live file is untouched, so the loss is still recoverable.
    expect(readFileSync(join(userDataDir, 'operator-model.json'), 'utf-8')).toBe('{"CLOBBERED":true}')
  })

  it('preserves the overwritten live content and logs the change (traceable restore)', () => {
    writeOperatorModel(200)
    backupMoatState(vaultDir, 'daily', userDataDir)
    const clobbered = '{"CLOBBERED":true}'
    writeFileSync(join(userDataDir, 'operator-model.json'), clobbered)

    const rep = restoreLatestMoatDetailed(vaultDir, 'operator-model', userDataDir)
    expect(rep.restored).toEqual(['operator-model'])

    // The content the restore replaced is archived, not discarded — an ill-judged restore
    // is itself undoable, and the log says what changed, when and where it went.
    const preDir = rep.preservedDir!
    expect(existsSync(preDir)).toBe(true)
    const saved = readdirSync(preDir).filter((n) => n.startsWith('operator-model.') && n.includes('.pre.'))
    expect(saved).toHaveLength(1)
    expect(readFileSync(join(preDir, saved[0]), 'utf-8')).toBe(clobbered)

    const log = readFileSync(join(preDir, 'restore-log.jsonl'), 'utf-8').trim().split('\n')
    const entry = JSON.parse(log[log.length - 1])
    expect(entry.label).toBe('operator-model')
    expect(entry.priorSavedAs).toBe(saved[0])
    expect(entry.priorBytes).toBe(clobbered.length)
    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('the preserved pre-restore copy can never become a restore candidate', () => {
    // Guard against the archive re-entering the backup pool: restoring a clobbered state
    // must not make that clobbered content the newest "backup" for the next restore.
    writeOperatorModel(200)
    backupMoatState(vaultDir, 'daily', userDataDir)
    const good = readFileSync(join(userDataDir, 'operator-model.json'), 'utf-8')
    writeFileSync(join(userDataDir, 'operator-model.json'), '{"CLOBBERED":true}')

    restoreLatestMoatDetailed(vaultDir, 'operator-model', userDataDir)
    writeFileSync(join(userDataDir, 'operator-model.json'), '{"CLOBBERED_AGAIN":true}')
    restoreLatestMoatDetailed(vaultDir, 'operator-model', userDataDir)

    expect(readFileSync(join(userDataDir, 'operator-model.json'), 'utf-8')).toBe(good)
  })
})
