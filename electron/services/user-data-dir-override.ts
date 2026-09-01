// user-data-dir-override — run a second, isolated DUIN beside an installed one (QA / release
// rehearsal). Env-only, no settings surface: DUIN_USER_DATA_DIR=<absolute path>.
//
// Electron keys the single-instance lock on the `userData` path, and every store, ledger and
// the SQLite file resolve from it, so redirecting `userData` (and `sessionData`, which holds the
// Chromium cache/cookies and defaults to `userData`) BEFORE the first consumer runs is what makes
// two instances coexist without sharing a lock, a DB or a cache. `app.setPath` throws when the
// directory does not exist, so it is created first.
import { mkdirSync } from 'fs'
import { isAbsolute } from 'path'

/** The slice of Electron's `app` this needs; a test seam. */
export interface PathSettableApp {
  setPath(name: string, path: string): void
}

/**
 * Apply the override. Returns the directory that was applied, or null when the variable is
 * unset, blank, or not an absolute path (a relative path would resolve against whatever cwd the
 * launcher happened to use, which is exactly the ambiguity an isolation flag must not have).
 */
export function applyUserDataDirOverride(
  app: PathSettableApp,
  raw: string | undefined,
  ensureDir: (dir: string) => void = (dir) => mkdirSync(dir, { recursive: true })
): string | null {
  const dir = (raw ?? '').trim()
  if (!dir || !isAbsolute(dir)) return null
  ensureDir(dir)
  app.setPath('userData', dir)
  app.setPath('sessionData', dir)
  return dir
}
