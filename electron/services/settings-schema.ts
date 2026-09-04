import { DEFAULT_APP_SETTINGS } from './default-app-settings'

// What settings:set is allowed to write.
//
// Until the 2026-09-03 settings evaluation (D5) the renderer could persist ANY top-level
// key with ANY value: the sanitizer stripped only prototype-pollution names, so a typo'd
// key or a string where a boolean belonged landed on disk, came back through settings:get,
// and every reader coped (or did not) on its own. The shape of the file is now stated in
// one place and checked on the way in. A key that is not known, or a known key with a
// value of the wrong kind, is REFUSED — loudly, with the key named — because our own
// renderer is the only writer and a surprise here is a bug we want to see, not absorb.

/** AppSettings keys that have no entry in DEFAULT_APP_SETTINGS (absent = unset). */
export const OPTIONAL_SETTINGS_KEYS = [
  'agentTone',
  'agentToneCustom',
  'mcpCallTimeoutMs',
  'reasoningEffort',
  'streamInactivityMs',
  'toolResultSpill',
  'toolResultSpillBytes',
  'windowBounds'
] as const

/** Blocks other main-side owners keep in the same file; not part of AppSettings. */
export const OWNED_BLOB_KEYS = ['currentInfo', 'webTools', 'imageGen', 'githubMode', 'defaultHooksSeeded'] as const

export const KNOWN_SETTINGS_KEYS: ReadonlySet<string> = new Set<string>([
  ...Object.keys(DEFAULT_APP_SETTINGS),
  ...OPTIONAL_SETTINGS_KEYS,
  ...OWNED_BLOB_KEYS
])

export interface SettingsRejection {
  key: string
  reason: string
}

export interface GuardedPartial {
  /** The keys that passed, in the order they were given. */
  accepted: Record<string, unknown>
  /** The keys that did not, each with a sentence an operator can act on. */
  rejected: SettingsRejection[]
}

export function settingsValueKind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Check a renderer-supplied partial against the schema. Keys with a default must carry
 * a value of the default's kind (boolean / number / string / array / object); optional
 * keys and owned blobs only have to be known. Nothing here mutates the input.
 */
export function guardSettingsPartial(
  partial: Record<string, unknown>,
  defaults: Record<string, unknown> = DEFAULT_APP_SETTINGS as unknown as Record<string, unknown>
): GuardedPartial {
  const accepted: Record<string, unknown> = {}
  const rejected: SettingsRejection[] = []
  for (const [key, value] of Object.entries(partial)) {
    if (!KNOWN_SETTINGS_KEYS.has(key)) {
      rejected.push({ key, reason: `${key} is not a setting DUIN knows` })
      continue
    }
    if (Object.prototype.hasOwnProperty.call(defaults, key)) {
      const want = settingsValueKind(defaults[key])
      const got = settingsValueKind(value)
      if (want !== got) {
        rejected.push({ key, reason: `${key} must be ${want}, got ${got}` })
        continue
      }
    }
    accepted[key] = value
  }
  return { accepted, rejected }
}
