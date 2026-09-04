import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  applySettingsBundle,
  buildSettingsBundle,
  listCorruptSidecars,
  parseSettingsBundle,
  resetSettingsFile
} from './settings-bundle'

// Portability of the four plain-JSON configuration files (settings evaluation D4).
// keys.json never travels (safeStorage is bound to the OS user) and windowBounds never
// travels (machine-specific); everything else round-trips.

let dir: string
const readJson = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir, name), 'utf-8'))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duin-bundle-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('buildSettingsBundle', () => {
  it('collects the files that exist, strips windowBounds, and never touches keys.json', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ fontSize: 16, windowBounds: { x: 1 }, localBrainNotesDir: dir }))
    writeFileSync(join(dir, 'channels.json'), JSON.stringify({ telegram: { enabled: true } }))
    writeFileSync(join(dir, 'keys.json'), JSON.stringify({ deepseek: 'ciphertext' }))
    const b = buildSettingsBundle(dir, '0.8.0', new Date('2026-09-03T00:00:00Z'))
    expect(b.format).toBe('duin-settings-bundle')
    expect(b.exportedAt).toBe('2026-09-03T00:00:00.000Z')
    expect(b.files['settings.json']).toEqual({ fontSize: 16, localBrainNotesDir: dir })
    expect(b.files['channels.json']).toEqual({ telegram: { enabled: true } })
    expect(b.files['pairings.json']).toBeUndefined()
    expect(JSON.stringify(b)).not.toContain('ciphertext')
  })
})

describe('parseSettingsBundle', () => {
  it('rejects non-JSON, a foreign file, and a newer version with sentences fit to show', () => {
    expect(() => parseSettingsBundle('{')).toThrow('not valid JSON')
    expect(() => parseSettingsBundle(JSON.stringify({ hello: 1 }))).toThrow('not a DUIN settings export')
    expect(() => parseSettingsBundle(JSON.stringify({ format: 'duin-settings-bundle', version: 99, files: {} }))).toThrow(
      'newer DUIN'
    )
  })

  it('keeps only the bundled files it knows', () => {
    const b = parseSettingsBundle(
      JSON.stringify({ format: 'duin-settings-bundle', version: 1, files: { 'settings.json': { fontSize: 12 }, 'evil.json': { a: 1 } } })
    )
    expect(Object.keys(b.files)).toEqual(['settings.json'])
  })
})

describe('applySettingsBundle', () => {
  it('merges settings through the schema guard and replaces the other files whole', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ fontSize: 14, minimizeToTray: true }))
    const r = applySettingsBundle(dir, {
      format: 'duin-settings-bundle',
      version: 1,
      exportedAt: '',
      appVersion: '',
      files: {
        'settings.json': { fontSize: 18, bogusKey: 1, windowBounds: { x: 9 } },
        'pairings.json': { approved: [] }
      }
    })
    expect(r.applied).toEqual(['settings.json', 'pairings.json'])
    expect(r.refused).toEqual(['bogusKey is not a setting DUIN knows'])
    expect(r.restartNeeded).toBe(true)
    expect(readJson('settings.json')).toEqual({ fontSize: 18, minimizeToTray: true })
    expect(readJson('pairings.json')).toEqual({ approved: [] })
  })

  it('keeps the current vault folder when the bundle points at one that is not on this machine', () => {
    const vault = join(dir, 'vault')
    mkdirSync(vault)
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ localBrainNotesDir: vault }))
    const r = applySettingsBundle(dir, {
      format: 'duin-settings-bundle',
      version: 1,
      exportedAt: '',
      appVersion: '',
      files: { 'settings.json': { localBrainNotesDir: 'Z:\\nowhere\\brain', fontSize: 15 } }
    })
    expect(r.keptVaultPath).toBe(true)
    expect(r.restartNeeded).toBe(false)
    expect(readJson('settings.json')).toEqual({ localBrainNotesDir: vault, fontSize: 15 })
  })
})

describe('resetSettingsFile', () => {
  it('keeps the vault pointer and a given consent, drops everything else', () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ localBrainNotesDir: dir, cloudExtractionConsent: true, fontSize: 20, providerPolicy: { order: ['x'] } })
    )
    const r = resetSettingsFile(dir)
    expect(r.kept).toEqual(['localBrainNotesDir', 'cloudExtractionConsent'])
    expect(readJson('settings.json')).toEqual({ localBrainNotesDir: dir, cloudExtractionConsent: true })
  })
})

describe('listCorruptSidecars', () => {
  it('lists settings.corrupt-*.json newest first and nothing else', () => {
    writeFileSync(join(dir, 'settings.corrupt-2026-09-01T00-00-00-000Z.json'), '{')
    writeFileSync(join(dir, 'settings.corrupt-2026-09-03T00-00-00-000Z.json'), '{')
    writeFileSync(join(dir, 'settings.json'), '{}')
    const list = listCorruptSidecars(dir)
    expect(list.map((p) => p.slice(dir.length + 1))).toEqual([
      'settings.corrupt-2026-09-03T00-00-00-000Z.json',
      'settings.corrupt-2026-09-01T00-00-00-000Z.json'
    ])
    expect(existsSync(join(dir, 'settings.json'))).toBe(true)
  })
})
