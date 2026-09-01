import { describe, it, expect, vi, beforeEach } from 'vitest'

const getActiveWorkspaceMock = vi.fn()
vi.mock('../workspace-state', () => ({
  getActiveWorkspace: () => getActiveWorkspaceMock()
}))
// agui-executors pulls a large graph at import; stub the leaves this test cannot use.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, shell: { openExternal: vi.fn() } }))

beforeEach(() => {
  getActiveWorkspaceMock.mockReset()
  vi.resetModules()
})

describe('resolveShellCwd', () => {
  it('runs in the workspace the user picked, not the vault', async () => {
    // The bug this pins: agui-tools passes ctx.notesDir (the VAULT) as cwd, while the
    // user picks a workspace with the ChatInput chip. agui-gate already resolves the
    // chosen workspace for its POLICY decision, so picking a project directory changed
    // which policy applied and nothing about where the command ran — and on macOS the
    // sandbox kept jailing writes to the vault, which reads as "it cannot write code".
    getActiveWorkspaceMock.mockReturnValue('/Users/x/code/project')
    const { resolveShellCwd } = await import('./agui-executors')
    expect(resolveShellCwd('/Users/x/Documents/Vault')).toBe('/Users/x/code/project')
  })

  it('falls back to the caller path when no workspace is chosen', async () => {
    // getActiveWorkspace() itself falls back to the vault, so an empty answer must
    // leave behaviour exactly as it was.
    getActiveWorkspaceMock.mockReturnValue('')
    const { resolveShellCwd } = await import('./agui-executors')
    expect(resolveShellCwd('/Users/x/Documents/Vault')).toBe('/Users/x/Documents/Vault')
  })

  it('falls back when workspace-state throws rather than failing the command', async () => {
    getActiveWorkspaceMock.mockImplementation(() => {
      throw new Error('workspace store unavailable')
    })
    const { resolveShellCwd } = await import('./agui-executors')
    expect(resolveShellCwd('/fallback')).toBe('/fallback')
  })
})
