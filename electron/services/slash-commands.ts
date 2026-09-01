import { app, BrowserWindow } from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  copyFileSync
} from 'fs'
import { join, basename, resolve } from 'path'
import matter from 'gray-matter'
import chokidar, { FSWatcher } from 'chokidar'
import { is } from '@electron-toolkit/utils'
// Static import (no circular dep). Replaces the former lazy
// `require('./plugin-loader')` that broke under the single-file main bundle.
import { enabledPluginRoots, subscribeToPluginChanges } from './plugin-loader'
// Methods-as-slash-commands: a `type: method` vault note becomes a `/slug`
// command whose body is resolved dynamically via prepareMethodRun (no template
// file on disk). No circular dep — neither of these imports slash-commands.
import { listWorkflows } from './brain/workflows-native'
import { prepareMethodRun } from './brain/method-run'
import { installedSkillNames } from './skill-loader'

// Track 2 / C4 — slash-command loader. Mirrors the skill-loader pattern:
//   - Built-ins live under `resources/slash-commands/<name>.md`
//   - User overrides live under `userData/slash-commands/<name>.md`
//   - First-run bootstrap copies missing built-ins into userData so users
//     can edit them in place without losing on reinstall (skill-loader
//     does the same thing for `userData/skills/`).
//   - chokidar watches for live edits and broadcasts `slash:changed`.
//
// Frontmatter (matches the plan §5 contract):
//   name        string  required — the slug after '/'. Lowercased on load.
//   description string  required — shown in the palette + autocomplete.
//   args        string[] | undefined  — positional arg names for docs +
//                                       `{{name}}` interpolation.
//   hidden      boolean | undefined   — when true, the entry stays out of
//                                       the palette/autocomplete UI but
//                                       `slash:resolve` still resolves it
//                                       (so a user can type the name verbatim).
//
// The body is the prompt template. Interpolation tokens:
//   {{args}}             — everything after the command, joined with spaces
//   {{arg1}} .. {{argN}} — positional tokens
//   {{<name>}}           — when `args` declares a name, that named arg
//
// Unmatched tokens stay literal so a template author can use mustache-
// looking strings in plain text without escaping.

export interface SlashCommand {
  name: string
  description: string
  args: string[]
  hidden: boolean
  body: string
  filePath: string
  source: 'user' | 'builtin' | 'plugin'
  /** Customize C11: when sourced from an enabled plugin, the plugin id.
   *  Command name is namespaced as `<pluginId>:<commandName>` so it
   *  can't collide with user-defined commands. */
  pluginId?: string
  /** Methods-as-slash: 'method' entries have no template body — their prompt is
   *  resolved dynamically from the vault note at `methodPath` via prepareMethodRun.
   *  Absent/undefined ⇒ an ordinary file/plugin command. */
  kind?: 'command' | 'method'
  /** Vault-relative path of the `type: method` note (only when kind==='method'). */
  methodPath?: string
}

const commands = new Map<string, SlashCommand>()
const pluginCommands = new Map<string, SlashCommand>()
let watcher: FSWatcher | null = null
let slashDirPath: string | null = null
let unsubscribePluginChanges: (() => void) | null = null

function resolveSlashDir(): string {
  if (is.dev) {
    return join(__dirname, '../../resources/slash-commands')
  }
  return join(app.getPath('userData'), 'slash-commands')
}

function bundledSlashDir(): string {
  if (is.dev) return join(__dirname, '../../resources/slash-commands')
  return join(process.resourcesPath, 'slash-commands')
}

function ensureSlashDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const bundled = bundledSlashDir()
  if (!existsSync(bundled) || resolve(bundled) === resolve(dir)) return

  // Copy any missing built-ins into the user dir so they can be edited
  // in place without disappearing on next reinstall.
  for (const entry of readdirSync(bundled)) {
    const src = join(bundled, entry)
    const dest = join(dir, entry)
    try {
      if (statSync(src).isFile() && !existsSync(dest)) {
        copyFileSync(src, dest)
      }
    } catch (err) {
      console.error('[slash-loader] failed to copy built-in', src, err)
    }
  }
}

function isMarkdownFile(filePath: string): boolean {
  return basename(filePath).toLowerCase().endsWith('.md')
}

function discoverSlashFiles(dir: string): string[] {
  const files: string[] = []
  if (!existsSync(dir)) return files
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    let stats
    try {
      stats = statSync(full)
    } catch {
      continue
    }
    if (stats.isFile() && isMarkdownFile(full)) files.push(full)
  }
  return files
}

function fileNameToSlug(filePath: string): string {
  // Strip the .md extension case-insensitively so on case-preserving
  // filesystems (Windows, macOS) a file named "Init.MD" yields 'init'
  // — matching the `isMarkdownFile` predicate's case-insensitive check.
  const base = basename(filePath).toLowerCase()
  return base.endsWith('.md') ? base.slice(0, -3) : base
}

function parseSlashFile(filePath: string): SlashCommand | null {
  try {
    if (!statSync(filePath).isFile()) return null
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = matter(raw)
    const frontmatterName =
      typeof parsed.data.name === 'string' ? parsed.data.name.trim().toLowerCase() : ''
    const name = frontmatterName || fileNameToSlug(filePath)
    const description =
      typeof parsed.data.description === 'string' ? parsed.data.description.trim() : ''
    const args = Array.isArray(parsed.data.args)
      ? parsed.data.args
          .filter((a): a is string => typeof a === 'string')
          .map((a) => a.trim())
          .filter(Boolean)
      : []
    const hidden = parsed.data.hidden === true
    const body = parsed.content.replace(/^\s+|\s+$/g, '')
    if (!name) {
      console.warn('[slash-loader] skipping command without name:', filePath)
      return null
    }
    if (!body) {
      console.warn('[slash-loader] skipping command with empty body:', filePath)
      return null
    }
    return {
      name,
      description,
      args,
      hidden,
      body,
      filePath,
      // The userData copy shadows the resources one; we tag every entry
      // 'user' when it was read from the userData dir so the UI can show
      // a "(user override)" hint if needed.
      source: filePath.startsWith(resolveSlashDir())
        ? 'user'
        : ('builtin' as const)
    }
  } catch (err) {
    console.error('[slash-loader] failed to parse', filePath, err)
    return null
  }
}

function broadcastChange(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('slash:changed', listSlashCommands())
  }
}

function upsertFromPath(filePath: string): void {
  if (!isMarkdownFile(filePath)) return
  const cmd = parseSlashFile(filePath)
  if (!cmd) return
  commands.set(cmd.name, cmd)
  broadcastChange()
}

function removeByPath(filePath: string): void {
  if (!isMarkdownFile(filePath)) return
  const slug = fileNameToSlug(filePath)
  if (commands.delete(slug)) broadcastChange()
}

function rescanPluginCommands(): void {
  pluginCommands.clear()
  for (const { pluginId, rootPath } of enabledPluginRoots()) {
    const dir = join(rootPath, 'slash-commands')
    if (!existsSync(dir)) continue
    let files: string[]
    try {
      files = discoverSlashFiles(dir)
    } catch {
      continue
    }
    for (const file of files) {
      const cmd = parseSlashFile(file)
      if (!cmd) continue
      const namespacedName = `${pluginId}:${cmd.name}`
      pluginCommands.set(namespacedName, {
        ...cmd,
        name: namespacedName,
        source: 'plugin',
        pluginId
      })
    }
  }
  broadcastChange()
}

export function initializeSlashCommandLoader(): void {
  if (slashDirPath) return
  const dir = resolveSlashDir()
  ensureSlashDir(dir)
  slashDirPath = dir

  try {
    for (const file of discoverSlashFiles(dir)) {
      const cmd = parseSlashFile(file)
      if (cmd) commands.set(cmd.name, cmd)
    }
  } catch (err) {
    console.error('[slash-loader] initial scan failed:', err)
  }

  watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
  })
  watcher.on('add', upsertFromPath)
  watcher.on('change', upsertFromPath)
  watcher.on('unlink', removeByPath)
  watcher.on('error', (err) => console.error('[slash-loader] watcher error:', err))

  // Customize C11 — pick up plugin-sourced commands now and on every
  // enabled-state change.
  try {
    unsubscribePluginChanges = subscribeToPluginChanges(rescanPluginCommands)
    rescanPluginCommands()
  } catch (err) {
    console.error('[slash-loader] plugin subscription failed:', err)
  }

  console.log(
    `[slash-loader] watching ${dir} (${commands.size} user, ${pluginCommands.size} plugin)`
  )
}

export function shutdownSlashCommandLoader(): void {
  if (watcher) {
    watcher.close().catch(() => {})
    watcher = null
  }
  if (unsubscribePluginChanges) {
    unsubscribePluginChanges()
    unsubscribePluginChanges = null
  }
  commands.clear()
  pluginCommands.clear()
  slashDirPath = null
}

export function listSlashCommands(): SlashCommand[] {
  const out = [...commands.values(), ...pluginCommands.values()]
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function getSlashCommand(name: string): SlashCommand | undefined {
  const key = name.toLowerCase()
  return commands.get(key) ?? pluginCommands.get(key)
}

/**
 * Apply mustache-style interpolation to the body. Tokens:
 *   {{args}}              the concatenated rest of the user's input
 *   {{arg1}} .. {{argN}}  positional tokens (split on whitespace)
 *   {{<name>}}            named arg when `args:` declared one with `<name>`
 *
 * Unmatched tokens are LEFT INTACT — the template author can write
 * literal `{{foo}}` in a prompt without escape. This is the same
 * behaviour as Mustache's strict mode minus the throw.
 */
export function interpolateSlashBody(
  cmd: SlashCommand,
  rest: string
): string {
  const trimmed = rest.trim()
  const tokens = trimmed.length ? trimmed.split(/\s+/) : []
  const mappings = new Map<string, string>()
  mappings.set('args', trimmed)
  tokens.forEach((tok, i) => mappings.set(`arg${i + 1}`, tok))
  cmd.args.forEach((name, i) => {
    mappings.set(name, tokens[i] ?? '')
  })
  return cmd.body.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (whole, key: string) => {
    if (mappings.has(key)) return mappings.get(key)!
    // Positional argN synthetics resolve to empty when out of range, so
    // a template with {{arg1}} doesn't leak the literal placeholder when
    // the user invokes with no args.
    if (/^arg\d+$/.test(key)) return ''
    // Named tokens that aren't mapped stay literal — the template
    // author may want mustache-looking strings in their prompt body.
    return whole
  })
}

/**
 * Resolve a slash invocation into the final prompt. Returns null when
 * the command name is unknown so the caller (UI/IPC) can surface that
 * verbatim instead of fabricating a prompt.
 */
export function resolveSlashCommand(
  name: string,
  rest: string
): { name: string; description: string; prompt: string } | null {
  const cmd = getSlashCommand(name)
  if (!cmd) return null
  return {
    name: cmd.name,
    description: cmd.description,
    prompt: interpolateSlashBody(cmd, rest)
  }
}

/**
 * Enumerate vault `type: method` notes as slash commands. The slug is the note
 * basename minus `.md` with a leading `m-` stripped for a clean `/engine-fault-isolation`
 * — UNLESS that would collide with an existing file/plugin command (or another
 * method), in which case the full `m-…` basename is kept. Pure read; safe to call
 * per `slash:list`. Returns [] when no vault is configured.
 */
export function listMethodSlashCommands(notesDir: string | null): SlashCommand[] {
  if (!notesDir) return []
  let methods: ReturnType<typeof listWorkflows>['methods']
  try {
    methods = listWorkflows(notesDir, installedSkillNames()).methods
  } catch {
    return []
  }
  const taken = new Set<string>([...commands.keys(), ...pluginCommands.keys()])
  const out: SlashCommand[] = []
  for (const m of methods) {
    const base = (m.path.split('/').pop() ?? '').replace(/\.md$/i, '').toLowerCase()
    if (!base) continue
    const stripped = base.replace(/^m-/, '')
    // Prefer the clean slug; fall back to the full basename on any collision.
    const slug = stripped && !taken.has(stripped) ? stripped : base
    if (taken.has(slug)) continue // full basename also taken → skip (extremely rare)
    taken.add(slug)
    out.push({
      name: slug,
      description: m.desc ? `Method · ${m.desc}` : `Method · ${m.name}`,
      args: [],
      hidden: false,
      body: '', // resolved dynamically via prepareMethodRun on invoke
      filePath: m.path,
      source: 'builtin',
      kind: 'method',
      methodPath: m.path
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Resolve a method slash invocation into its run prompt + the skills it wires.
 * Returns null when `name` isn't a known method. The caller activates
 * `activateSkills` for the turn and dispatches `prompt` as a normal user turn.
 */
export function resolveMethodSlash(
  notesDir: string | null,
  name: string
): { name: string; description: string; prompt: string; activateSkills: string[] } | null {
  if (!notesDir) return null
  const key = name.toLowerCase()
  const cmd = listMethodSlashCommands(notesDir).find((c) => c.name === key)
  if (!cmd?.methodPath) return null
  const run = prepareMethodRun(notesDir, cmd.methodPath, installedSkillNames())
  if (!run) return null
  return {
    name: run.name,
    description: cmd.description,
    prompt: run.prompt,
    activateSkills: run.skillWires
  }
}

// Test hooks.
export const __slashLoaderTest = {
  parseSlashFile,
  fileNameToSlug,
  isMarkdownFile,
  interpolateSlashBody,
  // Method-slash internals expose the module command maps for collision tests.
  _setCommandForTest: (c: SlashCommand) => commands.set(c.name, c),
  _clearCommandsForTest: () => commands.clear()
}
