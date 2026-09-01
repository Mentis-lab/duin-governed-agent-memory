import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DshChild } from './dsh-adapter'
import { composeDshCordisYml, dshRuntimeBin, dshRuntimeDir, probeChildShell, probeDshRuntime, writeRunComposition, childPersona } from './executor-runtime'
import { SAFE_CHILD_ENV_KEYS } from '../mcp-manager'
import type { ExecutorEvent } from './executor-types'

// Opt-in: boots the REAL dsh runtime (resources/executors/dsh, staged) with the REAL generated
// composition — sandbox rows, the shell rows this machine's probe picks, `duin-gate` as a bare
// package, the MCP-client row against a brain that may not be listening — under this process's
// Node, then shuts it down through the ladder. No model call: a dummy key satisfies the adapter
// at initialize. This is the proof that every row in composeDshCordisYml resolves and loads.
//
// KNOWN LIMIT (2026-08-27): vitest runs under plain NODE, and dsh's plugin activation differs
// between node and electron-as-node — a composition can boot here yet fail under electron-as-node
// (production's spawn). That gap hid the missing dsh-shell-env row, caught only by a live
// electron-as-node run. The string invariant in executor-runtime.test.ts ('NEVER mounts a shell
// tool without its shellEnv provider') is the electron-free guard for that class; this boot test
// proves resolution, not electron-parity.
//
//   DUIN_E2E_EXECUTOR=1 npx vitest run electron/services/executor/executor-real-runtime
//
// Skipped by default: it needs the staged runtime (63 MB) and ~2 s per boot.

const enabled = process.env.DUIN_E2E_EXECUTOR === '1'
const runtimeDir = dshRuntimeDir()
const staged = probeDshRuntime(runtimeDir).satisfied

describe.skipIf(!enabled || !staged)('real dsh runtime boots with the generated composition', () => {
  it('initialize answers, no plugin failed to load, shutdown ladder ends the child', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'dsh-real-wt-'))
    const shell = probeChildShell(process.env)
    const yml = composeDshCordisYml({ shell, mcpUrl: 'http://127.0.0.1:8799/exec/mcp' })
    const { configPath, sessionRoot } = writeRunComposition('real-boot', yml)
    const env: Record<string, string> = {}
    for (const k of SAFE_CHILD_ENV_KEYS) if (typeof process.env[k] === 'string') env[k] = process.env[k] as string
    Object.assign(env, {
      ELECTRON_RUN_AS_NODE: '1',
      DEEPSEEK_API_KEY: 'sk-dummy-for-boot',
      DSH_CWD: worktree,
      DSH_SESSION_ROOT: sessionRoot,
      DSH_SYSTEM_PROMPT: childPersona(shell, null),
      DSH_MODEL: 'deepseek-v4-flash',
      DSH_CORDIS_CONFIG: configPath,
      DUIN_EXEC_URL: 'http://127.0.0.1:8799/exec/hook',
      DUIN_EXEC_TOKEN: 'dummy',
      DUIN_EXEC_RUN_ID: 'real-boot'
    })
    const events: ExecutorEvent[] = []
    const child = DshChild.launch({
      spec: { command: process.execPath, args: [dshRuntimeBin(runtimeDir), configPath], cwd: worktree, env },
      onEvent: (e) => events.push(e),
      requestTimeoutMs: 60_000
    })
    const t0 = Date.now()
    const init = await child.initialize({ cwd: worktree, provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 1024 })
    expect(init.serverInfo.name).toBe('deepseek-harness-sdk-runtime')
    const stderr = events.filter((e): e is Extract<ExecutorEvent, { type: 'child.stderr' }> => e.type === 'child.stderr').map((e) => e.line)
    expect(stderr.join('\n')).not.toMatch(/failed to load|Cannot find module|ERR_MODULE_NOT_FOUND/i)
    console.log(`[real-runtime] shell=${shell.kind} initialize in ${Date.now() - t0} ms; stderr lines: ${stderr.length}`)
    for (const line of stderr.slice(0, 12)) console.log('  stderr:', line.slice(0, 200))
    await child.stop()
    expect(child.hasExited).toBe(true)
  }, 90_000)
})
