import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { composeDshCordisYml, dshRuntimeRequirements, probeChildShell, probeDshRuntime, childPersona, dshRuntimeDir } from './executor-runtime'

// The composition is generated, so it is tested like code: rows present per shell choice, no
// path and no secret inlined, and the requirement list identical in shape to what the staging
// script writes.

describe('composeDshCordisYml', () => {
  it('always mounts the server, sandbox, never-ask approval, DUIN gate, fs tools, spine, sessions', () => {
    const yml = composeDshCordisYml({ shell: { kind: 'none' }, mcpUrl: null })
    for (const row of ['dsh-sdk-jsonrpc-server', 'dsh-sandbox-local', 'dsh-sandbox-policy', 'dsh-user-approval', 'name: duin-gate', 'dsh-fs-sandbox', 'dsh-tool-fs', 'dsh-agent-spine-demo', 'dsh-session-persistence-jsonl', 'dsh-session-checkpoint-policy']) {
      expect(yml, row).toContain(row)
    }
    expect(yml).toContain('policy: never')
    expect(yml).toContain('mode: workspace-write')
    expect(yml).not.toContain('dsh-pwsh')
    expect(yml).not.toContain('dsh-bash')
    expect(yml).not.toContain('dsh-mcp-client')
  })

  it('mounts pwsh rows with the resolved path, or bash rows, per the probe', () => {
    const pwsh = composeDshCordisYml({ shell: { kind: 'pwsh', path: 'C:\\pwsh\\pwsh.exe' }, mcpUrl: null })
    expect(pwsh).toContain('dsh-pwsh-sandbox')
    expect(pwsh).toContain('dsh-tool-pwsh')
    expect(pwsh).toContain("pwshPath: 'C:\\pwsh\\pwsh.exe'")
    const bash = composeDshCordisYml({ shell: { kind: 'bash', path: '/usr/bin/bash' }, mcpUrl: null })
    expect(bash).toContain('dsh-bash-sandbox')
    expect(bash).toContain('dsh-tool-bash')
    expect(bash).not.toContain('pwsh')
  })

  it('NEVER mounts a shell tool without its shellEnv provider — the boot-crash class (2026-08-27)', () => {
    // dsh-tool-bash / dsh-tool-pwsh inject the `shellEnv` service, provided ONLY by
    // dsh-shell-env (a standalone plugin, nobody's transitive dep). Omitting it left the tool
    // fiber pending and the runtime failed to boot under electron-as-node — production's spawn —
    // while it booted under plain node, which is why the node-only real-runtime test missed it.
    // This string invariant catches the omission with no electron needed.
    for (const shell of [{ kind: 'pwsh' as const, path: 'p' }, { kind: 'bash' as const, path: 'b' }]) {
      const yml = composeDshCordisYml({ shell, mcpUrl: null })
      expect(yml, `${shell.kind} mounts a shell tool`).toMatch(/dsh-tool-(bash|pwsh)/)
      expect(yml, `${shell.kind} must mount dsh-shell-env for the tool's shellEnv service`).toContain('dsh-shell-env')
      // and the provider must come BEFORE the tool that injects it (Loader activates in order)
      expect(yml.indexOf('dsh-shell-env')).toBeLessThan(yml.search(/dsh-tool-(bash|pwsh)/))
    }
    // the file-tools-only path needs no shell env
    expect(composeDshCordisYml({ shell: { kind: 'none' }, mcpUrl: null })).not.toContain('dsh-shell-env')
  })

  it("carries every per-run value through the environment, never inline — the token never appears", () => {
    const yml = composeDshCordisYml({ shell: { kind: 'none' }, mcpUrl: 'http://127.0.0.1:8799/exec/mcp' })
    expect(yml).toContain('dsh-mcp-client')
    expect(yml).toContain('process.env.DUIN_EXEC_TOKEN')
    expect(yml).toContain('process.env.DSH_CWD')
    expect(yml).toContain('process.env.DSH_SESSION_ROOT')
    expect(yml).toContain('process.env.DSH_SYSTEM_PROMPT')
    expect(yml).not.toMatch(/Bearer [A-Za-z0-9]{10,}/)
  })
})

describe('runtime requirements + probe', () => {
  it('names the entry, the gate plugin, and the platform natives', () => {
    const win = dshRuntimeRequirements('R', 'win32', 'x64').map((r) => (r.kind === 'file' ? r.path : ''))
    expect(win.some((p) => p.endsWith(join('dsh-sdk-jsonrpc-demo', 'lib', 'bin.js')))).toBe(true)
    expect(win.some((p) => p.endsWith(join('duin-gate', 'index.mjs')))).toBe(true)
    expect(win.some((p) => p.endsWith('koffi.node'))).toBe(true)
    expect(win.some((p) => p.endsWith('conpty.node'))).toBe(true)
    const mac = dshRuntimeRequirements('R', 'darwin', 'arm64').map((r) => (r.kind === 'file' ? r.path : ''))
    expect(mac.some((p) => p.endsWith(join('darwin-arm64', 'pty.node')))).toBe(true)
    expect(mac.some((p) => p.endsWith('koffi.node'))).toBe(false)
  })

  it('an unstaged directory is reported as missing, with the staging hint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
    const report = probeDshRuntime(dir)
    expect(report.satisfied).toBe(false)
    expect(report.missing.length).toBeGreaterThan(0)
  })

  it('DUIN_DSH_RUNTIME_DIR overrides the resolved location', () => {
    expect(dshRuntimeDir({ DUIN_DSH_RUNTIME_DIR: 'X:\\rt' })).toBe('X:\\rt')
  })
})

describe('probeChildShell', () => {
  it('prefers pwsh, then bash, else none — resolved against the env the child will see', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-shell-'))
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const env = { PATH: bin, Path: bin, PATHEXT: '.EXE;.CMD' }
    expect(probeChildShell(env, 'win32')).toEqual({ kind: 'none' })
    writeFileSync(join(bin, process.platform === 'win32' ? 'bash.exe' : 'bash'), '')
    expect(probeChildShell(env, process.platform === 'win32' ? 'win32' : 'linux').kind).toBe('bash')
    if (process.platform === 'win32') {
      writeFileSync(join(bin, 'pwsh.exe'), '')
      expect(probeChildShell(env, 'win32')).toMatchObject({ kind: 'pwsh' })
    }
  })
})

describe('childPersona', () => {
  it('tells the model when it has no shell, and carries the brief', () => {
    expect(childPersona({ kind: 'none' }, null)).toContain('NO shell')
    expect(childPersona({ kind: 'bash', path: '/bin/bash' }, 'Operator likes small PRs')).toContain('Operator likes small PRs')
  })
})
