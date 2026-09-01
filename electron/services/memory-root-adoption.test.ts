// memory-root-adoption.test.ts — the memory the store could see on disk and never index.
//
// The store's path contract is `<base>/<projectSlug>/<name>.md`. `scanAndSync` honors it by
// walking `listProjectSlugs()`, which returns DIRECTORIES only, so a `.md` written straight to
// `<base>` matched no project and was never scanned. Nothing reported it: the file sat on disk
// looking filed, and was invisible to listing, retrieval and MEMORY.md forever.
//
// Measured on the live install 2026-07-30: `lamprey-memory/lark-cli-default.md`, a real operator
// preference written 07-29, while `memory_index` held 2 rows.
//
// Adoption MOVES the file into the default project rather than indexing it where it lies, because
// `writeMemoryFile` always derives its path from the project dir and never consults an existing
// record — indexing in place would leave two paths for one memory name, and the mirror is keyed by
// name. The one case it must refuse is a name collision, where overwriting would destroy one of
// the operator's two memories.
//
// The store is forced into its in-memory fallback so the suite does not need the Electron-ABI
// better-sqlite3 binding; the .md files on disk are canonical either way.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let TEST_USER_DATA = join(tmpdir(), `lamprey-memroot-test-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: { getPath: () => TEST_USER_DATA },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.mock('chokidar', () => ({
  default: {
    watch: () => ({
      on() {
        return this
      },
      close: async () => undefined
    })
  }
}))

import * as memStore from './memory-store'

const ROOT_MEMORY = `---
name: lark_cli_default
description: Reply to Theo on Feishu with rich formatting
type: feedback
---

Always use the md tag for native Feishu bullets.
`

function baseDir(): string {
  return join(TEST_USER_DATA, 'lamprey-memory')
}
function globalPath(file: string): string {
  return join(memStore.__memoryStoreTest.projectDir('__global__'), file)
}

beforeEach(() => {
  TEST_USER_DATA = mkdtempSync(join(tmpdir(), `lamprey-memroot-test-${process.pid}-`))
  mkdirSync(TEST_USER_DATA, { recursive: true })
  memStore.__memoryStoreTest.resetForTests()
  memStore.__memoryStoreTest.forceFallback()
})

describe('memory written at the store root is adopted, not silently invisible', () => {
  it('indexes a root-level .md by adopting it into the default project', () => {
    mkdirSync(baseDir(), { recursive: true })
    writeFileSync(join(baseDir(), 'lark_cli_default.md'), ROOT_MEMORY, 'utf-8')

    const listed = memStore.listMemoryFiles()

    // The load-bearing assertion: it is visible at all.
    expect(listed.map((m) => m.name)).toContain('lark_cli_default')
    // And it moved onto the contract, so a later edit writes to the same file it reads.
    expect(existsSync(globalPath('lark_cli_default.md'))).toBe(true)
    expect(existsSync(join(baseDir(), 'lark_cli_default.md'))).toBe(false)
    expect(readFileSync(globalPath('lark_cli_default.md'), 'utf-8')).toContain('native Feishu bullets')
  })

  it('refuses to adopt over an existing memory of the same name', () => {
    memStore.writeMemoryFile({
      name: 'lark_cli_default',
      description: 'the one already filed',
      type: 'feedback',
      body: 'ORIGINAL BODY — must survive',
      projectSlug: '__global__'
    })
    writeFileSync(join(baseDir(), 'lark_cli_default.md'), ROOT_MEMORY, 'utf-8')

    memStore.listMemoryFiles()

    // The filed memory is untouched; the stray is left where it was rather than clobbering it.
    expect(readFileSync(globalPath('lark_cli_default.md'), 'utf-8')).toContain('ORIGINAL BODY')
    expect(existsSync(join(baseDir(), 'lark_cli_default.md'))).toBe(true)
  })

  // The index and the in-memory mirror are keyed on `name` — frontmatter `name`, else the basename
  // — so two different FILENAMES can be one memory. Guarding only on `existsSync(dest)` let a root
  // file with a colliding frontmatter name land beside the real one; scanAndSync then indexed both,
  // whichever readdirSync returned last won the key, and the other memory silently vanished from
  // the index while its file sat on disk. Adoption would have turned "invisible" into "shadows
  // something real" — strictly worse than the bug it fixes.
  it('refuses to adopt when the FRONTMATTER NAME collides, even though the filename does not', () => {
    memStore.writeMemoryFile({
      name: 'lark_cli_default',
      description: 'the one already filed',
      type: 'feedback',
      body: 'ORIGINAL BODY — must survive',
      projectSlug: '__global__'
    })
    // Different FILENAME, same index key.
    writeFileSync(join(baseDir(), 'lark-cli-default.md'), ROOT_MEMORY, 'utf-8')

    const listed = memStore.listMemoryFiles()

    // The filed memory still owns the name and its body is intact.
    expect(readFileSync(globalPath('lark_cli_default.md'), 'utf-8')).toContain('ORIGINAL BODY')
    expect(memStore.readMemoryFile('lark_cli_default')?.body).toContain('ORIGINAL BODY')
    // The stray was left where it was rather than shadowing it.
    expect(existsSync(join(baseDir(), 'lark-cli-default.md'))).toBe(true)
    expect(existsSync(globalPath('lark-cli-default.md'))).toBe(false)
    // Exactly one memory owns that name.
    expect(listed.filter((m) => m.name === 'lark_cli_default')).toHaveLength(1)
  })

  it('leaves MEMORY.md and dotfiles at the root alone', () => {
    mkdirSync(baseDir(), { recursive: true })
    writeFileSync(join(baseDir(), 'MEMORY.md'), '# index, not a memory', 'utf-8')
    writeFileSync(join(baseDir(), '.migrated-from-sqlite'), 'v1', 'utf-8')

    memStore.listMemoryFiles()

    // MEMORY.md is the generated index, not a memory (isMemoryFile excludes `memory.*`), and a
    // dotfile is store bookkeeping. Adopting either would file DUIN's own plumbing as an
    // operator memory.
    expect(existsSync(join(baseDir(), 'MEMORY.md'))).toBe(true)
    expect(existsSync(join(baseDir(), '.migrated-from-sqlite'))).toBe(true)
    expect(existsSync(globalPath('MEMORY.md'))).toBe(false) // not moved into the project
    expect(memStore.listMemoryFiles().map((m) => m.name)).not.toContain('MEMORY')
  })
})
