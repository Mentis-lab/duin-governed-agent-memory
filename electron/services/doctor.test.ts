import { describe, it, expect } from 'vitest'
import { buildDoctorReport, renderDoctorReport, type DoctorReadings } from './doctor'

// The doctor's whole value is that it refuses to report "fine" for something it did not
// measure — every outage it exists to catch presented as a green surface at the time.

const healthy: DoctorReadings = {
  build: { version: '0.8.0', shortSha: 'abc1234', branch: 'trunk', dirty: false, builtAt: '2026-08-25T00:00:00Z' },
  health: { status: 'ok', indexed: 1200 },
  brainHealth: { overall: 92 },
  backendHealth: { problems: [], integrityOk: true },
  stalls: { recent: [{ scope: 'ipc:x', ms: 40 }] },
  gaps: { open: 0 },
  providersWithKeys: ['deepseek'],
  liveProbe: { ok: true, provider: 'deepseek' },
  channelsWaiting: []
}

const idOf = (r: ReturnType<typeof buildDoctorReport>, id: string) =>
  r.checks.find((c) => c.id === id)

describe('exit-code contract', () => {
  it('0 when everything passed', () => {
    const r = buildDoctorReport(healthy)
    expect(r.status).toBe('pass')
    expect(r.exitCode).toBe(0)
  })

  it('1 when anything FAILED', () => {
    const r = buildDoctorReport({ ...healthy, health: null })
    expect(r.exitCode).toBe(1)
  })

  it('2 when nothing failed but something could not be answered — never 0', () => {
    const r = buildDoctorReport({ ...healthy, liveProbe: null })
    expect(r.status).toBe('warn')
    expect(r.exitCode).toBe(2)
  })

  it('a failure outranks a warning', () => {
    const r = buildDoctorReport({
      ...healthy,
      liveProbe: null,
      backendHealth: { problems: ["INTEGRITY: lamprey integrity_check is not 'ok'"], integrityOk: false }
    })
    expect(r.exitCode).toBe(1)
  })
})

describe('model access — the 402 outage shape', () => {
  it('a stored key alone is NOT a pass: it warns and names the live probe', () => {
    const r = buildDoctorReport({ ...healthy, liveProbe: null })
    const model = idOf(r, 'model')
    expect(model?.status).toBe('warn')
    expect(model?.detail).toMatch(/only proves a key exists/i)
    expect(model?.remedy).toMatch(/--live/)
  })

  it('a refused live probe FAILS and points at balance/quota', () => {
    const r = buildDoctorReport({
      ...healthy,
      liveProbe: { ok: false, error: '402 Insufficient Balance' }
    })
    const model = idOf(r, 'model')
    expect(model?.status).toBe('fail')
    expect(model?.detail).toMatch(/402/)
    expect(r.exitCode).toBe(1)
  })

  it('no key at all fails rather than warns — nothing can run', () => {
    const r = buildDoctorReport({ ...healthy, providersWithKeys: [], liveProbe: null })
    expect(idOf(r, 'model')?.status).toBe('fail')
  })

  it('an unreadable key store warns instead of passing', () => {
    const r = buildDoctorReport({ ...healthy, providersWithKeys: undefined, liveProbe: null })
    expect(idOf(r, 'model')?.status).toBe('warn')
  })
})

describe('deploy identity — the stale-asar shape', () => {
  it('FAILS when a CLEAN build disagrees with the running app - the stale-asar shape', () => {
    const r = buildDoctorReport({
      ...healthy,
      installedBuild: { shortSha: 'deadbee', builtAt: '2026-08-01T00:00:00Z' }
    })
    const build = idOf(r, 'build')
    expect(build?.status).toBe('fail')
    expect(build?.detail).toMatch(/deadbee/)
    expect(build?.remedy).toMatch(/GUARD B/)
  })

  it('only WARNS when a DIRTY build disagrees - that is an ordinary dev-tree run', () => {
    const r = buildDoctorReport({
      ...healthy,
      build: { ...healthy.build!, dirty: true },
      installedBuild: { shortSha: 'deadbee', builtAt: 'x' }
    })
    expect(idOf(r, 'build')?.status).toBe('warn')
    expect(idOf(r, 'build')?.remedy).toMatch(/dev-tree run/)
  })

  it('passes when they agree, and says which commit', () => {
    const r = buildDoctorReport({ ...healthy, installedBuild: { shortSha: 'abc1234', builtAt: 'x' } })
    expect(idOf(r, 'build')?.status).toBe('pass')
    expect(idOf(r, 'build')?.detail).toMatch(/abc1234/)
  })

  it('an unstamped build warns rather than claiming provenance', () => {
    const r = buildDoctorReport({
      ...healthy,
      build: { version: '0.8.0', shortSha: 'unknown', branch: 'unknown', dirty: false, builtAt: 'unknown' }
    })
    expect(idOf(r, 'build')?.status).toBe('warn')
  })

  it('says so when the build came from a dirty tree', () => {
    const r = buildDoctorReport({ ...healthy, build: { ...healthy.build!, dirty: true } })
    expect(idOf(r, 'build')?.detail).toMatch(/DIRTY/)
  })
})

describe('backend health — corrupt is a FAIL, everything else the monitor flags is a WARN', () => {
  it('a clean entry passes and says what was actually checked', () => {
    const c = idOf(buildDoctorReport(healthy), 'backend')
    expect(c?.status).toBe('pass')
    expect(c?.detail).toMatch(/integrity_check is clean/)
  })

  it('a stale backup WARNS rather than failing — real, but the data is not damaged', () => {
    const r = buildDoctorReport({
      ...healthy,
      backendHealth: { problems: ['BACKUP: newest lamprey backup 99h old'], integrityOk: true }
    })
    expect(idOf(r, 'backend')?.status).toBe('warn')
    expect(idOf(r, 'backend')?.detail).toMatch(/99h/)
    expect(r.exitCode).toBe(2)
  })

  it('a failed integrity_check FAILS', () => {
    const r = buildDoctorReport({
      ...healthy,
      backendHealth: { problems: ["INTEGRITY: lamprey integrity_check is not 'ok'"], integrityOk: false }
    })
    expect(idOf(r, 'backend')?.status).toBe('fail')
  })
})

describe('the rest of the surface', () => {
  it('an indexed-zero brain warns: answering is not the same as having anything', () => {
    const r = buildDoctorReport({ ...healthy, health: { status: 'ok', indexed: 0 } })
    expect(idOf(r, 'brain')?.status).toBe('warn')
  })

  it('reports the worst recent stall, and passes when they are all small', () => {
    expect(idOf(buildDoctorReport(healthy), 'stalls')?.status).toBe('pass')
    const r = buildDoctorReport({
      ...healthy,
      stalls: { recent: [{ scope: 'unattributed', ms: 880 }, { scope: 'ipc:y', ms: 20 }] }
    })
    expect(idOf(r, 'stalls')?.status).toBe('warn')
    expect(idOf(r, 'stalls')?.detail).toMatch(/880ms in unattributed/)
  })

  it('names channels that are enabled but cannot connect', () => {
    const r = buildDoctorReport({ ...healthy, channelsWaiting: ['telegram'] })
    expect(idOf(r, 'channels')?.detail).toMatch(/telegram/)
  })

  it('omits optional checks entirely when their reading is absent', () => {
    const r = buildDoctorReport({ ...healthy, gaps: undefined, stalls: undefined, brainHealth: undefined })
    expect(idOf(r, 'gaps')).toBeUndefined()
    expect(idOf(r, 'stalls')).toBeUndefined()
    expect(idOf(r, 'brain-health')).toBeUndefined()
  })
})

describe('rendering', () => {
  it('sanitises text passed through from OTHER modules, not just its own literals', () => {
    // The backend monitor writes a real >= glyph; terminal-safety has to be enforced where
    // the text is printed, because this file's own literals are not the only source.
    const text = renderDoctorReport(
      buildDoctorReport({
        ...healthy,
        backendHealth: { problems: ["FAILURES: count=1532 ≥ 100 — runaway"], integrityOk: true }
      })
    )
    expect(text).toContain('>= 100')
    expect([...text].filter((ch) => ch.charCodeAt(0) > 127)).toEqual([])
  })

  it('is ASCII-only so it survives cmd.exe and Git Bash — across EVERY branch', () => {
    // One report shape only exercises the remedies that shape happens to hit, and the
    // first version of this test passed while three unrendered remedies still carried a
    // Unicode arrow. Cover every branch that can produce text.
    const shapes: DoctorReadings[] = [
      healthy,
      { ...healthy, liveProbe: null },
      { ...healthy, providersWithKeys: [], liveProbe: null },
      { ...healthy, providersWithKeys: undefined, liveProbe: null },
      { ...healthy, liveProbe: { ok: false, error: '402 Insufficient Balance' } },
      { ...healthy, health: null },
      { ...healthy, health: { status: 'degraded' } },
      { ...healthy, health: { status: 'ok', indexed: 0 } },
      { ...healthy, backendHealth: null },
      { ...healthy, backendHealth: { problems: ['BACKUP: newest lamprey backup 99h old'], integrityOk: true } },
      { ...healthy, backendHealth: { problems: ['INTEGRITY: lamprey bad'], integrityOk: false } },
      { ...healthy, brainHealth: { overall: 40 } },
      { ...healthy, stalls: { recent: [{ scope: 'unattributed', ms: 900 }] } },
      { ...healthy, gaps: { open: 3 } },
      { ...healthy, channelsWaiting: ['telegram', 'discord'] },
      { ...healthy, installedBuild: { shortSha: 'deadbee', builtAt: 'x' } },
      { ...healthy, build: { version: '0', shortSha: 'unknown', branch: 'unknown', dirty: false, builtAt: 'unknown' } },
      { ...healthy, build: { ...healthy.build!, dirty: true } },
      {}
    ]
    for (const shape of shapes) {
      const text = renderDoctorReport(buildDoctorReport(shape))
      const offenders = [...text].filter((ch) => ch.charCodeAt(0) > 127)
      expect(offenders).toEqual([])
    }
  })

  it('prints every check, its detail, and the exit code', () => {
    const report = buildDoctorReport(healthy)
    const text = renderDoctorReport(report)
    for (const c of report.checks) expect(text).toContain(c.title)
    expect(text).toContain('exit 0')
  })
})
