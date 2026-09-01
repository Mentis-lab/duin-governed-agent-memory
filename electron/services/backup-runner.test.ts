import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  statSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  utimesSync,
  symlinkSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let appPathForTest = '.'

vi.mock('electron', () => ({
  app: {
    getPath: () => appPathForTest
  }
}))

import {
  createBackup,
  listBackups,
  pruneOldBackups,
  restoreFromBackup,
  startBackupRunner,
  createLocalBrainBackup,
  listLocalBrainBackups,
  pruneLocalBrainBackups
} from './backup-runner'

const HAS_NATIVE_SQLITE: boolean = (() => {
  try {
    const probe = new BetterSqlite3(':memory:')
    probe.close()
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!HAS_NATIVE_SQLITE)('backup-runner (PS5)', () => {
  let tmpDir: string
  let dbPath: string
  let backupDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lamprey-ps5-'))
    appPathForTest = tmpDir
    dbPath = join(tmpDir, 'lamprey.db')
    backupDir = join(tmpDir, 'backups')

    // Seed a real DB with some content so the backup has something to copy.
    const db = new BetterSqlite3(dbPath)
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    const insert = db.prepare('INSERT INTO t (v) VALUES (?)')
    for (let i = 0; i < 50; i++) insert.run(`val-${i}`)
    db.close()
  }, 60_000)

  afterEach(() => {
    // Best-effort temp cleanup. On Windows, better-sqlite3 13 (N-API) can hold the sqlite file
    // handle until GC/process-exit even after close(), so rmSync of the temp dir may EPERM. The
    // product closes every handle (onlineCopySqlite finally) and never deletes its DB dir mid-
    // session, so this is a test-only OS-cleanup artifact — never fail the test on it (the temp
    // dir is reclaimed at reboot). The assertions above are what this test verifies.
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
    } catch (e) {
      void e // EPERM: OS still holds a sqlite handle; leave the temp dir for OS cleanup
    }
  }, 60_000)

  it('createBackup creates a valid copy under YYYY-MM-DD filename', async () => {
    const info = await createBackup(dbPath, backupDir, 'test')
    expect(existsSync(info.path)).toBe(true)
    expect(info.name).toMatch(/^lamprey-\d{4}-\d{2}-\d{2}\.db$/)
    expect(info.bytes).toBeGreaterThan(0)
    expect(info.reason).toBe('test')

    // Verify the copy is a valid SQLite DB with the seeded data.
    const copy = new BetterSqlite3(info.path, { readonly: true })
    const row = copy.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }
    expect(row.c).toBe(50)
    copy.close()
  })

  it('createBackup is idempotent within the same day (overwrites)', async () => {
    await createBackup(dbPath, backupDir, 'first')
    const second = await createBackup(dbPath, backupDir, 'second')
    expect(second.reason).toBe('second')
    const list = listBackups(backupDir)
    expect(list).toHaveLength(1)
  })

  it('listBackups returns newest-first', () => {
    // Stamp two files manually with distinct mtimes.
    const path1 = join(backupDir, 'lamprey-2026-01-01.db')
    const path2 = join(backupDir, 'lamprey-2026-06-01.db')
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(path1, 'fake1')
    writeFileSync(path2, 'fake2')
    // Set mtimes deliberately.
    utimesSync(path1, new Date('2026-01-01'), new Date('2026-01-01'))
    utimesSync(path2, new Date('2026-06-01'), new Date('2026-06-01'))
    const list = listBackups(backupDir)
    expect(list).toHaveLength(2)
    expect(list[0].name).toBe('lamprey-2026-06-01.db')
    expect(list[1].name).toBe('lamprey-2026-01-01.db')
  })

  it('listBackups returns empty array when backupDir does not exist', () => {
    expect(listBackups(join(tmpDir, 'nope'))).toEqual([])
  })

  it('listBackups skips files that do not match the naming pattern', () => {
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(join(backupDir, 'lamprey-2026-06-01.db'), 'ok')
    writeFileSync(join(backupDir, 'random.db'), 'no')
    writeFileSync(join(backupDir, 'lamprey-2026-06-01.db.bak'), 'no')
    const list = listBackups(backupDir)
    expect(list.map((b) => b.name)).toEqual(['lamprey-2026-06-01.db'])
  })

  it('pruneOldBackups deletes files older than retentionDays', () => {
    mkdirSync(backupDir, { recursive: true })
    const old = join(backupDir, 'lamprey-2020-01-01.db')
    const recent = join(backupDir, 'lamprey-2026-06-01.db')
    writeFileSync(old, 'old')
    writeFileSync(recent, 'recent')
    const twentyDaysAgo = Date.now() - 20 * 24 * 60 * 60 * 1000
    utimesSync(old, new Date(twentyDaysAgo - 86400_000), new Date(twentyDaysAgo - 86400_000))
    utimesSync(recent, new Date(), new Date())
    const deleted = pruneOldBackups(backupDir, 14)
    expect(deleted).toContain(old)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })

  it('restoreFromBackup swaps in the backup and preserves the pre-restore copy', async () => {
    const backup = await createBackup(dbPath, backupDir, 'baseline')

    // Corrupt the live DB.
    writeFileSync(dbPath, Buffer.alloc(128, 0xff))

    const info = await restoreFromBackup(dbPath, backup.path)
    expect(info.movedTo).toMatch(/\.pre-restore-/)
    expect(existsSync(info.movedTo)).toBe(true)
    expect(existsSync(dbPath)).toBe(true)
    // The corrupt live DB is preserved (byte-for-byte) under the pre-restore path.
    expect(statSync(info.movedTo).size).toBe(128)

    // The restored DB should be valid and contain the seeded rows.
    const reopened = new BetterSqlite3(dbPath, { readonly: true })
    const row = reopened.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }
    expect(row.c).toBe(50)
    reopened.close()
  })

  it('restoreFromBackup refuses a backup that fails integrity verification (live DB untouched)', async () => {
    // Write a file with a valid backup NAME but garbage (non-SQLite) content.
    const badBackup = join(backupDir, 'lamprey-2026-06-01.db')
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(badBackup, Buffer.alloc(256, 0xab))

    // Snapshot the live DB so we can prove it was untouched.
    const before = statSync(dbPath)
    await expect(restoreFromBackup(dbPath, badBackup)).rejects.toThrowError(
      /failed verification/
    )
    // Live DB still present + same size; no temp / pre-restore left behind.
    expect(existsSync(dbPath)).toBe(true)
    expect(statSync(dbPath).size).toBe(before.size)
    expect(existsSync(`${dbPath}.restore-tmp`)).toBe(false)
  })

  it('restoreFromBackup refuses unrecognized backup filenames', async () => {
    const weird = join(tmpDir, 'random.db')
    writeFileSync(weird, 'no')
    await expect(restoreFromBackup(dbPath, weird)).rejects.toThrowError(
      /not a recognized backup filename/
    )
  })

  it('restoreFromBackup refuses missing backup path', async () => {
    await expect(
      restoreFromBackup(dbPath, join(backupDir, 'lamprey-2026-06-01.db'))
    ).rejects.toThrowError(/backup file not found/)
  })

  it('F12: refuses a backup-named SQLite OUTSIDE the allowed dir (path confinement)', async () => {
    // A valid, healthy, correctly-named backup planted somewhere the operator's backups dir does
    // not contain — the old checks (name + existence + health) all pass; only containment stops it.
    const backup = await createBackup(dbPath, backupDir) // a real, health-passing backup
    const outsideDir = mkdtempSync(join(tmpdir(), 'lamprey-elsewhere-'))
    const planted = join(outsideDir, 'lamprey-2026-06-01.db')
    writeFileSync(planted, readFileSync(backup.path)) // byte-identical, health-passing, right name
    try {
      await expect(
        restoreFromBackup(dbPath, planted, { allowedDir: backupDir })
      ).rejects.toThrowError(/outside the backups directory/)
      // and a path INSIDE the allowed dir still restores (negative control)
      const info = await restoreFromBackup(dbPath, backup.path, { allowedDir: backupDir })
      expect(info).toBeTruthy()
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('confinement is MANDATORY: with no allowedDir, a healthy named backup outside <db dir>/backups is refused', async () => {
    // The caller-supplied pin above is opt-in; this pins the always-on realpath confinement so a
    // call site that forgets allowedDir still cannot restore from an arbitrary renderer path.
    const externalDir = join(tmpDir, 'external')
    const externalBackup = join(externalDir, 'lamprey-2026-06-01.db')
    mkdirSync(backupDir, { recursive: true })
    mkdirSync(externalDir, { recursive: true })
    const external = new BetterSqlite3(externalBackup)
    external.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    external.close()

    await expect(restoreFromBackup(dbPath, externalBackup)).rejects.toThrowError(
      /outside the owned backups directory/
    )
  })
})

describe.skipIf(!HAS_NATIVE_SQLITE)('backup-runner — local-brain.db (B1)', () => {
  let tmpDir: string
  let lbPath: string
  let backupDir: string

  function seedLocalBrain(path: string, rows: number): void {
    const db = new BetterSqlite3(path)
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, v TEXT)')
    const ins = db.prepare('INSERT INTO chunks (v) VALUES (?)')
    for (let i = 0; i < rows; i++) ins.run(`chunk-${i}`)
    db.close()
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lamprey-lb-'))
    appPathForTest = tmpDir
    lbPath = join(tmpDir, 'local-brain.db')
    backupDir = join(tmpDir, 'backups')
    seedLocalBrain(lbPath, 40)
  })
  afterEach(() => {
    // Best-effort temp cleanup. On Windows, better-sqlite3 13 (N-API) can hold the sqlite file
    // handle until GC/process-exit even after close(), so rmSync of the temp dir may EPERM. The
    // product closes every handle (onlineCopySqlite finally) and never deletes its DB dir mid-
    // session, so this is a test-only OS-cleanup artifact — never fail the test on it (the temp
    // dir is reclaimed at reboot). The assertions above are what this test verifies.
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
    } catch (e) {
      void e // EPERM: OS still holds a sqlite handle; leave the temp dir for OS cleanup
    }
  })

  it('createLocalBrainBackup writes a valid WAL-safe online copy', async () => {
    const info = await createLocalBrainBackup(lbPath, backupDir, 'test')
    expect(info).not.toBeNull()
    expect(info!.name).toMatch(/^local-brain-\d{4}-\d{2}-\d{2}\.db$/)
    expect(existsSync(info!.path)).toBe(true)
    // The copy is a valid SQLite DB with the seeded rows (proves it's not a torn raw copy).
    const copy = new BetterSqlite3(info!.path, { readonly: true })
    const row = copy.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number }
    expect(row.c).toBe(40)
    copy.close()
  })

  it('returns null (no-op) when the index does not exist yet', async () => {
    const info = await createLocalBrainBackup(join(tmpDir, 'nope.db'), backupDir, 'test')
    expect(info).toBeNull()
  })

  it('list is newest-first and does NOT overlap the lamprey backup list', async () => {
    await createLocalBrainBackup(lbPath, backupDir, 'test')
    writeFileSync(join(backupDir, 'lamprey-2026-06-01.db'), 'fake')
    const lb = listLocalBrainBackups(backupDir)
    expect(lb).toHaveLength(1) // only the local-brain file
    expect(lb[0].name).toMatch(/^local-brain-/)
    expect(listBackups(backupDir).map((b) => b.name)).toEqual(['lamprey-2026-06-01.db']) // disjoint
  })

  it('pruneLocalBrainBackups keeps only the newest N by count', () => {
    mkdirSync(backupDir, { recursive: true })
    // Fabricate 5 dated snapshots with ascending mtimes.
    for (let i = 1; i <= 5; i++) {
      const p = join(backupDir, `local-brain-2026-06-0${i}.db`)
      writeFileSync(p, `snap-${i}`)
      utimesSync(p, new Date(`2026-06-0${i}`), new Date(`2026-06-0${i}`))
    }
    const deleted = pruneLocalBrainBackups(backupDir, 2)
    expect(deleted).toHaveLength(3)
    const kept = listLocalBrainBackups(backupDir).map((b) => b.name)
    expect(kept).toEqual(['local-brain-2026-06-05.db', 'local-brain-2026-06-04.db'])
  })
})

// B4 — atomic restore. These exercise the real fs swap/rollback/sidecar logic
// but inject the copy + verify seams, so they run WITHOUT native SQLite (the
// SQLite-backed end-to-end cases above are skipIf-guarded).
describe('backup-runner — atomic restore (B4)', () => {
  let tmpDir: string
  let dbPath: string
  let backupDir: string
  let backupPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lamprey-b4-'))
    appPathForTest = tmpDir
    dbPath = join(tmpDir, 'lamprey.db')
    backupDir = join(tmpDir, 'backups')
    mkdirSync(backupDir, { recursive: true })
    // A file with a valid backup NAME. Content is opaque here — the copy +
    // verify steps are injected, so real SQLite is never touched.
    backupPath = join(backupDir, 'lamprey-2026-06-01.db')
    writeFileSync(backupPath, 'BACKUP-BYTES')
  })

  afterEach(() => {
    // Best-effort temp cleanup. On Windows, better-sqlite3 13 (N-API) can hold the sqlite file
    // handle until GC/process-exit even after close(), so rmSync of the temp dir may EPERM. The
    // product closes every handle (onlineCopySqlite finally) and never deletes its DB dir mid-
    // session, so this is a test-only OS-cleanup artifact — never fail the test on it (the temp
    // dir is reclaimed at reboot). The assertions above are what this test verifies.
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
    } catch (e) {
      void e // EPERM: OS still holds a sqlite handle; leave the temp dir for OS cleanup
    }
  })

  // KEY TEST: a restore whose verification FAILS must leave the ORIGINAL live DB
  // in place — never a missing/partial DB.
  it('verification failure of the temp leaves the original live DB intact', async () => {
    writeFileSync(dbPath, 'ORIGINAL-LIVE')
    // copy writes a (would-be) restored temp; verify passes for the backup
    // source but FAILS for the temp — simulating a corrupt/partial copy.
    const copyInto = vi.fn(async (_src: string, dest: string) => {
      writeFileSync(dest, 'PARTIAL-RESTORE')
    })
    const verify = vi.fn((p: string) => {
      if (p.endsWith('.restore-tmp')) throw new Error('integrity_check returned not-ok')
    })

    await expect(
      restoreFromBackup(dbPath, backupPath, { copyInto, verify })
    ).rejects.toThrowError(/failed verification.*live DB untouched/)

    // Original live DB byte-for-byte intact.
    expect(readFileSync(dbPath, 'utf8')).toBe('ORIGINAL-LIVE')
    // Temp cleaned up; no pre-restore aside file created (we never reached the swap).
    expect(existsSync(`${dbPath}.restore-tmp`)).toBe(false)
    expect(existsSync(dbPath)).toBe(true)
    expect(copyInto).toHaveBeenCalledOnce()
  })

  // Step 1 guard: a corrupt BACKUP SOURCE must be refused BEFORE any copy/swap,
  // so the live DB is never touched and no temp/aside file is created.
  it('refuses to restore when the backup SOURCE fails verification (live DB untouched, no temp/aside)', async () => {
    writeFileSync(dbPath, 'ORIGINAL-LIVE')
    const copyInto = vi.fn(async () => {})
    const verify = vi.fn((p: string) => {
      if (p === backupPath) throw new Error('integrity_check returned not-ok')
    })

    await expect(
      restoreFromBackup(dbPath, backupPath, { copyInto, verify })
    ).rejects.toThrowError(/backup failed verification, refusing to restore/)

    // Live DB byte-for-byte intact; step 1 aborts before copy, so nothing else happened.
    expect(readFileSync(dbPath, 'utf8')).toBe('ORIGINAL-LIVE')
    expect(existsSync(`${dbPath}.restore-tmp`)).toBe(false)
    expect(readdirSync(tmpDir).filter((f) => f.includes('.pre-restore-'))).toEqual([])
    expect(copyInto).not.toHaveBeenCalled()
  })

  it('refuses a backup reached through a symlink or junction escape', async () => {
    const externalDir = join(tmpDir, 'external')
    const linkedDir = join(backupDir, 'linked-external')
    const externalBackup = join(externalDir, 'lamprey-2026-06-02.db')
    mkdirSync(externalDir)
    writeFileSync(externalBackup, 'EXTERNAL-BACKUP')
    symlinkSync(externalDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir')

    const copyInto = vi.fn(async () => {})
    const verify = vi.fn(() => {})
    await expect(
      restoreFromBackup(dbPath, join(linkedDir, 'lamprey-2026-06-02.db'), {
        copyInto,
        verify
      })
    ).rejects.toThrowError(/outside the owned backups directory/)
    expect(verify).not.toHaveBeenCalled()
    expect(copyInto).not.toHaveBeenCalled()
  })

  it('successful injected restore swaps in the temp and preserves the pre-restore copy', async () => {
    writeFileSync(dbPath, 'ORIGINAL-LIVE')
    const copyInto = vi.fn(async (_src: string, dest: string) => {
      writeFileSync(dest, 'RESTORED-BYTES')
    })
    const verify = vi.fn(() => {}) // both source + temp pass

    const info = await restoreFromBackup(dbPath, backupPath, { copyInto, verify })

    // Live path now holds the restored bytes.
    expect(readFileSync(dbPath, 'utf8')).toBe('RESTORED-BYTES')
    // Pre-restore copy preserved with the original bytes.
    expect(info.movedTo).toMatch(/\.pre-restore-/)
    expect(readFileSync(info.movedTo, 'utf8')).toBe('ORIGINAL-LIVE')
    // Temp consumed by the swap.
    expect(existsSync(`${dbPath}.restore-tmp`)).toBe(false)
  })

  it('rolls back to the original live DB when the final swap fails', async () => {
    writeFileSync(dbPath, 'ORIGINAL-LIVE')
    // copy is a no-op → the temp is never created → the final rename(temp → live)
    // throws ENOENT, exercising the rollback path.
    const copyInto = vi.fn(async () => {})
    const verify = vi.fn(() => {}) // verify is injected, so the missing temp passes

    await expect(
      restoreFromBackup(dbPath, backupPath, { copyInto, verify })
    ).rejects.toThrowError(/final swap failed, rolled back/)

    // Rollback restored the live DB from the aside copy…
    expect(existsSync(dbPath)).toBe(true)
    expect(readFileSync(dbPath, 'utf8')).toBe('ORIGINAL-LIVE')
    // …and no pre-restore orphan is left in the dir (the aside file was renamed back).
    const orphans = readdirSync(tmpDir).filter((f) => f.includes('.pre-restore-'))
    expect(orphans).toEqual([])
    expect(existsSync(`${dbPath}.restore-tmp`)).toBe(false)
  })

  it('moves the -wal/-shm sidecars aside during the swap', async () => {
    writeFileSync(dbPath, 'LIVE')
    writeFileSync(`${dbPath}-wal`, 'WAL-BYTES')
    writeFileSync(`${dbPath}-shm`, 'SHM-BYTES')
    const copyInto = vi.fn(async (_src: string, dest: string) => {
      writeFileSync(dest, 'RESTORED')
    })
    const verify = vi.fn(() => {})

    const info = await restoreFromBackup(dbPath, backupPath, { copyInto, verify })

    // Restored DB in place; the STALE sidecars are gone from the live path so
    // SQLite cannot replay a WAL onto the restored file.
    expect(readFileSync(dbPath, 'utf8')).toBe('RESTORED')
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
    expect(existsSync(`${dbPath}-shm`)).toBe(false)
    // The sidecars were preserved alongside the pre-restore DB.
    expect(readFileSync(`${info.movedTo}-wal`, 'utf8')).toBe('WAL-BYTES')
    expect(readFileSync(`${info.movedTo}-shm`, 'utf8')).toBe('SHM-BYTES')
  })

  it('deletes the temp and leaves the live DB untouched when the copy fails', async () => {
    writeFileSync(dbPath, 'ORIGINAL-LIVE')
    const copyInto = vi.fn(async (_src: string, dest: string) => {
      // Simulate a mid-copy crash: a partial temp exists, then the copy throws.
      writeFileSync(dest, 'HALF')
      throw new Error('disk full')
    })
    const verify = vi.fn(() => {}) // backup source passes

    await expect(
      restoreFromBackup(dbPath, backupPath, { copyInto, verify })
    ).rejects.toThrowError(/failed to copy backup into temp.*live DB untouched/)

    expect(readFileSync(dbPath, 'utf8')).toBe('ORIGINAL-LIVE')
    expect(existsSync(`${dbPath}.restore-tmp`)).toBe(false)
    // No pre-restore aside file (we never reached the swap).
    expect(existsSync(dbPath)).toBe(true)
  })

  it('restore into a fresh slot (no live DB yet) still verifies + swaps', async () => {
    // No dbPath on disk. copy + verify succeed.
    const copyInto = vi.fn(async (_src: string, dest: string) => {
      writeFileSync(dest, 'RESTORED-FRESH')
    })
    const verify = vi.fn(() => {})

    const info = await restoreFromBackup(dbPath, backupPath, { copyInto, verify })
    expect(readFileSync(dbPath, 'utf8')).toBe('RESTORED-FRESH')
    // Nothing to move aside → pre-restore path advertised but not created.
    expect(info.movedTo).toMatch(/\.pre-restore-/)
    expect(existsSync(info.movedTo)).toBe(false)
  })
})

// B5 — createBackup must not overwrite an existing same-day backup with an
// UNVERIFIED copy. These inject the copy + verify seams (same seam the B4
// restore tests use) so they run WITHOUT native SQLite — the native-backed
// cases above are skipIf-guarded and skip SILENTLY in this environment.
describe('backup-runner — verified same-day overwrite (B5)', () => {
  let tmpDir: string
  let dbPath: string
  let backupDir: string
  let todayPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lamprey-b5-'))
    appPathForTest = tmpDir
    dbPath = join(tmpDir, 'lamprey.db')
    backupDir = join(tmpDir, 'backups')
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(dbPath, 'LIVE-DB')
    // The 09:00 tick already wrote a healthy backup under today's filename.
    todayPath = join(backupDir, `lamprey-${new Date().toISOString().slice(0, 10)}.db`)
    writeFileSync(todayPath, 'GOOD-MORNING-BACKUP')
  })

  afterEach(() => {
    // Best-effort temp cleanup. On Windows, better-sqlite3 13 (N-API) can hold the sqlite file
    // handle until GC/process-exit even after close(), so rmSync of the temp dir may EPERM. The
    // product closes every handle (onlineCopySqlite finally) and never deletes its DB dir mid-
    // session, so this is a test-only OS-cleanup artifact — never fail the test on it (the temp
    // dir is reclaimed at reboot). The assertions above are what this test verifies.
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
    } catch (e) {
      void e // EPERM: OS still holds a sqlite handle; leave the temp dir for OS cleanup
    }
  })

  // KEY TEST: the live DB has become corrupt-but-readable, so the copy SUCCEEDS
  // (throws nothing) and only verification catches it. The morning's good backup
  // — possibly today's only recovery point — must survive byte-for-byte.
  it('a corrupt-but-readable source does NOT clobber the existing same-day backup', async () => {
    const copyInto = vi.fn(async (_src: string, dest: string) => {
      // Faithful copy of a malformed source: no error at all.
      writeFileSync(dest, 'MALFORMED-IMAGE')
    })
    const verify = vi.fn((p: string) => {
      if (p.endsWith('.tmp')) throw new Error('integrity_check returned *** in database main ***')
    })

    await expect(
      createBackup(dbPath, backupDir, 'periodic', { copyInto, verify })
    ).rejects.toThrowError(/failed verification, refusing to overwrite/)

    // The morning backup is untouched — this is the whole point.
    expect(readFileSync(todayPath, 'utf8')).toBe('GOOD-MORNING-BACKUP')
    // The rejected copy is dropped, and never under a name listBackups advertises.
    expect(existsSync(`${todayPath}.tmp`)).toBe(false)
    expect(listBackups(backupDir).map((b) => b.name)).toEqual([
      `lamprey-${new Date().toISOString().slice(0, 10)}.db`
    ])
    // Verification ran on the temp, not on the published day file.
    expect(verify).toHaveBeenCalledWith(`${todayPath}.tmp`)
  })

  it('a mid-copy failure leaves the existing same-day backup intact', async () => {
    const copyInto = vi.fn(async (_src: string, dest: string) => {
      writeFileSync(dest, 'HALF')
      throw new Error('disk full')
    })
    const verify = vi.fn(() => {})

    await expect(
      createBackup(dbPath, backupDir, 'periodic', { copyInto, verify })
    ).rejects.toThrowError(/copy failed.*left intact/)

    expect(readFileSync(todayPath, 'utf8')).toBe('GOOD-MORNING-BACKUP')
    expect(existsSync(`${todayPath}.tmp`)).toBe(false)
    expect(verify).not.toHaveBeenCalled()
  })

  it('a VERIFIED copy still replaces the same-day backup (overwrite stays intended)', async () => {
    const copyInto = vi.fn(async (_src: string, dest: string) => {
      writeFileSync(dest, 'FRESH-HEALTHY-BACKUP')
    })
    const verify = vi.fn(() => {})

    const info = await createBackup(dbPath, backupDir, 'periodic', { copyInto, verify })

    expect(info.path).toBe(todayPath)
    expect(readFileSync(todayPath, 'utf8')).toBe('FRESH-HEALTHY-BACKUP')
    expect(info.bytes).toBe('FRESH-HEALTHY-BACKUP'.length)
    // Copy went to the temp and was published by rename; no temp survives.
    expect(copyInto).toHaveBeenCalledWith(dbPath, `${todayPath}.tmp`)
    expect(existsSync(`${todayPath}.tmp`)).toBe(false)
    expect(listBackups(backupDir)).toHaveLength(1)
  })

  it('first-ever backup of a corrupt DB publishes nothing (no bogus recovery point)', async () => {
    rmSync(todayPath)
    const copyInto = vi.fn(async (_src: string, dest: string) => {
      writeFileSync(dest, 'MALFORMED-IMAGE')
    })
    const verify = vi.fn(() => {
      throw new Error('integrity_check returned not-ok')
    })

    await expect(
      createBackup(dbPath, backupDir, 'periodic', { copyInto, verify })
    ).rejects.toThrowError(/failed verification, refusing to overwrite/)

    // Nothing advertised as a backup — an unverified file must never enter the list.
    expect(listBackups(backupDir)).toEqual([])
    expect(existsSync(`${todayPath}.tmp`)).toBe(false)
  })
})

describe('backup-runner timer lifecycle', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lamprey-ps5-timer-'))
    appPathForTest = tmpDir
  })

  afterEach(() => {
    // Best-effort temp cleanup. On Windows, better-sqlite3 13 (N-API) can hold the sqlite file
    // handle until GC/process-exit even after close(), so rmSync of the temp dir may EPERM. The
    // product closes every handle (onlineCopySqlite finally) and never deletes its DB dir mid-
    // session, so this is a test-only OS-cleanup artifact — never fail the test on it (the temp
    // dir is reclaimed at reboot). The assertions above are what this test verifies.
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
    } catch (e) {
      void e // EPERM: OS still holds a sqlite handle; leave the temp dir for OS cleanup
    }
  })

  it('stop cancels the delayed first periodic backup tick', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const stop = startBackupRunner({ intervalMs: 60_000 })
      stop()
      await vi.advanceTimersByTimeAsync(30_001)
      expect(warn).not.toHaveBeenCalledWith(
        '[backup-runner] periodic backup failed:',
        expect.anything()
      )
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })
})
