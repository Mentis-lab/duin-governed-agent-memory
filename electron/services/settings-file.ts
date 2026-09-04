import { existsSync, readFileSync, renameSync } from 'fs'
import { basename, dirname, join } from 'path'
import { atomicWriteFileSync } from './atomic-write'

/**
 * The single read/write choke point for `userData/settings.json`.
 *
 * Why this module exists — the amplifier it closes:
 *
 * Five separate modules (ipc/model.ts, ipc/settings.ts, ipc/github.ts,
 * ipc/onboarding.ts, services/settings-helper.ts) each had their own private
 * copy of the same read-modify-write pair, and every one of them collapsed
 * "file absent" and "file present but unparseable" into the SAME return value
 * (`{}` / bare defaults). The very next write then serialized that near-empty
 * object over the whole file.
 *
 * A torn write leaves a valid-JSON PREFIX on disk, so after a crash, a power
 * loss, an ENOSPC (writeFileSync opens O_TRUNC before writing), or two handlers
 * interleaving, most of the user's config is still physically there and
 * hand-recoverable. The catch->{} read followed by the whole-object write is
 * precisely what converted recoverable-partial into unrecoverable-total:
 * ~1680 bytes of residue down to ~34, with `success: true` returned and
 * nothing logged. It fired with no user intent at all — main.ts's
 * schedulePersistBounds patches `windowBounds` on a 500ms debounce after any
 * window move or resize.
 *
 * The destroyed keys are not a rebuildable cache: `customModels` (hand-entered
 * id/provider/contextWindow per model), `localBrainNotesDir` (the vault path —
 * the brain then points nowhere), rssFeeds, watchers, operator, homeChannel,
 * modelConfig, agenticCodingSkills. (API keys are safe; they live in the
 * keychain, which already writes atomically.)
 *
 * Two fixes, both reusing machinery that already existed in the tree:
 *
 * 1. `readSettingsFile` reports `state` so callers can tell 'absent' from
 *    'corrupt'. `writeSettingsFile` refuses to silently overwrite a corrupt
 *    file: it first renames it to a timestamped side-car
 *    (`settings.corrupt-<ts>.json`) and logs. The prior bytes are preserved and
 *    the alteration is traceable (what changed, when, where it went) rather
 *    than the write being refused outright — the app stays usable and the
 *    residue stays recoverable.
 *
 * 2. Writes go through `atomicWriteFileSync`, exactly as that module's own
 *    docstring already instructs by name for this very file ("keys.json ...
 *    settings.json, the MCP config — that torn write is catastrophic ... Use
 *    this instead of writeFileSync for those files"). 22 other call sites
 *    already did; all five settings writers were the holdouts, which is what
 *    made the corrupt precondition reachable in the first place.
 *
 * Takes the path as an argument rather than importing electron's `app` so the
 * behaviour is directly testable and so the existing per-module path resolvers
 * (which differ — settings-helper tolerates a missing `app` under vitest) keep
 * working unchanged.
 */

export type SettingsFileState = 'absent' | 'ok' | 'corrupt'

export interface SettingsFileRead {
  /** 'absent' = nothing to lose. 'corrupt' = present but unparseable — there IS
   *  something to lose, so a blind overwrite is data destruction. */
  state: SettingsFileState
  /** Parsed object for 'ok'; an empty object for 'absent' and 'corrupt' so
   *  existing readers that only want values keep working. */
  data: Record<string, unknown>
}

/** Read + classify. Never throws. */
export function readSettingsFile(path: string): SettingsFileRead {
  if (!path || !existsSync(path)) return { state: 'absent', data: {} }
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    // Present on disk but unreadable (permissions, a directory, an I/O error).
    // Same hazard class as unparseable: there is content we must not clobber.
    return { state: 'corrupt', data: {} }
  }
  try {
    const parsed = JSON.parse(raw)
    // A top-level array/string/number is not a settings object; spreading it
    // would silently produce garbage, so treat it as corrupt too.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { state: 'corrupt', data: {} }
    }
    return { state: 'ok', data: parsed as Record<string, unknown> }
  } catch {
    return { state: 'corrupt', data: {} }
  }
}

/**
 * Move an unparseable settings file aside to a timestamped side-car, preserving
 * the bytes for hand-recovery. Returns the side-car path, or null if it could
 * not be moved (in which case the caller must NOT overwrite).
 */
export function quarantineCorruptSettings(path: string): string | null {
  const dir = dirname(path)
  const stem = basename(path).replace(/\.json$/i, '')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (let attempt = 0; attempt < 50; attempt++) {
    const suffix = attempt === 0 ? '' : `-${attempt}`
    const sidecar = join(dir, `${stem}.corrupt-${stamp}${suffix}.json`)
    if (existsSync(sidecar)) continue
    try {
      renameSync(path, sidecar)
      return sidecar
    } catch {
      return null
    }
  }
  return null
}

/**
 * Crash-safe settings write that never destroys an unrecoverable-by-any-other-
 * means corrupt file.
 *
 * If the on-disk file is present but unparseable, its bytes are side-cared
 * (preserve + record + stamp) and the event is logged BEFORE the new content is
 * written. If the side-car cannot be created, the write is skipped and an error
 * is thrown rather than overwriting the only copy.
 */
export function writeSettingsFile(path: string, next: Record<string, unknown>): void {
  if (!path) return
  if (readSettingsFile(path).state === 'corrupt') {
    const sidecar = quarantineCorruptSettings(path)
    if (!sidecar) {
      throw new Error(
        `Refusing to overwrite unreadable settings file ${path}: it could not be moved aside, ` +
          `and overwriting it would destroy the only recoverable copy of your settings.`
      )
    }
    console.error(
      `[settings] ${path} was present but unparseable (likely a torn write). ` +
        `Preserved the previous bytes at ${sidecar} before writing fresh settings. ` +
        `Recover any lost keys (customModels, localBrainNotesDir, ...) from that file.`
    )
  }
  atomicWriteFileSync(path, JSON.stringify(next, null, 2))
}

// ── Provider-policy migration (cohesion build P0, plan §2.1 W3) ────────────────────────────────
//
// `defaultModel`, `backgroundModel` and `brainEngine` stored MODEL IDS as preferences. A stored
// model id is a claim the account is funded and the id still exists; the 2026-09-02 evaluation
// found the stored default dead for a week with nothing saying so (S2). The replacement is a
// PROVIDER preference (`providerPolicy`, roles.ts) resolved against live health at call time.
//
// Pure so it is testable without electron: the two lookups it needs from the catalog are injected.
// Idempotent by construction — a second pass over its own output changes nothing.

export interface LegacyModelSettingsDeps {
  /** Provider owning a model id, or null when the id is unknown / the brain connector. */
  providerOf: (modelId: string) => string | null
  /** Every provider with a stored key, in catalog order. */
  keyedProviders: () => string[]
}

export const LEGACY_MODEL_SETTING_KEYS = ['defaultModel', 'backgroundModel', 'brainEngine'] as const

/**
 * Seed `providerPolicy` from the three legacy keys (only when no policy is stored yet), then
 * delete the keys. Returns the migrated object and whether anything changed. Seeding rules:
 *   order            = [provider of brainEngine (a real id), else of defaultModel, then every other
 *                       keyed provider in catalog order]; empty when nothing resolves — an empty
 *                       order means "every keyed provider in catalog order", computed at resolve time
 *   roles.extraction = [provider of backgroundModel] when it was a pinned id that resolves
 *   localOnlyBackground = false; speed = 'fast'
 */
export function migrateLegacyModelSettings(
  data: Record<string, unknown>,
  deps: LegacyModelSettingsDeps
): { data: Record<string, unknown>; changed: boolean } {
  const present = LEGACY_MODEL_SETTING_KEYS.filter((k) => k in data)
  if (present.length === 0) return { data, changed: false }
  const next: Record<string, unknown> = { ...data }
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  if (!('providerPolicy' in data) || !data.providerPolicy || typeof data.providerPolicy !== 'object') {
    const engine = str(data.brainEngine)
    const def = str(data.defaultModel)
    const first =
      (engine && engine !== 'auto' ? deps.providerOf(engine) : null) ??
      (def && def !== 'duin-brain' ? deps.providerOf(def) : null)
    const keyed = deps.keyedProviders()
    const order = first ? [first, ...keyed.filter((p) => p !== first)] : [...keyed]
    const bg = str(data.backgroundModel)
    const bgProvider = bg && bg !== 'auto' ? deps.providerOf(bg) : null
    next.providerPolicy = {
      order,
      roles: bgProvider ? { extraction: [bgProvider] } : {},
      localOnlyBackground: false,
      // The evaluation's chat pick was the flash tier (L6 §4); a migrated install starts there.
      speed: 'fast'
    }
  }
  for (const k of present) delete next[k]
  return { data: next, changed: true }
}
