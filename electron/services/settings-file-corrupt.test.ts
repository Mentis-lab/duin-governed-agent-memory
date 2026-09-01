import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readSettingsFile, writeSettingsFile, quarantineCorruptSettings } from './settings-file'

// `fs` is mocked as a pass-through so a single test can make renameSync fail
// (the "side-car could not be created" branch). Everything else delegates to
// the real fs, so these tests still hit a real temp directory.
let failRename = false
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  return {
    ...real,
    default: real,
    renameSync: (from: string, to: string) => {
      if (failRename) throw new Error('EPERM: operation not permitted, rename')
      return real.renameSync(from, to)
    }
  }
})

// Regression guard for the settings.json corrupt-read amplifier.
//
// Every settings.json reader used to collapse 'file absent' and 'file present
// but unparseable' into the same `{}` / bare-defaults return, after which the
// very next handler write serialized that near-empty object over the whole
// file. A torn write leaves a valid-JSON PREFIX, so most of the user's config
// is still physically on disk and hand-recoverable — the catch->{} read plus
// the whole-object write is exactly what converted recoverable-partial into
// unrecoverable-total.
//
// These tests run against a real temp dir (no electron, no sqlite) so they
// genuinely execute rather than silently skipping.

let dir: string
let settingsPath: string

// A realistic torn-write residue: the writer died partway through, leaving a
// valid JSON prefix that still physically contains the hand-entered keys.
const TORN = `{
  "defaultModel": "deepseek-chat",
  "localBrainNotesDir": "D:\\\\vaults\\\\Sample-brain",
  "githubAuthMode": "oauth",
  "customModels": [
    { "id": "my-local-qwen", "name": "Qwen 72B (local)", "provider": "openai-compat", "contextWindow": 32768 },
    { "id": "house-glm", "name": "GLM 4.6 house", "provider": "zhipu", "contextWindow": 128000 }
  ],
  "webSearchProvider": "tavily",
  "currentInfo": { "enabled": true, "timezone": "As`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'settings-file-'))
  settingsPath = join(dir, 'settings.json')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const sidecars = (): string[] => readdirSync(dir).filter((f) => f.includes('.corrupt-'))

describe('readSettingsFile — absent vs corrupt are distinguishable', () => {
  it('reports absent when the file does not exist', () => {
    expect(readSettingsFile(settingsPath)).toEqual({ state: 'absent', data: {} })
  })

  it('reports ok with the parsed data', () => {
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'duin-brain' }))
    const read = readSettingsFile(settingsPath)
    expect(read.state).toBe('ok')
    expect(read.data).toEqual({ defaultModel: 'duin-brain' })
  })

  it('reports corrupt — NOT absent — for a truncated file', () => {
    writeFileSync(settingsPath, TORN)
    const read = readSettingsFile(settingsPath)
    // The whole defect was that this state was byte-identical to 'absent'.
    expect(read.state).toBe('corrupt')
    expect(read.state).not.toBe('absent')
  })

  it('reports corrupt for valid JSON that is not a settings object', () => {
    writeFileSync(settingsPath, '["not", "an", "object"]')
    expect(readSettingsFile(settingsPath).state).toBe('corrupt')
    writeFileSync(settingsPath, 'null')
    expect(readSettingsFile(settingsPath).state).toBe('corrupt')
  })
})

describe('writeSettingsFile — a corrupt file is preserved, not overwritten', () => {
  it('side-cars the torn bytes before writing, so the residue stays recoverable', () => {
    writeFileSync(settingsPath, TORN)

    // Reproduces model:setActive after a torn write: readSettings() yields {},
    // the handler sets one key, and writeSettings persists the whole object.
    const settings = readSettingsFile(settingsPath).data
    settings.defaultModel = 'glm-4.6'
    writeSettingsFile(settingsPath, settings)

    // The new file is written (the app keeps working)...
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toEqual({ defaultModel: 'glm-4.6' })

    // ...but the prior bytes were NOT destroyed. This is the assertion that
    // fails without the fix: previously the only copy was overwritten in place.
    const found = sidecars()
    expect(found).toHaveLength(1)
    const preserved = readFileSync(join(dir, found[0]), 'utf-8')
    expect(preserved).toBe(TORN)

    // The specific hand-entered, non-rebuildable keys survive in the side-car.
    expect(preserved).toContain('my-local-qwen')
    expect(preserved).toContain('house-glm')
    expect(preserved).toContain('Sample-brain')
    expect(preserved).toContain('tavily')
  })

  it('side-car name is timestamped and traceable, and the event is logged', () => {
    writeFileSync(settingsPath, TORN)
    writeSettingsFile(settingsPath, { defaultModel: 'x' })

    const found = sidecars()
    expect(found[0]).toMatch(/^settings\.corrupt-[\dTZ-]+\.json$/)
    expect(console.error).toHaveBeenCalledTimes(1)
    const logged = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]
    expect(logged).toContain('unparseable')
    expect(logged).toContain(found[0])
  })

  it('the windowBounds path (no user intent) also preserves — main.ts schedulePersistBounds', () => {
    writeFileSync(settingsPath, TORN)

    // settings-helper.patchSettings shape: merge a patch into whatever read gave.
    const patch = { windowBounds: { x: 1, y: 2, width: 3, height: 4 } }
    writeSettingsFile(settingsPath, { ...readSettingsFile(settingsPath).data, ...patch })

    expect(sidecars()).toHaveLength(1)
    expect(readFileSync(join(dir, sidecars()[0]), 'utf-8')).toBe(TORN)
  })

  it('does not side-car when the file is merely absent (nothing to lose)', () => {
    writeSettingsFile(settingsPath, { defaultModel: 'duin-brain' })
    expect(sidecars()).toHaveLength(0)
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toEqual({ defaultModel: 'duin-brain' })
  })

  it('does not side-car on a normal read-modify-write of a healthy file', () => {
    writeFileSync(settingsPath, JSON.stringify({ a: 1, customModels: [{ id: 'keep' }] }, null, 2))
    const s = readSettingsFile(settingsPath).data
    s.defaultModel = 'glm-4.6'
    writeSettingsFile(settingsPath, s)

    expect(sidecars()).toHaveLength(0)
    // And the pre-existing keys ride through untouched.
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toEqual({
      a: 1,
      customModels: [{ id: 'keep' }],
      defaultModel: 'glm-4.6'
    })
    expect(console.error).not.toHaveBeenCalled()
  })

  it('repeated corrupt writes do not clobber an earlier side-car', () => {
    writeFileSync(settingsPath, TORN)
    writeSettingsFile(settingsPath, { pass: 1 })
    writeFileSync(settingsPath, '{"second": tru')
    writeSettingsFile(settingsPath, { pass: 2 })

    const found = sidecars()
    expect(found).toHaveLength(2)
    const bodies = found.map((f) => readFileSync(join(dir, f), 'utf-8')).sort()
    expect(bodies).toEqual([TORN, '{"second": tru'].sort())
  })

  it('refuses to write rather than destroy when the side-car cannot be made', () => {
    writeFileSync(settingsPath, TORN)
    failRename = true
    try {
      expect(() => writeSettingsFile(settingsPath, { defaultModel: 'x' })).toThrow(/Refusing to overwrite/)
      // The only copy is still intact on disk.
      expect(readFileSync(settingsPath, 'utf-8')).toBe(TORN)
      expect(sidecars()).toHaveLength(0)
    } finally {
      failRename = false
    }
  })
})

describe('writeSettingsFile — crash-safe write (atomic-write.ts names settings.json by name)', () => {
  it('leaves no temp files behind and writes the full content', () => {
    writeSettingsFile(settingsPath, { defaultModel: 'duin-brain', customModels: [] })
    expect(readdirSync(dir).filter((f) => f.startsWith('.atomic-'))).toHaveLength(0)
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })
})

describe('quarantineCorruptSettings', () => {
  it('returns null when there is no file to move', () => {
    expect(quarantineCorruptSettings(settingsPath)).toBeNull()
    expect(existsSync(settingsPath)).toBe(false)
  })
})
