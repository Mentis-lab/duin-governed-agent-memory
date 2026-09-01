// command-screen — a PURE, high-precision denylist backstop for run_command.
//
// This is NOT a sandbox and does not pretend to be one. It is a narrow last-resort
// guard that refuses the small set of CATASTROPHIC, irreversible host operations
// (wiping a drive/home, formatting, disk-level writes, shutting the machine down,
// disabling the AV/firewall, fork bombs) even on an already-authorized turn. The
// exec token authenticates the app; per-action approval (permissions-store) gates
// intent; this screen is the floor under both — so a compromised or confused model
// cannot destroy the host with a single command that slipped through.
//
// Design contract:
//   • FAIL-SAFE — a pattern match REFUSES; anything unmatched passes (this is a
//     backstop, not the primary control, so it must not become a chokepoint).
//   • HIGH PRECISION — every pattern targets an unambiguously destructive shape so
//     ordinary dev commands (npm/git/node/python/build/test, editing vault files)
//     are never blocked. Precision over recall by design.
//   • PURE — (command) → verdict, no I/O; unit-tested in isolation.

export type CommandScreenResult = { ok: true } | { ok: false; reason: string }

interface DenyRule {
  re: RegExp
  reason: string
}

// Each rule matches a catastrophic, effectively-irreversible operation. Patterns are
// deliberately anchored to destructive TARGETS (drive roots, home, block devices,
// system state) rather than a bare verb, to keep precision high.
const DENY_RULES: DenyRule[] = [
  // POSIX recursive force-remove aimed at a root / home / drive-glob.
  {
    re: /\brm\b[^\n|;&]*\s-[a-z]*\b(?:rf|fr)\b[^\n|;&]*\s(?:\/|~|\/\*|\$HOME)\s*(?:$|[\s;|&])/i,
    reason: 'recursive force-delete of a root/home path'
  },
  // POSIX rm -rf of a drive root written as `-r -f` in either order (loose form).
  {
    re: /\brm\b(?=[^\n|;&]*\s-[a-z]*r)(?=[^\n|;&]*\s-[a-z]*f)[^\n|;&]*\s(?:\/|~)\s*(?:$|[\s;|&])/i,
    reason: 'recursive force-delete of a root/home path'
  },
  // Windows recursive delete of a drive root (del /s /q C:\  |  rd/rmdir /s C:\).
  {
    re: /\b(?:del|erase|rd|rmdir)\b[^\n]*\/s\b[^\n]*[a-z]:\\?\s*(?:$|[\s&|])/i,
    reason: 'recursive delete of a drive root'
  },
  // PowerShell Remove-Item -Recurse -Force on a drive root or home.
  {
    re: /remove-item\b(?=[^\n]*-recurse)(?=[^\n]*-force)[^\n]*\s(?:[a-z]:\\?|\$home|~)\s*(?:$|[\s;|])/i,
    reason: 'recursive force Remove-Item of a drive root/home'
  },
  // Disk formatting / partitioning / raw block-device writes.
  { re: /\bformat\b[^\n]*\b[a-z]:\s/i, reason: 'formatting a drive' },
  { re: /\bmkfs(?:\.\w+)?\b/i, reason: 'making a new filesystem (mkfs)' },
  { re: /\bdiskpart\b/i, reason: 'disk partitioning (diskpart)' },
  { re: /\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|disk|hd)/i, reason: 'raw write to a block device (dd of=/dev/...)' },
  { re: />\s*\/dev\/(?:sd|nvme|disk|hd)\w+/i, reason: 'redirect to a raw block device' },
  // Machine power-state changes.
  { re: /\bshutdown\b/i, reason: 'shutting the machine down' },
  { re: /\b(?:Restart|Stop)-Computer\b/i, reason: 'restarting/stopping the machine' },
  // Disabling security controls.
  { re: /set-mppreference\b[^\n]*-disable\w*realtime/i, reason: 'disabling antivirus real-time protection' },
  { re: /netsh\b[^\n]*advfirewall[^\n]*\bstate\s+off/i, reason: 'turning the firewall off' },
  // Registry deletion of a root hive.
  { re: /\breg\b[^\n]*\bdelete\b[^\n]*\bHK(?:LM|CU|CR|U|CC)\\?\s*(?:$|[\s&|/])/i, reason: 'deleting a registry root hive' },
  // Classic fork bomb.
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
  // Volume-shadow / backup destruction (ransomware signature; irreversible).
  { re: /\bvssadmin\b[^\n]*\bdelete\b[^\n]*\bshadows\b/i, reason: 'deleting volume shadow copies (backup destruction)' },
  { re: /\bwmic\b[^\n]*\bshadowcopy\b[^\n]*\bdelete\b/i, reason: 'deleting volume shadow copies (backup destruction)' },
  // PowerShell disk-destruction cmdlets (parallel to format/diskpart).
  { re: /\b(?:Clear-Disk|Format-Volume|Remove-Partition)\b/i, reason: 'destructive disk cmdlet (clear/format/repartition)' },
  // Filesystem-signature wipe / raw device shred.
  { re: /\bwipefs\b[^\n]*(?:\s-a\b|\/dev\/)/i, reason: 'wiping filesystem signatures (wipefs)' },
  { re: /\bshred\b[^\n]*\/dev\/(?:sd|nvme|disk|hd)/i, reason: 'shredding a raw block device' },
  // Additional machine power-state changes (parallel to shutdown).
  { re: /(?:^|[;&|]\s*|\bsudo\s+)(?:poweroff|halt)\b/i, reason: 'powering off / halting the machine' },
  { re: /(?:^|[;&|]\s*|\bsudo\s+)init\s+[06]\b/i, reason: 'changing runlevel to halt/reboot (init 0/6)' },
  // Boot-configuration destruction (can brick startup).
  { re: /\bbcdedit\b[^\n]*\/delete(?:value)?\b/i, reason: 'deleting boot configuration (bcdedit /delete)' },
  // Root-scoped permission/ownership lockout.
  { re: /\bchmod\b[^\n]*\s0{2,3}\s+\/\s*(?:$|[\s;|&])/i, reason: 'chmod 000 on the filesystem root (lockout)' },
  { re: /\bchown\b[^\n]*\s-R\b[^\n]*\s\/\s*(?:$|[\s;|&])/i, reason: 'recursive chown of the filesystem root' }
]

/**
 * Screen a shell command string against the catastrophic-operation denylist.
 * Returns `{ ok: true }` for anything not matched (the overwhelming common case),
 * or `{ ok: false, reason }` naming why it was refused. PURE.
 */
export function screenCommand(command: unknown): CommandScreenResult {
  const cmd = String(command ?? '')
  for (const rule of DENY_RULES) {
    if (rule.re.test(cmd)) return { ok: false, reason: rule.reason }
  }
  return { ok: true }
}

// ── Risk classification (for the tier-aware AFK escalation) ────────────────
// `elevated` = a non-catastrophic but HIGH-RISK shape that should NOT silently
// auto-run under the fail-open `trusted-afk` posture when there is no kernel
// sandbox (Windows tier 'none'): piping a network fetch straight into a shell /
// interpreter (curl|sh, iwr|iex) or expression-evaluating downloaded content —
// the classic unsandboxed-RCE / supply-chain vector. NOT denied (legit installers
// use `curl … | sh`); it just loses the AFK auto-allow and re-prompts on an
// unsandboxed host. On a sandboxed host it stays auto-allowed. PURE.
export type CommandRisk = 'normal' | 'elevated'

const ELEVATED_RULES: RegExp[] = [
  /\b(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|d)?sh\b/i,
  /\b(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(?:iex|invoke-expression|python|node|perl|ruby)\b/i,
  /\b(?:iex|invoke-expression)\b[^\n]*(?:downloadstring|invoke-webrequest|iwr|invoke-restmethod|new-object\s+net\.webclient)/i
]

export function classifyCommandRisk(command: unknown): CommandRisk {
  const cmd = String(command ?? '')
  return ELEVATED_RULES.some((re) => re.test(cmd)) ? 'elevated' : 'normal'
}
