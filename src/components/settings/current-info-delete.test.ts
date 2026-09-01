import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  deleteTargetProvider,
  deleteDisabledReason,
  canDeleteKey,
  type ProviderStatusLike
} from './current-info-delete'

// U13 — "Delete key" deleted the wrong provider's key and reported success.
// The renderer env here is node-only (no jsdom), so the decision is a pure
// function tested directly, plus a source-lock proving CurrentInfoSettings
// stopped aiming the delete at the unsaved dropdown.

const root = join(__dirname, '..', '..', '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf-8')

const bothFinanceKeys: ProviderStatusLike = {
  finance: { provider: 'finnhub', hasKey: true },
  weather: { provider: 'open-meteo', hasKey: true, keyRequired: false }
}

describe('deleteTargetProvider — the saved provider, never the draft', () => {
  it('returns the saved finance provider even while the dropdown shows another', () => {
    // The exact scenario: user flips the <select> to alphavantage, does not
    // Save, clicks Delete. The old code aimed at alphavantage.
    expect(deleteTargetProvider('finance', bothFinanceKeys)).toBe('finnhub')
  })

  it('returns the saved weather provider', () => {
    expect(deleteTargetProvider('weather', bothFinanceKeys)).toBe('open-meteo')
  })

  it('refuses to name a target before status has loaded', () => {
    expect(deleteTargetProvider('finance', null)).toBeNull()
    expect(deleteTargetProvider('finance', undefined)).toBeNull()
  })
})

describe('canDeleteKey — finance', () => {
  it('is disabled while the dropdown differs from the saved provider', () => {
    expect(canDeleteKey('finance', bothFinanceKeys, 'alphavantage')).toBe(false)
    expect(deleteDisabledReason('finance', bothFinanceKeys, 'alphavantage')).toContain('finnhub')
  })

  it('is enabled when the dropdown agrees and a key is stored', () => {
    expect(canDeleteKey('finance', bothFinanceKeys, 'finnhub')).toBe(true)
    expect(deleteDisabledReason('finance', bothFinanceKeys, 'finnhub')).toBeNull()
  })

  it('is disabled when no key is stored for the saved provider', () => {
    const noKey: ProviderStatusLike = {
      ...bothFinanceKeys,
      finance: { provider: 'finnhub', hasKey: false }
    }
    expect(canDeleteKey('finance', noKey, 'finnhub')).toBe(false)
  })

  it('is disabled before status loads', () => {
    expect(canDeleteKey('finance', null, 'finnhub')).toBe(false)
  })
})

describe('canDeleteKey — weather (the open-meteo trap)', () => {
  // current-info-tools reports hasKey:true for open-meteo because it needs no
  // key. Flipping the dropdown to OpenWeatherMap used to render Delete enabled
  // off that forced true, and one click switched the live provider to a
  // keyless OpenWeatherMap — breaking weather_lookup.
  it('is disabled when the saved provider needs no key, whatever the dropdown says', () => {
    expect(canDeleteKey('weather', bothFinanceKeys, 'openweather')).toBe(false)
    expect(canDeleteKey('weather', bothFinanceKeys, 'open-meteo')).toBe(false)
    expect(deleteDisabledReason('weather', bothFinanceKeys, 'openweather')).toContain('open-meteo')
  })

  it('is enabled once OpenWeatherMap is the saved provider and holds a key', () => {
    const owmSaved: ProviderStatusLike = {
      ...bothFinanceKeys,
      weather: { provider: 'openweather', hasKey: true, keyRequired: true }
    }
    expect(canDeleteKey('weather', owmSaved, 'openweather')).toBe(true)
    // ...and goes away again the moment the dropdown is flipped back unsaved.
    expect(canDeleteKey('weather', owmSaved, 'open-meteo')).toBe(false)
  })

  it('is disabled when OpenWeatherMap is saved but holds no key', () => {
    const owmNoKey: ProviderStatusLike = {
      ...bothFinanceKeys,
      weather: { provider: 'openweather', hasKey: false, keyRequired: true }
    }
    expect(canDeleteKey('weather', owmNoKey, 'openweather')).toBe(false)
  })
})

describe('CurrentInfoSettings wiring (source-lock)', () => {
  const src = read('src/components/settings/CurrentInfoSettings.tsx')

  it('no longer picks the delete target off the unsaved dropdown state', () => {
    // The defect, verbatim.
    expect(src).not.toMatch(/kind === 'finance'\s*\?\s*financeProvider\s*:\s*weatherProvider/)
  })

  it('aims the delete at the saved provider', () => {
    expect(src).toMatch(/deleteTargetProvider\(/)
  })

  it('gates both Delete buttons on canDeleteKey', () => {
    const gated = src.match(/canDeleteKey\(/g) ?? []
    expect(gated.length).toBeGreaterThanOrEqual(2)
  })

  it('still refuses to act when the target cannot be resolved', () => {
    // A null target must abort rather than fall back to the draft.
    expect(src).toMatch(/if\s*\(\s*!\s*provider\s*\)/)
  })
})
