import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { join, basename, dirname, resolve } from 'path'
import matter from 'gray-matter'
import chokidar, { FSWatcher } from 'chokidar'
import { is } from '@electron-toolkit/utils'
// Static import (no circular dep — plugin-loader imports only electron/fs/path/
// chokidar). The former lazy `require('./plugin-loader')` broke under the
// single-file main bundle ("Cannot find module './plugin-loader'").
import { enabledPluginRoots, subscribeToPluginChanges } from './plugin-loader'
import {
  coerceRequirements,
  probeRequirements,
  type Requirement,
  type RequirementResult
} from './capability-requires'

export interface LoadedSkill {
  id: string
  name: string
  description: string
  content: string
  filePath: string
  enabled: boolean
  /** Customize C3: tool-glob allowlist injected into the skill block.
   *  When omitted, the skill can call any tool the agent has access to. */
  allowedTools?: string[]
  /** Customize C3: optional per-skill model override. Field is parsed
   *  and surfaced; routing wiring layers on top in a future phase. */
  model?: string
  /** Customize C3: when false the skill is manual-only (user must
   *  reference it explicitly). Defaults to true. */
  autoInvoke?: boolean
  /** Customize C3: directory-mode siblings discovered next to
   *  `skill.md`. Filenames are relative to the skill directory; the
   *  agent reads them by path when referenced. Empty for flat skills. */
  supportingFiles?: string[]
  /** Customize C11: when sourced from an enabled plugin's skills/ dir,
   *  the plugin's manifest id. ID is namespaced as `<pluginId>:<skillId>`
   *  so it can't collide with user-authored skills. */
  pluginId?: string
  /** True when this file was seeded from the shipped bundle. The UI used to
   *  infer this from the path (`filePath.includes('/resources/skills/')`),
   *  which was never true in EITHER mode — dev read `<repo>/skills` and prod
   *  reads a userData copy — so the bundled/user distinction silently never
   *  rendered. Sourced from the seed manifest instead. */
  bundled?: boolean
  /** `requires:` frontmatter — what this skill needs on the machine to work.
   *  The common case is a skill whose instructions tell the model to shell out
   *  to a CLI: without this, the only way to learn the tool is absent is to
   *  watch the model try and fail mid-turn, having already spent the call. */
  requires?: Requirement[]
  /** Probed failures for `requires`. Absent when nothing is missing.
   *  Relative `file` requirements resolve against the skill's directory. */
  missing?: RequirementResult[]
}

const skills = new Map<string, LoadedSkill>()
// Customize C11: plugin-sourced skills live in a separate Map keyed by
// namespaced id (`<pluginId>:<skillId>`). The `listSkills()` reader
// concatenates both. Removing/disabling a plugin clears its entries
// without touching the user-authored set.
const pluginSkills = new Map<string, LoadedSkill>()
let watcher: FSWatcher | null = null
let skillsDirPath: string | null = null
let unsubscribePluginChanges: (() => void) | null = null

function resolveSkillsDir(): string {
  // Dev reads the SHIPPED set directly, so there is exactly one bundled-skill
  // tree to maintain. Until 2026-08-17 dev read a separate top-level `skills/`
  // and prod read `resources/skills`, and the two silently drifted: dev-only
  // `method-creator` + an `x` test stub, prod-only `ingest` + the format demo.
  // A default a developer never sees is a default nobody reviews.
  if (is.dev) return bundledSkillsDir()
  return join(app.getPath('userData'), 'skills')
}

function bundledSkillsDir(): string {
  if (is.dev) return join(__dirname, '../../resources/skills')
  return join(process.resourcesPath, 'skills')
}

/** Records which bundled files we seeded, and the bytes we seeded, so the three
 *  states below can be told apart on the next launch. Lives in the skills dir;
 *  not a `.md`, so neither the scanner nor the watcher treats it as a skill. */
const BUNDLED_MANIFEST = '.bundled-skills.json'

interface BundledManifest {
  /** posix relPath under the skills dir -> sha256 of the bytes last seeded. */
  seeded: Record<string, string>
}

/** Absolute paths of skills that came from the bundle, for the `bundled` flag.
 *  Rebuilt by ensureSkillsDir on every startup. */
const bundledPaths = new Set<string>()

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function readManifest(dir: string): BundledManifest {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, BUNDLED_MANIFEST), 'utf-8')) as BundledManifest
    if (parsed && typeof parsed === 'object' && parsed.seeded && typeof parsed.seeded === 'object') {
      return { seeded: parsed.seeded }
    }
  } catch {
    // Absent (first run) or corrupt. Treating corrupt as first-run would
    // re-seed skills the operator deleted, so prefer an empty manifest only
    // when the file genuinely cannot be parsed — the cost is one re-seed.
  }
  return { seeded: {} }
}

function writeManifest(dir: string, manifest: BundledManifest): void {
  try {
    writeFileSync(join(dir, BUNDLED_MANIFEST), JSON.stringify(manifest, null, 2), 'utf-8')
  } catch (err) {
    console.error('[skill-loader] could not persist the bundled-skill manifest', err)
  }
}

/** Every file under `root`, as posix-relative paths. */
function bundledFiles(root: string, prefix = ''): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(root, entry)
    const rel = prefix ? `${prefix}/${entry}` : entry
    try {
      const st = statSync(full)
      if (st.isDirectory()) out.push(...bundledFiles(full, rel))
      else if (st.isFile()) out.push(rel)
    } catch {
      /* skip unreadable entry */
    }
  }
  return out
}

/**
 * Reconcile the bundled skills into the operator's skills dir.
 *
 * The previous implementation copied any bundled file whose destination did not
 * exist and skipped every one that did. That is wrong in both directions:
 *   - DELETING a bundled skill did not stick. The next launch copied it back,
 *     while the delete toast said a recoverable copy had been archived — so the
 *     operator was told the file was gone and it was not.
 *   - A bundled skill could never be IMPROVED. Once seeded, a shipped fix could
 *     not reach any existing install, silently, forever.
 *
 * The manifest distinguishes the three states a destination can be in:
 *   absent + previously seeded  -> the operator deleted it; stay deleted
 *   present + matches manifest  -> untouched; a changed bundle may update it
 *   present + differs           -> the operator edited it; never clobber
 */
function ensureSkillsDir(dir: string, bundledDir?: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  bundledPaths.clear()

  const bundled = bundledDir ?? bundledSkillsDir()
  if (!existsSync(bundled)) return
  if (resolve(bundled) === resolve(dir)) {
    // Dev: the skills dir IS the bundle. Nothing to seed, but the files are
    // still bundled for the purposes of the UI flag.
    for (const rel of bundledFiles(bundled)) {
      bundledPaths.add(resolve(join(dir, ...rel.split('/'))))
    }
    return
  }

  const manifest = readManifest(dir)
  const next: Record<string, string> = {}
  let mutated = false

  for (const rel of bundledFiles(bundled)) {
    if (basename(rel) === BUNDLED_MANIFEST) continue
    const src = join(bundled, ...rel.split('/'))
    const dest = join(dir, ...rel.split('/'))
    bundledPaths.add(resolve(dest))

    let srcBytes: Buffer
    try {
      srcBytes = readFileSync(src)
    } catch {
      continue
    }
    const srcHash = sha256(srcBytes)
    const seededHash = manifest.seeded[rel]

    if (!existsSync(dest)) {
      if (seededHash !== undefined) {
        // Deleted by the operator. Keep the row so we keep remembering.
        next[rel] = seededHash
        bundledPaths.delete(resolve(dest))
        continue
      }
      try {
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, srcBytes)
        next[rel] = srcHash
        mutated = true
      } catch (err) {
        console.error('[skill-loader] failed to seed bundled skill', src, err)
      }
      continue
    }

    let destHash: string
    try {
      destHash = sha256(readFileSync(dest))
    } catch {
      next[rel] = seededHash ?? srcHash
      continue
    }

    if (destHash === srcHash) {
      next[rel] = srcHash
      continue
    }

    if (seededHash !== undefined && destHash === seededHash) {
      try {
        writeFileSync(dest, srcBytes)
        next[rel] = srcHash
        mutated = true
      } catch (err) {
        console.error('[skill-loader] failed to update bundled skill', dest, err)
        next[rel] = seededHash
      }
      continue
    }

    // Operator-edited: their bytes win. Remember what they diverged from so a
    // later bundled change is still recognised as "they edited this", not as
    // "untouched" — otherwise one coincidental hash match clobbers their work.
    next[rel] = seededHash ?? destHash
  }

  const rowsChanged =
    Object.keys(next).length !== Object.keys(manifest.seeded).length ||
    Object.keys(next).some((k) => next[k] !== manifest.seeded[k])
  if (mutated || rowsChanged) writeManifest(dir, { seeded: next })
}

function fileIdFromPath(filePath: string): string {
  if (basename(filePath).toLowerCase() === 'skill.md') {
    return basename(dirname(filePath))
  }
  return basename(filePath, '.md')
}

function isSkillFile(filePath: string): boolean {
  const base = basename(filePath).toLowerCase()
  return base === 'skill.md' || base.endsWith('.md')
}

function discoverSkillFiles(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  // A directory-mode skill contributes exactly ONE skill: its `SKILL.md`.
  // Its siblings are supportingFiles — deliberately NOT inlined into the
  // prompt — and must not be scanned as skills in their own right. Otherwise a
  // `reference.md` carrying `name:` frontmatter registers as a phantom
  // top-level skill whose id is its basename, so two directory skills each
  // shipping a `reference.md` collide and one silently replaces the other.
  const own = entries.find((e) => e.toLowerCase() === 'skill.md')
  if (own) {
    const ownPath = join(dir, own)
    try {
      if (statSync(ownPath).isFile()) return [ownPath]
    } catch {
      /* unreadable — fall through to the normal scan */
    }
  }

  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry)
    try {
      const stats = statSync(full)
      if (stats.isDirectory()) {
        files.push(...discoverSkillFiles(full))
      } else if (stats.isFile() && isSkillFile(full)) {
        files.push(full)
      }
    } catch {
      /* skip unreadable entry */
    }
  }
  return files
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) out.push(item.trim())
  }
  return out.length ? out : undefined
}

function discoverSupportingFiles(skillFilePath: string): string[] | undefined {
  // Only directory-mode skills have supporting files. A directory-mode
  // skill is one whose filename is exactly `skill.md`.
  if (basename(skillFilePath).toLowerCase() !== 'skill.md') return undefined
  const dir = dirname(skillFilePath)
  const rel: string[] = []
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (!statSync(full).isFile()) continue
      if (entry.toLowerCase() === 'skill.md') continue
      rel.push(entry)
    }
  } catch {
    return undefined
  }
  return rel.length ? rel.sort() : undefined
}

function parseSkillFile(filePath: string): LoadedSkill | null {
  try {
    if (!statSync(filePath).isFile()) return null
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = matter(raw)
    const name = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : ''
    const description =
      typeof parsed.data.description === 'string' ? parsed.data.description.trim() : ''
    const content = parsed.content.trim()
    if (!name) {
      console.warn('[skill-loader] skipping skill without name:', filePath)
      return null
    }
    const allowedTools = asStringArray(parsed.data.allowedTools ?? parsed.data['allowed-tools'])
    const model =
      typeof parsed.data.model === 'string' && parsed.data.model.trim()
        ? parsed.data.model.trim()
        : undefined
    // Two equivalent spellings — matches what users coming from Claude
    // Code's `disable-model-invocation` instinct expect. Default is on.
    let autoInvoke: boolean | undefined
    if (typeof parsed.data.autoInvoke === 'boolean') autoInvoke = parsed.data.autoInvoke
    else if (typeof parsed.data['auto-invoke'] === 'boolean')
      autoInvoke = parsed.data['auto-invoke'] as boolean
    else if (typeof parsed.data['disable-model-invocation'] === 'boolean')
      autoInvoke = !(parsed.data['disable-model-invocation'] as boolean)
    const supportingFiles = discoverSupportingFiles(filePath)
    // Both spellings, matching the allowed-tools precedent one field up.
    const requires = coerceRequirements(parsed.data.requires ?? parsed.data['requires-tools'])
    // Relative `file` requirements resolve against the skill's own directory, so a
    // directory-mode skill can require an asset it ships next to skill.md.
    const missing = probeRequirements(requires, { baseDir: dirname(filePath) }).missing
    return {
      id: fileIdFromPath(filePath),
      name,
      description,
      content,
      filePath,
      enabled: false,
      ...(allowedTools ? { allowedTools } : {}),
      ...(model ? { model } : {}),
      ...(autoInvoke !== undefined ? { autoInvoke } : {}),
      ...(supportingFiles ? { supportingFiles } : {}),
      ...(bundledPaths.has(resolve(filePath)) ? { bundled: true } : {}),
      ...(requires ? { requires } : {}),
      ...(missing.length > 0 ? { missing } : {})
    }
  } catch (err) {
    console.error('[skill-loader] failed to parse', filePath, err)
    return null
  }
}

function broadcastChange(): void {
  const list = listSkills()
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('skills:changed', list)
  }
}

function upsertFromPath(filePath: string): void {
  if (!isSkillFile(filePath)) return
  const skill = parseSkillFile(filePath)
  if (!skill) return
  skills.set(skill.id, skill)
  broadcastChange()
}

function removeByPath(filePath: string): void {
  if (!isSkillFile(filePath)) return
  const id = fileIdFromPath(filePath)
  if (skills.delete(id)) {
    broadcastChange()
  }
}

function rescanPluginSkills(): void {
  const before = pluginSkills.size
  pluginSkills.clear()
  for (const { pluginId, rootPath } of enabledPluginRoots()) {
    const dir = join(rootPath, 'skills')
    if (!existsSync(dir)) continue
    let files: string[]
    try {
      files = discoverSkillFiles(dir)
    } catch {
      continue
    }
    for (const file of files) {
      const skill = parseSkillFile(file)
      if (!skill) continue
      const namespaced: LoadedSkill = {
        ...skill,
        id: `${pluginId}:${skill.id}`,
        pluginId
      }
      pluginSkills.set(namespaced.id, namespaced)
    }
  }
  if (before !== pluginSkills.size) {
    broadcastChange()
  } else {
    // No count change but ids may have shifted; broadcast anyway so the
    // renderer sees the new contents.
    broadcastChange()
  }
}

export function initializeSkillLoader(): void {
  if (skillsDirPath) return
  const dir = resolveSkillsDir()
  ensureSkillsDir(dir)
  skillsDirPath = dir

  // Initial scan
  try {
    for (const file of discoverSkillFiles(dir)) {
      const skill = parseSkillFile(file)
      if (skill) skills.set(skill.id, skill)
    }
  } catch (err) {
    console.error('[skill-loader] initial scan failed:', err)
  }

  watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
  })

  watcher.on('add', upsertFromPath)
  watcher.on('change', upsertFromPath)
  watcher.on('unlink', removeByPath)
  watcher.on('error', (err) => console.error('[skill-loader] watcher error:', err))

  // Customize C11 — pick up plugin-sourced skills now and on every
  // enabled-state change broadcast by plugin-loader.
  try {
    unsubscribePluginChanges = subscribeToPluginChanges(rescanPluginSkills)
    rescanPluginSkills()
  } catch (err) {
    console.error('[skill-loader] plugin subscription failed:', err)
  }

  console.log(
    `[skill-loader] watching ${dir} (${skills.size} user skills, ${pluginSkills.size} plugin skills loaded)`
  )
}

export function shutdownSkillLoader(): void {
  if (watcher) {
    watcher.close().catch(() => {})
    watcher = null
  }
  if (unsubscribePluginChanges) {
    unsubscribePluginChanges()
    unsubscribePluginChanges = null
  }
  skills.clear()
  pluginSkills.clear()
  skillsDirPath = null
}

export function getSkillsDir(): string {
  if (!skillsDirPath) {
    skillsDirPath = resolveSkillsDir()
    ensureSkillsDir(skillsDirPath)
  }
  return skillsDirPath
}

export function listSkills(): LoadedSkill[] {
  // Plugin skills come after user skills in the unsorted set, then
  // the localeCompare gives one merged alpha list. UI groups by
  // pluginId when present.
  const out: LoadedSkill[] = [...skills.values(), ...pluginSkills.values()]
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function getSkill(id: string): LoadedSkill | undefined {
  return skills.get(id) ?? pluginSkills.get(id)
}

/**
 * Ids AND display names of every loaded skill.
 *
 * The Methods layer classifies a method note's `[[wikilinks]]` as skill wires by
 * matching them against "installed skills" — and both readers resolved that set
 * from `<vault>/.duin/skills`, a directory DUIN never writes. The app's skills
 * live here, in `userData/skills`. So on every install except one where a vault
 * happened to carry a hand-built `.duin/skills`, wikilink wires resolved to
 * nothing and only `calls-skills:` frontmatter worked. Pass this in.
 */
export function installedSkillNames(): string[] {
  const out: string[] = []
  for (const skill of listSkills()) {
    out.push(skill.id)
    if (skill.name) out.push(skill.name)
  }
  return out
}

export function getSkillContent(id: string): string | null {
  const skill = skills.get(id) ?? pluginSkills.get(id)
  return skill ? skill.content : null
}

export const __skillLoaderTest = {
  discoverSkillFiles,
  parseSkillFile,
  fileIdFromPath,
  ensureSkillsDir,
  bundledPaths,
  BUNDLED_MANIFEST
}
