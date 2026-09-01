import { t } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { restoreConfirmMessage, restoreCompletionMessage, type RestoreInfo } from './restore-copy'

// Persistence Phase / PS4 — non-dismissible startup banner that
// surfaces a non-'ok' `PRAGMA integrity_check` result. The banner
// stays put until the user either:
//   1. Restores from the most recent backup (PS5 wires the restore
//      action — this banner ships first; without PS5 the button toasts
//      "backup restore shipping in next prompt").
//   2. Continues in read-only mode (UI affordance for inspection).
//
// We deliberately do NOT add a dismiss button — corruption is not a
// preference the user toggles away. Per the §3.2 design in the phase
// plan, the banner is paired with the Settings → Persistence panel
// (PS10) which can re-run the check + restore.

interface IntegrityCheckResult {
  ok: boolean
  result: string
  ranAt: number
  durationMs: number
}

interface BackupInfo {
  path: string
  name: string
  mtime: number
  bytes: number
}

interface PersistenceStatus {
  lastIntegrity: IntegrityCheckResult | null
  latestBackup: BackupInfo | null
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString()
}

export function IntegrityBanner(): React.ReactElement | null {
  const [status, setStatus] = useState<PersistenceStatus | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [readOnlyMode, setReadOnlyMode] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!window.api?.persistence) return
    let cancelled = false
    window.api.persistence
      .getStatus()
      .then((result: { success: boolean; data?: PersistenceStatus; error?: string }) => {
        if (cancelled) return
        if (result.success && result.data) {
          setStatus(result.data)
        }
      })
      .catch(() => {
        /* silent — banner just won't show */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Hide when status is unknown, the check is ok, or the user opted
  // into read-only mode (the banner has already done its job — they
  // know).
  if (!status || !status.lastIntegrity) return null
  if (status.lastIntegrity.ok) return null
  if (readOnlyMode) return null

  const lastIntegrity = status.lastIntegrity
  const latestBackup = status.latestBackup

  const handleReadOnly = async (): Promise<void> => {
    const result = await window.api.persistence.setReadOnlyMode(true)
    if (!result.success) {
      setError(result.error ?? 'Could not enter read-only mode.')
      return
    }
    setReadOnlyMode(true)
  }

  const handleRestore = async (): Promise<void> => {
    if (!latestBackup) {
      setError(
        'No backup available to restore from. Save a backup via Settings → Persistence first, or continue in read-only mode.'
      )
      return
    }
    // U9: the same unconfirmed whole-database swap reachable from Settings ->
    // Persistence is reachable from this button. Both surfaces raise the
    // identical dialog, built by the shared module.
    if (!window.confirm(restoreConfirmMessage(latestBackup))) return
    setRestoring(true)
    setError(null)
    try {
      const result = await window.api.persistence.restoreFromBackup(latestBackup.path)
      if (!result.success) {
        setError(result.error ?? 'Restore failed.')
        setRestoring(false)
        return
      }
      // Restore landed; the cached DB handle in main is still pointing
      // at the moved-aside corrupt file, so the user MUST relaunch.
      // We don't auto-relaunch — show the message and let them click
      // Quit, which the main process picks up via the standard quit
      // path. The message names RestoreInfo.movedTo so the pre-restore
      // database is findable rather than presumed gone.
      setError(restoreCompletionMessage(result.data as RestoreInfo | undefined))
    } catch (err: any) {
      setError(err?.message ?? 'Restore failed unexpectedly.')
      setRestoring(false)
    }
  }

  return (
    <div className="flex items-start justify-between gap-3 border-b border-[var(--error)] bg-[var(--error)]/10 px-4 py-2.5 text-[12px] text-[var(--text-primary)]">
      <div className="flex flex-col gap-1">
        <div className="font-semibold">
          Database integrity issue detected ({formatTimestamp(lastIntegrity.ranAt)})
        </div>
        <div className="text-[var(--text-muted)]">
          {lastIntegrity.result.split('\n').slice(0, 2).join(' • ')}
          {lastIntegrity.result.split('\n').length > 2 && ' • …'}
        </div>
        {latestBackup ? (
          <div className="text-[var(--text-muted)]">
            Most recent backup: {latestBackup.name} ({formatTimestamp(latestBackup.mtime)})
          </div>
        ) : (
          <div className="text-[var(--text-muted)]">
            No backups available. Open Settings → Persistence to create one before
            restoring.
          </div>
        )}
        {error && <div className="text-[var(--warning)]">{error}</div>}
      </div>
      <div className="flex flex-col gap-1.5">
        <button
          onClick={handleRestore}
          disabled={restoring || !latestBackup}
          className="rounded border border-[var(--error)] bg-[var(--error)]/20 px-2 py-1 text-[12px] font-medium hover:bg-[var(--error)]/30 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {restoring ? 'Restoring…' : 'Restore from backup'}
        </button>
        <button
          onClick={handleReadOnly}
          className="rounded border border-[var(--border)] px-2 py-1 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          {t('Continue read-only')}
        </button>
      </div>
    </div>
  )
}
