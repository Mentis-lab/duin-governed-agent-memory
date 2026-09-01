// ────────────────────────────────────────────────────────────────────────
// S3 — Sandbox profile abstraction layer
//
// `applyProfile()` is the single entry point the shell executor calls to
// wrap a spawn `(cmd, args)` pair with OS-level isolation. The function
// dispatches to a per-platform module:
//
//   darwin → sandbox-exec wrapper (S4 — ./darwin.ts)
//   linux  → bubblewrap wrapper   (S5 — ./linux.ts)
//   win32  → pass-through, tier   (S6 — ./win32.ts)
//
// When a platform module returns `null` (e.g. bwrap missing) or is not
// implemented, the entry point falls back to a pass-through with
// `sandboxTier: 'none'` so the caller still gets a usable invocation —
// the weaker tier is surfaced in the result so the renderer / model can
// react to it.
//
// This module is pure (no Electron imports, no I/O beyond what the
// platform helpers do). The shell executor stays unit-testable.
// ────────────────────────────────────────────────────────────────────────

import { applyDarwinProfile } from './darwin'
import { applyLinuxProfile } from './linux'
import { applyWindowsProfile } from './win32'
import { findOnPath } from '../shell-tool'

/** Does THIS host provide a real kernel sandbox for host-exec? Mirrors the
 *  per-platform availability the profile modules use (darwin `sandbox-exec` /
 *  linux `bwrap` present on PATH). Consumed by the approval gate for the
 *  tier-aware trusted-afk escalation (a high-risk unsandboxed command must
 *  not silently auto-run).
 *
 *  DELIBERATELY still `false` on win32 even though the write-restricted
 *  backend (S6, 2026-08-15) now confines writes: returning true here LOOSENS
 *  approval prompting, and the new backend is write-only confinement
 *  (reads/network open) that should earn that loosening through live soak
 *  first. Flip only as a deliberate reviewed change. */
export function hasKernelSandbox(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'darwin') return !!findOnPath('sandbox-exec')
  if (platform === 'linux') return !!findOnPath('bwrap')
  return false
}

export type SandboxTier =
  | 'darwin-sbx'
  | 'linux-bwrap'
  | 'win32-write-restricted'
  | 'none'
  | 'bypassed'

export type NetworkPolicy = 'open' | 'deny' | { allowDomains: string[] }

export interface SandboxOptions {
  /** Workspace root the shell call is rooted in. Always included in fsWritePaths. */
  workspaceRoot: string
  /** Additional writable paths. The system tmpdir is added automatically. */
  fsWritePaths?: string[]
  /** Network egress policy. Default `'open'`. */
  networkPolicy?: NetworkPolicy
}

export interface SandboxInput {
  spawnCmd: string
  spawnArgs: string[]
  cwd: string
  opts: SandboxOptions
  /** Override for tests — defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** Full computer access (operator opt-in, OFF by default): when true, the write-confinement
   *  is OFF — the shell may write anywhere. The CALLER reads the setting (fullComputerAccess())
   *  and passes it, so applyProfile stays pure/testable and its confinement suites (which omit
   *  this) are unaffected. Catastrophic commands are still screened at the gate + executor
   *  seam; this only lifts the fs-write jail. */
  fullAccess?: boolean
}

export interface SandboxOutput {
  cmd: string
  args: string[]
  sandboxTier: SandboxTier
  /** Optional human-readable note about *why* the tier is what it is.
   *  Surface to the model when tier !== 'darwin-sbx' / 'linux-bwrap'. */
  note?: string
}

/** Pass-through used when no platform impl applies or one returns `null`. */
function passThrough(input: SandboxInput, note?: string): SandboxOutput {
  return {
    cmd: input.spawnCmd,
    args: input.spawnArgs,
    sandboxTier: 'none',
    note
  }
}

/**
 * Resolve the right platform module and return a wrapped invocation.
 * Returns a pass-through with `tier: 'none'` when no kernel-level
 * isolation is available on this host.
 */
export function applyProfile(input: SandboxInput): SandboxOutput {
  const platform = input.platform ?? process.platform

  // OPERATOR KILL SWITCH — `DUIN_SANDBOX=0` degrades to pass-through.
  //
  // Polarity is deliberate and matches the house rule (unset ≠ zero, property 8):
  // unset/anything-else = sandbox ON (secure default); ONLY the explicit string
  // '0' turns it off, and the result says so honestly rather than pretending a
  // tier it isn't enforcing.
  //
  // Why this must exist: the win32 backend needs admin to create its per-workspace
  // group, and it is FAIL-CLOSED — on a machine without that right, every single
  // shell_command dies at sandbox setup (exit 190) with no way to proceed. A
  // security control with no operator-reachable off switch is a bricking bug on
  // any host it cannot initialise on. It also lets the shell-tool test suites,
  // which exercise shell SEMANTICS (cwd persistence, env merge, exit codes) rather
  // than confinement, run without a restricted token that cannot initialise inside
  // a vitest worker (STATUS_DLL_INIT_FAILED / 0xC0000142 there, while the same
  // wrapper runs clean from a real node/PowerShell parent).
  if (process.env.DUIN_SANDBOX === '0') {
    return passThrough(input, 'sandbox disabled by operator (DUIN_SANDBOX=0)')
  }

  // Full computer access (operator opt-in, OFF by default): DUIN is authorized to act anywhere
  // on the machine, so the shell WRITE-confinement is off — pass through. This only lifts the
  // fs-write jail; catastrophic commands are still screened at the gate + executor seam
  // (command-screen.ts). The caller passes the setting (fullComputerAccess()); confined mode
  // (fullAccess falsy — the default) keeps the per-workspace sandbox below. NOTE for a confined
  // win32 host: the write-restricted launcher needs an ELEVATED process to create its
  // per-workspace group; win32.ts probes elevation up front and, when the process is not
  // elevated, returns the honest pass-through (tier 'none', WIN32_NOT_ELEVATED_NOTE) so an
  // approved command runs unjailed instead of dying at exit 190 after the modal.
  if (input.fullAccess) {
    return passThrough(input, 'full computer access (operator opt-in): shell write-confinement off')
  }

  if (platform === 'darwin') {
    return applyDarwinProfile(input) ?? passThrough(input, 'darwin profile unavailable')
  }
  if (platform === 'linux') {
    return applyLinuxProfile(input) ?? passThrough(input, 'linux profile unavailable (bwrap missing?)')
  }
  if (platform === 'win32') {
    return applyWindowsProfile(input) ?? passThrough(input, 'windows host: no kernel sandbox')
  }

  // Unknown platform (e.g. freebsd). Pass through, surface the tier.
  return passThrough(input, `no sandbox profile for platform "${platform}"`)
}
