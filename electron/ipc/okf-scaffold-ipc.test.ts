// CALL-SITE coverage for `brain:scaffoldOkf` — and an HONEST RECORD of where the
// `replaced` chain actually stops.
//
// THE GAP: 935c1f3 fixed a data-loss defect in okf-scaffold.ts and threaded
// `replaced` (the .trash recovery path for each file whose prior content was
// overwritten) out through electron/ipc/onboarding.ts. okf-scaffold.test.ts
// covers the module; nothing covered the handler, so reverting the onboarding.ts
// hunk — dropping `replaced` from the IPC payload — left the suite green. Since
// the whole point of `replaced` is that SOMEBODY IS TOLD where the bytes went,
// dropping it at the IPC boundary reinstates the exact omission the commit
// describes: "the .trash copy existed but no caller was told where".
//
// WHAT I CHANGED, AND WHAT I DELIBERATELY DID NOT:
//
//  DONE — preload.ts's declared return type for scaffoldOkf omitted `replaced`
//  while the handler had always returned it. That is a wrong type, not a missing
//  feature: the value rides through ipcRenderer.invoke at runtime but was
//  invisible to every renderer typechecker. Corrected, so a renderer that wants
//  it can see it.
//
//  NOT DONE — a renderer surface. This is an INCOMPLETE FEATURE and is reported
//  as such rather than finished here, because finishing it would be speculative:
//
//    * `replaced` is only ever non-empty when a caller passes `overwrite: true`.
//    * NO renderer caller does. brain-shell.tsx:798 calls `scaffoldOkf(dir)` with
//      one argument; src/lib/brain-seed.ts scaffoldSeed calls
//      `brain.scaffoldOkf(notesDir, answers)` and reads only `success` and
//      `data.conceptsWritten`; OnboardingFlow.tsx reads only `conceptsWritten`.
//    * So the recovery path is unreachable from the UI today, and a toast for a
//      branch nothing can enter is invented coverage, not a closed gap. The
//      parent commit says as much — the defect is "latent rather than firing".
//
//  The honest state: the guard is real, the IPC payload carries the recovery
//  path, the type now admits it, and the last hop (a renderer that arms
//  `overwrite` and shows the user where their GOALS.md went) remains open work.
//  These tests pin everything up to that boundary so arming `overwrite` later is
//  a one-line renderer change against a proven contract, which is precisely the
//  scenario the parent commit warns about.
//
// POWER CONTROL: reverting the onboarding.ts hunk fails these tests.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let vault = ''
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
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => userDataDir,
    getVersion: () => '0.0.0-test'
  },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openPath: async () => '' },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

// The handler fires reindex best-effort after a successful scaffold. Stubbed so
// the test does not depend on the index substrate — it is explicitly
// fire-and-forget and never affects the result.
vi.mock('../services/local-brain/index-store', () => ({
  reindex: async () => 0,
  indexedCount: () => 0
}))

import { registerOnboardingHandlers } from './onboarding'
import {
  __resetTrustedDirectoryGrants,
  grantTrustedDirectory
} from '../services/trusted-path-grants'

/** What the operator has maintained for months — the file the scaffold replaces. */
const OPERATOR_GOALS = `# GOALS\n\n## Tracks\n- [[Q3 Platform]] — shipping\n- [[Hiring]] — 2 open\n\n${'detail line\n'.repeat(50)}`

function scaffold(overwrite: boolean): Promise<any> {
  return handlers.get('brain:scaffoldOkf')!({}, vault, {}, overwrite)
}

beforeEach(() => {
  handlers.clear()
  vault = mkdtempSync(join(tmpdir(), 'duin-okf-ipc-vault-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'duin-okf-ipc-ud-'))
  grantTrustedDirectory(vault)
  registerOnboardingHandlers()
})

afterEach(() => {
  __resetTrustedDirectoryGrants()
  for (const d of [vault, userDataDir]) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true })
  }
})

describe('brain:scaffoldOkf IPC handler (real call site)', () => {
  it('is registered', () => {
    expect(handlers.has('brain:scaffoldOkf')).toBe(true)
  })

  it('rejects every renderer-supplied write root that lacks a picker grant', async () => {
    const scaffoldOkfResult = await handlers.get('brain:scaffoldOkf')!({}, userDataDir, {}, false)
    const identityResult = await handlers.get('brain:writeIdentity')!({}, userDataDir, '# ME', '# BRAIN')
    const newOperatorResult = await handlers.get('brain:scaffoldNewOperator')!({}, userDataDir, {})

    for (const result of [scaffoldOkfResult, identityResult, newOperatorResult]) {
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/active vault|native folder picker/i)
    }
  })

  it('always carries a `replaced` map in the payload, even on a clean scaffold', async () => {
    const res = await scaffold(false)

    expect(res.success).toBe(true)
    // Present-and-empty rather than absent, so a consumer can read it
    // unconditionally instead of feature-detecting.
    expect(res.data.replaced).toEqual({})
  })

  it('surfaces the .trash recovery path for a REPLACED GOALS.md through IPC', async () => {
    writeFileSync(join(vault, 'GOALS.md'), OPERATOR_GOALS, 'utf-8')

    const res = await scaffold(true)

    expect(res.success).toBe(true)
    // THE POINT OF THE FIX: somebody is told where the bytes went.
    const replaced = res.data.replaced as Record<string, string>
    expect(Object.keys(replaced).length).toBeGreaterThan(0)
    const goalsKey = Object.keys(replaced).find((k) => k.includes('GOALS.md'))
    expect(goalsKey).toBeDefined()

    // And the path it names actually resolves to the operator's prior bytes.
    const recovered = join(vault, ...String(replaced[goalsKey!]).split('/'))
    expect(existsSync(recovered)).toBe(true)
    expect(readFileSync(recovered, 'utf-8')).toBe(OPERATOR_GOALS)
  })

  it('reports the same recovery paths the service produced, not a reconstruction', async () => {
    writeFileSync(join(vault, 'GOALS.md'), OPERATOR_GOALS, 'utf-8')
    mkdirSync(join(vault, '.brain', 'memory'), { recursive: true })

    const res = await scaffold(true)

    // Every value is a vault-relative .trash path, and every one exists on disk.
    for (const [, rel] of Object.entries(res.data.replaced as Record<string, string>)) {
      expect(rel).toContain('.trash')
      expect(existsSync(join(vault, ...String(rel).split('/')))).toBe(true)
    }
  })
})
