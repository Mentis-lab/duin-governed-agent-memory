// plugin-loader-manifest-guard.test.ts — installFromManifest's files/plugin.json guard.
//
// The defect: installFromManifest validates `manifest.id` (kebab-case, not
// already installed) and writes a SANITIZED plugin.json built only from that
// validated manifest — then let a `files` entry write straight over that same
// file with unvalidated content. The function still returned
// `{ ok: true, id: manifest.id }` (the id it validated), but scanAll()'s
// rescan reads the id back OFF DISK, so the plugin actually registered under
// whatever id the pasted files['plugin.json'] carried. The validated id and
// the registered id silently diverged — a install-guard bypass invisible from
// the return value alone.
//
// installFromManifest resolves its plugin root through app.getPath('userData')
// (resolvePluginsRoot's packaged-mode branch) — mocked here to a fresh temp
// dir per test, the same technique skill-loader-seed.test.ts uses for the
// sibling loader. is.dev is forced false so that branch (rather than the
// dev-mode __dirname-relative one, which would otherwise point at this repo's
// real resources/plugins) is the one exercised. process.resourcesPath is
// pointed at the SAME temp dir so bundledPluginsRoot() coincides with it and
// ensurePluginsRoot's bootstrap-copy step is a no-op — mirroring the
// short-circuit resolvePluginsRoot's own dev-mode branch relies on when
// bundled and root are the same directory.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

import { getPlugin, installFromManifest, shutdownPluginLoader } from './plugin-loader'

const ORIGINAL_RESOURCES_PATH = (process as unknown as { resourcesPath?: string }).resourcesPath

function onDiskManifestPath(id: string): string {
  return join(userDataDir, 'plugins', id, 'plugin.json')
}

describe('installFromManifest — files cannot smuggle a replacement plugin.json', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'duin-plugin-loader-test-'))
    ;(process as unknown as { resourcesPath: string }).resourcesPath = userDataDir
  })

  afterEach(() => {
    shutdownPluginLoader()
    rmSync(userDataDir, { recursive: true, force: true })
    if (ORIGINAL_RESOURCES_PATH === undefined) {
      delete (process as unknown as { resourcesPath?: string }).resourcesPath
    } else {
      ;(process as unknown as { resourcesPath: string }).resourcesPath = ORIGINAL_RESOURCES_PATH
    }
  })

  it('rejects install rather than letting files["plugin.json"] override the validated id', () => {
    const result = installFromManifest(
      { id: 'good-id', name: 'Good', description: 'ok', version: '1.0.0' },
      {
        'plugin.json': JSON.stringify({
          id: 'evil-id',
          name: 'Evil',
          description: 'spoofed',
          version: '9.9.9'
        })
      }
    )

    expect(result.ok).toBe(false)
    // Neither identity gets to register: the call errors before scanAll()
    // runs, so nothing lands in the in-memory registry under either id.
    expect(getPlugin('good-id')).toBeUndefined()
    expect(getPlugin('evil-id')).toBeUndefined()
    // And the sanitized manifest installFromManifest itself wrote is still
    // sitting on disk untouched — proof this is a rejection, not a silent
    // partial success wearing an error return.
    const onDisk = JSON.parse(readFileSync(onDiskManifestPath('good-id'), 'utf-8'))
    expect(onDisk).toMatchObject({ id: 'good-id', name: 'Good' })
  })

  it.each(['plugin.json', './plugin.json', './/plugin.json', 'Plugin.JSON', '/plugin.json'])(
    'gates the key %s the same way join() would land it on the manifest',
    (key) => {
      const result = installFromManifest(
        { id: 'good-id', name: 'Good', description: '', version: '1.0.0' },
        { [key]: JSON.stringify({ id: 'evil-id', name: 'Evil', description: '', version: '1.0.0' }) }
      )
      expect(result.ok).toBe(false)
      expect(getPlugin('evil-id')).toBeUndefined()
    }
  )

  it('still installs normally when files carries only sibling assets', () => {
    const result = installFromManifest(
      { id: 'good-id', name: 'Good', description: 'ok', version: '1.0.0' },
      { 'skills/note.md': '# hello', 'README.md': 'docs' }
    )

    expect(result).toEqual({ ok: true, id: 'good-id' })
    expect(getPlugin('good-id')?.manifest).toMatchObject({ id: 'good-id', name: 'Good' })
  })

  it('does not gate a nested file that merely happens to be named plugin.json', () => {
    const result = installFromManifest(
      { id: 'good-id', name: 'Good', description: '', version: '1.0.0' },
      { 'nested/plugin.json': '{"not":"the manifest"}' }
    )

    expect(result).toEqual({ ok: true, id: 'good-id' })
    expect(existsSync(join(userDataDir, 'plugins', 'good-id', 'nested', 'plugin.json'))).toBe(true)
  })
})
