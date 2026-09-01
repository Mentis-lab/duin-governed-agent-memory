// CALL-SITE coverage for `brain:graphHistory` (electron/ipc/settings.ts).
//
// THE GAP these tests close: f93f3bd fixed a data-loss defect by EXTRACTING the
// inline read-modify-rewrite out of the IPC handler and into
// services/brain/graph-history-store.ts. graph-history-store.test.ts (8 tests)
// covers the module, but nothing covered the HANDLER — so reverting settings.ts
// wholesale back to the pre-fix inline body (JSON.parse -> `catch { return null }`
// -> `.filter(r => r !== null)` -> bare writeFileSync) left every one of those 8
// library tests green. For this commit the extraction IS the fix, so un-wired
// == un-fixed, and the suite was green against the exact bug it documents.
//
// These tests drive the REAL registered ipcMain handler: electron is mocked only
// for ipcMain (to capture handlers), app.getPath (userData -> temp) and
// BrowserWindow/dialog; the settings.json the handler reads is a REAL file in a
// REAL temp dir, and the ledger it rewrites is a REAL file in a REAL temp vault.
// graph-insight is stubbed because the live brain graph is not what is under
// test — the snapshot's CONTENT is irrelevant, its arrival in the ledger is not.
//
// POWER CONTROL: reverting the settings.ts hunk to the pre-fix inline handler
// fails both tests here — the unparseable line is deleted from disk, and
// atomicWriteFileSync is never called.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let userDataDir = ''
let vaultDir = ''

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

// The live brain graph is irrelevant here; a deterministic snapshot keeps the
// assertions about the LEDGER, which is what the handler is responsible for.
vi.mock('../services/brain/graph-insight', () => ({
  buildGraphSnapshot: () => ({ nodes: 99, edges: 42 }),
  buildGraphReport: () => ({}),
  buildCommunityAssignments: () => ({})
}))

// Wrap (do not replace) atomic-write so the real atomic rewrite still happens on
// disk AND we can prove the handler's write went through it rather than a bare
// writeFileSync that truncates the only copy in place.
const atomicSpy = vi.fn()
vi.mock('../services/atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/atomic-write')>()
  return {
    ...actual,
    atomicWriteFileSync: (target: string, data: string | Buffer, mode?: number) => {
      atomicSpy(target)
      return actual.atomicWriteFileSync(target, data, mode)
    }
  }
})

import { registerSettingsHandlers } from './settings'

const TORN = '{"date":"2026-07-18","notes":12'
const VALID_PAST = '{"date":"2026-07-17","nodes":5,"edges":3}'

function ledgerPath(): string {
  return join(vaultDir, '.duin', '_state', 'graph-history.jsonl')
}

/** Seed a real vault whose ledger already carries one valid and one torn line. */
function seedLedger(lines: string[]): void {
  const stateDir = join(vaultDir, '.duin', '_state')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(ledgerPath(), lines.join('\n') + '\n', 'utf8')
}

beforeEach(() => {
  handlers.clear()
  atomicSpy.mockClear()
  userDataDir = mkdtempSync(join(tmpdir(), 'duin-ghist-ud-'))
  vaultDir = mkdtempSync(join(tmpdir(), 'duin-ghist-vault-'))
  // The handler's ONLY gate is settings.localBrainNotesDir — a real settings.json,
  // read by the real readSettingsFile, pointing at the real temp vault.
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({ localBrainNotesDir: vaultDir }),
    'utf8'
  )
  registerSettingsHandlers()
})

afterEach(() => {
  for (const d of [userDataDir, vaultDir]) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true })
  }
})

describe('brain:graphHistory IPC handler (real call site)', () => {
  it('is registered', () => {
    expect(handlers.has('brain:graphHistory')).toBe(true)
  })

  it('preserves an unparseable ledger line on disk while recording today', async () => {
    seedLedger([VALID_PAST, TORN])

    const res = await handlers.get('brain:graphHistory')!({})
    expect(res.success).toBe(true)

    // The line the pre-fix handler deleted from the only copy on disk.
    const after = readFileSync(ledgerPath(), 'utf8')
    expect(after).toContain(TORN)
    // The valid prior line survives verbatim, and today's snapshot was appended.
    expect(after).toContain(VALID_PAST)
    expect(after).toContain('"nodes":99')

    // The panel still only renders parseable rows — the torn line is preserved on
    // disk, not surfaced as a row.
    const rows = res.data as Record<string, unknown>[]
    expect(rows.every((r) => r && typeof r === 'object')).toBe(true)
    expect(rows.some((r) => r.nodes === 99)).toBe(true)
    expect(rows).toHaveLength(2)
  })

  it('rewrites the ledger through atomicWriteFileSync, not a bare writeFileSync', async () => {
    seedLedger([VALID_PAST])

    await handlers.get('brain:graphHistory')!({})

    expect(atomicSpy).toHaveBeenCalledTimes(1)
    expect(atomicSpy).toHaveBeenCalledWith(ledgerPath())
  })

  it('does not create .duin/_state just to log telemetry into a cold vault', async () => {
    // No .duin/_state seeded — the cold-data-safe gate must hold at the call site.
    const res = await handlers.get('brain:graphHistory')!({})

    expect(res.success).toBe(true)
    expect(existsSync(join(vaultDir, '.duin', '_state'))).toBe(false)
    expect(atomicSpy).not.toHaveBeenCalled()
  })
})
