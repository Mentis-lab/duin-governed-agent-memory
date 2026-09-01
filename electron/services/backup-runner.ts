import Database from 'better-sqlite3'
import { app } from 'electron'
import { join, basename, dirname, relative, isAbsolute, resolve, sep } from 'path'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync
} from 'fs'
import { getDb, checkpoint } from './database'
import { recordEvent, pruneEvents } from './event-log'
import { messageOf } from './guarded'
import { backupMoatState } from './local-brain/moat-backup'
import { readSettings } from './settings-helper'

// Persistence Phase / PS5 — daily SQLite backups + rolling retention +
// restore.
//
// better-sqlite3 exposes db.backup(destPath, opts) which is a wrapper
// around SQLite's online backup API. Page-by-page copy with explicit
// step size means we can run it while the DB is in use without blocking
// writes for the full duration. We use a 100-page step (~400 KB at the
// default 4KB page size) with no yield between steps — the call is
// synchronous from JS's point of view, but each step releases the
// shared lock so streaming writes proceed in between.
//
// Backups live at `userData/backups/lamprey-YYYY-MM-DD.db` (one per
// day; same-day calls overwrite — but only VERIFIED-through-temp, see B5
// on createBackup: the day file is never written in place, so a corrupt
// source can't silently destroy an earlier good backup for the same day).
//
// Restore is ATOMIC (B4). `restoreFromBackup` never overwrites the live
// DB in place. It copies the backup into a temp file, verifies the temp
// (PRAGMA integrity_check + table presence), then swaps: the live DB
// (+ its -wal/-shm sidecars) is moved aside to `.pre-restore-<ts>` and
// the verified temp is renamed onto `dbPath`. If any step fails the live
// DB is left untouched (early steps) or rolled back from the aside copy
// (final swap) — at no point is `dbPath` missing or partial. The caller
// is expected to relaunch the app afterwards because the live `db`
// handle in database.ts will still point at the moved-aside file.

export interface BackupInfo {
  path: string
  /** Display label, e.g. 'lamprey-2026-06-06.db'. */
  name: string
  /** When the file was last modified (= backup time). */
  mtime: number
  /** File size in bytes. */
  bytes: number
  /** Reason recorded at create time (free-form). */
  reason?: string
}

const BACKUP_FILE_PATTERN = /^lamprey-(\d{4}-\d{2}-\d{2})\.db$/
// local-brain.db (the vector index) — its OWN filename namespace + retention so it
// never collides with, nor gets pruned by, the lamprey.db backup accounting.
const LOCAL_BRAIN_FILE_PATTERN = /^local-brain-(\d{4}-\d{2}-\d{2})\.db$/

const DEFAULT_RETENTION_DAYS = 14
// local-brain.db is ~30 MB; keep a small COUNT (not a day-window) so disk stays bounded.
const DEFAULT_LOCAL_BRAIN_KEEP = 5
const BACKUP_STEP_PAGES = 100

/**
 * WAL-SAFE online copy of a live SQLite DB. Opens a FRESH read-only handle and drives
 * SQLite's online backup API (better-sqlite3 `db.backup`) page-by-page — each 100-page
 * step releases the shared lock so a concurrent writer proceeds. This reads a consistent,
 * committed snapshot INCLUDING un-checkpointed WAL pages. It is NEVER a raw fs copy of a
 * live WAL DB (which would tear across the -wal sidecar and yield a corrupt file).
 */
async function onlineCopySqlite(srcDbPath: string, destPath: string): Promise<void> {
  const source = new Database(srcDbPath, { readonly: true, fileMustExist: true })
  try {
    await source.backup(destPath, { progress: () => BACKUP_STEP_PAGES })
  } finally {
    try {
      source.close()
    } catch (e) { console.debug('[backup-runner] already closed:', messageOf(e)) }
  }
}

function ymdUtc(date: Date): string {
  // YYYY-MM-DD in UTC so a user crossing midnight in their local
  // timezone doesn't accidentally double-backup or skip a day.
  return date.toISOString().slice(0, 10)
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/**
 * PS5 — create a backup of `dbPath` under `backupDir`. Returns metadata
 * about the created file. Same-day calls overwrite (the filename is
 * the YYYY-MM-DD stamp). Reason is recorded for the audit trail (PS22).
 *
 * Strategy:
 *   1. Checkpoint the live DB first so the backup is taken from the
 *      main DB file rather than the WAL — guarantees the backup is a
 *      consistent snapshot at the moment of the checkpoint.
 *   2. Use better-sqlite3's `db.backup(destPath, { progress })` for the
 *      online copy. The callback receives `{ totalPages, remainingPages }`
 *      after each step; we don't surface progress to the renderer yet
 *      (PS10 could) but log it.
 *
 * B5 — WRITE-THROUGH-TEMP (same guards restoreFromBackup uses, and for the
 * same reason). Same-day calls overwrite a filename that may already hold the
 * ONLY good recovery point for today. A corrupt-but-READABLE source (bad
 * sector, interrupted write) copies faithfully and throws NOTHING: SQLite's
 * online-backup API rolls the destination back when a copy *fails*, but a
 * successful copy of corrupt pages is reported as success. Copying straight
 * onto `destPath` therefore replaces this morning's healthy backup with a
 * malformed file that `listBackups` keeps advertising — the loss only surfaces
 * later, when `restoreFromBackup` refuses it.
 *
 * So: copy into `<destPath>.tmp`, run the SAME `assertSqliteHealthy` the
 * restore path runs, and only then `renameSync` onto the day file. On
 * verification failure the previous good backup is left EXACTLY as it was, the
 * temp is dropped, and the refusal is recorded as a `persistence.backup_rejected`
 * event (traceable: what was rejected, when, and why) before throwing. Nothing
 * unique is discarded — the corrupt source is still the live DB.
 */
export async function createBackup(
  dbPath: string,
  backupDir: string,
  reason: string = 'periodic',
  deps: BackupDeps = {}
): Promise<BackupInfo> {
  const copyInto = deps.copyInto ?? onlineCopySqlite
  const verify = deps.verify ?? assertSqliteHealthy

  ensureDir(backupDir)
  const now = new Date()
  const filename = `lamprey-${ymdUtc(now)}.db`
  const destPath = join(backupDir, filename)
  const tempPath = `${destPath}.tmp`
  // Pre-flight: checkpoint so the WAL has been folded into the main DB
  // file. If the cached DB handle isn't open (test paths), skip — the
  // backup is still valid, just possibly missing the last few writes.
  try {
    checkpoint()
  } catch (err) {
    console.warn('[backup-runner] pre-backup checkpoint failed (continuing):', err)
  }
  // Clear any temp left by a previously-interrupted backup so the copy starts
  // from a blank slot. (`.tmp` doesn't match BACKUP_FILE_PATTERN, so a leftover
  // was never advertised by listBackups.)
  cleanupTemp(tempPath)

  // Step 1 — copy into the TEMP path. Open a NEW read-only handle (not the
  // cached `getDb()`) and drive the online backup API page-by-page; see
  // onlineCopySqlite. Total wall time for a typical multi-MB DB is in the
  // hundreds of ms. A mid-copy failure leaves the previous day-file untouched.
  try {
    await copyInto(dbPath, tempPath)
  } catch (err) {
    cleanupTemp(tempPath)
    throw new Error(
      `createBackup: copy failed (previous backup at ${destPath} left intact): ${messageOf(err) ?? err}`,
      { cause: err }
    )
  }

  // Step 2 — verify the temp BEFORE it goes anywhere near the day file. This is
  // the guard that catches the silent case: a copy that "succeeded" but carries
  // the source's corruption.
  try {
    verify(tempPath)
  } catch (err) {
    const rejectedBytes = existsSync(tempPath) ? statSync(tempPath).size : 0
    cleanupTemp(tempPath)
    // PS22 — record the REFUSAL so it is traceable (what, when, why) instead of
    // being a console line nobody reads. severity 'error': a failed backup with
    // a possibly-corrupt live DB is exactly the state a user must act on.
    try {
      recordEvent({
        type: 'persistence.backup_rejected',
        actorKind: 'system',
        severity: 'error',
        payload: {
          path: destPath,
          rejectedBytes,
          reason,
          error: messageOf(err) ?? String(err),
          previousBackupKept: existsSync(destPath)
        }
      })
    } catch (e) { console.debug('[backup-runner] non-fatal:', messageOf(e)) }
    throw new Error(
      `createBackup: fresh copy failed verification, refusing to overwrite ` +
        `${existsSync(destPath) ? `the previous backup at ${destPath}` : destPath} ` +
        `(the live DB at ${dbPath} is likely corrupt): ${messageOf(err) ?? err}`,
      { cause: err }
    )
  }

  // Step 3 — publish. rename() over the day file is atomic on both NTFS and
  // POSIX, so `destPath` is at every instant either the previous good backup or
  // the fully-verified new one — never a partial file.
  try {
    renameSync(tempPath, destPath)
  } catch (err) {
    cleanupTemp(tempPath)
    throw new Error(
      `createBackup: failed to publish verified backup onto ${destPath} ` +
        `(previous backup left intact): ${messageOf(err) ?? err}`,
      { cause: err }
    )
  }
  const stat = statSync(destPath)
  const info: BackupInfo = {
    path: destPath,
    name: filename,
    mtime: stat.mtimeMs,
    bytes: stat.size,
    reason
  }
  // PS22 — emit. Backup events let the Activity Timeline show "last
  // backup" pulses + flag missing nightly runs.
  try {
    recordEvent({
      type: 'persistence.backup',
      actorKind: 'system',
      severity: 'info',
      payload: {
        path: destPath,
        bytes: stat.size,
        reason
      }
    })
  } catch (e) { console.debug('[backup-runner] non-fatal:', messageOf(e)) }
  return info
}

/**
 * PS5 — list known backups in `backupDir`, newest first. Files that
 * don't match the naming pattern are skipped (so a user dropping
 * unrelated files in the directory doesn't break the list).
 */
export function listBackups(backupDir: string): BackupInfo[] {
  if (!existsSync(backupDir)) return []
  const entries = readdirSync(backupDir, { withFileTypes: true })
  const infos: BackupInfo[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!BACKUP_FILE_PATTERN.test(entry.name)) continue
    const fullPath = join(backupDir, entry.name)
    try {
      const stat = statSync(fullPath)
      infos.push({
        path: fullPath,
        name: entry.name,
        mtime: stat.mtimeMs,
        bytes: stat.size
      })
    } catch (e) { console.debug('[backup-runner] unreadable file; skip:', messageOf(e)) }
  }
  infos.sort((a, b) => b.mtime - a.mtime)
  return infos
}

/**
 * PS5 — prune backups older than `retentionDays`. Returns the list of
 * files actually deleted. Idempotent: a second call with no eligible
 * deletions is a no-op.
 */
export function pruneOldBackups(
  backupDir: string,
  retentionDays: number = DEFAULT_RETENTION_DAYS
): string[] {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const deleted: string[] = []
  for (const info of listBackups(backupDir)) {
    if (info.mtime < cutoff) {
      try {
        unlinkSync(info.path)
        deleted.push(info.path)
      } catch (err) {
        console.warn(`[backup-runner] failed to prune ${info.path}:`, err)
      }
    }
  }
  return deleted
}

/**
 * B1 — online snapshot of `local-brain.db` (the vector index). Rebuildable from notes
 * (~24 min re-embed) but that is expensive, so a cheap daily snapshot is worth the disk.
 * Filename `local-brain-YYYY-MM-DD.db` (same-day overwrites). Returns metadata, or null
 * when the index doesn't exist yet (fresh install / never reindexed) — a no-op, not an error.
 *
 * SAFETY: uses the WAL-safe online backup API (onlineCopySqlite), NOT a raw fs copy. We do
 * NOT checkpoint first — this DB's live handle is owned elsewhere (index-store) and the online
 * backup already reads a committed, WAL-consistent snapshot without touching that handle.
 */
export async function createLocalBrainBackup(
  dbPath: string,
  backupDir: string,
  reason: string = 'periodic'
): Promise<BackupInfo | null> {
  if (!existsSync(dbPath)) return null
  ensureDir(backupDir)
  const filename = `local-brain-${ymdUtc(new Date())}.db`
  const destPath = join(backupDir, filename)
  await onlineCopySqlite(dbPath, destPath)
  const stat = statSync(destPath)
  const info: BackupInfo = {
    path: destPath,
    name: filename,
    mtime: stat.mtimeMs,
    bytes: stat.size,
    reason
  }
  try {
    recordEvent({
      type: 'persistence.backup',
      actorKind: 'system',
      severity: 'info',
      payload: { path: destPath, bytes: stat.size, reason, kind: 'local-brain' }
    })
  } catch (e) { console.debug('[backup-runner] non-fatal:', messageOf(e)) }
  return info
}

/** B1 — list local-brain snapshots, newest first. Own naming namespace so it never
 *  overlaps the lamprey.db backup list. */
export function listLocalBrainBackups(backupDir: string): BackupInfo[] {
  if (!existsSync(backupDir)) return []
  const infos: BackupInfo[] = []
  for (const entry of readdirSync(backupDir, { withFileTypes: true })) {
    if (!entry.isFile() || !LOCAL_BRAIN_FILE_PATTERN.test(entry.name)) continue
    const fullPath = join(backupDir, entry.name)
    try {
      const stat = statSync(fullPath)
      infos.push({ path: fullPath, name: entry.name, mtime: stat.mtimeMs, bytes: stat.size })
    } catch (e) { console.debug('[backup-runner] unreadable file; skip:', messageOf(e)) }
  }
  infos.sort((a, b) => b.mtime - a.mtime)
  return infos
}

/** B1 — COUNT-based retention for local-brain snapshots (they are ~30 MB each). Keeps the
 *  newest `keep`, deletes the rest. Returns deleted paths. Idempotent. */
export function pruneLocalBrainBackups(
  backupDir: string,
  keep: number = DEFAULT_LOCAL_BRAIN_KEEP
): string[] {
  const deleted: string[] = []
  const all = listLocalBrainBackups(backupDir)
  for (const info of all.slice(Math.max(0, keep))) {
    try {
      unlinkSync(info.path)
      deleted.push(info.path)
    } catch (err) {
      console.warn(`[backup-runner] failed to prune ${info.path}:`, err)
    }
  }
  return deleted
}

export interface RestoreInfo {
  /** Where the pre-restore live DB was preserved (`<dbPath>.pre-restore-<ts>`).
   *  Kept for rollback / diagnosis; callers may surface it to the user. */
  movedTo: string
  restoredFrom: string
  restoredAt: number
}

/**
 * B4 — dependency seam so the copy + verify steps are injectable/mockable.
 * Production uses the WAL-safe online backup (`onlineCopySqlite`) and a
 * read-only `PRAGMA integrity_check`. Tests inject stubs to force a
 * mid-copy failure or a verification failure without a genuinely-corrupt
 * (or native-SQLite-backed) file.
 */
export interface RestoreDeps {
  /** Copy the SQLite DB at `srcPath` into a fresh `destPath` (page-by-page). */
  copyInto?: (srcPath: string, destPath: string) => Promise<void>
  /** Assert the SQLite DB file at `path` is structurally healthy; throw if not. */
  verify?: (path: string) => void
  /** F12 (2026-08-22): confine the restore SOURCE to this directory. The IPC handler forwards a
   *  renderer-supplied backupPath, and the old checks (filename pattern + existence + SQLite
   *  health) would accept ANY backup-named valid SQLite anywhere on disk as a replacement for
   *  lamprey.db. When set, the resolved backupPath must sit inside this dir. Omit only for
   *  internal callers that already own the path (they pass a path they built themselves). */
  allowedDir?: string
}

/**
 * B5 — `createBackup` runs the SAME copy + verify steps as the restore path
 * (write to a temp, verify, then swap), so it takes the SAME seam. Aliased
 * rather than duplicated so the two paths can never drift apart.
 */
export type BackupDeps = RestoreDeps

/**
 * B4 — default verification: open the file read-only and require
 * `PRAGMA integrity_check` == 'ok', plus a table-presence sanity check so a
 * zero-byte / truncated file that technically opens but holds no schema is
 * rejected. Throws with a descriptive message on any failure.
 */
function assertSqliteHealthy(path: string): void {
  if (!existsSync(path)) {
    throw new Error(`verify: file does not exist: ${path}`)
  }
  const probe = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const integrity = probe.pragma('integrity_check', { simple: true }) as unknown
    if (integrity !== 'ok') {
      throw new Error(`verify: integrity_check returned ${String(integrity)} (expected 'ok')`)
    }
    // A real restore target has ≥1 schema object. Rejects an empty/partial file.
    const tables = probe
      .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table'")
      .get() as { c: number }
    if (!tables || tables.c < 1) {
      throw new Error('verify: DB has no tables (empty or truncated)')
    }
  } finally {
    try {
      probe.close()
    } catch (e) { console.debug('[backup-runner] verify probe close:', messageOf(e)) }
  }
}

/** B4 — best-effort unlink of a temp file and its sidecars. */
function cleanupTemp(tempPath: string): void {
  for (const p of [tempPath, `${tempPath}-wal`, `${tempPath}-shm`]) {
    if (existsSync(p)) {
      try {
        unlinkSync(p)
      } catch (e) { console.debug('[backup-runner] temp cleanup non-fatal:', messageOf(e)) }
    }
  }
}

/**
 * PS5 / B4 — ATOMICALLY restore the DB from a named backup. Sequence:
 *   1. Validate the backup: recognized filename, exists, and passes SQLite
 *      verification (refuse to restore from a corrupt backup).
 *   2. Copy the backup into a TEMP file (`<dbPath>.restore-tmp`) — never
 *      over the live path. A mid-copy failure deletes the temp; live DB is
 *      untouched.
 *   3. Verify the temp (integrity_check + table presence). On failure delete
 *      the temp and throw; live DB is untouched.
 *   4. Atomic swap: move the live DB + its -wal/-shm sidecars aside to
 *      `.pre-restore-<ts>` (kept for rollback), then rename the verified temp
 *      onto `dbPath`. If the final rename fails, roll the aside files back so
 *      the pre-restore live DB is fully restored.
 * Invariant: at every point `dbPath` is either the original live DB or the
 * fully-verified restored DB — never missing or partial.
 *
 * Returns the path of the preserved pre-restore file. The caller is
 * responsible for relaunching the app — the cached `getDb()` handle still
 * points at the moved-aside file.
 */
export async function restoreFromBackup(
  dbPath: string,
  backupPath: string,
  deps: RestoreDeps = {}
): Promise<RestoreInfo> {
  const copyInto = deps.copyInto ?? onlineCopySqlite
  const verify = deps.verify ?? assertSqliteHealthy

  // Step 0 — F12 confinement: a renderer-supplied path must resolve INSIDE the backups dir.
  // Checked before existence so a traversal target is refused even if it happens to exist.
  if (deps.allowedDir) {
    const root = resolve(deps.allowedDir)
    const target = resolve(backupPath)
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`restoreFromBackup: backup path is outside the backups directory (refused): ${backupPath}`)
    }
  }
  // Step 1 — validate the backup (filename + existence + readable SQLite).
  if (!existsSync(backupPath)) {
    throw new Error(`restoreFromBackup: backup file not found: ${backupPath}`)
  }
  const name = basename(backupPath)
  if (!BACKUP_FILE_PATTERN.test(name)) {
    throw new Error(
      `restoreFromBackup: not a recognized backup filename: ${name}`
    )
  }
  // Mandatory confinement (F12 hardening, 2026-08-25): unlike the caller-supplied step-0 pin
  // above, this one cannot be forgotten and is symlink-proof — BOTH the owned backups dir and
  // the candidate are realpath'd before comparison, and the file must sit DIRECTLY inside the
  // dir (no subpaths). Root = the caller's allowedDir when given, else <db dir>/backups.
  const confinedBackupPath = ((): string => {
    const ownedDir = deps.allowedDir ?? join(dirname(dbPath), 'backups')
    let realDir: string
    let realPath: string
    try {
      realDir = realpathSync(ownedDir)
      realPath = realpathSync(backupPath)
    } catch {
      throw new Error('restoreFromBackup: backup path cannot be resolved')
    }
    const rel = relative(realDir, realPath)
    if (isAbsolute(rel) || dirname(rel) !== '.') {
      throw new Error('restoreFromBackup: backup path is outside the owned backups directory')
    }
    return realPath
  })()
  try {
    verify(confinedBackupPath)
  } catch (err) {
    throw new Error(
      `restoreFromBackup: backup failed verification, refusing to restore: ${messageOf(err) ?? err}`,
      { cause: err }
    )
  }

  const SIDECARS = ['-wal', '-shm'] as const
  const tempPath = `${dbPath}.restore-tmp`
  // Clear any temp left by a previously-interrupted restore so the copy starts
  // from a blank slot.
  cleanupTemp(tempPath)

  // Step 2 — restore INTO the temp path (never over the live DB).
  try {
    await copyInto(confinedBackupPath, tempPath)
  } catch (err) {
    cleanupTemp(tempPath)
    throw new Error(
      `restoreFromBackup: failed to copy backup into temp (live DB untouched): ${messageOf(err) ?? err}`,
      { cause: err }
    )
  }

  // Step 3 — verify the temp BEFORE it goes anywhere near the live path.
  try {
    verify(tempPath)
  } catch (err) {
    cleanupTemp(tempPath)
    throw new Error(
      `restoreFromBackup: restored temp failed verification (live DB untouched): ${messageOf(err) ?? err}`,
      { cause: err }
    )
  }

  // Step 4 — atomic swap. Move the live DB (+ sidecars) aside, then rename the
  // verified temp onto `dbPath`. Track every aside move so we can undo it.
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const preRestorePath = `${dbPath}.pre-restore-${ts}`
  const movedAside: Array<{ from: string; to: string }> = []

  if (existsSync(dbPath)) {
    try {
      renameSync(dbPath, preRestorePath)
      movedAside.push({ from: dbPath, to: preRestorePath })
    } catch (err) {
      // Couldn't move the live DB aside — abort; live DB stays in place.
      cleanupTemp(tempPath)
      throw new Error(
        `restoreFromBackup: failed to move current DB aside (live DB untouched): ${messageOf(err) ?? err}`,
        { cause: err }
      )
    }
    // Move the stale WAL + SHM aside too so SQLite can't replay them onto the
    // restored file. Preserved alongside the pre-restore DB.
    for (const suffix of SIDECARS) {
      const sidecar = `${dbPath}${suffix}`
      if (existsSync(sidecar)) {
        try {
          renameSync(sidecar, `${preRestorePath}${suffix}`)
          movedAside.push({ from: sidecar, to: `${preRestorePath}${suffix}` })
        } catch (e) { console.debug('[backup-runner] sidecar move failure is non-fatal:', messageOf(e)) }
      }
    }
  }

  // Final rename: temp → live. On failure, roll back every aside move so the
  // pre-restore live DB is fully restored, and drop the (verified) temp.
  try {
    renameSync(tempPath, dbPath)
  } catch (err) {
    // Roll back the aside moves. movedAside[0] is the main DB (pushed first); restore it
    // FIRST. If the main rename-back itself fails, the live path is genuinely gone — STOP
    // rather than scatter the -wal/-shm sidecars onto an absent dbPath, so the original DB
    // and its sidecars stay co-located at preRestorePath and the error message can point
    // there honestly (the "never missing" invariant is already broken by this double-fault;
    // the priority now is a recoverable, truthfully-reported state).
    let mainRestored = true
    for (const { from, to } of movedAside) {
      try {
        if (existsSync(to)) renameSync(to, from)
      } catch (e) {
        console.warn('[backup-runner] rollback rename failed:', messageOf(e))
        if (from === dbPath) { mainRestored = false; break }
      }
    }
    cleanupTemp(tempPath)
    if (!mainRestored) {
      throw new Error(
        `restoreFromBackup: final swap failed AND the live DB could not be rolled back. ` +
          `The original DB is intact at ${preRestorePath} (with its -wal/-shm sidecars); ` +
          `move it back to ${dbPath} to recover. Cause: ${messageOf(err) ?? err}`,
        { cause: err }
      )
    }
    throw new Error(
      `restoreFromBackup: final swap failed, rolled back to pre-restore DB: ${messageOf(err) ?? err}`,
      { cause: err }
    )
  }

  const result: RestoreInfo = {
    movedTo: preRestorePath,
    restoredFrom: backupPath,
    restoredAt: Date.now()
  }
  // PS22 — recovery is a high-signal event; severity 'warning' so the
  // timeline surfaces it (a restore implies the previous DB was suspect).
  try {
    recordEvent({
      type: 'persistence.recovery',
      actorKind: 'user',
      severity: 'warning',
      payload: {
        fromPath: backupPath,
        toPath: dbPath,
        movedTo: preRestorePath
      }
    })
  } catch (e) { console.debug('[backup-runner] non-fatal:', messageOf(e)) }
  return result
}

// Periodic runner — schedules `createBackup` once per day at startup
// and on a 24h interval. Idempotent: same-day backup overwrites; second
// startup call rebinds the timer.
let backupTimer: NodeJS.Timeout | null = null
let initialBackupTimer: NodeJS.Timeout | null = null

export function startBackupRunner(opts?: {
  intervalMs?: number
  retentionDays?: number
  localBrainKeep?: number
}): () => void {
  if (backupTimer) {
    const live = backupTimer
    const initial = initialBackupTimer
    return () => {
      if (initialBackupTimer === initial && initialBackupTimer) {
        clearTimeout(initialBackupTimer)
        initialBackupTimer = null
      }
      if (backupTimer === live) {
        clearInterval(live)
        backupTimer = null
      }
    }
  }
  const intervalMs = opts?.intervalMs ?? 24 * 60 * 60 * 1000
  const retentionDays = opts?.retentionDays ?? DEFAULT_RETENTION_DAYS
  const localBrainKeep = opts?.localBrainKeep ?? DEFAULT_LOCAL_BRAIN_KEEP
  const userDataDir = app.getPath('userData')
  const dbPath = join(userDataDir, 'lamprey.db')
  const localBrainPath = join(userDataDir, 'local-brain.db')
  const backupDir = join(userDataDir, 'backups')
  const tick = (): void => {
    // 1) lamprey.db (relational store) — daily, day-windowed retention.
    createBackup(dbPath, backupDir, 'periodic')
      .then(() => {
        pruneOldBackups(backupDir, retentionDays)
      })
      .catch((err) => {
        console.warn('[backup-runner] periodic backup failed:', err)
      })
    // 2) local-brain.db (vector index) — daily online snapshot, count-capped retention.
    //    Default-on; DUIN_LOCAL_BRAIN_BACKUP=0 disables (it's the only cost-adding source: ~30 MB).
    if (process.env.DUIN_LOCAL_BRAIN_BACKUP !== '0') {
      createLocalBrainBackup(localBrainPath, backupDir, 'periodic')
        .then((info) => {
          if (info) pruneLocalBrainBackups(backupDir, localBrainKeep)
        })
        .catch((err) => {
          console.warn('[backup-runner] local-brain backup failed:', err)
        })
    }
    // 3) Moat JSON (operator-model / success-traces / ans-capabilities from userData) +
    //    the small `.duin/_state` ledgers — atomic/dedup/shrink-guard/rotation via moat-backup.
    //    Snapshots land in `<vault>/.duin/_backups/` so they travel with the vault. Best-effort.
    try {
      const raw = readSettings().localBrainNotesDir
      const vaultDir = typeof raw === 'string' && raw.trim() !== '' ? raw : null
      if (vaultDir) backupMoatState(vaultDir, 'daily', userDataDir)
    } catch (err) {
      console.warn('[backup-runner] moat snapshot failed:', err)
    }
    // 4) Events retention — the `events` table has no rotation of its own (~570
    //    rows/day, and a runaway automation once wrote 108k). Prune it on the same
    //    daily cadence, reusing this tick rather than adding a standalone scheduler.
    //    Reference-preserving + failure-isolated (see event-log.pruneEvents).
    try {
      const { deleted } = pruneEvents()
      if (deleted > 0) console.log(`[backup-runner] pruned ${deleted} old event(s)`)
    } catch (err) {
      console.warn('[backup-runner] events prune failed:', err)
    }
  }
  // Fire the first tick after a 30s delay so startup isn't slowed and
  // the first backup happens once the app is settled.
  initialBackupTimer = setTimeout(() => {
    initialBackupTimer = null
    tick()
  }, 30_000)
  initialBackupTimer.unref?.()
  backupTimer = setInterval(tick, intervalMs)
  backupTimer.unref?.()
  return () => {
    if (initialBackupTimer) {
      clearTimeout(initialBackupTimer)
      initialBackupTimer = null
    }
    if (backupTimer) {
      clearInterval(backupTimer)
      backupTimer = null
    }
  }
}
