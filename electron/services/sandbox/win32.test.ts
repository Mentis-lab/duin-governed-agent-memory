import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  applyWindowsProfile,
  encodeCmdB64,
  __setWin32LocatorsForTest,
  __setWin32ElevationProbeForTest,
  win32HostIsElevated,
  WIN32_NOT_ELEVATED_NOTE
} from './win32'
import { applyProfile, hasKernelSandbox } from './index'

const baseInput = {
  spawnCmd: 'cmd',
  spawnArgs: ['/c', 'echo hi'],
  cwd: 'C:\\work',
  opts: { workspaceRoot: 'C:\\work' },
  platform: 'win32' as NodeJS.Platform
}

// The wrapper-shape suite describes an ELEVATED host: the launcher can create its group, so the
// write-restricted tier is claimed. The real probe would make these depend on how the runner
// was started.
beforeEach(() => {
  __setWin32ElevationProbeForTest(() => true)
})
afterEach(() => {
  __setWin32LocatorsForTest(null)
  __setWin32ElevationProbeForTest(null)
  vi.restoreAllMocks()
})

// A non-elevated DUIN (every double-clicked DUIN.exe) cannot create the per-workspace local
// group restrict-run.ps1 needs, so before this branch every approved command in confined mode
// died at exit 190 AFTER the approval modal. Same degrade linux-without-bwrap has: honest
// pass-through, tier 'none', reason in the note, and the approval floor untouched.
describe('applyWindowsProfile — not elevated', () => {
  it('degrades to the pass-through so the approved command runs unjailed', () => {
    __setWin32LocatorsForTest(() => 'L', () => 'P')
    __setWin32ElevationProbeForTest(() => false)
    const r = applyWindowsProfile(baseInput)
    expect(r).not.toBeNull()
    expect(r!.sandboxTier).toBe('none')
    expect(r!.cmd).toBe('cmd')
    expect(r!.args).toEqual(['/c', 'echo hi'])
    expect(r!.note).toBe(WIN32_NOT_ELEVATED_NOTE)
    expect(r!.note).toMatch(/not running elevated/)
  })

  it('reaches the model through the dispatcher unchanged', () => {
    __setWin32LocatorsForTest(() => 'L', () => 'P')
    __setWin32ElevationProbeForTest(() => false)
    const r = applyProfile(baseInput)
    expect(r.sandboxTier).toBe('none')
    expect(r.note).toBe(WIN32_NOT_ELEVATED_NOTE)
  })

  it('logs the reason ONCE per process, not per command', () => {
    __setWin32LocatorsForTest(() => 'L', () => 'P')
    __setWin32ElevationProbeForTest(() => false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    applyWindowsProfile(baseInput)
    applyWindowsProfile(baseInput)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('not running elevated')
  })

  it('caches the probe — one whoami per process', () => {
    __setWin32LocatorsForTest(() => 'L', () => 'P')
    const probe = vi.fn(() => false)
    __setWin32ElevationProbeForTest(probe)
    applyWindowsProfile(baseInput)
    applyWindowsProfile(baseInput)
    expect(win32HostIsElevated()).toBe(false)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('keeps the approval floor: win32 still reports NO kernel sandbox, elevated or not', () => {
    // agui-approval.ts refuses `curl | sh` shapes unattended when sandboxed === false; that
    // must stay true on the degraded host, so the pass-through never loosens approvals.
    __setWin32ElevationProbeForTest(() => false)
    expect(hasKernelSandbox('win32')).toBe(false)
    __setWin32ElevationProbeForTest(() => true)
    expect(hasKernelSandbox('win32')).toBe(false)
  })

  it('an elevated host is unchanged: the write-restricted wrapper is claimed', () => {
    __setWin32LocatorsForTest(() => 'L', () => 'P')
    __setWin32ElevationProbeForTest(() => true)
    expect(applyWindowsProfile(baseInput)!.sandboxTier).toBe('win32-write-restricted')
  })
})

describe('applyWindowsProfile — wrapper shape', () => {
  it('wraps through powershell + the launcher with a decodable argv payload', () => {
    __setWin32LocatorsForTest(
      () => 'C:\\app\\resources\\sandbox-win32\\restrict-run.ps1',
      () => 'C:\\Windows\\powershell.exe'
    )
    const r = applyWindowsProfile(baseInput)
    expect(r).not.toBeNull()
    expect(r!.sandboxTier).toBe('win32-write-restricted')
    expect(r!.cmd).toBe('C:\\Windows\\powershell.exe')
    expect(r!.args).toContain('-File')
    expect(r!.args).toContain('C:\\app\\resources\\sandbox-win32\\restrict-run.ps1')
    expect(r!.args).toContain('-Workspace')
    const b64 = r!.args[r!.args.indexOf('-CmdB64') + 1]
    expect(JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'))).toEqual([
      'cmd',
      '/c',
      'echo hi'
    ])
    expect(r!.note).toMatch(/partial/i)
  })

  it('threads fsWritePaths as a semicolon list', () => {
    __setWin32LocatorsForTest(() => 'L', () => 'P')
    const r = applyWindowsProfile({
      ...baseInput,
      opts: { workspaceRoot: 'C:\\work', fsWritePaths: ['D:\\extra', 'E:\\more'] }
    })
    const idx = r!.args.indexOf('-WritePaths')
    expect(idx).toBeGreaterThan(-1)
    expect(r!.args[idx + 1]).toBe('D:\\extra;E:\\more')
  })

  it('returns null (dispatcher pass-through, tier none) when launcher or powershell is missing', () => {
    __setWin32LocatorsForTest(() => null, () => 'P')
    expect(applyWindowsProfile(baseInput)).toBeNull()
    __setWin32LocatorsForTest(() => 'L', () => null)
    expect(applyWindowsProfile(baseInput)).toBeNull()
    __setWin32LocatorsForTest(() => null, () => null)
    const viaDispatcher = applyProfile(baseInput)
    expect(viaDispatcher.sandboxTier).toBe('none')
  })

  it('encodeCmdB64 round-trips awkward args (quotes, spaces, dashes)', () => {
    const argv = ['pwsh', '-Command', 'echo "a b" --flag']
    expect(JSON.parse(Buffer.from(encodeCmdB64(argv), 'base64').toString('utf-8'))).toEqual(argv)
  })
})

// ── LIVE kernel enforcement (runs only on a real Windows host) ────────────
// The honest bar for a sandbox backend: prove the kernel actually denies.
// Skipped off-win32 (CI on linux/macOS, or Wine where the token APIs lie).
// Also skipped when THIS runner is not elevated: the launcher could not create its group there
// and the wrap now degrades to the pass-through by design (see the not-elevated suite).
describe.skipIf(process.platform !== 'win32' || !win32HostIsElevated())('win32 WRITE_RESTRICTED — live enforcement', () => {
  it(
    'writes inside the workspace succeed; writes outside are kernel-denied; reads pass',
    () => {
      const ws = mkdtempSync(join(tmpdir(), 'sbx-ws-'))
      const outside = mkdtempSync(join(tmpdir(), 'sbx-out-'))
      try {
        const wrapped = applyProfile({
          spawnCmd: 'cmd',
          spawnArgs: ['/c', `echo hello > ${ws}\\in.txt`],
          cwd: ws,
          opts: { workspaceRoot: ws },
          platform: 'win32'
        })
        expect(wrapped.sandboxTier).toBe('win32-write-restricted')
        execFileSync(wrapped.cmd, wrapped.args, { stdio: 'pipe' })
        expect(existsSync(join(ws, 'in.txt'))).toBe(true)

        const denied = applyProfile({
          spawnCmd: 'cmd',
          spawnArgs: ['/c', `echo hello > ${outside}\\out.txt`],
          cwd: ws,
          opts: { workspaceRoot: ws },
          platform: 'win32'
        })
        let deniedThrew = false
        try {
          execFileSync(denied.cmd, denied.args, { stdio: 'pipe' })
        } catch {
          deniedThrew = true
        }
        expect(deniedThrew).toBe(true)
        expect(existsSync(join(outside, 'out.txt'))).toBe(false)

        writeFileSync(join(outside, 'read.txt'), 'readable', 'utf-8')
        const read = applyProfile({
          spawnCmd: 'cmd',
          spawnArgs: ['/c', `type ${outside}\\read.txt`],
          cwd: ws,
          opts: { workspaceRoot: ws },
          platform: 'win32'
        })
        const out = execFileSync(read.cmd, read.args, { stdio: 'pipe' }).toString()
        expect(out).toContain('readable')
        expect(readFileSync(join(outside, 'read.txt'), 'utf-8')).toBe('readable')
      } finally {
        rmSync(ws, { recursive: true, force: true })
        rmSync(outside, { recursive: true, force: true })
      }
    },
    120_000
  )
})
