// executor-runtime — where the dsh runtime lives, what it needs, and the composition DUIN
// hands it for one run.
//
// The runtime (resources/executors/dsh, staged by scripts/stage-dsh-runtime.mjs, shipped via
// extraResources) is a pinned set of npm packages that runs under DUIN's own Node. Nothing
// about it is user-installed. The composition (`cordis.yml`) is GENERATED per run because
// the shell rows depend on the machine (`pwsh` → `bash` → file tools only) and every path
// is per-worktree; a hand-edited template would drift from both.

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { probeRequirements, resolveBinary, type Requirement, type RequirementReport } from '../capability-requires'

export type ChildShell = { kind: 'pwsh'; path: string } | { kind: 'bash'; path: string } | { kind: 'none' }

/** The runtime directory: dev tree in development, `resources/executors/dsh` when packaged.
 *  `DUIN_DSH_RUNTIME_DIR` overrides both (tests, an operator pointing at a staged copy). */
export function dshRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DUIN_DSH_RUNTIME_DIR
  if (override && override.trim()) return override.trim()
  try {
    if (app.isPackaged) return join(process.resourcesPath, 'executors', 'dsh')
  } catch {
    /* no electron app (tests) → dev layout below */
  }
  return join(process.cwd(), 'resources', 'executors', 'dsh')
}

/** The artifacts the executor probes before spawning. Keep identical to
 *  scripts/stage-dsh-runtime.mjs `requiredArtifacts` — the staging script is the writer,
 *  this is the reader, and both name the same files. */
export function dshRuntimeRequirements(dir: string, platform = process.platform, arch = process.arch): Requirement[] {
  const nm = join(dir, 'node_modules')
  const reqs: Requirement[] = [
    { kind: 'file', path: join(nm, '@deepseek-ai', 'dsh-sdk-jsonrpc-demo', 'lib', 'bin.js'), hint: 'run `node scripts/stage-dsh-runtime.mjs`' },
    { kind: 'file', path: join(nm, '@deepseek-ai', 'dsh-sandbox-local', 'package.json'), hint: 'the dsh runtime set is incomplete' },
    { kind: 'file', path: join(nm, 'duin-gate', 'index.mjs'), hint: "DUIN's in-child gate plugin is missing from the runtime" }
  ]
  if (platform === 'win32') {
    reqs.push({ kind: 'file', path: join(nm, '@koromix', `koffi-win32-${arch}`, `win32_${arch}`, 'koffi.node'), hint: 'prebuilt koffi binary missing' })
    reqs.push({ kind: 'file', path: join(nm, 'node-pty', 'prebuilds', `win32-${arch}`, 'conpty.node'), hint: 'prebuilt node-pty binary missing' })
  } else {
    reqs.push({ kind: 'file', path: join(nm, 'node-pty', 'prebuilds', `${platform}-${arch}`, 'pty.node'), hint: 'prebuilt node-pty binary missing' })
  }
  return reqs
}

export function probeDshRuntime(dir: string = dshRuntimeDir()): RequirementReport {
  return probeRequirements(dshRuntimeRequirements(dir))
}

/** The entry the child runs. */
export function dshRuntimeBin(dir: string = dshRuntimeDir()): string {
  return join(dir, 'node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-demo', 'lib', 'bin.js')
}

/** For the journal: where the runtime came from, never a secret. */
export function describeRuntime(dir: string = dshRuntimeDir()): { dir: string; bin: string } {
  return { dir, bin: dshRuntimeBin(dir) }
}

/**
 * Which shell the child may have. On Windows dsh's shell rows need PowerShell 7 (`pwsh`), which
 * Windows does not ship; Git Bash is the common second; with neither, the run gets file tools
 * only and the model is told so in its persona. Resolved against the env the CHILD will see.
 */
export function probeChildShell(env: NodeJS.ProcessEnv = process.env, platform = process.platform): ChildShell {
  if (platform === 'win32') {
    const pwsh = resolveBinary('pwsh', env)
    if (pwsh) return { kind: 'pwsh', path: pwsh }
    const bash = resolveBinary('bash', env)
    // System32\bash.exe is the WSL launcher, not a shell dsh can drive.
    if (bash && !/\\system32\\bash\.exe$/i.test(bash)) return { kind: 'bash', path: bash }
    return { kind: 'none' }
  }
  const bash = resolveBinary('bash', env)
  return bash ? { kind: 'bash', path: bash } : { kind: 'none' }
}

export interface ComposeOptions {
  shell: ChildShell
  /** Mount DUIN's own MCP tools (`mcp__duin__*`) via the run's bearer. */
  mcpUrl: string | null
}

function yamlString(s: string): string {
  // Single-quoted YAML scalar: only the quote itself needs doubling.
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * The child's composition. Every value that differs per run comes from the environment the
 * parent sets (`DSH_CWD`, `DSH_SESSION_ROOT`, `DSH_SYSTEM_PROMPT`, `DUIN_EXEC_*`), so the
 * YAML never carries a path or a secret and the same text is reproducible in tests.
 */
export function composeDshCordisYml(o: ComposeOptions): string {
  const rows: string[] = []
  const row = (s: string): void => {
    rows.push(s.trimEnd())
  }
  row(`# Generated by DUIN for one delegated run. Do not edit: executor-runtime.ts owns this.
- id: sdk-jsonrpc-server
  name: '@deepseek-ai/dsh-sdk-jsonrpc-server'
  config:
    maxTokensAsSuccess: false
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: workspace-write
    workspaceRoot: !!js process.env.DSH_CWD ?? process.cwd()
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: never
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'
- id: duin-gate
  name: duin-gate`)
  if (o.shell.kind !== 'none') {
    // The shell TOOL (dsh-tool-bash / dsh-tool-pwsh) injects the `shellEnv` service, provided by
    // dsh-shell-env — a standalone plugin that must be mounted explicitly (it is nobody's
    // transitive dependency). Omitting it leaves the tool fiber PENDING and the whole runtime
    // fails to boot ("1 entry did not activate") — but ONLY under electron-as-node, which is how
    // production spawns it; under plain node it boots, which is why a node-only test missed this.
    // A shell tool is never mounted without its shellEnv provider — see the test.
    row(`- id: shell-env
  name: '@deepseek-ai/dsh-shell-env'`)
  }
  if (o.shell.kind === 'pwsh') {
    row(`- id: pwsh
  name: '@deepseek-ai/dsh-pwsh-sandbox'
  config:
    pwshPath: ${yamlString(o.shell.path)}
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'`)
  } else if (o.shell.kind === 'bash') {
    row(`- id: bash
  name: '@deepseek-ai/dsh-bash-sandbox'
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'`)
  }
  row(`- id: fs
  name: '@deepseek-ai/dsh-fs-sandbox'
  config:
    cwd: !!js process.env.DSH_CWD ?? process.cwd()
- id: fs-observation-policy
  name: '@deepseek-ai/dsh-fs-observation-policy'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
- id: agent-spine
  name: '@deepseek-ai/dsh-agent-spine-demo'
  config:
    includeHarnessIdentity: false
    includeRuntimeContext: false
    persona: !!js process.env.DSH_SYSTEM_PROMPT ?? 'You are the DUIN executor.'
    workspaceContext: false
    skills:
      enabled: false
    toolBash: false
    toolJobs: false`)
  if (o.mcpUrl) {
    row(`- id: mcp-duin
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: duin
    transport: streamable-http
    url: ${yamlString(o.mcpUrl)}
    headers:
      Authorization: !!js '\`Bearer \${process.env.DUIN_EXEC_TOKEN}\`'
    failOnStartupError: false`)
  }
  row(`- id: sessions
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js process.env.DSH_SESSION_ROOT ?? './.sessions'
- id: session-checkpoints
  name: '@deepseek-ai/dsh-session-checkpoint-policy'`)
  return rows.join('\n') + '\n'
}

/** Per-run scratch under userData: the generated config and the child's session log. */
export function executorRunDir(runId: string): string {
  const base = (() => {
    try {
      return join(app.getPath('userData'), 'executor', 'runs')
    } catch {
      return join(process.cwd(), '.executor-runs')
    }
  })()
  return join(base, runId)
}

export function writeRunComposition(runId: string, yml: string): { dir: string; configPath: string; sessionRoot: string } {
  const dir = executorRunDir(runId)
  const sessionRoot = join(dir, 'sessions')
  if (!existsSync(sessionRoot)) mkdirSync(sessionRoot, { recursive: true })
  const configPath = join(dir, 'cordis.yml')
  writeFileSync(configPath, yml, 'utf8')
  return { dir, configPath, sessionRoot }
}

/** The persona the child runs under: DUIN's frame plus what it may and may not do here. */
export function childPersona(shell: ChildShell, brief: string | null): string {
  const parts = [
    'You are a coding executor delegated by DUIN, a personal judgment system that governs your tool use.',
    'Work only inside the workspace you were given; every tool call is checked by DUIN before it runs, and a denied call tells you why. Do not retry a denied call unchanged.',
    shell.kind === 'none'
      ? 'This run has NO shell: you can read, write and edit files only. Say so in your result if the task needed a shell.'
      : `This run has a ${shell.kind} shell confined to the workspace.`,
    'Finish by stating what you changed, what you verified, and what you could not do.'
  ]
  if (brief && brief.trim()) parts.push(`Operator context from DUIN:\n${brief.trim()}`)
  return parts.join('\n\n')
}
