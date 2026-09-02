// W7 — rehydrateMemoryFromVault must honor an EXTERNAL deletion.
//
// projectMemoryToVault is additive, so a memory deleted from userData keeps its vault copy forever, and
// the boot rehydrate restores "present in the vault, absent from userData" unless the tombstone journal
// says the user threw it away. The app's own delete writes that journal line (tombstoneToTrash). A file
// removed by hand (Explorer, `rm`, a sync client) produced no line — the store's watcher only dropped the
// index row — so every launch resurrected it. recordExternalDeletion is the journal line for that case:
// a delete with no `to`, because there are no bytes left to keep.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { writeMoatOrigin, projectMemoryToVault, rehydrateMemoryFromVault } from './moat-durability'
import { recordExternalDeletion, listTombstones, TRASH_DIR_NAME, TOMBSTONE_JOURNAL } from './local-brain/vault-trash'

const MEM_SUB = 'lamprey-memory'
const VAULT_MEM_SUB = join('.brain', '_memory-store')

let root: string
let userData: string
let vault: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'duin-ext-unlink-'))
  userData = join(root, 'userData')
  vault = join(root, 'vault')
  mkdirSync(join(userData, MEM_SUB), { recursive: true })
  mkdirSync(vault, { recursive: true })
  writeMoatOrigin(userData, vault)
})

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* best-effort cleanup */
  }
})

describe('recordExternalDeletion', () => {
  it('appends a delete line keyed on the live path, with no trash copy, that listTombstones tolerates', () => {
    const memoryRoot = join(userData, MEM_SUB)
    const gone = join(memoryRoot, 'nested', 'gone.md')

    expect(recordExternalDeletion(memoryRoot, gone, 'memory-store', 'external-unlink')).toBe(true)

    const journal = join(memoryRoot, TRASH_DIR_NAME, TOMBSTONE_JOURNAL)
    const lines = readFileSync(journal, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ actor: 'memory-store', from: 'nested/gone.md', op: 'delete', reason: 'external-unlink', external: true })
    expect(lines[0].to).toBeUndefined()
    expect(listTombstones(memoryRoot)).toEqual([]) // nothing recoverable, and the parser does not choke
    expect(recordExternalDeletion('', gone, 'memory-store')).toBe(false)
  })
})

describe('rehydrateMemoryFromVault — external unlink journal', () => {
  it('withholds the memory whose only journal line is the external form, and still restores an untouched one', () => {
    const memoryRoot = join(userData, MEM_SUB)
    const gone = join(memoryRoot, 'gone.md')
    const kept = join(memoryRoot, 'kept.md')
    writeFileSync(gone, '# gone\nremove me by hand\n', 'utf-8')
    writeFileSync(kept, '# kept\nreinstall brings me back\n', 'utf-8')
    expect(projectMemoryToVault(userData, vault)).toBeGreaterThanOrEqual(2)
    expect(existsSync(join(vault, VAULT_MEM_SUB, 'gone.md'))).toBe(true)

    // Both files vanish from userData. Only `gone.md` was seen removed by the watcher; `kept.md` models a
    // reinstall (absent, no journal line) and must come back.
    rmSync(gone)
    rmSync(kept)
    expect(recordExternalDeletion(memoryRoot, gone, 'memory-store', 'external-unlink')).toBe(true)

    expect(rehydrateMemoryFromVault(userData, vault)).toBe(1)
    expect(existsSync(kept)).toBe(true)
    expect(existsSync(gone)).toBe(false)
  })
})
