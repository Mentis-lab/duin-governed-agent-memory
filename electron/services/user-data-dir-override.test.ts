import { describe, it, expect, vi } from 'vitest'
import { resolve } from 'path'
import { applyUserDataDirOverride } from './user-data-dir-override'

// main.ts calls this before crashReporter.start() and requestSingleInstanceLock(); the
// contract pinned here is what makes a second instance isolated rather than merely relocated.

function fakeApp() {
  return { setPath: vi.fn<(name: string, path: string) => void>() }
}

describe('applyUserDataDirOverride', () => {
  it('does nothing when DUIN_USER_DATA_DIR is unset or blank', () => {
    const app = fakeApp()
    const ensure = vi.fn()
    expect(applyUserDataDirOverride(app, undefined, ensure)).toBeNull()
    expect(applyUserDataDirOverride(app, '', ensure)).toBeNull()
    expect(applyUserDataDirOverride(app, '   ', ensure)).toBeNull()
    expect(app.setPath).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
  })

  it('refuses a relative path — isolation must not depend on the launcher cwd', () => {
    const app = fakeApp()
    const ensure = vi.fn()
    expect(applyUserDataDirOverride(app, 'qa-instance', ensure)).toBeNull()
    expect(applyUserDataDirOverride(app, './qa', ensure)).toBeNull()
    expect(app.setPath).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
  })

  it('creates the directory, then redirects userData AND sessionData to it', () => {
    const app = fakeApp()
    const calls: string[] = []
    const ensure = vi.fn((d: string) => {
      calls.push(`mkdir:${d}`)
    })
    app.setPath.mockImplementation((name) => {
      calls.push(`setPath:${name}`)
    })
    const dir = resolve('/tmp/duin-qa-instance')
    expect(applyUserDataDirOverride(app, `  ${dir}  `, ensure)).toBe(dir)
    expect(app.setPath).toHaveBeenCalledWith('userData', dir)
    expect(app.setPath).toHaveBeenCalledWith('sessionData', dir)
    // mkdir first: app.setPath throws on a directory that does not exist yet.
    expect(calls).toEqual([`mkdir:${dir}`, 'setPath:userData', 'setPath:sessionData'])
  })
})
