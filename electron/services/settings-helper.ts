import { join } from 'path'
import { app } from 'electron'
import {
  readSettingsFile,
  writeSettingsFile,
  migrateLegacyModelSettings,
  type LegacyModelSettingsDeps
} from './settings-file'

// Tolerate a missing `app` (e.g. under vitest, where electron's app is undefined) so readers
// on hot paths never throw outside the main process — they just see no settings.
const settingsPath = (): string => {
  // Optional chaining alone only covers `app` being ABSENT. It does not cover `getPath` being
  // present and THROWING — which happens when it is called before app-ready, and which is exactly
  // what electron/services/rag/ingest.test.ts mocks. That escaping throw did not surface as a
  // crash; it surfaced as a document's status_detail reading "electron app not available in test
  // environment" INSTEAD of "unsupported extension" — a real failure reported as the wrong one,
  // because ocrEnabled() -> readSettings() sits on the ingest path. Honour the contract stated
  // above: a settings read on a hot path degrades to "no settings", it never throws.
  try {
    const base = (app as { getPath?: (name: string) => string } | undefined)?.getPath?.('userData')
    return base ? join(base, 'settings.json') : ''
  } catch {
    return ''
  }
}

// ── Legacy model-key migration (plan §2.1 W3) ─────────────────────────────────────────────────
//
// The migration needs two catalog lookups (which provider owns a model id; which providers are
// keyed). The catalog lives in providers/registry.ts, which imports THIS module, so the lookups
// are registered late by registry.ts at load time instead of imported here (`import-x/no-cycle`).
// Until they are registered, `readSettings` returns the file untouched — the legacy keys are
// inert to every reader that does not route models — and the first read after registry loads
// migrates and writes back ONCE per process. A file that no longer holds the keys is a no-op.
let migrationDeps: LegacyModelSettingsDeps | null = null
let migrationDone = false

/** Called by providers/registry.ts at module init. Idempotent. */
export function registerLegacyModelSettingsDeps(deps: LegacyModelSettingsDeps): void {
  migrationDeps = deps
}

/** Test seam: forget that the migration ran, so the next read re-checks the file. */
export function __resetSettingsMigrationForTest(): void {
  migrationDone = false
}

function migrateOnce(path: string, data: Record<string, unknown>): Record<string, unknown> {
  if (migrationDone || !migrationDeps || !path) return data
  migrationDone = true
  try {
    const { data: next, changed } = migrateLegacyModelSettings(data, migrationDeps)
    if (!changed) return data
    writeSettingsFile(path, next)
    console.log('[settings] migrated defaultModel/backgroundModel/brainEngine → providerPolicy')
    return next
  } catch (err) {
    console.warn('[settings] provider-policy migration skipped:', (err as Error)?.message)
    return data
  }
}

export function readSettings(): Record<string, unknown> {
  const path = settingsPath()
  const read = readSettingsFile(path)
  // Never migrate over a corrupt file: writeSettingsFile would side-car it, and a read must not
  // have that side effect. 'absent' has nothing to migrate.
  if (read.state !== 'ok') return read.data
  return migrateOnce(path, read.data)
}

/** Merge `patch` into the persisted settings.
 *
 *  Goes through `writeSettingsFile`, which side-cars a present-but-unparseable
 *  file before writing instead of serializing `{...{}, ...patch}` over it. That
 *  mattered most here: main.ts's schedulePersistBounds calls this with
 *  `windowBounds` on a 500ms debounce after any window move/resize, so a torn
 *  settings.json used to be flattened to a single key by merely nudging the
 *  DUIN window — no user intent required. */
export function patchSettings(patch: Record<string, unknown>): void {
  const path = settingsPath()
  if (!path) return
  writeSettingsFile(path, { ...readSettingsFile(path).data, ...patch })
}
