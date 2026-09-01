// ────────────────────────────────────────────────────────────────────────
// Windows WRITE_RESTRICTED profile (S6 — real backend, 2026-08-15).
//
// Replaces the honest pass-through with kernel-level write confinement,
// the deepseek-harness sandbox-windows-acl approach reimplemented
// dependency-free: a bundled PowerShell launcher
// (resources/sandbox-win32/restrict-run.ps1) builds a WRITE_RESTRICTED
// token whose only restricted SID is a deterministic per-workspace local
// group, grants that SID Modify on the workspace root (+ extra write
// paths, idempotent icacls), redirects the child's TEMP inside the
// workspace, and CreateProcessAsUser-launches the command. Writes outside
// the grants are kernel-denied ("Access is denied"); reads and network
// are untouched — WRITE_RESTRICTED's design, and DUIN's approval/CAP
// layers stay above this floor.
//
// Enforcement tier is reported as 'win32-write-restricted' with an honest
// PARTIAL note. `hasKernelSandbox()` deliberately still returns false on
// win32 for now: that predicate loosens the trusted-afk approval
// escalation, and this backend earns that only after live soak.
//
// Launcher failures FAIL CLOSED (exit 190, command not run) — a broken
// sandbox never silently degrades to unconfined execution at runtime.
// When the launcher script or powershell.exe is missing at wrap time, we
// return null and the dispatcher's pass-through surfaces tier 'none',
// mirroring "bwrap missing" on linux.
//
// ELEVATION PRE-CHECK (release, 2026-09-01). The launcher's per-workspace
// local group needs an ELEVATED process (restrict-run.ps1:62-70,
// New-LocalGroup), and a normal double-clicked DUIN.exe is not elevated —
// so on a stranger's Windows box in confined mode every approved command
// died at exit 190 after the approval modal: a broken shell tool on first
// use. `whoami /groups` answers "is this process elevated?" once per
// process; when it says no, the wrap degrades to the honest pass-through
// (tier 'none', WIN32_NOT_ELEVATED_NOTE) exactly like linux-without-bwrap,
// and the command runs unjailed. What stays: the approval modal, the
// catastrophic-command screen, and `hasKernelSandbox()` still reporting
// false on win32 — so agui-approval keeps refusing `curl | sh` shapes
// unattended on this host. An UNKNOWN probe result (no whoami, unexpected
// output) reads as elevated, so a probe failure can never loosen the
// sandbox: the launcher is attempted and fails closed exactly as before.
//
// Pure module: no Electron imports. Path resolution uses __dirname (dev
// tree) and process.resourcesPath (packaged), both plain globals.
// ────────────────────────────────────────────────────────────────────────

import { existsSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { findOnPath } from '../shell-tool'
import type { SandboxInput, SandboxOutput } from './index'

/** The one-line reason a confined win32 host runs a command unjailed. Surfaced as the
 *  pass-through `note` (the model sees it) and logged once per process. */
export const WIN32_NOT_ELEVATED_NOTE =
  'windows host: DUIN is not running elevated, so the write-restricted sandbox cannot be set up ' +
  '(its launcher creates a per-workspace local group); the command runs unjailed — the approval ' +
  'modal and the catastrophic-command screen still apply'

/** Mandatory-integrity labels `whoami /groups` prints. High (S-1-16-12288) and System
 *  (S-1-16-16384) mean the process is elevated; Medium/Low/Untrusted mean it is not. */
const ELEVATED_LABEL_RE = /\bS-1-16-(12288|16384)\b/
const ANY_LABEL_RE = /\bS-1-16-\d+\b/

/** Is THIS process elevated? Cheap (one `whoami /groups`, ~30 ms) and cached — the answer cannot
 *  change for a running process. Unknown → `true` (fail closed: attempt the launcher). */
function probeElevation(): boolean {
  const candidates = [join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), 'whoami']
  for (const cmd of candidates) {
    try {
      const r = spawnSync(cmd, ['/groups'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      if (r.error || r.status !== 0 || typeof r.stdout !== 'string') continue
      if (!ANY_LABEL_RE.test(r.stdout)) return true // no integrity label at all → unknown → fail closed
      return ELEVATED_LABEL_RE.test(r.stdout)
    } catch {
      /* try the next candidate */
    }
  }
  return true
}

let elevationCache: boolean | null = null
let elevationProbe: () => boolean = probeElevation
let degradeNoted = false

/** Cached answer to "is this process elevated?" — exported so the live enforcement test can
 *  skip honestly on a host where the launcher could not run anyway. */
export function win32HostIsElevated(): boolean {
  if (elevationCache === null) elevationCache = elevationProbe()
  return elevationCache
}

/** Test seam: replace the elevation probe (null restores the real one). Clears the cache. */
export function __setWin32ElevationProbeForTest(probe: (() => boolean) | null): void {
  elevationProbe = probe ?? probeElevation
  elevationCache = null
  degradeNoted = false
}

const PARTIAL_NOTE =
  'Sandbox: win32-write-restricted (partial) — writes are kernel-denied outside the workspace ' +
  'and its declared write paths; reads, network, and process launch remain open. Approval ' +
  'policies still gate network-tier calls.'

/** Locate the bundled launcher script (dev tree vs packaged resources). */
function defaultLauncherPath(): string | null {
  const candidates = [
    // Packaged: extraResources ships resources/sandbox-win32 → resources/sandbox-win32.
    typeof process.resourcesPath === 'string'
      ? join(process.resourcesPath, 'sandbox-win32', 'restrict-run.ps1')
      : null,
    // Dev: compiled main runs from out/main; the repo root is two levels up.
    join(__dirname, '..', '..', 'resources', 'sandbox-win32', 'restrict-run.ps1'),
    join(process.cwd(), 'resources', 'sandbox-win32', 'restrict-run.ps1')
  ].filter((p): p is string => !!p)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Test seams. */
let launcherLocator: () => string | null = defaultLauncherPath
let powershellLocator: () => string | null = () => findOnPath('powershell')

export function __setWin32LocatorsForTest(
  launcher: (() => string | null) | null,
  powershell?: (() => string | null) | null
): void {
  launcherLocator = launcher ?? defaultLauncherPath
  powershellLocator = powershell === undefined || powershell === null
    ? () => findOnPath('powershell')
    : powershell
}

/** The command argv travels as base64(JSON string[]) — immune to PowerShell
 *  parameter binding and every quoting layer between spawn and the script.
 *  Exposed for tests. */
export function encodeCmdB64(argv: string[]): string {
  return Buffer.from(JSON.stringify(argv), 'utf-8').toString('base64')
}

export function applyWindowsProfile(input: SandboxInput): SandboxOutput | null {
  const launcher = launcherLocator()
  const powershell = powershellLocator()
  if (!launcher || !powershell) return null

  // Not elevated → the launcher would fail closed at exit 190 on every command. Degrade to the
  // honest pass-through instead (same shape as linux-without-bwrap): tier 'none', the reason in
  // the note, one console line per process. See the header.
  if (!win32HostIsElevated()) {
    if (!degradeNoted) {
      degradeNoted = true
      console.warn(`[sandbox] ${WIN32_NOT_ELEVATED_NOTE}`)
    }
    return { cmd: input.spawnCmd, args: input.spawnArgs, sandboxTier: 'none', note: WIN32_NOT_ELEVATED_NOTE }
  }

  const writePaths = (input.opts.fsWritePaths ?? []).filter(Boolean).join(';')
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    launcher,
    '-Workspace',
    input.opts.workspaceRoot,
    ...(writePaths ? ['-WritePaths', writePaths] : []),
    '-CmdB64',
    encodeCmdB64([input.spawnCmd, ...input.spawnArgs])
  ]
  return {
    cmd: powershell,
    args,
    sandboxTier: 'win32-write-restricted',
    note: PARTIAL_NOTE
  }
}
