import { app, BrowserWindow } from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync
} from 'fs'
import { join, basename } from 'path'
import matter from 'gray-matter'
import chokidar, { FSWatcher } from 'chokidar'
import { is } from '@electron-toolkit/utils'

// Subagent type registry. Mirrors the skill-loader filesystem-discovery pattern:
// users drop a markdown file at `userData/subagent-types/<name>.md` with YAML
// frontmatter, and the file appears as a forkable agent type by name.
//
// Built-in types ship in BUILT_IN_SUBAGENT_TYPES below — Explore / Plan /
// code-reviewer / general. Users may shadow a built-in by writing a file with
// the same name; user types win.

export type AllowedTools = '*' | string[]

export interface SubagentTypeDef {
  /** Type identifier — what callers pass as `agentType` to forkAgent. */
  name: string
  /** One-line description, shown in the UI and in /agents-style listings. */
  description: string
  /** Allowed tool descriptor IDs, or '*' for "all tools the parent has". */
  allowedTools: AllowedTools
  /** Full system prompt the subagent runs under. */
  systemPrompt: string
  /** Origin — 'builtin' or absolute path to the source .md file. */
  source: 'builtin' | string
}

// Built-in defaults. These are the agent types Lamprey ships with; users can
// shadow any by name in userData/subagent-types/.
// Tool ids here are matched EXACTLY against subagent-config's SUBAGENT_TOOLS ceiling;
// anything outside it is refused no matter what this list says. Three of the four ids
// these agents used to name were outside it:
//
//   grep_search / glob_search — never existed; the real ids are search_files/glob_files
//   shell_command             — the AGUI surface calls it `run_command`
//
// So Explore, Plan and code-reviewer — the three agents whose entire purpose is
// searching — actually ran with `read_file` and nothing else. Nothing errored; the tools
// simply were not there.
//
// The search ids are restored. `shell_command` is DROPPED rather than translated to
// `run_command`: that capability has never once been live for these agents, all three are
// described as read-only, and `run_command` is host-exec. Granting three read-only agents
// shell access is a governance decision, not a defect fix — the systemPrompt no longer
// tells them to reach for it either. subagent-allowed-tools.test.ts pins every id against
// the ceiling so a phantom entry cannot come back.
export const BUILT_IN_SUBAGENT_TYPES: Record<string, SubagentTypeDef> = {
  Explore: {
    name: 'Explore',
    description:
      'Fast read-only search agent for locating code. Use it to find files by pattern, grep for symbols, or answer "where is X defined / which files reference Y." Does NOT edit.',
    allowedTools: ['read_file', 'search_files', 'glob_files'],
    systemPrompt:
      'You are the Explore agent. You search and locate code; you never edit. ' +
      'Use search_files/glob_files/read_file to answer "where is X" or ' +
      '"which files reference Y". Return a tight list of file paths with one-line ' +
      'context per hit. Do not speculate beyond what the searches show. Never edit ' +
      'files. Never call mutating tools. End with a short summary of how confident ' +
      'you are that the search was exhaustive for the asked scope.',
    source: 'builtin'
  },
  Plan: {
    name: 'Plan',
    description:
      'Software architect agent for designing implementation plans. Returns step-by-step plans and identifies critical files. Read-only.',
    allowedTools: ['read_file', 'search_files', 'glob_files'],
    systemPrompt:
      'You are the Plan agent. Decompose the requested task into an ordered ' +
      'minimal sequence of steps. For each step name the specific files involved ' +
      'and the tool you would use. State assumptions explicitly. You never edit ' +
      'files — your output is a plan, not code. End with a short risk list and a ' +
      'recommendation on whether to proceed or to clarify with the user first.',
    source: 'builtin'
  },
  'code-reviewer': {
    name: 'code-reviewer',
    description:
      'Reviews a diff or file for correctness, regressions, missed edge cases, dead code, and naming drift. Cites by file:line. Read-only.',
    allowedTools: ['read_file', 'search_files', 'glob_files'],
    systemPrompt:
      'You are the code-reviewer agent. Hunt for real problems: correctness bugs, ' +
      'regressions, missed edge cases, dead code, missing or weak tests, naming or ' +
      'style that drifts from the rest of the codebase. Cite findings by file and ' +
      'line number. Do not rewrite the change; point at the bugs and suggest the ' +
      'smallest edit that fixes each one. End with one verdict word on its own — ' +
      'SHIP if the change is good to merge, or CHANGES if not. If CHANGES, follow ' +
      'with a minimal list of required edits.',
    source: 'builtin'
  },
  general: {
    name: 'general',
    description:
      'General-purpose agent. Inherits every tool the parent has. Use when no more specific type fits.',
    allowedTools: '*',
    systemPrompt:
      'You are a general-purpose subagent. Read the task carefully, gather only ' +
      'the context you need, take the smallest correct action, verify the result, ' +
      'and report back concisely. Prefer evidence from tool calls over speculation.',
    source: 'builtin'
  }
}

const userTypes = new Map<string, SubagentTypeDef>()
let watcher: FSWatcher | null = null
let typesDirPath: string | null = null

function resolveTypesDir(): string {
  if (is.dev) {
    return join(__dirname, '../../subagent-types')
  }
  return join(app.getPath('userData'), 'subagent-types')
}

function ensureTypesDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function isTypeFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.md')
}

function nameFromPath(filePath: string): string {
  return basename(filePath, '.md')
}

function discoverTypeFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    try {
      const stats = statSync(full)
      if (stats.isFile() && isTypeFile(full)) files.push(full)
    } catch {
      // ignore — file may have been removed between readdir and statSync
    }
  }
  return files
}

function parseAllowedTools(raw: unknown): AllowedTools | null {
  if (raw === '*' || raw === 'all') return '*'
  if (Array.isArray(raw)) {
    const cleaned = raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    return cleaned
  }
  return null
}

export function parseSubagentTypeFile(filePath: string): SubagentTypeDef | null {
  try {
    if (!statSync(filePath).isFile()) return null
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = matter(raw)
    const fmName = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : ''
    const name = fmName || nameFromPath(filePath)
    const description =
      typeof parsed.data.description === 'string' ? parsed.data.description.trim() : ''
    const allowedTools = parseAllowedTools(parsed.data.allowedTools)
    // systemPrompt can be in frontmatter (override) or as the markdown body.
    // Body is the ergonomic default — long prompts in YAML are painful to edit.
    const frontmatterPrompt =
      typeof parsed.data.systemPrompt === 'string' ? parsed.data.systemPrompt.trim() : ''
    const bodyPrompt = parsed.content.trim()
    const systemPrompt = frontmatterPrompt || bodyPrompt
    if (!name || !description || !allowedTools || !systemPrompt) {
      console.warn(
        `[subagent-types] skipping ${filePath}: requires { name? (or filename), description, allowedTools[], systemPrompt (frontmatter or body) }`
      )
      return null
    }
    return {
      name,
      description,
      allowedTools,
      systemPrompt,
      source: filePath
    }
  } catch (err) {
    console.error('[subagent-types] failed to parse', filePath, err)
    return null
  }
}

function broadcastChange(): void {
  const list = listSubagentTypes()
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('subagent-types:changed', list)
  }
}

function upsertFromPath(filePath: string): void {
  if (!isTypeFile(filePath)) return
  const def = parseSubagentTypeFile(filePath)
  if (!def) return
  userTypes.set(def.name, def)
  broadcastChange()
}

function removeByPath(filePath: string): void {
  if (!isTypeFile(filePath)) return
  const name = nameFromPath(filePath)
  // Also remove any user type whose source matches this file path (covers the
  // case where the frontmatter `name` differed from the filename).
  let removed = userTypes.delete(name)
  for (const [k, v] of userTypes) {
    if (v.source === filePath) {
      userTypes.delete(k)
      removed = true
    }
  }
  if (removed) broadcastChange()
}

export function initializeSubagentTypeLoader(): void {
  if (typesDirPath) return
  const dir = resolveTypesDir()
  ensureTypesDir(dir)
  typesDirPath = dir

  try {
    for (const file of discoverTypeFiles(dir)) {
      const def = parseSubagentTypeFile(file)
      if (def) userTypes.set(def.name, def)
    }
  } catch (err) {
    console.error('[subagent-types] initial scan failed:', err)
  }

  watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
  })

  watcher.on('add', upsertFromPath)
  watcher.on('change', upsertFromPath)
  watcher.on('unlink', removeByPath)
  watcher.on('error', (err) => console.error('[subagent-types] watcher error:', err))

  console.log(`[subagent-types] watching ${dir} (${userTypes.size} user types loaded)`)
}

export function shutdownSubagentTypeLoader(): void {
  if (watcher) {
    watcher.close().catch(() => {})
    watcher = null
  }
  userTypes.clear()
  typesDirPath = null
}

export function getSubagentTypesDir(): string {
  if (!typesDirPath) {
    typesDirPath = resolveTypesDir()
    ensureTypesDir(typesDirPath)
  }
  return typesDirPath
}

/** User types shadow built-ins of the same name. */
export function getSubagentType(name: string): SubagentTypeDef | null {
  if (userTypes.has(name)) return userTypes.get(name)!
  if (Object.prototype.hasOwnProperty.call(BUILT_IN_SUBAGENT_TYPES, name)) {
    return BUILT_IN_SUBAGENT_TYPES[name]
  }
  return null
}

export function listSubagentTypes(): SubagentTypeDef[] {
  const out = new Map<string, SubagentTypeDef>()
  for (const [k, v] of Object.entries(BUILT_IN_SUBAGENT_TYPES)) out.set(k, v)
  for (const [k, v] of userTypes) out.set(k, v) // user wins
  return Array.from(out.values()).sort((a, b) => a.name.localeCompare(b.name))
}

/** Register or replace a subagent type at runtime — e.g. agents discovered in
 *  the vault's `.duin/agents/`. Like user files, these shadow a built-in of the
 *  same name. */
export function upsertSubagentType(def: SubagentTypeDef): void {
  userTypes.set(def.name, def)
  broadcastChange()
}

/** Remove every registered type whose `source` matches — used to clear a prior
 *  vault's agents before loading a new vault's set. Returns # removed. */
export function removeSubagentTypesBySource(match: (source: string) => boolean): number {
  let removed = 0
  for (const [k, v] of userTypes) {
    if (typeof v.source === 'string' && match(v.source)) {
      userTypes.delete(k)
      removed++
    }
  }
  if (removed) broadcastChange()
  return removed
}

// Test-only seam. Tests inject a stub type map without touching the filesystem.
export const __subagentTypesTest = {
  setUserType(def: SubagentTypeDef): void {
    userTypes.set(def.name, def)
  },
  clearUserTypes(): void {
    userTypes.clear()
  },
  parseSubagentTypeFile,
  parseAllowedTools
}
