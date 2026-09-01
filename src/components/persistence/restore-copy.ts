// U9 — shared copy for the two surfaces that can swap the live database.
//
// Restoring is the single most destructive action in the app: it moves the
// live `lamprey.db` aside and puts a backup in its place. The backend is
// already sound — backup-runner preserves `lamprey.db.pre-restore-<ts>` with a
// full rollback of every aside move, and electron/ipc/persistence.ts closes the
// DB handle first so main does not keep writing to the moved-aside file. The
// defect was purely presentational: Settings -> Persistence fired the restore
// on one unconfirmed click and then said only "Restore <name> complete.", so a
// misclick read as total data loss to the operator while the renderer sat on
// pre-restore state.
//
// Both call sites (PersistenceSettings' backup list and IntegrityBanner's
// "Restore from backup" button) must raise the IDENTICAL dialog, hence one
// module rather than two hand-written strings.

/** Mirrors `RestoreInfo` from electron/services/backup-runner.ts. Duplicated
 *  structurally rather than imported so this renderer module stays free of
 *  main-process imports. */
export interface RestoreInfo {
  /** Where the pre-restore live DB was preserved (`<dbPath>.pre-restore-<ts>`). */
  movedTo: string
  restoredFrom: string
  restoredAt: number
}

export interface RestoreBackupRef {
  name: string
  /** Backup file mtime, ms since epoch. */
  mtime: number
}

/** The relaunch instruction. Lifted verbatim from IntegrityBanner so the two
 *  surfaces cannot drift apart. */
export const RESTORE_RELAUNCH_COPY =
  'Please quit + relaunch DUIN to load the restored database.'

export function formatBackupTime(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown time'
  return new Date(ms).toLocaleString()
}

/**
 * The confirm shown before ANY restore. Names the backup's timestamp so the
 * operator can tell "the one I made five minutes ago" from "the one from three
 * weeks ago" — the whole point of the prompt is that the two are one misclick
 * apart in the list.
 */
export function restoreConfirmMessage(backup: RestoreBackupRef): string {
  return [
    `Restore the database from "${backup.name}"?`,
    '',
    `That backup was taken ${formatBackupTime(backup.mtime)}.`,
    '',
    'This replaces the live database. Your current database is kept alongside it',
    'as lamprey.db.pre-restore-<timestamp> so the swap can be rolled back.',
    RESTORE_RELAUNCH_COPY
  ].join('\n')
}

/**
 * Completion message. Surfaces `RestoreInfo.movedTo` — without it the operator
 * has no way to know their previous database still exists, which is exactly
 * what made an accidental restore feel unrecoverable.
 */
export function restoreCompletionMessage(info: RestoreInfo | null | undefined): string {
  const movedTo = info && typeof info.movedTo === 'string' ? info.movedTo.trim() : ''
  if (!movedTo) {
    // The IPC envelope succeeded but carried no path. Still tell the truth
    // about the relaunch; don't invent a path.
    return `Restore complete. ${RESTORE_RELAUNCH_COPY}`
  }
  return `Restore complete. Your previous database was preserved at ${movedTo}. ${RESTORE_RELAUNCH_COPY}`
}
