# restrict-run.ps1 — Windows WRITE_RESTRICTED sandbox launcher (S6, real).
#
# Wraps an arbitrary command in a WRITE-restricted token (the dsh
# sandbox-windows-acl approach, reimplemented dependency-free over
# PowerShell + Add-Type P/Invoke so DUIN ships no new native module):
#
#   * CreateRestrictedToken(WRITE_RESTRICTED) — WRITE-class access checks
#     pass ONLY where one of the token's *restricted SIDs* is explicitly
#     granted. Reads are unaffected (that is the flag's design).
#   * The restricted SID set is exactly ONE real SID nothing else on the
#     machine carries: a deterministic per-workspace LOCAL GROUP
#     (`duin-sbx-<hash12>`, created idempotently, no members needed —
#     restricted-SID checks are ACE checks, not membership) granted
#     Modify on the workspace root and each extra write path. The child's
#     TEMP/TMP is redirected to a fresh dir INSIDE the workspace, covered
#     by the same grant — no grant ever lands on the shared user TEMP, so
#     no other sandboxed process (e.g. a browser's restricted renderers)
#     gains anything from ours.
#   * CreateProcessAsUser with the restricted token (allowed without
#     special privileges for a restricted copy of the caller's own
#     token), inheriting stdio, forwarding the exit code.
#
# Enforcement is honest-but-partial (same stance dsh ships): writes are
# kernel-denied outside the grants, but reads, network, and process
# launch remain open — DUIN's approval/CAP layers stay above this floor.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File restrict-run.ps1
#     -Workspace <abs path> [-WritePaths "p1;p2"] -CmdB64 <base64(JSON string[])>
#
# The command travels as base64-encoded JSON argv — immune to PowerShell's
# parameter binding (a bare `--` or a `-flag`-shaped argument would
# otherwise be eaten by the CmdletBinding parser) and to every quoting
# layer between Node's spawn and this script.
#
# Exit codes: the child's own exit code; 190 = launcher setup failure
# (fail-closed: the command did NOT run unconfined).

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Workspace,
  [string]$WritePaths = '',
  [Parameter(Mandatory = $true)][string]$CmdB64
)

$ErrorActionPreference = 'Stop'

try {
  # ── argv: decode the base64 JSON array ──────────────────────────────────
  $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CmdB64))
  $cmdParts = @(($json | ConvertFrom-Json) | ForEach-Object { [string]$_ })
  if ($cmdParts.Count -lt 1) { [Console]::Error.WriteLine('restrict-run: no command given'); exit 190 }

  # ── deterministic per-workspace restricted SID: a REAL local group ──────
  # CreateRestrictedToken rejects synthetic capability-style SIDs in a
  # non-AppContainer restricted list (error 87), so the restricted SID must
  # be a genuine one. A dedicated local group per workspace gives exactly
  # that: a real SID that NOTHING else on the machine ever carries (no
  # membership is needed — restricted SIDs are checked against ACEs, not
  # group membership), so the write grants widen no other sandboxed
  # process (unlike granting to the shared RESTRICTED or logon SIDs).
  # Group creation needs admin; without it we fail closed (exit 190).
  $wsFull = [System.IO.Path]::GetFullPath($Workspace)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($wsFull.ToLowerInvariant()))
  $groupName = 'duin-sbx-' + (($hash[0..5] | ForEach-Object { $_.ToString('x2') }) -join '')
  $group = Get-LocalGroup -Name $groupName -ErrorAction SilentlyContinue
  if (-not $group) {
    # Description caps at 48 chars on PS 5.1's New-LocalGroup.
    $group = New-LocalGroup -Name $groupName -Description 'DUIN write-restricted sandbox SID'
  }
  $wsSid = $group.SID.Value

  # ── child TEMP lives INSIDE the workspace, covered by the same grant ────
  $childTemp = Join-Path $wsFull ('.duin-tmp-' + [Guid]::NewGuid().ToString('N').Substring(0, 10))
  New-Item -ItemType Directory -Path $childTemp -Force | Out-Null

  # ── idempotent write grants for the restricted SID ──────────────────────
  # The idempotence check must match on the RESOLVED PRINCIPAL NAME, not the raw
  # SID. `icacls <dir>` prints ACEs as `MACHINE\duin-sbx-<hash>:(OI)(CI)(M)` — it
  # never prints the S-1-5-… literal — so the original `-notmatch $sid` test was
  # always true and the grant re-ran on EVERY command. That grant carries (OI)(CI),
  # so each run made Windows re-propagate inheritance across the whole workspace
  # tree: measured 12.9s of the wrapper's 13.2s on this repo, per shell command,
  # forever. Matching the name makes the grant genuinely once-per-workspace (the
  # SID is still checked too, so a name-resolution failure degrades to the old
  # re-grant rather than skipping a grant that isn't actually there).
  function Grant-WriteSid([string]$path, [string]$sid, [string]$principalName) {
    if (-not (Test-Path -LiteralPath $path)) { return }
    $current = & icacls "$path" 2>$null | Out-String
    $alreadyGranted = ($current -match [regex]::Escape($sid)) -or
                      ($principalName -and ($current -match [regex]::Escape($principalName)))
    if (-not $alreadyGranted) {
      & icacls "$path" /grant "*${sid}:(OI)(CI)M" /Q | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "icacls grant failed on $path" }
    }
  }
  Grant-WriteSid $wsFull $wsSid $groupName
  foreach ($p in ($WritePaths -split ';' | Where-Object { $_ })) { Grant-WriteSid $p $wsSid $groupName }

  # ── P/Invoke core ───────────────────────────────────────────────────────
  # COMPILE ONCE TO DISK, not once per session. The original comment here read
  # "compiled once per PS session; ~0.5s cold" — true in an interactive session,
  # and false for the way this script is actually used: DUIN spawns a FRESH
  # `powershell.exe -File restrict-run.ps1` per shell command, so `Add-Type
  # -TypeDefinition` re-invoked csc.exe on EVERY command. Measured on this host:
  # 13.4s per `cmd /c echo` (vs 8ms unwrapped) — a ~1700x tax on every
  # shell_command in the product, and the cause of 15 shell/bg-shell test
  # timeouts. Caching the compiled assembly and loading it with `Add-Type -Path`
  # keeps identical semantics at ~30ms.
  #
  # The cache is keyed by a hash of the SOURCE below, so editing the C# in this
  # file automatically invalidates it — a stale DLL can never outlive its source.
  # Publish is write-tmp-then-move so two concurrent shells can't tear a reader.
  $csSource = @'
using System;
using System.Runtime.InteropServices;
public static class DuinRestrictRun {
  const uint TOKEN_ALL_ACCESS = 0xF01FF;
  const uint WRITE_RESTRICTED = 0x8;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x400;

  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars;
    public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow;
    public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int nStdHandle);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ConvertStringSidToSidW(string sid, out IntPtr psid);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool CreateRestrictedToken(IntPtr existing, uint flags,
    uint disableCount, IntPtr sidsToDisable, uint deleteCount, IntPtr privsToDelete,
    uint restrictCount, SID_AND_ATTRIBUTES[] sidsToRestrict, out IntPtr newToken);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessAsUserW(IntPtr token, string app, string cmdLine,
    IntPtr pa, IntPtr ta, bool inherit, uint flags, string env, string cwd,
    ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);

  public static int Run(string cmdLine, string cwd, string envBlock, string[] restrictSids) {
    IntPtr baseTok;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, out baseTok))
      throw new Exception("OpenProcessToken failed: " + Marshal.GetLastWin32Error());
    var sids = new SID_AND_ATTRIBUTES[restrictSids.Length];
    for (int i = 0; i < restrictSids.Length; i++) {
      IntPtr psid;
      if (!ConvertStringSidToSidW(restrictSids[i], out psid))
        throw new Exception("ConvertStringSidToSid failed for " + restrictSids[i] + ": " + Marshal.GetLastWin32Error());
      sids[i].Sid = psid; sids[i].Attributes = 0;
    }
    IntPtr restricted;
    if (!CreateRestrictedToken(baseTok, WRITE_RESTRICTED, 0, IntPtr.Zero, 0, IntPtr.Zero,
        (uint)sids.Length, sids, out restricted))
      throw new Exception("CreateRestrictedToken failed: " + Marshal.GetLastWin32Error());
    var si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.dwFlags = 0x100; // STARTF_USESTDHANDLES
    si.hStdInput = GetStdHandle(-10); si.hStdOutput = GetStdHandle(-11); si.hStdError = GetStdHandle(-12);
    PROCESS_INFORMATION pi;
    if (!CreateProcessAsUserW(restricted, null, cmdLine, IntPtr.Zero, IntPtr.Zero, true,
        CREATE_UNICODE_ENVIRONMENT, envBlock, cwd, ref si, out pi))
      throw new Exception("CreateProcessAsUser failed: " + Marshal.GetLastWin32Error());
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code;
    GetExitCodeProcess(pi.hProcess, out code);
    return unchecked((int)code);
  }
}
'@

  # Load the cached assembly, or compile it once and publish it for every later
  # invocation. Any failure on the cache path falls back to a direct in-memory
  # compile, so a corrupt/unwritable cache degrades to the OLD (slow) behaviour
  # rather than failing the command — this is a latency optimisation and must
  # never become a new way for the sandbox to refuse to run.
  $csHash = [BitConverter]::ToString(
    [Security.Cryptography.SHA256]::Create().ComputeHash(
      [Text.Encoding]::UTF8.GetBytes($csSource)
    )
  ).Replace('-', '').Substring(0, 16)
  $cacheDir = Join-Path $env:LOCALAPPDATA 'DUIN\sandbox-cache'
  $cacheDll = Join-Path $cacheDir "DuinRestrictRun-$csHash.dll"
  $loaded = $false
  if (Test-Path -LiteralPath $cacheDll) {
    try { Add-Type -Path $cacheDll; $loaded = $true } catch { $loaded = $false }
  }
  if (-not $loaded) {
    try {
      if (-not (Test-Path -LiteralPath $cacheDir)) {
        New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
      }
      $tmpDll = "$cacheDll.$PID.tmp"
      Add-Type -TypeDefinition $csSource -OutputAssembly $tmpDll -OutputType Library
      Move-Item -LiteralPath $tmpDll -Destination $cacheDll -Force
      Add-Type -Path $cacheDll
      $loaded = $true
    } catch {
      try { Remove-Item -LiteralPath "$cacheDll.$PID.tmp" -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
  if (-not $loaded) { Add-Type -TypeDefinition $csSource }

  # ── command line + environment block (TEMP redirected) ──────────────────
  function Quote-Arg([string]$a) {
    if ($a -match '[\s"]') { '"' + ($a -replace '"', '\"') + '"' } else { $a }
  }
  # cmd.exe is not a C-runtime parser: its `/c` payload must travel VERBATIM
  # (backslash-escaped quotes and re-wrapping both break redirects). DUIN's
  # shell tool composes exactly ['cmd','/c', <full command string>], so that
  # shape is special-cased; everything else gets MSVCRT-convention quoting.
  $isCmdShell = $cmdParts.Count -ge 3 -and
    ($cmdParts[0] -match '(?i)^(cmd(\.exe)?)$') -and ($cmdParts[1] -match '(?i)^/[ck]$')
  if ($isCmdShell) {
    $payload = ($cmdParts[2..($cmdParts.Count - 1)]) -join ' '
    $cmdLine = 'cmd.exe ' + $cmdParts[1] + ' "' + $payload + '"'
  } else {
    $cmdLine = ($cmdParts | ForEach-Object { Quote-Arg $_ }) -join ' '
  }

  $envPairs = [System.Collections.Generic.List[string]]::new()
  foreach ($kv in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) {
    $name = [string]$kv.Key
    if ($name -ieq 'TEMP' -or $name -ieq 'TMP') { continue }
    $envPairs.Add("$name=$($kv.Value)")
  }
  $envPairs.Add("TEMP=$childTemp"); $envPairs.Add("TMP=$childTemp")
  # CreateProcess env block: NUL-separated, double-NUL terminated, sorted.
  $envBlock = (($envPairs | Sort-Object) -join "`0") + "`0`0"

  $code = [DuinRestrictRun]::Run($cmdLine, (Get-Location).Path, $envBlock, @($wsSid))
  exit $code
} catch {
  [Console]::Error.WriteLine("restrict-run: sandbox setup failed (fail-closed, command NOT run): $($_.Exception.Message)")
  exit 190
} finally {
  if ($childTemp -and (Test-Path -LiteralPath $childTemp)) {
    try { Remove-Item -LiteralPath $childTemp -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  }
}
