import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn(async () => undefined) } }))

const openMock = vi.fn()
vi.mock('fs/promises', () => ({ open: (...args: unknown[]) => openMock(...args) }))

const realPlatform = process.platform
function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

beforeEach(() => {
  openMock.mockReset()
  vi.resetModules()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
})

function err(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException
  e.code = code
  return e
}

describe('getFullDiskAccessState', () => {
  it('is not-applicable off macOS — the concept does not exist there', async () => {
    setPlatform('win32')
    const { getFullDiskAccessState } = await import('./mac-permissions')
    expect(await getFullDiskAccessState()).toBe('not-applicable')
    expect(openMock).not.toHaveBeenCalled()
  })

  it('reports granted when a protected path opens', async () => {
    setPlatform('darwin')
    openMock.mockResolvedValue({ close: vi.fn(async () => undefined) })
    const { getFullDiskAccessState } = await import('./mac-permissions')
    expect(await getFullDiskAccessState()).toBe('granted')
  })

  it('treats EISDIR as granted — the open SUCCEEDED, the target is a directory', async () => {
    setPlatform('darwin')
    openMock.mockRejectedValue(err('EISDIR'))
    const { getFullDiskAccessState } = await import('./mac-permissions')
    expect(await getFullDiskAccessState()).toBe('granted')
  })

  it('reports denied only on an ACTUAL refusal', async () => {
    setPlatform('darwin')
    openMock.mockRejectedValue(err('EPERM'))
    const { getFullDiskAccessState } = await import('./mac-permissions')
    expect(await getFullDiskAccessState()).toBe('denied')
  })

  it('does NOT report denied when the probe files merely do not exist', async () => {
    // The regression this guards: a Mac that never configured Mail has no ~/Library/Mail,
    // and calling that "denied" would send the user to fix a permission that was never
    // the problem. ENOENT is inconclusive, not a refusal.
    setPlatform('darwin')
    openMock.mockRejectedValue(err('ENOENT'))
    const { getFullDiskAccessState } = await import('./mac-permissions')
    expect(await getFullDiskAccessState()).toBe('granted')
  })

  it('a single refusal is enough, even when other probes are missing', async () => {
    setPlatform('darwin')
    openMock
      .mockRejectedValueOnce(err('ENOENT'))
      .mockRejectedValueOnce(err('EACCES'))
      .mockRejectedValueOnce(err('ENOENT'))
    const { getFullDiskAccessState } = await import('./mac-permissions')
    expect(await getFullDiskAccessState()).toBe('denied')
  })
})

describe('openFullDiskAccessSettings', () => {
  it('does nothing off macOS', async () => {
    setPlatform('linux')
    const { openFullDiskAccessSettings } = await import('./mac-permissions')
    expect(await openFullDiskAccessSettings()).toBe(false)
  })

  it('opens the Full Disk Access pane by deep link', async () => {
    setPlatform('darwin')
    const { openFullDiskAccessSettings } = await import('./mac-permissions')
    const { shell } = await import('electron')
    expect(await openFullDiskAccessSettings()).toBe(true)
    expect(shell.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
    )
  })
})

describe('registerForFullDiskAccessListing', () => {
  it('touches a protected path on macOS so the app gets LISTED', async () => {
    // This attempt is the entire reason DUIN appears in the Full Disk Access list at
    // all — macOS adds an app when it tries a protected read, not when it is installed.
    setPlatform('darwin')
    openMock.mockRejectedValue(err('EPERM'))
    const { registerForFullDiskAccessListing } = await import('./mac-permissions')
    registerForFullDiskAccessListing()
    await new Promise((r) => setTimeout(r, 0))
    expect(openMock).toHaveBeenCalled()
  })

  it('is a no-op off macOS', async () => {
    setPlatform('win32')
    const { registerForFullDiskAccessListing } = await import('./mac-permissions')
    registerForFullDiskAccessListing()
    await new Promise((r) => setTimeout(r, 0))
    expect(openMock).not.toHaveBeenCalled()
  })
})
