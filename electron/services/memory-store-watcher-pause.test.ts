import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// The cold-start regression behind pauseMemoryStoreWatcher, run against the REAL chokidar (the
// sibling memory-store.test.ts stubs it out). moat-durability's vault switch does exactly the
// `rmSync(<userData>/lamprey-memory, { recursive: true })` below; with the watcher armed, Windows
// refuses it (ReadDirectoryChangesW holds every watched directory open) and every first-run folder
// pick failed at "Vault durability moat failed: vault switch cleanup failed: lamprey-memory".

let TEST_USER_DATA = mkdtempSync(join(tmpdir(), `lamprey-memstore-pause-${process.pid}-`))

vi.mock('electron', () => ({
  app: { getPath: () => TEST_USER_DATA },
  BrowserWindow: { getAllWindows: () => [] }
}))

import * as memStore from './memory-store'

const memoryDir = (): string => join(TEST_USER_DATA, 'lamprey-memory')

afterEach(async () => {
  await memStore.pauseMemoryStoreWatcher()
  memStore.__memoryStoreTest.resetForTests()
  try {
    rmSync(TEST_USER_DATA, { recursive: true, force: true })
  } catch {
    /* best effort — a lingering SQLite handle on Windows; the OS temp cleanup takes the rest */
  }
  TEST_USER_DATA = mkdtempSync(join(tmpdir(), `lamprey-memstore-pause-${process.pid}-`))
})

describe('pauseMemoryStoreWatcher — the vault switch can remove lamprey-memory', () => {
  it('releases the directory handles so a recursive remove succeeds, and resume re-creates the store', async () => {
    memStore.__memoryStoreTest.forceFallback()
    memStore.initializeMemoryStore()
    expect(existsSync(join(memoryDir(), '__global__'))).toBe(true)
    // A memory file inside the watched tree, the shape the switch deletes and rehydrates.
    writeFileSync(join(memoryDir(), '__global__', 'note.md'), '---\nname: note\n---\nbody\n')
    await memStore.__memoryStoreTest.whenWatcherReady()

    // The lock itself only shows under Electron's main process (plain Node's fs.watch opens the
    // directories with share-delete and the remove goes through), so this proves the CONTRACT the
    // vault switch relies on — released handles, a clean remove, a working re-arm — and the
    // defect is pinned by the live cold-start run recorded in the commit, not by a platform assert.
    await memStore.pauseMemoryStoreWatcher()
    expect(() => rmSync(memoryDir(), { recursive: true, force: true })).not.toThrow()
    expect(existsSync(memoryDir())).toBe(false)

    memStore.resumeMemoryStoreWatcher()
    expect(existsSync(join(memoryDir(), '__global__'))).toBe(true)
    await memStore.__memoryStoreTest.whenWatcherReady()
  })

  it('is a no-op when nothing is armed, and pause is idempotent', async () => {
    await expect(memStore.pauseMemoryStoreWatcher()).resolves.toBeUndefined()
    memStore.__memoryStoreTest.forceFallback()
    memStore.initializeMemoryStore()
    await memStore.pauseMemoryStoreWatcher()
    await expect(memStore.pauseMemoryStoreWatcher()).resolves.toBeUndefined()
  })
})
