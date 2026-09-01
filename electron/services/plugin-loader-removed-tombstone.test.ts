// plugin-loader-removed-tombstone.test.ts — a removed bundled plugin must
// stay removed across relaunches.
//
// The defect: ensurePluginsRoot() (the bootstrap step both
// initializePluginLoader and getPluginsRoot run on every launch) copies any
// bundled entry whose userland directory is missing. removePlugin() deletes
// that directory outright — and its plugins.json enabled-state entry — so
// after a user removes a bundled plugin, the very next launch sees "no
// directory" and treats that as "never seeded", silently recreating it
// (enabled, since the record that would have marked it disabled is gone
// too). The top-of-file module comment already claims "Subsequent runs read
// userland only; bundled is the seed, not a live source" — the bug is that
// nothing in the code actually enforced that; every launch behaved like a
// first run.
//
// Mocking follows plugin-loader-manifest-guard.test.ts's established
// pattern (mock electron + is.dev, point resolvePluginsRoot's packaged-mode
// branch at a temp dir). Unlike that file, bundled and userland roots are
// kept as two DIFFERENT temp dirs here — the bug only reproduces when
// ensurePluginsRoot's copy loop actually runs, which it skips whenever
// resolve(bundled) === resolve(root).
//
// "Relaunch" is simulated with shutdownPluginLoader() + getPluginsRoot():
// the latter is the same lazy-bootstrap entry point initializePluginLoader
// uses, and calling it directly avoids starting chokidar's watcher, which
// every other loader test in this repo also avoids (see
// slash-commands.test.ts's comment on the same tradeoff).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''
let resourcesDir = ''

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

import {
  getPlugin,
  getPluginsRoot,
  installBundled,
  removePlugin,
  shutdownPluginLoader,
  __pluginLoaderTest
} from './plugin-loader'

const { readRemovedPlugins } = __pluginLoaderTest

const ORIGINAL_RESOURCES_PATH = (process as unknown as { resourcesPath?: string }).resourcesPath

function writeBundledPlugin(id: string): void {
  const dir = join(resourcesDir, 'plugins', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({ id, name: id, description: '', version: '1.0.0' }),
    'utf-8'
  )
}

function userPluginDir(id: string): string {
  return join(userDataDir, 'plugins', id)
}

/** Resets the module's cached pluginsRoot so the next getPluginsRoot() call
 *  re-runs ensurePluginsRoot from scratch, the same as a fresh app process. */
function simulateRelaunch(): void {
  shutdownPluginLoader()
}

describe('ensurePluginsRoot — removed bundled plugins stay removed', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'duin-plugin-loader-userdata-'))
    resourcesDir = mkdtempSync(join(tmpdir(), 'duin-plugin-loader-resources-'))
    ;(process as unknown as { resourcesPath: string }).resourcesPath = resourcesDir
  })

  afterEach(() => {
    shutdownPluginLoader()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(resourcesDir, { recursive: true, force: true })
    if (ORIGINAL_RESOURCES_PATH === undefined) {
      delete (process as unknown as { resourcesPath?: string }).resourcesPath
    } else {
      ;(process as unknown as { resourcesPath: string }).resourcesPath = ORIGINAL_RESOURCES_PATH
    }
  })

  it('does not resurrect a plugin the user explicitly removed, across a simulated relaunch', () => {
    writeBundledPlugin('starter-notes')

    // "First launch": installBundled both seeds the whole bundled catalog
    // (via getPluginsRoot -> ensurePluginsRoot, same as a real first run)
    // and scans it into the live registry so removePlugin has something to
    // act on.
    expect(installBundled('starter-notes')).toEqual({ ok: true, id: 'starter-notes' })
    expect(existsSync(userPluginDir('starter-notes'))).toBe(true)
    expect(getPlugin('starter-notes')).toBeDefined()

    // User removes it.
    expect(removePlugin('starter-notes')).toBe(true)
    expect(existsSync(userPluginDir('starter-notes'))).toBe(false)
    expect(readRemovedPlugins().has('starter-notes')).toBe(true)

    // "Second launch": the exact bootstrap call initializePluginLoader makes
    // on every start (getPluginsRoot short-circuits once pluginsRoot is
    // cached, so it must be cleared first to reproduce a fresh process).
    simulateRelaunch()
    getPluginsRoot()

    expect(existsSync(userPluginDir('starter-notes'))).toBe(false)
  })

  it('still seeds a bundled plugin the user never installed or removed', () => {
    writeBundledPlugin('starter-notes')
    writeBundledPlugin('second-plugin') // simulates a plugin new in this app version

    getPluginsRoot() // first-ever launch bootstrap

    expect(existsSync(userPluginDir('starter-notes'))).toBe(true)
    expect(existsSync(userPluginDir('second-plugin'))).toBe(true)
  })

  it('still fills in a new file added to an already-installed plugin (upgrade merge)', () => {
    writeBundledPlugin('starter-notes')
    getPluginsRoot()
    expect(existsSync(userPluginDir('starter-notes'))).toBe(true)

    // App upgrade ships a new sibling file inside the still-installed
    // plugin's bundled directory.
    writeFileSync(join(resourcesDir, 'plugins', 'starter-notes', 'README.md'), 'docs', 'utf-8')

    simulateRelaunch()
    getPluginsRoot()

    expect(readFileSync(join(userPluginDir('starter-notes'), 'README.md'), 'utf-8')).toBe('docs')
  })

  it('installBundled clears the tombstone so a later external re-removal is not permanently stuck', () => {
    writeBundledPlugin('starter-notes')
    expect(installBundled('starter-notes')).toEqual({ ok: true, id: 'starter-notes' })
    expect(removePlugin('starter-notes')).toBe(true)
    expect(readRemovedPlugins().has('starter-notes')).toBe(true)

    // Explicit reinstall from the "bundled catalog" UI action.
    expect(installBundled('starter-notes')).toEqual({ ok: true, id: 'starter-notes' })
    expect(readRemovedPlugins().has('starter-notes')).toBe(false)
  })
})
