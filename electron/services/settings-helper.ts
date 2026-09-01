import { join } from 'path'
import { app } from 'electron'
import { readSettingsFile, writeSettingsFile } from './settings-file'

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

export function readSettings(): Record<string, unknown> {
  return readSettingsFile(settingsPath()).data
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
