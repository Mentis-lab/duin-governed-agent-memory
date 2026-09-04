// defaultModel / backgroundModel / brainEngine → providerPolicy, once (P0 model plane, W3).
//
// Two layers: the PURE mapping (settings-file.ts) with the catalog lookups injected, and the
// RUNNER (settings-helper.ts) against a real temp settings.json — the file is rewritten once,
// the legacy keys are gone afterwards, and a second read changes nothing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userDataDir = mkdtempSync(join(tmpdir(), 'duin-policy-migration-'))

vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData') return userDataDir
      throw new Error(`unexpected getPath("${which}") in test`)
    }
  }
}))

import { migrateLegacyModelSettings, type LegacyModelSettingsDeps } from './settings-file'
import { readSettings, registerLegacyModelSettingsDeps, __resetSettingsMigrationForTest } from './settings-helper'

const deps: LegacyModelSettingsDeps = {
  providerOf: (id) =>
    ({ 'claude-fable-5': 'anthropic', 'deepseek-v4-flash': 'deepseek', 'glm-4.7-flashx': 'zhipu', 'gpt-5.5': 'openai' })[id] ?? null,
  keyedProviders: () => ['deepseek', 'anthropic', 'openai']
}

describe('migrateLegacyModelSettings — pure', () => {
  it('leaves a file without the legacy keys untouched', () => {
    const data = { theme: 'dark', providerPolicy: { order: ['openai'] } }
    expect(migrateLegacyModelSettings(data, deps)).toEqual({ data, changed: false })
  })

  it('seeds the order from the old default’s provider, then every other keyed provider in catalog order, and deletes the keys', () => {
    const r = migrateLegacyModelSettings({ theme: 'dark', defaultModel: 'claude-fable-5', backgroundModel: '', brainEngine: 'auto' }, deps)
    expect(r.changed).toBe(true)
    expect(r.data).toEqual({
      theme: 'dark',
      providerPolicy: { order: ['anthropic', 'deepseek', 'openai'], roles: {}, localOnlyBackground: false, speed: 'fast' }
    })
    expect('defaultModel' in r.data).toBe(false)
    expect('backgroundModel' in r.data).toBe(false)
    expect('brainEngine' in r.data).toBe(false)
  })

  it('an explicit brainEngine beats defaultModel — it WAS the engine (resolveAnswerModel precedence)', () => {
    const r = migrateLegacyModelSettings({ defaultModel: 'claude-fable-5', brainEngine: 'deepseek-v4-flash' }, deps)
    expect((r.data.providerPolicy as { order: string[] }).order).toEqual(['deepseek', 'anthropic', 'openai'])
  })

  it('duin-brain / auto / unknown ids seed nothing specific: the order is every keyed provider in catalog order', () => {
    for (const legacy of [{ defaultModel: 'duin-brain' }, { brainEngine: 'auto', defaultModel: 'duin-brain' }, { defaultModel: 'no-such' }]) {
      const r = migrateLegacyModelSettings(legacy, deps)
      expect((r.data.providerPolicy as { order: string[] }).order).toEqual(['deepseek', 'anthropic', 'openai'])
    }
  })

  it('a pinned backgroundModel becomes the extraction role override; blank / auto does not', () => {
    const pinned = migrateLegacyModelSettings({ backgroundModel: 'glm-4.7-flashx' }, deps)
    expect((pinned.data.providerPolicy as { roles: unknown }).roles).toEqual({ extraction: ['zhipu'] })
    for (const bg of ['', 'auto', '   ']) {
      const r = migrateLegacyModelSettings({ backgroundModel: bg }, deps)
      expect((r.data.providerPolicy as { roles: unknown }).roles).toEqual({})
    }
  })

  it('an existing providerPolicy is preserved; the legacy keys are still removed', () => {
    const policy = { order: ['openai'], roles: {}, localOnlyBackground: true }
    const r = migrateLegacyModelSettings({ providerPolicy: policy, defaultModel: 'claude-fable-5' }, deps)
    expect(r.changed).toBe(true)
    expect(r.data).toEqual({ providerPolicy: policy })
  })

  it('is idempotent: a second pass over its own output changes nothing', () => {
    const once = migrateLegacyModelSettings({ defaultModel: 'claude-fable-5', backgroundModel: 'gpt-5.5', brainEngine: 'auto' }, deps)
    const twice = migrateLegacyModelSettings(once.data, deps)
    expect(twice.changed).toBe(false)
    expect(twice.data).toEqual(once.data)
  })

  it('does not mutate its input', () => {
    const input = { defaultModel: 'claude-fable-5' }
    migrateLegacyModelSettings(input, deps)
    expect(input).toEqual({ defaultModel: 'claude-fable-5' })
  })
})

describe('readSettings — the runner writes back once', () => {
  const SETTINGS = join(userDataDir, 'settings.json')
  const clean = (): void => {
    for (const f of readdirSync(userDataDir)) rmSync(join(userDataDir, f), { force: true })
  }
  beforeEach(() => {
    clean()
    __resetSettingsMigrationForTest()
    registerLegacyModelSettingsDeps(deps)
  })
  afterEach(clean)

  it('migrates a legacy file on first read, deletes the keys on disk, and does not rewrite on the next read', () => {
    writeFileSync(SETTINGS, JSON.stringify({ theme: 'dark', defaultModel: 'claude-fable-5', backgroundModel: 'glm-4.7-flashx', brainEngine: 'auto' }), 'utf8')
    const first = readSettings()
    expect(first.providerPolicy).toEqual({ order: ['anthropic', 'deepseek', 'openai'], roles: { extraction: ['zhipu'] }, localOnlyBackground: false, speed: 'fast' })
    expect(first.defaultModel).toBeUndefined()
    const onDisk = JSON.parse(readFileSync(SETTINGS, 'utf-8')) as Record<string, unknown>
    expect(onDisk.providerPolicy).toEqual(first.providerPolicy)
    expect('defaultModel' in onDisk).toBe(false)
    expect('backgroundModel' in onDisk).toBe(false)
    expect('brainEngine' in onDisk).toBe(false)
    expect(onDisk.theme).toBe('dark')

    const mtime = statSync(SETTINGS).mtimeMs
    expect(readSettings()).toEqual(first)
    expect(statSync(SETTINGS).mtimeMs).toBe(mtime)
  })

  it('a file already on the new shape is read as-is, no write', () => {
    const body = JSON.stringify({ providerPolicy: { order: ['deepseek'], roles: {}, localOnlyBackground: false, speed: 'fast' } })
    writeFileSync(SETTINGS, body, 'utf8')
    const mtime = statSync(SETTINGS).mtimeMs
    expect(readSettings().providerPolicy).toEqual({ order: ['deepseek'], roles: {}, localOnlyBackground: false, speed: 'fast' })
    expect(readFileSync(SETTINGS, 'utf-8')).toBe(body)
    expect(statSync(SETTINGS).mtimeMs).toBe(mtime)
  })

  it('never migrates over a torn file — a read must not side-car settings.json', () => {
    const torn = '{"defaultModel":"claude-fable-5","theme":"da'
    writeFileSync(SETTINGS, torn, 'utf8')
    expect(readSettings()).toEqual({})
    expect(readFileSync(SETTINGS, 'utf-8')).toBe(torn)
    expect(readdirSync(userDataDir).filter((f) => f.startsWith('settings.corrupt-'))).toEqual([])
  })

  it('an absent file reads as empty and creates nothing', () => {
    expect(readSettings()).toEqual({})
    expect(readdirSync(userDataDir)).toEqual([])
  })
})

// ── Boot wiring (P0 audit A2, 2026-09-03) ──
// registry.ts used to register these deps as a module-load side effect, so the migration ran iff
// registry happened to be loaded before the first settings read. main.ts now registers them
// explicitly at the top of app.whenReady — before its doctor path and before the first
// readSettings() of the boot body; registry.ts only EXPORTS the lookups.
describe('the migration deps are registered by an explicit boot call', () => {
  const mainSrc = readFileSync(join(__dirname, '..', 'main.ts'), 'utf-8')
  const registrySrc = readFileSync(join(__dirname, 'providers', 'registry.ts'), 'utf-8')

  it('electron/main.ts calls registerLegacyModelSettingsDeps(LEGACY_MODEL_SETTINGS_DEPS) before the doctor path and startLocalBrain', () => {
    const call = mainSrc.indexOf('registerLegacyModelSettingsDeps(LEGACY_MODEL_SETTINGS_DEPS)')
    expect(call).toBeGreaterThan(-1)
    expect(call).toBeLessThan(mainSrc.indexOf('isDoctorArgv(process.argv)'))
    expect(call).toBeLessThan(mainSrc.indexOf('startLocalBrain().catch'))
  })

  it('registry.ts exports LEGACY_MODEL_SETTINGS_DEPS and no longer registers at load', () => {
    expect(registrySrc).toContain('export const LEGACY_MODEL_SETTINGS_DEPS')
    expect(registrySrc).not.toMatch(/registerLegacyModelSettingsDeps\(/)
  })
})
