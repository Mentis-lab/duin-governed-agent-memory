#!/usr/bin/env node
// live-eval-launch.mjs — launch an ISOLATED DUIN instance for bench/live-eval.
//
// Isolation is by construction, not by discipline:
//   · own userData (DUIN_USER_DATA_DIR) — assertIsolated() refuses anything under the owner's
//     %APPDATA%\DUIN or the installed app dir;
//   · own ports (DUIN_BRAIN_PORT / BF_DEBUG_PORT) — 8799 and 9333 (the owner's) are refused;
//   · every DUIN_* / BF_* / LAMPREY_* variable inherited from the shell is DROPPED before ours are
//     set, so the owner's HKCU pins (DUIN_ROUTE_EXTRACTION, DUIN_ENTITY_GRAPH, …) cannot leak in;
//   · stop() kills only processes whose executable path IS the binary we launched AND whose
//     command line names this instance's userData (the main process carries a
//     `--live-eval-user-data=<dir>` marker; Chromium children carry `--user-data-dir=<dir>`,
//     which is the same directory because main.ts sets sessionData = userData). Never by name.
//
// Module API: launchIsolated(opts) → { stop(), brain, cdp, userData, vaultDir, execToken(), … }.
// CLI:        node scripts/live-eval-launch.mjs --stop <instanceRoot> [--exe <path>]
//             (sweeps a leftover instance from a `--keep` run; same exe+userData filter).
//
// Exports the pure pieces (selectOwnedProcesses, buildLaunchEnv, seedSettings, assertIsolated,
// resolveLaunchTarget) so bench/live-eval/launcher.test.mjs can prove the kill filter and the env
// scrubbing without launching anything.

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The owner's live instance binds these; the suite must never be able to reach it. */
export const OWNER_PORTS = new Set([8799, 9333])

/** Command-line marker that lets stop() recognise the MAIN process of one instance. Inert for the
 *  app: an unknown `--` switch is ignored by Chromium and by DUIN's own argv parsing (which keys on
 *  `--duin-headless` / `run`, neither of which this can ever equal). */
export const USER_DATA_MARKER = '--live-eval-user-data='

const foldPath = (p) => {
  const n = normalize(String(p ?? '')).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? n.toLowerCase() : n
}

/** Directories the owner's DUIN lives in. Any userData inside one of these is refused. */
export function ownerUserDataDirs(env = process.env) {
  const out = []
  if (env.APPDATA) out.push(join(env.APPDATA, 'DUIN'))
  if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, 'Programs', 'DUIN'))
  if (env.HOME) {
    out.push(join(env.HOME, 'Library', 'Application Support', 'DUIN'))
    out.push(join(env.HOME, '.config', 'DUIN'))
  }
  return out
}

/** Throws unless the (userData, ports) triple cannot collide with the owner's instance. */
export function assertIsolated({ userData, brainPort, cdpPort, env = process.env }) {
  if (!userData || !isAbsolute(userData)) throw new Error(`userData must be an absolute path (got ${userData})`)
  const ud = foldPath(userData)
  for (const owner of ownerUserDataDirs(env)) {
    const o = foldPath(owner)
    if (ud === o || ud.startsWith(o + sep)) throw new Error(`refusing to use the owner's DUIN directory as userData: ${userData}`)
  }
  for (const p of [brainPort, cdpPort]) {
    if (!Number.isInteger(p) || p <= 0 || p > 65535) throw new Error(`invalid port ${p}`)
    if (OWNER_PORTS.has(p)) throw new Error(`port ${p} belongs to the owner's live instance; pick another`)
  }
  if (brainPort === cdpPort) throw new Error('brain and CDP ports must differ')
}

/** PURE. The child env: the caller's env minus every inherited DUIN_, BF_ and LAMPREY_ variable, plus ours. */
export function buildLaunchEnv(base, { userData, brainPort, cdpPort, envExtra = {} }) {
  const env = {}
  for (const [k, v] of Object.entries(base ?? {})) {
    if (/^(DUIN_|BF_|LAMPREY_)/i.test(k)) continue
    if (k === 'ELECTRON_RUN_AS_NODE') continue
    env[k] = v
  }
  Object.assign(env, {
    DUIN_USER_DATA_DIR: userData,
    DUIN_BRAIN_PORT: String(brainPort),
    BF_DEBUG_PORT: String(cdpPort),
    // Local/slow engines and a headless approval path both need more than the 90 s default.
    DUIN_TURN_STALL_MS: '600000',
    // No background self-modification while measuring.
    DUIN_TRANSFER_AB_TICK: '0',
    DUIN_RSI_TICK_MS: '0',
    // The suite authenticates with the per-launch exec token, published to <userData>/exec-token.
    DUIN_EXEC_TOKEN_FILE: '1'
  })
  for (const [k, v] of Object.entries(envExtra ?? {})) {
    if (v === undefined || v === null) delete env[k]
    else env[k] = String(v)
  }
  return env
}

/** PURE. The pre-seeded settings.json: vault + language + the posture the suite measures under. */
export function seedSettings(existing, { vaultDir, providerPolicy, extra = {} }) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}
  return {
    ...base,
    localBrainNotesDir: vaultDir,
    language: 'en',
    backgroundAutonomy: false,
    loopsEnabled: false,
    ...(providerPolicy ? { providerPolicy } : {}),
    ...extra
  }
}

/**
 * PURE. From a Win32_Process-shaped row list, the PIDs that belong to ONE launched instance:
 * executable path equals the launched binary AND the command line names this userData.
 * A DUIN.exe with a different userData (the owner's) never matches, whatever its name.
 */
export function selectOwnedProcesses(rows, { exe, userData }) {
  const exeKey = foldPath(exe)
  const udKeys = new Set([foldPath(userData), foldPath(userData).replace(/\\/g, '/')])
  const out = []
  for (const r of Array.isArray(rows) ? rows : []) {
    const path = r?.ExecutablePath
    const cmd = r?.CommandLine
    if (typeof path !== 'string' || typeof cmd !== 'string') continue
    if (foldPath(path) !== exeKey) continue
    const cmdKey = process.platform === 'win32' ? cmd.toLowerCase() : cmd
    let named = false
    for (const k of udKeys) if (k && cmdKey.includes(k)) named = true
    if (!named) continue
    const pid = Number(r.ProcessId)
    if (Number.isInteger(pid) && pid > 0) out.push(pid)
  }
  return out
}

function listProcesses() {
  if (process.platform === 'win32') {
    const ps = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | Select-Object ProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress -Depth 2'
      ],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
    )
    if (ps.status !== 0) throw new Error(`Win32_Process query failed: ${String(ps.stderr).slice(0, 400)}`)
    const text = String(ps.stdout).trim()
    if (!text) return []
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : [parsed]
  }
  const ps = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
  if (ps.status !== 0) return []
  return String(ps.stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^(\d+)\s+(\S+)(.*)$/.exec(l)
      return m ? { ProcessId: Number(m[1]), ExecutablePath: m[2], CommandLine: m[2] + m[3] } : null
    })
    .filter(Boolean)
}

function killPids(pids) {
  if (pids.length === 0) return
  if (process.platform === 'win32') {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${pids.join(',')} -Force -ErrorAction SilentlyContinue`], {
      encoding: 'utf8',
      windowsHide: true
    })
    return
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/** Kill every process of ONE instance (exe + userData filter). Returns the PIDs it targeted. */
export function sweepInstance({ exe, userData }) {
  const pids = selectOwnedProcesses(listProcesses(), { exe, userData })
  killPids(pids)
  return pids
}

/** Which binary to launch for the tree under test. Packaged build first, else electron + out/. */
export function resolveLaunchTarget(repoRoot, exeOverride) {
  if (exeOverride) {
    const exe = resolve(exeOverride)
    if (!existsSync(exe)) throw new Error(`--exe not found: ${exe}`)
    return { exe, args: [], cwd: dirname(exe), kind: 'packaged' }
  }
  const packaged = join(repoRoot, 'dist', 'win-unpacked', 'DUIN.exe')
  if (existsSync(packaged)) return { exe: packaged, args: [], cwd: dirname(packaged), kind: 'packaged' }
  const built = join(repoRoot, 'out', 'main', 'index.js')
  const electron =
    process.platform === 'win32'
      ? join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
      : join(repoRoot, 'node_modules', '.bin', 'electron')
  if (existsSync(built) && existsSync(electron)) return { exe: electron, args: ['.'], cwd: repoRoot, kind: 'electron' }
  throw new Error(
    `no app to launch under ${repoRoot}: run \`npm run build\` (out/ + electron) or \`npm run build:win\` (dist/win-unpacked/DUIN.exe), or pass --exe`
  )
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function portFree(port) {
  return new Promise((resolvePort) => {
    const srv = createServer()
    srv.once('error', () => resolvePort(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolvePort(true)))
  })
}

function getJson(port, path, timeoutMs = 3000) {
  return new Promise((resolveReq, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try {
          resolveReq({ status: res.statusCode, json: JSON.parse(text) })
        } catch {
          resolveReq({ status: res.statusCode, json: null, text })
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

function tailOf(path, n = 30) {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-n).join('\n')
  } catch {
    return ''
  }
}

/**
 * Copy a transformers.js model cache into `<userData>/models/transformers` for a dev-target launch.
 * Sources tried in order: `explicit` (LIVE_EVAL_EMBEDDER_CACHE / opts.embedderCache), then
 * `<repoRoot>/resources/models/transformers` (the electron-builder extraResources source). Returns the
 * source used, or null when none exists. Idempotent: an existing non-empty target is left alone.
 * Exported so the choice is unit-testable without launching anything.
 */
export function seedEmbedderCache(userData, explicit, repoRoot = REPO_ROOT) {
  const candidates = [explicit, join(repoRoot, 'resources', 'models', 'transformers')].filter(Boolean)
  const src = candidates.map((c) => resolve(c)).find((c) => existsSync(c))
  if (!src) return null
  const dest = join(userData, 'models', 'transformers')
  if (!existsSync(dest)) {
    mkdirSync(join(userData, 'models'), { recursive: true })
    cpSync(src, dest, { recursive: true })
  }
  return src
}

/**
 * Launch the app isolated under `root`:
 *   <root>/userdata   DUIN_USER_DATA_DIR (settings.json pre-seeded)
 *   <root>/vault      the active vault (a fresh copy of opts.fixtureVault when given)
 *   <root>/app.log    the app's stdout+stderr
 * Resolves once /health answers and the exec-token file exists. `opts.detached` keeps the app alive
 * after this process exits (for --keep); otherwise it dies with us.
 */
export async function launchIsolated(opts = {}) {
  const root = resolve(opts.root)
  const repoRoot = opts.repoRoot ? resolve(opts.repoRoot) : REPO_ROOT
  const brainPort = opts.brainPort ?? 8899
  const cdpPort = opts.cdpPort ?? 9444
  const userData = join(root, 'userdata')
  const vaultDir = opts.vaultDir ? resolve(opts.vaultDir) : join(root, 'vault')
  assertIsolated({ userData, brainPort, cdpPort })
  const target = resolveLaunchTarget(repoRoot, opts.exe)

  // A previous --keep run of THIS root may still be up; nothing else can match the filter.
  sweepInstance({ exe: target.exe, userData })
  for (const p of [brainPort, cdpPort]) {
    if (!(await portFree(p))) {
      throw new Error(`port ${p} is busy. A leftover instance? \`node scripts/live-eval-launch.mjs --stop <instanceRoot>\` sweeps one by exe+userData.`)
    }
  }

  mkdirSync(userData, { recursive: true })
  if (opts.fixtureVault) {
    rmSync(vaultDir, { recursive: true, force: true })
    cpSync(resolve(opts.fixtureVault), vaultDir, { recursive: true })
  } else {
    mkdirSync(vaultDir, { recursive: true })
  }
  // Search model. The packaged app ships it under resources/models/transformers (offline-first,
  // service.ts bundledModelsPath); the dev launch (electron + out/) reads userData/models/transformers
  // instead and DOWNLOADS on a miss — and a blocked download makes every grounding wait on the
  // timeout before the first model call (measured 2026-09-03: a 240 s turn that never reached the
  // engine). Seed the cache so the suite measures the product, not the network.
  if (target.kind !== 'packaged') {
    const seeded = seedEmbedderCache(userData, opts.embedderCache ?? process.env.LIVE_EVAL_EMBEDDER_CACHE, repoRoot)
    if (!seeded) {
      console.warn('[live-eval-launch] no embedder cache found (LIVE_EVAL_EMBEDDER_CACHE or <repo>/resources/models/transformers) — grounding will be lexical-only after the download timeout')
    }
  }
  const settingsPath = join(userData, 'settings.json')
  let existing = {}
  try {
    existing = JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    /* absent or torn: the seed is the whole file */
  }
  writeFileSync(
    settingsPath,
    JSON.stringify(seedSettings(existing, { vaultDir, providerPolicy: opts.providerPolicy, extra: opts.settingsSeed ?? {} }), null, 2)
  )

  const env = buildLaunchEnv(process.env, { userData, brainPort, cdpPort, envExtra: opts.envExtra })
  const args = [...target.args, `${USER_DATA_MARKER}${userData}`]
  const logPath = join(root, 'app.log')
  const logFd = openSync(logPath, 'a')
  // libuv parks a non-detached Windows child in a kill-on-close job object, so by default the
  // instance dies with the runner (no orphan on a crash). `detached` (run.mjs --keep) breaks it
  // out on purpose; such an instance is only ever stopped by the exe+userData sweep (--stop).
  const detached = opts.detached === true
  const child = spawn(target.exe, args, { cwd: target.cwd, env, stdio: ['ignore', logFd, logFd], windowsHide: false, detached })
  if (detached) child.unref()
  let exited = null
  child.on('exit', (code, signal) => {
    exited = { code, signal }
  })
  child.on('error', (err) => {
    exited = { code: null, signal: null, error: err.message }
  })

  const brain = { host: '127.0.0.1', port: brainPort, url: `http://127.0.0.1:${brainPort}` }
  const readyTimeoutMs = opts.readyTimeoutMs ?? 120000
  const t0 = Date.now()
  let healthy = false
  while (Date.now() - t0 < readyTimeoutMs) {
    if (exited) break
    try {
      const r = await getJson(brainPort, '/health')
      if (r.status === 200 && r.json && r.json.status === 'ok') {
        healthy = true
        break
      }
    } catch {
      /* not listening yet */
    }
    await sleep(500)
  }
  const tokenPath = join(userData, 'exec-token')
  if (healthy) {
    const t1 = Date.now()
    while (Date.now() - t1 < 30000 && !(existsSync(tokenPath) && readFileSync(tokenPath, 'utf8').trim())) await sleep(250)
  }
  if (!healthy || !existsSync(tokenPath)) {
    const why = exited ? `app exited (${JSON.stringify(exited)})` : healthy ? 'no exec-token file' : `no /health on :${brainPort} within ${readyTimeoutMs} ms`
    try {
      if (!exited && child.pid) killTree(child.pid)
      sweepInstance({ exe: target.exe, userData })
    } finally {
      closeSync(logFd)
    }
    throw new Error(`isolated instance failed to start: ${why}\n--- ${logPath} (tail) ---\n${tailOf(logPath)}`)
  }

  let stopped = false
  return {
    root,
    userData,
    vaultDir,
    brain,
    cdp: { port: cdpPort, url: `http://127.0.0.1:${cdpPort}` },
    exe: target.exe,
    kind: target.kind,
    pid: child.pid,
    logPath,
    execToken: () => readFileSync(tokenPath, 'utf8').trim(),
    exited: () => exited,
    async stop() {
      if (stopped) return []
      stopped = true
      if (!exited && child.pid) killTree(child.pid)
      const swept = sweepInstance({ exe: target.exe, userData })
      await sleep(500)
      try {
        closeSync(logFd)
      } catch {
        /* already closed */
      }
      return swept
    }
  }
}

function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------- CLI (--stop only)
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  const at = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  if (argv.includes('--help') || argv.length === 0) {
    console.log('usage: node scripts/live-eval-launch.mjs --stop <instanceRoot> [--exe <path>]')
    console.log('  Kills the isolated DUIN instance launched under <instanceRoot> (exe + userData filter). Nothing else.')
    process.exit(0)
  }
  const stopRoot = at('--stop')
  if (!stopRoot) {
    console.error('missing --stop <instanceRoot>')
    process.exit(2)
  }
  const target = resolveLaunchTarget(REPO_ROOT, at('--exe'))
  const userData = join(resolve(stopRoot), 'userdata')
  assertIsolated({ userData, brainPort: 8899, cdpPort: 9444 })
  const pids = sweepInstance({ exe: target.exe, userData })
  console.log(pids.length ? `stopped ${pids.length} process(es): ${pids.join(', ')}` : 'nothing matched (exe + userData filter)')
}
