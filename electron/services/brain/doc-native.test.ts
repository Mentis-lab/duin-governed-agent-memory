import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readDoc, resolveWikilink } from './doc-native'
import { APP_STATE_DIRS, isVaultWalkDir } from './vault-dirs'

// Deep correctness proven by live parity (parity.ts: doc + resolve, found + 404 cases EXACT).
describe('doc-native', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-doc-'))
    mkdirSync(join(vault, 'People'), { recursive: true })
    writeFileSync(join(vault, 'me.md'), '# Me\r\nhi') // CRLF → normalized
    writeFileSync(join(vault, 'People', 'Ann.md'), 'x')
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('readDoc returns content (CRLF-normalized), null on miss / traversal / bad ext', () => {
    expect(readDoc(vault, 'me.md')).toBe('# Me\nhi')
    expect(readDoc(vault, 'vault:/me.md')).toBe('# Me\nhi') // vault: id stripped
    expect(readDoc(vault, 'nope.md')).toBeNull()
    expect(readDoc(vault, '../secret.md')).toBeNull() // traversal blocked
    expect(readDoc(vault, 'me.exe')).toBeNull() // disallowed ext
  })

  it('resolveWikilink finds .md by basename (alias/heading/subpath stripped), null on miss', () => {
    expect(resolveWikilink(vault, 'Ann')).toBe('People/Ann.md')
    expect(resolveWikilink(vault, 'x/Ann|alias#h')).toBe('People/Ann.md')
    expect(resolveWikilink(vault, 'me.md')).toBe('me.md')
    expect(resolveWikilink(vault, 'ghost')).toBeNull()
  })

  it('null vault → null', () => {
    expect(readDoc(null, 'me.md')).toBeNull()
    expect(resolveWikilink(null, 'Ann')).toBeNull()
  })

  it('does NOT resolve into hidden state dirs (.duin fixtures never satisfy a wikilink)', () => {
    mkdirSync(join(vault, '.duin', '_eval-fixtures', 'snapshot', 'Tasks'), { recursive: true })
    writeFileSync(join(vault, '.duin', '_eval-fixtures', 'snapshot', 'Tasks', 'Personal.md'), 'fixture')
    // A real note of the same name still resolves; the fixture is skipped, not preferred.
    expect(resolveWikilink(vault, 'Personal')).toBeNull() // only the fixture exists → unresolved
    writeFileSync(join(vault, 'Personal.md'), 'real')
    expect(resolveWikilink(vault, 'Personal')).toBe('Personal.md') // real note, not the fixture
  })

  // Consistency: the resolver must skip EVERY app-state dir the graph excludes, not just
  // `.duin` — else a walker drifts and a link resolves into a dir the graph never indexed.
  it('resolver skips every APP_STATE_DIRS entry (.brain and .duin both blocked)', () => {
    for (const d of APP_STATE_DIRS) {
      mkdirSync(join(vault, d, 'nested'), { recursive: true })
      writeFileSync(join(vault, d, 'nested', `Ghost-${d}.md`), 'app-state, not a note')
      expect(resolveWikilink(vault, `Ghost-${d}`)).toBeNull()
    }
  })

  it('isVaultWalkDir: keeps real folders, prunes infra/app-state/_agui', () => {
    expect(isVaultWalkDir('People')).toBe(true)
    expect(isVaultWalkDir('.claude')).toBe(true) // tooling dot-folders are KEPT (indexed as knowledge)
    expect(isVaultWalkDir('.brain')).toBe(false)
    expect(isVaultWalkDir('.duin')).toBe(false)
    expect(isVaultWalkDir('.git')).toBe(false)
    expect(isVaultWalkDir('node_modules')).toBe(false)
    expect(isVaultWalkDir('_agui-run-42')).toBe(false)
  })
})
