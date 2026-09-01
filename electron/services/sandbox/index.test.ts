import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { applyProfile } from './index'
import { __setWin32LocatorsForTest, __setWin32ElevationProbeForTest } from './win32'

// The win32 cases describe an ELEVATED host (the tier is claimed only when the launcher can
// create its group); the real probe would make them depend on how the runner was started.
beforeEach(() => {
  __setWin32ElevationProbeForTest(() => true)
})
afterEach(() => {
  __setWin32LocatorsForTest(null)
  __setWin32ElevationProbeForTest(null)
})

describe('applyProfile (S3 abstraction)', () => {
  const baseInput = {
    spawnCmd: 'echo',
    spawnArgs: ['hi'],
    cwd: '/tmp/wk',
    opts: { workspaceRoot: '/tmp/wk' }
  }

  it('returns a SandboxOutput shape on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32', 'freebsd'] as NodeJS.Platform[]) {
      const r = applyProfile({ ...baseInput, platform })
      expect(typeof r.cmd).toBe('string')
      expect(Array.isArray(r.args)).toBe(true)
      expect(['darwin-sbx', 'linux-bwrap', 'win32-write-restricted', 'none', 'bypassed']).toContain(
        r.sandboxTier
      )
    }
  })

  it("passes through with tier 'none' on platforms with no impl yet", () => {
    // Until S4/S5/S6 populate the platform modules, every dispatch
    // path returns null and we fall back to pass-through.
    const r = applyProfile({ ...baseInput, platform: 'darwin' })
    expect(r.cmd).toBe('echo')
    expect(r.args).toEqual(['hi'])
    expect(r.sandboxTier).toBe('none')
    expect(r.note).toMatch(/darwin profile unavailable/)
  })

  it('reports win32-write-restricted on win32 (S6 real backend, launcher shipped in-tree)', () => {
    // Inject BOTH locators. `platform: 'win32'` only redirects the dispatch — the win32
    // module then probes the REAL host, and the powershell probe is findOnPath('powershell'),
    // which finds nothing on a Linux CI runner. The module was right to decline a tier it
    // cannot enforce; the test was asserting an unconditional tier while depending on a
    // host-provided binary, so it passed on Windows and failed on every CI run.
    __setWin32LocatorsForTest(
      () => 'C:\\app\\restrict-run.ps1',
      () => 'C:\\Windows\\powershell.exe'
    )
    const r = applyProfile({ ...baseInput, platform: 'win32' })
    expect(r.sandboxTier).toBe('win32-write-restricted')
    expect(r.note).toMatch(/partial/i)
  })

  it('falls back to pass-through on win32 when PowerShell is absent', () => {
    // The other half of the same seam, and the case the Linux runner was really hitting:
    // a tier is claimed only when the interpreter that enforces it is actually present.
    __setWin32LocatorsForTest(() => 'C:\\app\\restrict-run.ps1', () => null)
    const r = applyProfile({ ...baseInput, platform: 'win32' })
    expect(r.sandboxTier).toBe('none')
  })

  it("annotates 'none' on linux when bwrap is missing", () => {
    const r = applyProfile({ ...baseInput, platform: 'linux' })
    expect(r.sandboxTier).toBe('none')
    expect(r.note).toMatch(/bwrap/)
  })

  it("annotates 'none' on unknown platforms", () => {
    const r = applyProfile({ ...baseInput, platform: 'freebsd' as NodeJS.Platform })
    expect(r.sandboxTier).toBe('none')
    expect(r.note).toMatch(/freebsd/)
  })

  it('passes the network policy through opts (does not mutate input)', () => {
    const input = {
      ...baseInput,
      platform: 'linux' as NodeJS.Platform,
      opts: { workspaceRoot: '/tmp/wk', networkPolicy: 'deny' as const }
    }
    const before = JSON.stringify(input)
    applyProfile(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})
