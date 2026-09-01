import { existsSync, statSync } from 'fs'
import { delimiter, join, isAbsolute } from 'path'

// WHAT A CAPABILITY NEEDS IN ORDER TO WORK, stated where the capability is declared
// and CHECKED before it is offered.
//
// The gap this closes. DUIN can reach open-source programs three ways — an MCP
// connector spawning `npx -y <pkg>`, a skill telling the model to shell out to a CLI,
// a plugin shipping either — and until now NONE of them could say what they needed.
// The tree contained no `requires`, no prerequisite, no binary-existence check
// anywhere, with exactly one exception: a ten-line `larkCliAvailable()` in
// mcp-defaults.ts that looked for one binary in three directories so the Feishu
// connector would seed DISABLED instead of broken. That was the right idea, written
// once, by hand, for one tool. This is that idea generalized.
//
// Why the check has to exist at all. Without it, "this machine does not have Node"
// and "this package does not exist" and "the registry is unreachable" all arrive at
// the same place — a failed connect, after the retry ladder, wearing whatever the
// child happened to write to stderr. The operator is told a connector is BROKEN when
// the truth is it was never INSTALLABLE here. Those want opposite responses, and only
// one of them is the operator's to fix.
//
// DELIBERATELY NOT A PACKAGE MANAGER. Nothing here installs, downloads, or executes.
// A probe answers "is this present" and, when it is not, "here is how you would get
// it" — as text for a human to read, never as a command anything runs. Probing must
// stay cheap and side-effect-free, because it runs on load, on every plugin change,
// and before every connect.

export type Requirement =
  /** An executable resolvable on PATH (or, on Windows, PATH + PATHEXT). */
  | { kind: 'binary'; name: string; hint?: string }
  /** A file or directory that must exist. Absolute, or relative to `baseDir`. */
  | { kind: 'file'; path: string; hint?: string }
  /** An environment variable that must be set and non-empty. Its VALUE is never
   *  read, logged, or returned — only whether it is present. */
  | { kind: 'env'; name: string; hint?: string }

export interface RequirementResult {
  requirement: Requirement
  satisfied: boolean
  /** Human-readable subject ("lark-cli", "GITHUB_TOKEN") for UI without re-switching. */
  label: string
  /** Where it was found. Present only when satisfied, and only for binary/file —
   *  an env var's location is its name, and its value must not leak. */
  resolvedPath?: string
  /** Why it is not satisfied + how to get it. Present only when unsatisfied. */
  detail?: string
}

export interface RequirementReport {
  /** True when every requirement passed, INCLUDING the empty case: something that
   *  declares no requirements is satisfiable, not unknown. */
  satisfied: boolean
  results: RequirementResult[]
  /** Just the failures, for the common "what is missing" render. */
  missing: RequirementResult[]
}

export interface ProbeOptions {
  /** Resolves relative `file` requirements — a plugin root, a skill directory. */
  baseDir?: string
  /**
   * The environment the thing being probed will actually SEE, when that differs
   * from this process's.
   *
   * This distinction is the whole value of the `env` kind for connectors. An MCP
   * stdio child receives `{...safeBase, ...config.env}` (mcp-manager connectStdio),
   * so a connector's token lives in its OWN env block in mcp-servers.json, not in
   * the main process. A probe that read `process.env` would report GITHUB_TOKEN
   * missing while the connector had it configured, and — worse — report it present
   * because the operator happened to export it in the shell that launched DUIN,
   * while the child (which gets only the SAFE_ENV_KEYS allowlist, and that is not
   * on it) never sees it. Both directions are wrong answers.
   */
  env?: NodeJS.ProcessEnv
}

/** Cheap enough to run per-connect, expensive enough to not want in a render loop. */
const CACHE_TTL_MS = 30_000
const cache = new Map<string, { at: number; result: RequirementResult }>()

/** Test seam + a real one: a plugin install or an `npm i -g` mid-session must not be
 *  masked by a stale negative. Called by the plugin loader on every change. */
export function clearRequirementCache(): void {
  cache.clear()
}

function cacheKey(req: Requirement, opts: ProbeOptions): string {
  switch (req.kind) {
    case 'binary':
      // Keyed on the PATH actually used, so two connectors with different env-block
      // PATHs do not share one another's answer.
      return `binary:${req.name}:${opts.env?.PATH ?? opts.env?.Path ?? ''}`
    case 'file':
      return `file:${opts.baseDir ?? ''}:${req.path}`
    case 'env':
      // NOT cached across different env sets — two connectors can both require
      // GITHUB_TOKEN and only one of them have it configured. Keying on the
      // presence bit keeps the cache correct without putting a secret in the key.
      return `env:${req.name}:${envHas(req.name, opts.env) ? 1 : 0}`
  }
}

/** Presence only — the value is never read into anything that outlives this call. */
function envHas(name: string, env: NodeJS.ProcessEnv | undefined): boolean {
  const source = env ?? process.env
  const v = source[name]
  return typeof v === 'string' && v.trim() !== ''
}

export function requirementLabel(req: Requirement): string {
  return req.kind === 'file' ? req.path : req.name
}

/**
 * Resolve an executable the way a spawn would.
 *
 * Mirrors `connectStdio`'s env policy: the child gets `PATH` from the main process,
 * so a probe that consulted anything else would answer a different question than the
 * one that matters. On Windows a bare name is not enough — `npx` on disk is
 * `npx.cmd`, and PATHEXT is what makes the bare name work — so the probe walks
 * PATHEXT exactly as the loader does. Getting this wrong in the lenient direction
 * (reporting present, then failing to spawn) is worse than not probing at all.
 *
 * Also checks the npm global bin directories, because that is where a tool the
 * operator installed with `npm i -g` lands and it is not always on the PATH this
 * process inherited — the case `larkCliAvailable()` was hand-written for.
 */
export function resolveBinary(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  // An explicit path is not a PATH lookup — honour it as written.
  if (name.includes('/') || name.includes('\\')) {
    return existsSync(name) ? name : null
  }

  const isWin = process.platform === 'win32'
  const exts = isWin
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  const pathValue = env.PATH ?? env.Path ?? ''
  const dirs = pathValue.split(delimiter).filter(Boolean)

  // npm's global bin. `npm i -g foo` on Windows writes %APPDATA%\npm\foo.cmd, which
  // is on the interactive user's PATH but not always on a service/launched process's.
  for (const root of [env.APPDATA, env.HOME, env.USERPROFILE]) {
    if (root) dirs.push(join(root, 'npm'))
  }

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      } catch {
        // An unreadable PATH entry is not an answer about this binary — keep looking.
      }
    }
  }
  return null
}

function probeUncached(req: Requirement, opts: ProbeOptions): RequirementResult {
  const label = requirementLabel(req)
  switch (req.kind) {
    case 'binary': {
      // Resolve against the env the CHILD gets, which is `{...parent, ...config.env}`
      // — config.env WINS (mcp-manager connectStdio). An earlier version of this
      // resolved against the main process PATH only, reasoning that SAFE_ENV_KEYS
      // forwards the parent's PATH. True, but incomplete: a connector that sets its
      // own PATH in its env block overrides that forward, so a command resolvable
      // only there would have been reported missing and refused a spawn that would
      // have worked. Merging is the accurate model of what the loader will see.
      const found = resolveBinary(req.name, { ...process.env, ...(opts.env ?? {}) })
      return found
        ? { requirement: req, satisfied: true, label, resolvedPath: found }
        : {
            requirement: req,
            satisfied: false,
            label,
            detail: req.hint ?? `"${req.name}" was not found on PATH.`
          }
    }
    case 'file': {
      const full = isAbsolute(req.path) ? req.path : join(opts.baseDir ?? '', req.path)
      return existsSync(full)
        ? { requirement: req, satisfied: true, label, resolvedPath: full }
        : {
            requirement: req,
            satisfied: false,
            label,
            detail: req.hint ?? `Not found: ${full}`
          }
    }
    case 'env': {
      // Presence only. The value is a secret often enough (GITHUB_TOKEN,
      // SLACK_BOT_TOKEN) that reading it into a result object which flows to the
      // renderer and into logs would be a leak with no upside.
      return envHas(req.name, opts.env)
        ? { requirement: req, satisfied: true, label }
        : {
            requirement: req,
            satisfied: false,
            label,
            detail: req.hint ?? `${req.name} is not set.`
          }
    }
  }
}

export function probeRequirement(req: Requirement, opts: ProbeOptions = {}): RequirementResult {
  const key = cacheKey(req, opts)
  const hit = cache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.result
  const result = probeUncached(req, opts)
  cache.set(key, { at: now, result })
  return result
}

/**
 * Probe a whole `requires` block.
 *
 * The empty case returns SATISFIED, not unknown. Almost everything declares no
 * requirements, and treating silence as "might be missing" would put a warning on
 * every connector in the list — which is how a signal earns a reputation for crying
 * wolf and stops being read.
 */
export function probeRequirements(
  requires: Requirement[] | undefined,
  opts: ProbeOptions = {}
): RequirementReport {
  const results = (requires ?? []).map((r) => probeRequirement(r, opts))
  const missing = results.filter((r) => !r.satisfied)
  return { satisfied: missing.length === 0, results, missing }
}

/**
 * The requirement a stdio command implies just by being what it is.
 *
 * MEASURED GAP, 2026-08-26. The first deploy of this mechanism was inert on the
 * machine it shipped to: every configured connector reported `requires: null`.
 * Declared requirements only reach a connector at ADD time (the catalog stamps them)
 * or through a managed-default refresh — so every server added before the field
 * existed, and every one a user hand-writes into mcp-servers.json, carries none. The
 * live Slack connector still failed the old way (spawn, generic transport error)
 * while the code that would have said "SLACK_BOT_TOKEN is not set" sat unreachable.
 *
 * The fix is to stop requiring the declaration for the one dependency that is already
 * stated: a stdio connector's `command` IS its binary dependency. Deriving it needs
 * no catalog, no migration and no author cooperation, and it covers hand-written
 * entries that no declaration would ever have reached.
 *
 * Declared `requires` keep their job — things the command line does NOT reveal, like
 * a token or a data file. This just means nobody has to declare `npx` to get `npx`
 * checked.
 *
 * Returns null for remote transports (nothing is spawned) and for an absolute path
 * that exists, which is the bundled-server shape (`process.execPath`) — resolveBinary
 * already honours explicit paths, so those stay satisfied.
 */
export function impliedCommandRequirement(
  transport: string | undefined,
  command: string | undefined
): Extract<Requirement, { kind: 'binary' }> | null {
  if (transport !== 'stdio') return null
  const name = (command ?? '').trim()
  if (!name) return null
  return {
    kind: 'binary',
    name,
    hint: `"${name}" is the program this connector runs, and it was not found on this machine.`
  }
}

/** Declared requirements plus the one the command line already implies. */
export function effectiveRequirements(
  declared: Requirement[] | undefined,
  transport: string | undefined,
  command: string | undefined
): Requirement[] | undefined {
  const implied = impliedCommandRequirement(transport, command)
  if (!implied) return declared
  // A declaration for the same binary WINS — its author-written hint is better than
  // the generic one, and duplicating the row would say the same thing twice.
  const alreadyDeclared = (declared ?? []).some(
    (r) => r.kind === 'binary' && r.name === implied.name
  )
  if (alreadyDeclared) return declared
  return [...(declared ?? []), implied]
}

/** One line an operator can act on: what is missing and how to get it. */
export function describeMissing(report: RequirementReport): string {
  if (report.satisfied) return ''
  return report.missing
    .map((m) => (m.detail ? `${m.label} — ${m.detail}` : m.label))
    .join('; ')
}

/**
 * Coerce untrusted JSON (a plugin manifest, a connectors.json, a skill's frontmatter)
 * into requirements, DROPPING anything malformed rather than throwing.
 *
 * A junk entry must never take down the thing that declared it: a typo'd requirement
 * that hard-failed the load would make the requires block more dangerous to add than
 * to omit, and nobody would adopt it. Bad entries are skipped and the rest still
 * apply. Returns undefined when nothing survives, so callers can keep using
 * "undefined means no requirements" everywhere.
 */
export function coerceRequirements(raw: unknown): Requirement[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: Requirement[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const hint = typeof e.hint === 'string' && e.hint.trim() ? e.hint.trim() : undefined
    const name = typeof e.name === 'string' ? e.name.trim() : ''
    const path = typeof e.path === 'string' ? e.path.trim() : ''
    switch (e.kind) {
      case 'binary':
        if (name) out.push({ kind: 'binary', name, hint })
        break
      case 'file':
        if (path) out.push({ kind: 'file', path, hint })
        break
      case 'env':
        if (name) out.push({ kind: 'env', name, hint })
        break
      default:
        break
    }
  }
  return out.length > 0 ? out : undefined
}
