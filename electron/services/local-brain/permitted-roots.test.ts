import { describe, it, expect, vi, beforeEach } from 'vitest'
import { normalize, join, sep } from 'path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'

const getActiveWorkspaceMock = vi.fn(() => '')
const operatorWritePathsMock = vi.fn((): string[] => [])
// Confined by default in these tests (full access OFF) so the permittedRoots allowlist is
// what's under test. The full-access describe below flips it on.
const fullComputerAccessMock = vi.fn((): boolean => false)

vi.mock('../workspace-state', () => ({ getActiveWorkspace: () => getActiveWorkspaceMock() }))
vi.mock('../sandbox/operator-write-paths', () => ({
  operatorWritePaths: () => operatorWritePathsMock(),
  fullComputerAccess: () => fullComputerAccessMock()
}))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, shell: { openExternal: vi.fn() } }))

const VAULT = normalize(process.platform === 'win32' ? 'C:/vault' : '/home/u/vault')
const DESKTOP = normalize(process.platform === 'win32' ? 'C:/Users/u/Desktop' : '/home/u/Desktop')

beforeEach(() => {
  getActiveWorkspaceMock.mockReturnValue('')
  operatorWritePathsMock.mockReturnValue([])
  fullComputerAccessMock.mockReturnValue(false)
  vi.resetModules()
})

describe('resolveInVault — relative paths are unchanged', () => {
  it('stays vault-relative', async () => {
    const { resolveInVault } = await import('./agui-executors')
    const r = resolveInVault(VAULT, 'notes/a.md')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.abs).toBe(join(VAULT, 'notes/a.md'))
  })

  it('cannot climb out with a leading separator or ..', async () => {
    const { resolveInVault } = await import('./agui-executors')
    expect(resolveInVault(VAULT, '../../etc/passwd').ok).toBe(false)
    const lead = resolveInVault(VAULT, '/etc/passwd')
    // A leading slash makes it ABSOLUTE on POSIX, so it is judged against the permitted
    // roots and refused there; on Windows it is stripped and stays inside the vault.
    if (process.platform !== 'win32') expect(lead.ok).toBe(false)
    else if (lead.ok) expect(lead.abs.startsWith(VAULT)).toBe(true)
  })
})

describe('resolveInVault — absolute paths', () => {
  it('REFUSES an absolute path outside every permitted root', async () => {
    // The default posture: nothing configured, so only the vault is permitted.
    const { resolveInVault } = await import('./agui-executors')
    const r = resolveInVault(VAULT, join(DESKTOP, 'junk.txt'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/outside every permitted location/)
  })

  it('ALLOWS it once the operator has listed that directory', async () => {
    // This is the whole feature: "delete this file on my Desktop" works when the
    // operator has said Desktop is allowed, and not before.
    operatorWritePathsMock.mockReturnValue([DESKTOP])
    const { resolveInVault } = await import('./agui-executors')
    const target = join(DESKTOP, 'junk.txt')
    const r = resolveInVault(VAULT, target)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.abs).toBe(normalize(target))
      expect(r.root).toBe(DESKTOP)
      expect(r.rel).toBe('junk.txt')
    }
  })

  it('ALLOWS a path inside the workspace the user picked', async () => {
    const ws = normalize(process.platform === 'win32' ? 'C:/code/proj' : '/home/u/code/proj')
    getActiveWorkspaceMock.mockReturnValue(ws)
    const { resolveInVault } = await import('./agui-executors')
    const r = resolveInVault(VAULT, join(ws, 'src/main.ts'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.root).toBe(ws)
  })

  it('refuses a SIBLING of a permitted root — prefix matching must not leak', async () => {
    // '/home/u/Desktop-old' starts with '/home/u/Desktop' as a STRING. Only a separator
    // boundary makes it containment rather than a shared prefix.
    operatorWritePathsMock.mockReturnValue([DESKTOP])
    const { resolveInVault } = await import('./agui-executors')
    expect(resolveInVault(VAULT, `${DESKTOP}-old${sep}secret.txt`).ok).toBe(false)
  })

  it('still allows the vault itself by absolute path', async () => {
    const { resolveInVault } = await import('./agui-executors')
    const r = resolveInVault(VAULT, join(VAULT, 'a.md'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.root).toBe(VAULT)
  })

  it('survives workspace-state throwing', async () => {
    getActiveWorkspaceMock.mockImplementation(() => {
      throw new Error('unavailable')
    })
    const { resolveInVault } = await import('./agui-executors')
    expect(resolveInVault(VAULT, 'notes/a.md').ok).toBe(true)
  })
})

describe('executeWriteNote reaches the permitted roots (create a file on the Desktop)', () => {
  // write_file was the lone mutating tool hard-jailed to the vault; it now resolves through
  // permittedRoots like its siblings, so "organize my Desktop into folders with an index"
  // can actually LAND the index. Real dirs — the write must genuinely happen.
  const mk = (): { vault: string; desktop: string } => {
    const baseDir = mkdtempSync(join(tmpdir(), 'duin-write-roots-'))
    const vault = join(baseDir, 'vault')
    const desktop = join(baseDir, 'Desktop')
    mkdirSync(vault, { recursive: true })
    mkdirSync(desktop, { recursive: true })
    return { vault, desktop }
  }

  it('REFUSES a new file on the Desktop until the operator has allowed it', async () => {
    const { vault, desktop } = mk()
    operatorWritePathsMock.mockReturnValue([])
    const { executeWriteNote } = await import('./agui-executors')
    const target = join(desktop, 'organized', 'index.md')
    const r = executeWriteNote(vault, target, '# Index\n')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/outside every permitted location/)
    expect(existsSync(target)).toBe(false)
  })

  it('CREATES a new file on the Desktop once it is a permitted root, and reports it ABSOLUTE', async () => {
    const { vault, desktop } = mk()
    operatorWritePathsMock.mockReturnValue([desktop])
    const { executeWriteNote } = await import('./agui-executors')
    const target = join(desktop, 'organized', 'index.md')
    const r = executeWriteNote(vault, target, '# Index\n')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe(normalize(target)) // out-of-vault hit is unambiguous → absolute
    expect(readFileSync(target, 'utf-8')).toBe('# Index\n')
  })

  it('an in-vault write is unchanged — relative path in, relative path out, no absolute leak', async () => {
    const { vault } = mk()
    operatorWritePathsMock.mockReturnValue([])
    const { executeWriteNote } = await import('./agui-executors')
    const r = executeWriteNote(vault, 'notes/a.md', 'hi\n')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe('notes/a.md')
    expect(readFileSync(join(vault, 'notes', 'a.md'), 'utf-8')).toBe('hi\n')
  })
})

describe('search + glob cover the permitted roots', () => {
  // Real directories, not just an ok:true assertion — the previous version of these
  // would have passed with the scoping entirely broken.
  const mk = (): { vault: string; extra: string } => {
    const base = mkdtempSync(join(tmpdir(), 'duin-roots-'))
    const vault = join(base, 'vault')
    const extra = join(base, 'desktop')
    mkdirSync(vault, { recursive: true })
    mkdirSync(extra, { recursive: true })
    writeFileSync(join(vault, 'in-vault.md'), 'needle here')
    writeFileSync(join(extra, 'on-desktop.md'), 'needle here')
    return { vault, extra }
  }

  it('glob finds files in an allowed root, and reports them ABSOLUTE', async () => {
    const { vault, extra } = mk()
    operatorWritePathsMock.mockReturnValue([extra])
    const { executeGlobFiles } = await import('./agui-executors')
    const r = executeGlobFiles(vault, '*.md')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Vault hit stays relative; the allowed-root hit is absolute and unambiguous.
    expect(r.results).toContain('in-vault.md')
    expect(r.results).toContain(join(extra, 'on-desktop.md'))
  })

  it('glob does NOT reach a directory the operator has not allowed', async () => {
    const { vault, extra } = mk()
    operatorWritePathsMock.mockReturnValue([])
    const { executeGlobFiles } = await import('./agui-executors')
    const r = executeGlobFiles(vault, '*.md')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.results).toContain('in-vault.md')
    expect(r.results.some((x) => x.includes('on-desktop'))).toBe(false)
  })

  it('search finds content in an allowed root', async () => {
    const { vault, extra } = mk()
    operatorWritePathsMock.mockReturnValue([extra])
    const { executeSearchFiles } = await import('./agui-executors')
    const r = executeSearchFiles(vault, 'needle')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.matches.some((m) => m.startsWith('in-vault.md:'))).toBe(true)
    expect(r.matches.some((m) => m.startsWith(join(extra, 'on-desktop.md') + ':'))).toBe(true)
  })
})

describe('full computer access — the vault/permitted-roots jail is off', () => {
  const OUTSIDE = normalize(process.platform === 'win32' ? 'C:/Users/u/Desktop/anywhere.txt' : '/home/u/Desktop/anywhere.txt')

  it('resolveInVault ACCEPTS any absolute path when full access is on, with NO folders granted', async () => {
    fullComputerAccessMock.mockReturnValue(true)
    operatorWritePathsMock.mockReturnValue([])
    const { resolveInVault } = await import('./agui-executors')
    const r = resolveInVault(VAULT, OUTSIDE)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.abs).toBe(OUTSIDE)
      // out-of-vault → owner is the filesystem root, not the vault (so it renders absolute).
      expect(normalize(r.root)).not.toBe(VAULT)
    }
  })

  it('confined mode (full access OFF) still REFUSES that same path', async () => {
    fullComputerAccessMock.mockReturnValue(false)
    operatorWritePathsMock.mockReturnValue([])
    const { resolveInVault } = await import('./agui-executors')
    expect(resolveInVault(VAULT, OUTSIDE).ok).toBe(false)
  })

  it('executeWriteNote CREATES a file in an UN-granted directory under full access', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'duin-fca-'))
    const vault = join(baseDir, 'vault')
    const outside = join(baseDir, 'somewhere-else')
    mkdirSync(vault, { recursive: true })
    mkdirSync(outside, { recursive: true })
    fullComputerAccessMock.mockReturnValue(true)
    operatorWritePathsMock.mockReturnValue([]) // nothing granted — full access is the only reason it lands
    const { executeWriteNote } = await import('./agui-executors')
    const target = join(outside, 'note.md')
    const r = executeWriteNote(vault, target, 'anywhere\n')
    expect(r.ok).toBe(true)
    expect(readFileSync(target, 'utf-8')).toBe('anywhere\n')
  })
})
