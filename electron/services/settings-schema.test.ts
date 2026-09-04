import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { DEFAULT_APP_SETTINGS } from './default-app-settings'
import { guardSettingsPartial, KNOWN_SETTINGS_KEYS, OPTIONAL_SETTINGS_KEYS } from './settings-schema'

// settings:set used to accept any key with any value. These pin the guard that replaced
// that, and — more importantly — pin the allowlist against the two places keys are
// declared, so a key added to AppSettings without being added here fails HERE, with the
// key named, instead of being silently refused at runtime.

const repoRoot = join(__dirname, '..', '..')

/** `key` / `key?` members of the `export interface AppSettings { … }` block. */
function appSettingsKeys(): string[] {
  const src = readFileSync(join(repoRoot, 'src', 'lib', 'types.ts'), 'utf-8')
  const start = src.indexOf('export interface AppSettings {')
  expect(start, 'AppSettings interface not found').toBeGreaterThan(-1)
  const body = src.slice(start, src.indexOf('\n}', start))
  return Array.from(body.matchAll(/^ {2}([A-Za-z_]\w*)\??:/gm)).map((m) => m[1])
}

describe('guardSettingsPartial', () => {
  it('accepts a known key with a value of the default kind', () => {
    const r = guardSettingsPartial({ minimizeToTray: true, fontSize: 16, language: 'zh' })
    expect(r.rejected).toEqual([])
    expect(r.accepted).toEqual({ minimizeToTray: true, fontSize: 16, language: 'zh' })
  })

  it('refuses a key DUIN does not know, naming it', () => {
    const r = guardSettingsPartial({ minimiseToTray: true })
    expect(r.accepted).toEqual({})
    expect(r.rejected).toEqual([{ key: 'minimiseToTray', reason: 'minimiseToTray is not a setting DUIN knows' }])
  })

  it('refuses a known key whose value is the wrong kind, and still accepts the rest', () => {
    const r = guardSettingsPartial({ fontSize: '16', autoCheckUpdates: false })
    expect(r.accepted).toEqual({ autoCheckUpdates: false })
    expect(r.rejected).toEqual([{ key: 'fontSize', reason: 'fontSize must be number, got string' }])
  })

  it('tells an array from an object and null from either', () => {
    expect(guardSettingsPartial({ sandboxWritePaths: {} }).rejected[0]?.reason).toBe(
      'sandboxWritePaths must be array, got object'
    )
    expect(guardSettingsPartial({ watchers: null }).rejected[0]?.reason).toBe('watchers must be object, got null')
    expect(guardSettingsPartial({ watchers: { ...DEFAULT_APP_SETTINGS.watchers, task: true } }).rejected).toEqual([])
  })

  it('accepts optional keys with any value, since they have no default to compare against', () => {
    const r = guardSettingsPartial({ reasoningEffort: 'high', windowBounds: { x: 1, y: 2, width: 3, height: 4 } })
    expect(r.rejected).toEqual([])
    expect(Object.keys(r.accepted)).toEqual(['reasoningEffort', 'windowBounds'])
  })
})

describe('the allowlist matches the declared schema', () => {
  it('knows every key of the renderer AppSettings interface', () => {
    const missing = appSettingsKeys().filter((k) => !KNOWN_SETTINGS_KEYS.has(k))
    expect(missing, `add to OPTIONAL_SETTINGS_KEYS or DEFAULT_APP_SETTINGS: ${missing.join(', ')}`).toEqual([])
  })

  it('lists as optional only keys that really have no default', () => {
    const withDefault = OPTIONAL_SETTINGS_KEYS.filter((k) => k in DEFAULT_APP_SETTINGS)
    expect(withDefault, 'these now have a default; drop them from OPTIONAL_SETTINGS_KEYS').toEqual([])
    const declared = new Set(appSettingsKeys())
    const undeclared = OPTIONAL_SETTINGS_KEYS.filter((k) => !declared.has(k))
    expect(undeclared, 'these are not in AppSettings any more').toEqual([])
  })

  it('every literal key the renderer writes through updateSettings is known', () => {
    // Best-effort: `updateSettings({ key` / `settings.set({ key` with a literal first key.
    // Calls that spread a variable are not seen here; the runtime guard still covers them.
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p)
      }
    }
    walk(join(repoRoot, 'src'))
    const unknown = new Set<string>()
    for (const file of files) {
      const src = readFileSync(file, 'utf-8')
      for (const m of src.matchAll(/(?:updateSettings|settings\.set)\(\s*\{\s*([A-Za-z_]\w*)\s*[:,}]/g)) {
        if (!KNOWN_SETTINGS_KEYS.has(m[1])) unknown.add(`${m[1]} (${file.slice(repoRoot.length + 1)})`)
      }
    }
    expect([...unknown]).toEqual([])
  })
})
