// launcher.test.mjs — the isolation guarantees of scripts/live-eval-launch.mjs, proven on pure
// functions with mocked process rows: stop() can only ever match the binary it launched with
// THIS instance's userData; the child env carries none of the owner's DUIN_* pins.
// Run: node --test bench/live-eval/test/*.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectOwnedProcesses, buildLaunchEnv, seedSettings, assertIsolated, resolveLaunchTarget, USER_DATA_MARKER } from '../../../scripts/live-eval-launch.mjs'

const EXE = 'D:\\repo\\node_modules\\electron\\dist\\electron.exe'
const UD = 'D:\\repo\\bench\\live-eval\\runs\\2026\\instance\\userdata'
const OWNER_UD = 'C:\\Users\\Operator\\AppData\\Roaming\\DUIN'

test('selectOwnedProcesses: only the launched exe with THIS userData on its command line', () => {
  const rows = [
    // our main process (marker arg) and a Chromium child (--user-data-dir)
    { ProcessId: 11, ExecutablePath: EXE, CommandLine: `"${EXE}" . ${USER_DATA_MARKER}${UD}` },
    { ProcessId: 12, ExecutablePath: EXE, CommandLine: `"${EXE}" --type=renderer --user-data-dir="${UD}" --field-trial` },
    // same binary, the OWNER's userData → never
    { ProcessId: 13, ExecutablePath: EXE, CommandLine: `"${EXE}" . ${USER_DATA_MARKER}${OWNER_UD}` },
    // the installed app, whatever it says → never (different exe)
    { ProcessId: 14, ExecutablePath: 'C:\\Users\\Operator\\AppData\\Local\\Programs\\DUIN\\DUIN.exe', CommandLine: `DUIN.exe --user-data-dir="${UD}"` },
    // same binary, no userData named → never
    { ProcessId: 15, ExecutablePath: EXE, CommandLine: `"${EXE}" .` },
    // junk rows
    { ProcessId: 16 },
    { ProcessId: 'x', ExecutablePath: EXE, CommandLine: `${USER_DATA_MARKER}${UD}` },
    null
  ]
  assert.deepEqual(selectOwnedProcesses(rows, { exe: EXE, userData: UD }), [11, 12])
  // a different instance root shares nothing
  assert.deepEqual(selectOwnedProcesses(rows, { exe: EXE, userData: 'D:\\repo\\other\\userdata' }), [])
  // a single object (PowerShell ConvertTo-Json of one row) is tolerated by the caller; here: not an array → nothing
  assert.deepEqual(selectOwnedProcesses(rows[0], { exe: EXE, userData: UD }), [])
})

test('selectOwnedProcesses: forward-slash and case variants of the same paths still match on win32', { skip: process.platform !== 'win32' }, () => {
  const rows = [{ ProcessId: 21, ExecutablePath: EXE.toUpperCase(), CommandLine: `--user-data-dir=${UD.replace(/\\/g, '/').toLowerCase()}` }]
  assert.deepEqual(selectOwnedProcesses(rows, { exe: EXE, userData: UD }), [21])
})

test('buildLaunchEnv: drops inherited DUIN_*/BF_*/LAMPREY_* pins, sets the isolation env', () => {
  const env = buildLaunchEnv(
    { PATH: 'x', DUIN_ROUTE_EXTRACTION: 'glm-4.5-airx', DUIN_ENTITY_GRAPH: '1', BF_DEBUG_PORT: '9333', LAMPREY_X: '1', ELECTRON_RUN_AS_NODE: '1', HOME: 'h' },
    { userData: UD, brainPort: 8899, cdpPort: 9444, envExtra: { DUIN_SANDBOX: '0', HOME: null } }
  )
  assert.equal(env.PATH, 'x')
  assert.equal('DUIN_ROUTE_EXTRACTION' in env, false)
  assert.equal('DUIN_ENTITY_GRAPH' in env, false)
  assert.equal('LAMPREY_X' in env, false)
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false)
  assert.equal('HOME' in env, false)
  assert.equal(env.DUIN_USER_DATA_DIR, UD)
  assert.equal(env.DUIN_BRAIN_PORT, '8899')
  assert.equal(env.BF_DEBUG_PORT, '9444')
  assert.equal(env.DUIN_TURN_STALL_MS, '600000')
  assert.equal(env.DUIN_TRANSFER_AB_TICK, '0')
  assert.equal(env.DUIN_RSI_TICK_MS, '0')
  assert.equal(env.DUIN_EXEC_TOKEN_FILE, '1')
  assert.equal(env.DUIN_SANDBOX, '0')
})

test('seedSettings: merges over an existing file, pins the vault, language and the measured posture', () => {
  const s = seedSettings({ fontSize: 16, localBrainNotesDir: 'old' }, { vaultDir: 'D:\\v', providerPolicy: { order: ['deepseek'] }, extra: { fullComputerAccess: true, approvalTimeoutMs: 60000 } })
  assert.equal(s.fontSize, 16)
  assert.equal(s.localBrainNotesDir, 'D:\\v')
  assert.equal(s.language, 'en')
  assert.equal(s.backgroundAutonomy, false)
  assert.equal(s.loopsEnabled, false)
  assert.deepEqual(s.providerPolicy, { order: ['deepseek'] })
  assert.equal(s.fullComputerAccess, true)
  assert.equal(s.approvalTimeoutMs, 60000)
  assert.equal(seedSettings(null, { vaultDir: 'v' }).localBrainNotesDir, 'v')
})

test('assertIsolated: refuses the owner ports and the owner userData, accepts the suite defaults', () => {
  const env = { APPDATA: 'C:\\Users\\Operator\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Operator\\AppData\\Local' }
  assert.doesNotThrow(() => assertIsolated({ userData: UD, brainPort: 8899, cdpPort: 9444, env }))
  assert.throws(() => assertIsolated({ userData: UD, brainPort: 8799, cdpPort: 9444, env }), /owner's live instance/)
  assert.throws(() => assertIsolated({ userData: UD, brainPort: 8899, cdpPort: 9333, env }), /owner's live instance/)
  assert.throws(() => assertIsolated({ userData: UD, brainPort: 8899, cdpPort: 8899, env }), /must differ/)
  assert.throws(() => assertIsolated({ userData: OWNER_UD, brainPort: 8899, cdpPort: 9444, env }), /owner's DUIN directory/)
  assert.throws(() => assertIsolated({ userData: join(OWNER_UD, 'sub'), brainPort: 8899, cdpPort: 9444, env }), /owner's DUIN directory/)
  assert.throws(() => assertIsolated({ userData: 'C:\\Users\\Operator\\AppData\\Local\\Programs\\DUIN\\x', brainPort: 8899, cdpPort: 9444, env }), /owner's DUIN directory/)
  assert.throws(() => assertIsolated({ userData: 'relative/dir', brainPort: 8899, cdpPort: 9444, env }), /absolute/)
})

test('resolveLaunchTarget: packaged build wins, else electron + out/, else a build hint', () => {
  const root = mkdtempSync(join(tmpdir(), 'live-eval-root-'))
  try {
    assert.throws(() => resolveLaunchTarget(root), /npm run build/)
    mkdirSync(join(root, 'out', 'main'), { recursive: true })
    writeFileSync(join(root, 'out', 'main', 'index.js'), '')
    const electron = process.platform === 'win32' ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe') : join(root, 'node_modules', '.bin', 'electron')
    mkdirSync(join(electron, '..'), { recursive: true })
    writeFileSync(electron, '')
    const t = resolveLaunchTarget(root)
    assert.equal(t.kind, 'electron')
    assert.equal(t.exe, electron)
    assert.deepEqual(t.args, ['.'])
    assert.equal(t.cwd, root)
    mkdirSync(join(root, 'dist', 'win-unpacked'), { recursive: true })
    writeFileSync(join(root, 'dist', 'win-unpacked', 'DUIN.exe'), '')
    const p = resolveLaunchTarget(root)
    assert.equal(p.kind, 'packaged')
    assert.deepEqual(p.args, [])
    assert.equal(resolveLaunchTarget(root, electron).kind, 'packaged')
    assert.throws(() => resolveLaunchTarget(root, join(root, 'nope.exe')), /--exe not found/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
