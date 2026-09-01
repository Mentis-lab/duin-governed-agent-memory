# Isolated DUIN benchmark instance launcher.
#
# Runs an EXCLUSIVE DUIN with its own --user-data-dir (separate settings / search index /
# claim ledger / model cache / vault pointer), on the default port :8799. This never touches
# the operator's real brain data (which lives in the default userData). The operator's DUIN is
# stopped for the duration and relaunched by `-Action stop`.
#
#   powershell -File bench_instance.ps1 -Action start   # stop operator DUIN, boot isolated bench instance
#   ... run the harness (DUIN_BRAIN_URL=http://127.0.0.1:8799) ...
#   powershell -File bench_instance.ps1 -Action stop    # stop bench instance, relaunch operator DUIN
#
# Why exclusive + --user-data-dir (not a concurrent 2nd port): a few internal self-calls still
# hardcode :8799 (decision-simulator etc.), so a concurrent instance on another port would leak
# self-calls to the operator's brain. Exclusive-on-8799 with isolated userData is clean today.
param(
  [Parameter(Mandatory=$true)][ValidateSet('start','stop')] [string]$Action,
  [string]$Exe = "$env:LOCALAPPDATA\Programs\DUIN\DUIN.exe",
  [string]$BenchUserData = "$env:APPDATA\DUIN-bench"
)

function Wait-Health($seconds=180) {
  for ($i=0; $i -lt [int]($seconds/4); $i++) {
    try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8799/state/claim-metabolism' -TimeoutSec 4 -UseBasicParsing
          if ($r.StatusCode -eq 200) { return $true } } catch {}
    Start-Sleep -Seconds 4
  }
  return $false
}

Get-Process DUIN -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

if ($Action -eq 'start') {
  if (-not (Test-Path $BenchUserData)) { New-Item -ItemType Directory -Force -Path $BenchUserData | Out-Null }
  Write-Output "Launching ISOLATED bench instance (userData=$BenchUserData) on :8799 ..."
  # --user-data-dir isolates settings/index/ledger/model-cache; the single-instance lock is
  # userData-scoped so this is independent of the operator's install.
  # 2026-08-17 — the bench instance MUST inherit the operator launch env, or the run is
  # silently garbage. Two failures this cost, both of which produced clean-looking output:
  #   * DUIN_ONEAI_BASE_URL unset -> the oneai provider resolves to the deliberately
  #     non-resolving placeholder host (the real endpoint is kept out of the binary by the
  #     operator-leak denylist), every turn dies on the 60s stream-idle watchdog, and the
  #     harness records EMPTY hypotheses that grade wrong. A full n=100 run scored 0.
  #   * a fresh --user-data-dir has NO keys.json at all (getKey reads only userData, with
  #     no env fallback), so nothing can answer.
  # Pull the gateway from the same jury config the harness grades with, and warn loudly
  # rather than launching an instance that cannot answer.
  if (-not $env:DUIN_ONEAI_BASE_URL) {
    $juryFile = if ($env:BH_JURY_FILE) { $env:BH_JURY_FILE } else { Join-Path $PSScriptRoot 'jury.local.json' }
    try {
      $base = (Get-Content $juryFile -Raw | ConvertFrom-Json).jury.base_url
      if ($base) { $env:DUIN_ONEAI_BASE_URL = $base; Write-Output "OK inherited DUIN_ONEAI_BASE_URL from $juryFile" }
    } catch { }
  }
  if (-not $env:DUIN_ONEAI_BASE_URL) {
    Write-Warning "DUIN_ONEAI_BASE_URL is NOT set - oneai turns will hang on the placeholder host and record EMPTY answers. Set it before running the harness."
  }
  if (-not (Test-Path (Join-Path $BenchUserData 'keys.json'))) {
    Write-Warning "$BenchUserData has no keys.json - the bench instance has NO providers and every turn will return empty. Copy the operator's keys.json in first."
  }
  # 2026-08-21 (W4 pre-registration) - LAUNCH-PARITY, same doctrine as the env inheritance
  # above: the operator's app runs with adaptive whole-note grounding ON (deploy.cmd +
  # duin-launch.bat both set these), so a bench instance without them measures a config
  # nobody runs. The 08-17 result was generated exactly that way - pre-fix behavior - and
  # the re-run exists to measure the fix. Explicit here so the run cannot silently depend
  # on the invoking shell.
  if (-not $env:DUIN_WHOLENOTE_GROUND) { $env:DUIN_WHOLENOTE_GROUND = "1" }
  if (-not $env:DUIN_WHOLENOTE_ALLOW_CLOUD) { $env:DUIN_WHOLENOTE_ALLOW_CLOUD = "1" }
  Start-Process -FilePath $Exe -ArgumentList "--user-data-dir=`"$BenchUserData`""
  if (Wait-Health) {
    Write-Output "OK bench instance healthy on :8799. It has an EMPTY vault until the harness sets one via /state/config."
    Write-Output "Run:  DUIN_BRAIN_URL=http://127.0.0.1:8799  python lme_harness.py duin --variant oracle --n 20"
  } else { Write-Output "WARN bench instance did not report healthy within timeout." }
}
elseif ($Action -eq 'stop') {
  Write-Output "Relaunching the OPERATOR DUIN (default userData) ..."
  $env:BF_DEBUG_PORT = "9333"
  Start-Process -FilePath $Exe
  if (Wait-Health) { Write-Output "OK operator DUIN restored + healthy on :8799." }
  else { Write-Output "WARN operator DUIN did not report healthy within timeout." }
}
