import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { atomicWriteFileSync } from './atomic-write'
import { readSettingsFile, writeSettingsFile } from './settings-file'
import { guardSettingsPartial } from './settings-schema'

// Settings portability (2026-09-03 settings evaluation, D4).
//
// "My DUIN settings" live in eight places, none of which could be exported, reset or
// moved to another machine. This module handles the four that are plain JSON under
// userData: settings.json, channels.json (channel config), pairings.json (who may talk
// to DUIN from a channel) and executive-principals.json (which agents may connect).
//
// Deliberately NOT here:
//   · keys.json — Electron safeStorage ciphertext is bound to the OS user account, so a
//     copied file is unreadable on any other machine. Keys are re-entered by design.
//   · lamprey.db — hooks, permission policies and automations live in the database beside
//     conversations; the database has its own backup and restore on the Persistence page.
//   · windowBounds — machine-specific, stripped on export.

export const BUNDLE_FORMAT = 'duin-settings-bundle' as const
export const BUNDLE_VERSION = 1
export const BUNDLED_FILES = ['settings.json', 'channels.json', 'pairings.json', 'executive-principals.json'] as const
export type BundledFile = (typeof BUNDLED_FILES)[number]

const SKIPPED_SETTINGS_KEYS = new Set(['windowBounds'])
/** What a reset keeps: the vault pointer (losing it looks like a fresh install and
 *  re-runs onboarding) and a consent already given. */
const RESET_KEEPS = ['localBrainNotesDir', 'cloudExtractionConsent'] as const

export interface SettingsBundle {
  format: typeof BUNDLE_FORMAT
  version: number
  exportedAt: string
  appVersion: string
  files: Partial<Record<BundledFile, unknown>>
}

function readJsonIfPresent(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Collect the operator's configuration files into one JSON document. */
export function buildSettingsBundle(userDataDir: string, appVersion: string, now: Date = new Date()): SettingsBundle {
  const files: SettingsBundle['files'] = {}
  for (const name of BUNDLED_FILES) {
    const data = readJsonIfPresent(join(userDataDir, name))
    if (data === undefined) continue
    if (name === 'settings.json') {
      const trimmed: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        if (!SKIPPED_SETTINGS_KEYS.has(k)) trimmed[k] = v
      }
      files[name] = trimmed
    } else {
      files[name] = data
    }
  }
  return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: now.toISOString(), appVersion, files }
}

/** Parse and validate a bundle. Throws an Error whose message is fit to show. */
export function parseSettingsBundle(text: string): SettingsBundle {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('That file is not valid JSON.')
  }
  const b = parsed as Partial<SettingsBundle> | null
  if (!b || typeof b !== 'object' || b.format !== BUNDLE_FORMAT) {
    throw new Error('That file is not a DUIN settings export.')
  }
  if (typeof b.version !== 'number' || b.version > BUNDLE_VERSION) {
    throw new Error('That settings export comes from a newer DUIN; update DUIN first.')
  }
  if (!b.files || typeof b.files !== 'object') throw new Error('That settings export holds no files.')
  const files: SettingsBundle['files'] = {}
  for (const name of BUNDLED_FILES) {
    const data = (b.files as Record<string, unknown>)[name]
    if (data && typeof data === 'object' && !Array.isArray(data)) files[name] = data
  }
  return {
    format: BUNDLE_FORMAT,
    version: b.version,
    exportedAt: typeof b.exportedAt === 'string' ? b.exportedAt : '',
    appVersion: typeof b.appVersion === 'string' ? b.appVersion : '',
    files
  }
}

export interface ApplyBundleResult {
  /** Files written, by name. */
  applied: BundledFile[]
  /** settings.json keys the schema refused (a hand-edited export), each with a reason. */
  refused: string[]
  /** True when the bundle's vault folder does not exist here and the current one was kept. */
  keptVaultPath: boolean
  /** True when a file other than settings.json changed: those stores load once at boot. */
  restartNeeded: boolean
}

/** Write a bundle over the current files. settings.json is merged through the schema
 *  guard; the other three are replaced whole. */
export function applySettingsBundle(userDataDir: string, bundle: SettingsBundle): ApplyBundleResult {
  const applied: BundledFile[] = []
  const refused: string[] = []
  let keptVaultPath = false

  const incoming = bundle.files['settings.json'] as Record<string, unknown> | undefined
  if (incoming) {
    const settingsPath = join(userDataDir, 'settings.json')
    const current = readSettingsFile(settingsPath).data
    const candidate: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(incoming)) {
      if (SKIPPED_SETTINGS_KEYS.has(k)) continue
      candidate[k] = v
    }
    // A vault folder that is not on this machine must not replace one that is: the app
    // would boot into onboarding with the operator's real notes one setting away.
    const vault = candidate.localBrainNotesDir
    if (typeof vault === 'string' && vault.trim() && !existsSync(vault)) {
      delete candidate.localBrainNotesDir
      keptVaultPath = true
    }
    const guarded = guardSettingsPartial(candidate)
    refused.push(...guarded.rejected.map((r) => r.reason))
    writeSettingsFile(settingsPath, { ...current, ...guarded.accepted })
    applied.push('settings.json')
  }

  for (const name of BUNDLED_FILES) {
    if (name === 'settings.json') continue
    const data = bundle.files[name]
    if (!data) continue
    atomicWriteFileSync(join(userDataDir, name), JSON.stringify(data, null, 2))
    applied.push(name)
  }

  return { applied, refused, keptVaultPath, restartNeeded: applied.some((f) => f !== 'settings.json') }
}

/** Put settings.json back to defaults, keeping only the vault pointer and a given consent. */
export function resetSettingsFile(userDataDir: string): { kept: string[] } {
  const settingsPath = join(userDataDir, 'settings.json')
  const current = readSettingsFile(settingsPath).data
  const next: Record<string, unknown> = {}
  const kept: string[] = []
  for (const key of RESET_KEEPS) {
    if (key in current) {
      next[key] = current[key]
      kept.push(key)
    }
  }
  writeSettingsFile(settingsPath, next)
  return { kept }
}

/** Side-cars a torn settings.json left behind, newest first. */
export function listCorruptSidecars(userDataDir: string): string[] {
  if (!existsSync(userDataDir)) return []
  return readdirSync(userDataDir)
    .filter((f) => /^settings\.corrupt-.*\.json$/.test(f))
    .sort()
    .reverse()
    .map((f) => join(userDataDir, f))
}
