import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseDoctorArgs, isDoctorArgv, collectDoctorReadings } from './doctor-collect'

// The collector's contract is narrow and load-bearing: a reading it could not take must
// come back as null/undefined so the report WARNS, and no single failing route may take
// down the run. A collector that threw would turn "the engine is down" — the exact thing
// the doctor exists to report — into a crash with no report at all.

describe('parseDoctorArgs', () => {
  it('defaults to a local brain, no json, no live probe', () => {
    const o = parseDoctorArgs(['doctor'])
    expect(o).toMatchObject({ json: false, live: false })
    expect(o.brainUrl).toMatch(/127\.0\.0\.1:8799$/)
  })

  it('reads --json, --live and both --brain spellings', () => {
    expect(parseDoctorArgs(['doctor', '--json', '--live'])).toMatchObject({ json: true, live: true })
    expect(parseDoctorArgs(['doctor', '--brain', 'http://x:1']).brainUrl).toBe('http://x:1')
    expect(parseDoctorArgs(['doctor', '--brain=http://y:2']).brainUrl).toBe('http://y:2')
  })

  it('ignores flags that appear BEFORE the verb (they belong to the launcher)', () => {
    expect(parseDoctorArgs(['--json', 'doctor']).json).toBe(false)
  })

  it('recognises the verb only as its own argument', () => {
    expect(isDoctorArgv(['--lamprey-headless', 'doctor'])).toBe(true)
    expect(isDoctorArgv(['run', '--conv', 'doctor-notes'])).toBe(false)
  })
})

const deps = {
  providersWithKeys: () => ['deepseek'],
  liveProbe: async () => ({ ok: true, provider: 'deepseek' }),
  channelsWaiting: () => []
}

const opts = { json: false, live: false, brainUrl: 'http://127.0.0.1:8799' }

afterEach(() => vi.unstubAllGlobals())

describe('collectDoctorReadings', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('a brain that is entirely down yields null readings, not a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const r = await collectDoctorReadings(opts, deps)
    expect(r.health).toBeNull()
    expect(r.brainHealth).toBeNull()
    expect(r.installedBuild).toBeNull()
    // …and the readings it can take locally still arrive.
    expect(r.providersWithKeys).toEqual(['deepseek'])
    expect(r.build).toBeTruthy()
  })

  it('a non-200 route reads as null rather than as parsed garbage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    const r = await collectDoctorReadings(opts, deps)
    expect(r.health).toBeNull()
  })

  it('skips the live probe unless --live is given', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ status: 'ok' }) })))
    const probe = vi.fn(async () => ({ ok: true }))
    const r = await collectDoctorReadings(opts, { ...deps, liveProbe: probe })
    expect(probe).not.toHaveBeenCalled()
    expect(r.liveProbe).toBeNull()

    const r2 = await collectDoctorReadings({ ...opts, live: true }, { ...deps, liveProbe: probe })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(r2.liveProbe).toMatchObject({ ok: true })
  })

  it('a throwing live probe becomes a FAILED probe, never an absent one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    const r = await collectDoctorReadings(
      { ...opts, live: true },
      { ...deps, liveProbe: async () => { throw new Error('402 Insufficient Balance') } }
    )
    expect(r.liveProbe).toMatchObject({ ok: false })
    expect(r.liveProbe?.error).toMatch(/402/)
  })

  it('an unreadable key store yields undefined (warn) rather than [] (a false "no keys")', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    const r = await collectDoctorReadings(opts, {
      ...deps,
      providersWithKeys: () => { throw new Error('keychain locked') }
    })
    expect(r.providersWithKeys).toBeUndefined()
  })

  it('reads the running app build from /state/build, ignoring an unstamped one', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.endsWith('/state/build')
        ? { ok: true, json: async () => ({ shortSha: 'abc1234', builtAt: '2026-08-25' }) }
        : { ok: true, json: async () => ({}) }
    ))
    expect((await collectDoctorReadings(opts, deps)).installedBuild).toMatchObject({ shortSha: 'abc1234' })

    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.endsWith('/state/build')
        ? { ok: true, json: async () => ({ shortSha: 'unknown' }) }
        : { ok: true, json: async () => ({}) }
    ))
    expect((await collectDoctorReadings(opts, deps)).installedBuild).toBeNull()
  })
})
