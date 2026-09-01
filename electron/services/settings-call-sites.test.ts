// 3f60165 built settings-file.ts as the single read/write choke point and covered it
// thoroughly (settings-file-corrupt.test.ts, 13 tests). What it did NOT cover is
// ADOPTION: nothing asserted that the five readers actually route through it. Revert
// any of settings-helper.ts / ipc/{model,github,onboarding,settings}.ts to bare
// readFileSync + `catch { return {} }` + writeFileSync and that entire suite stays
// green — while the defect returns in full.
//
// That gap matters more here than usual, because the commit's own thesis is that the
// defect LIVED at the call sites: five readers each collapsing 'absent' and 'corrupt'
// into {}. The mechanism was never the weak part.
//
// Two layers below:
//   1. BEHAVIOURAL, on the exact live path the commit measured — main.ts's
//      schedulePersistBounds -> patchSettings({windowBounds}) on a 500ms debounce after
//      any window move. That is the scenario that turned 1680 bytes of recoverable
//      residue into 34, with no user intent.
//   2. ADOPTION, across all five files — a structural guard that fails if any of them
//      reintroduces a bare settings write. It is deliberately a source-level check:
//      driving four more IPC handlers would need the full electron harness for far less
//      signal than simply pinning that the choke point stays the only door.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'

const userDataDir = mkdtempSync(join(tmpdir(), 'lamprey-settings-callsites-'))

vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData') return userDataDir
      throw new Error(`unexpected getPath("${which}") in test`)
    }
  }
}))

import { patchSettings, readSettings } from './settings-helper'

const SETTINGS = join(userDataDir, 'settings.json')

// A real torn write: a valid JSON PREFIX. Most of the config is still physically on
// disk and hand-recoverable — which is precisely what the old read+write pair destroyed.
const TORN =
  '{"localBrainNotesDir":"D:\\\\vaults\\\\Sample-brain",' +
  '"customModels":[{"id":"glm-5.2","provider":"zhipu","contextWindow":128000}],' +
  '"rssFeeds":["https://example.com/feed.xml"],"githubAuthMode":"pat","windowBo'

function sidecars(): string[] {
  return readdirSync(userDataDir).filter((f) => f.startsWith('settings.corrupt-'))
}

function clean(): void {
  for (const f of readdirSync(userDataDir)) rmSync(join(userDataDir, f), { force: true })
}

describe('settings call sites — patchSettings routes through the choke point', () => {
  beforeEach(clean)
  afterEach(clean)

  it('preserves a torn settings.json when a window nudge persists windowBounds', () => {
    writeFileSync(SETTINGS, TORN, 'utf8')

    // No user intent — this is the debounced bounds persist, the same call main.ts makes.
    patchSettings({ windowBounds: { x: 100, y: 80, width: 1280, height: 800 } })

    // The prior bytes survive, verbatim, in a traceable side-car...
    const side = sidecars()
    expect(side).toHaveLength(1)
    const preserved = readFileSync(join(userDataDir, side[0]), 'utf-8')
    expect(preserved).toBe(TORN)
    // ...including the vault path, whose loss points the brain at nothing.
    expect(preserved).toContain('Sample-brain')
    expect(preserved).toContain('glm-5.2')

    // ...and the app stays usable: the write went through, not refused.
    const now = JSON.parse(readFileSync(SETTINGS, 'utf-8')) as Record<string, unknown>
    expect((now.windowBounds as { width: number }).width).toBe(1280)
  })

  it('does NOT side-car a healthy settings.json — the guard must not fire on every write', () => {
    writeFileSync(SETTINGS, JSON.stringify({ localBrainNotesDir: '/vault', theme: 'dark' }), 'utf8')

    patchSettings({ windowBounds: { x: 1, y: 2, width: 3, height: 4 } })

    expect(sidecars()).toEqual([])
    const now = JSON.parse(readFileSync(SETTINGS, 'utf-8')) as Record<string, unknown>
    // The merge preserved the existing keys rather than replacing the file.
    expect(now.localBrainNotesDir).toBe('/vault')
    expect(now.theme).toBe('dark')
  })

  it('does NOT side-car an absent settings.json — absent and corrupt stay distinguishable', () => {
    expect(existsSync(SETTINGS)).toBe(false)

    patchSettings({ theme: 'light' })

    expect(sidecars()).toEqual([])
    expect(readSettings().theme).toBe('light')
  })

  it('reads a torn file as empty rather than throwing, so hot-path readers never crash', () => {
    writeFileSync(SETTINGS, TORN, 'utf8')
    expect(() => readSettings()).not.toThrow()
    expect(readSettings().localBrainNotesDir).toBeUndefined()
  })
})

// ── adoption: the choke point must stay the only door ──────────────────────────────
//
// Structural by design. The regression this catches is the one that actually happened:
// a reader doing its own readFileSync/catch/writeFileSync pair. Each settings owner
// was a separate instance of it.

const CALL_SITES = [
  'electron/services/settings-helper.ts',
  'electron/services/brain-vault-adoption.ts',
  'electron/ipc/model.ts',
  'electron/ipc/github.ts',
  // ipc/onboarding.ts left this list 2026-08-24: its only settings.json access was
  // `persistNotesDir` — private plumbing of the deleted brain:loadDemoVault handler
  // (d26f783), itself dead code since then, removed in the coldstart-review pass.
  // The file now has NO settings.json access to route. The bare-writer assert below
  // still applies the day one returns; re-add the row with the import if it does.
  'electron/ipc/settings.ts'
]

// vitest runs with the repo root as cwd.
const repoRoot = process.cwd()

describe('settings call sites — none may write settings.json directly', () => {
  for (const rel of CALL_SITES) {
    it(`${rel} routes through settings-file`, () => {
      const src = readFileSync(resolve(repoRoot, rel), 'utf-8')
      // Imports the choke point (github.ts aliases the names on import, hence the loose match).
      expect(src).toMatch(/from ['"][^'"]*settings-file['"]/)
      // And does not carry its own writer. writeSettingsFile/readSettingsFile as *local
      // wrapper names* are fine (github.ts does exactly that) — a bare fs write is not.
      expect(src).not.toMatch(/\bwriteFileSync\s*\(/)
    })
  }

  it('the settings-file module is the one place that writes, and it writes atomically', () => {
    const src = readFileSync(resolve(repoRoot, 'electron/services/settings-file.ts'), 'utf-8')
    // atomicWriteFileSync's own docstring names settings.json as a file whose torn write
    // is catastrophic; 3f60165's whole point was to finally obey it here.
    expect(src).toMatch(/atomicWriteFileSync/)
  })
})
