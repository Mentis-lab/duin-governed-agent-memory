import { t, tf } from '@/lib/i18n'
import { useCallback, useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { PanelState } from '@/components/ui/PanelState'
import {
  SettingsLoadError,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  SettingsSection
} from '@/components/ui/settings'
import { useDirtyGuard } from '@/hooks/useDirtyGuard'
import { invoke, query } from '@/lib/ipc-client'
import { panelFromResult, panelLoading, type PanelStatus } from '@/lib/panel-state'
import { describeError, type IpcEnvelope } from '@/lib/result'
import {
  restoreConfirmMessage,
  restoreCompletionMessage,
  type RestoreInfo
} from '@/components/persistence/restore-copy'
import { SettingsBackupSection } from './SettingsBackupSection'

// The Settings page for the database floor.
//
// Read sections:
//   - Database: file path and size; WAL / SHM sizes under a Details disclosure.
//   - Checkpoint: the last WAL checkpoint (ok flag, pages moved, duration).
//   - Integrity check: the last PRAGMA integrity_check (ok flag, raw result, timestamp).
//   - Backups: backup folder, count, latest backup, and the list to restore from.
//   - Encryption: binding available, database encrypted, passphrase stored.
//
// Actions:
//   - "Run checkpoint now" — wal_checkpoint(TRUNCATE) on demand; the WAL size above
//     shrinking proves the call.
//   - "Run integrity check now" — useful after a suspected corruption.
//   - "Create backup now" — async snapshot.
//   - "Restore" on a listed backup — confirm, atomic file swap, then a restart is needed.
//   - Encryption: an enable form (passphrase + confirm) and a disable form (current
//     passphrase), shown only when the cipher binding is available. A change-passphrase
//     IPC exists main-side; this page has no form for it.

interface CheckpointResult {
  ok: boolean
  pagesInWal: number
  pagesCheckpointed: number
  durationMs: number
}

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
  dbPath: string
  dbBytes: number | null
  walBytes: number | null
  shmBytes: number | null
  lastCheckpoint: CheckpointResult | null
  lastIntegrity: IntegrityCheckResult | null
  backupDir: string
  backupCount: number
  latestBackup: BackupInfo | null
}

interface EncryptionStatus {
  bindingAvailable: boolean
  bindingError: string | null
  databaseEncrypted: boolean
  passphraseStored: boolean
}

function formatBytes(n: number | null): string {
  if (n === null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatTimestamp(ms: number | undefined): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString()
}

function StatusLine({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-[12px]">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="break-all text-right font-mono text-[var(--text-primary)]">{value}</span>
    </div>
  )
}

function checkpointSummary(c: CheckpointResult | null): string {
  if (!c) return t('No checkpoint yet')
  if (c.ok) return tf('{moved} of {total} pages moved', { moved: c.pagesCheckpointed, total: c.pagesInWal })
  return t('Busy, no pages moved')
}

export function PersistenceSettings(): React.ReactElement {
  const [status, setStatus] = useState<PanelStatus<PersistenceStatus>>(panelLoading())
  const [encryption, setEncryption] = useState<PanelStatus<EncryptionStatus>>(panelLoading())
  const [backups, setBackups] = useState<PanelStatus<BackupInfo[]>>(panelLoading())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  // Encryption form state
  const [encryptPassphrase, setEncryptPassphrase] = useState('')
  const [encryptConfirm, setEncryptConfirm] = useState('')
  const [decryptPassphrase, setDecryptPassphrase] = useState('')
  const newPassId = useId()
  const confirmPassId = useId()
  const currentPassId = useId()
  useDirtyGuard(
    'settings:persistence:encryption',
    'the encryption form',
    encryptPassphrase !== '' || encryptConfirm !== '' || decryptPassphrase !== ''
  )

  // Every read lands in a PanelStatus: a thrown call, a missing handler and a
  // `success:false` envelope (which the old refresh silently dropped, leaving "—" in
  // every row) all render as a load error with a Retry.
  const refresh = useCallback(async (): Promise<void> => {
    const [s, e, b] = await Promise.all([
      query<PersistenceStatus>('database status', window.api?.persistence?.getStatus),
      query<EncryptionStatus>('encryption status', window.api?.persistence?.getEncryptionStatus),
      query<BackupInfo[]>('backups', window.api?.persistence?.listBackups)
    ])
    setStatus(panelFromResult(s))
    setEncryption(panelFromResult(e))
    setBackups(panelFromResult(b))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runAction = async <T,>(
    label: string,
    key: string,
    fn: () => Promise<IpcEnvelope<T> | undefined>,
    onSuccess: (data: T) => void
  ): Promise<void> => {
    setBusy(key)
    setError(null)
    setInfo(null)
    try {
      const data = await invoke<T>(label, fn)
      onSuccess(data)
      await refresh()
    } catch (err) {
      setError(describeError(err, t('Something went wrong')))
    } finally {
      setBusy(null)
    }
  }

  const encryptDisabled =
    busy !== null || encryptPassphrase.length < 8 || encryptPassphrase !== encryptConfirm

  return (
    <SettingsPage
      purpose={t('Where DUIN keeps its database and backups, and the tools to check and restore it.')}
    >
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-[var(--error)]/60 bg-[var(--bg-primary)] px-3 py-2 text-[12px] text-[var(--text-primary)]"
        >
          {error}
        </div>
      )}
      {info && (
        <div
          role="status"
          className="rounded-lg border border-[var(--success)]/60 bg-[var(--bg-primary)] px-3 py-2 text-[12px] text-[var(--text-primary)]"
        >
          {info}
        </div>
      )}

      <PanelState
        state={status}
        loading={<SettingsLoading what={t('the database status')} />}
        error={(message, retry) => (
          <SettingsLoadError what={t('the database status')} message={message} onRetry={retry} />
        )}
        empty={
          <SettingsLoadError
            what={t('the database status')}
            message={t('The main process returned no status.')}
            onRetry={() => void refresh()}
          />
        }
        onRetry={() => void refresh()}
      >
        {(s) => (
          <>
            <SettingsSection label={t('Database')}>
              <SettingsRow
                label={t('Database file')}
                hint={<span className="break-all font-mono">{s.dbPath}</span>}
              >
                <StatusLine label={t('Size')} value={formatBytes(s.dbBytes)} />
                <details className="mt-1 text-[12px]">
                  <summary className="cursor-pointer text-[var(--text-secondary)]">{t('Details')}</summary>
                  <StatusLine label="WAL" value={formatBytes(s.walBytes)} />
                  <StatusLine label="SHM" value={formatBytes(s.shmBytes)} />
                </details>
              </SettingsRow>
            </SettingsSection>

            <SettingsSection
              label={t('Checkpoint')}
              description={t('Moves pending writes from the write-ahead log into the main database file.')}
            >
              <SettingsRow
                label={t('Last checkpoint')}
                hint={checkpointSummary(s.lastCheckpoint)}
                control={
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      void runAction(
                        'force checkpoint',
                        'checkpoint',
                        () => window.api.persistence.forceCheckpoint(),
                        () => setInfo(t('Checkpoint complete.'))
                      )
                    }
                  >
                    {busy === 'checkpoint' ? t('Checkpointing…') : t('Run checkpoint now')}
                  </Button>
                }
              >
                <StatusLine
                  label={t('Duration')}
                  value={s.lastCheckpoint ? tf('{ms} ms', { ms: s.lastCheckpoint.durationMs }) : '—'}
                />
              </SettingsRow>
            </SettingsSection>

            <SettingsSection
              label={t('Integrity check')}
              description={t('Asks SQLite to verify the whole file. Run it after a crash or when something looks wrong.')}
            >
              <SettingsRow
                label={t('Last integrity check')}
                hint={
                  s.lastIntegrity ? (
                    s.lastIntegrity.ok ? (
                      <span className="text-[var(--success)]">{t('OK')}</span>
                    ) : (
                      <span className="text-[var(--error)]">{s.lastIntegrity.result}</span>
                    )
                  ) : (
                    t('Never run')
                  )
                }
                control={
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      void runAction(
                        'run integrity check',
                        'integrity',
                        () => window.api.persistence.runIntegrityCheck(),
                        () => setInfo(t('Integrity check complete.'))
                      )
                    }
                  >
                    {busy === 'integrity' ? t('Checking…') : t('Run integrity check now')}
                  </Button>
                }
              >
                <StatusLine label={t('Ran at')} value={formatTimestamp(s.lastIntegrity?.ranAt)} />
                <StatusLine
                  label={t('Duration')}
                  value={s.lastIntegrity ? tf('{ms} ms', { ms: s.lastIntegrity.durationMs }) : '—'}
                />
              </SettingsRow>
            </SettingsSection>

            <SettingsSection
              label={t('Backups')}
              description={t('Snapshots of the database. Restoring swaps the live file for a backup and keeps the current file beside it.')}
            >
              <SettingsRow
                label={tf('{n} backups kept', { n: s.backupCount })}
                hint={<span className="break-all font-mono">{s.backupDir}</span>}
                control={
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      void runAction(
                        'create backup',
                        'backup',
                        () => window.api.persistence.createBackup(),
                        () => setInfo(t('Backup created.'))
                      )
                    }
                  >
                    {busy === 'backup' ? t('Backing up…') : t('Create backup now')}
                  </Button>
                }
              >
                <StatusLine
                  label={t('Latest backup')}
                  value={
                    s.latestBackup
                      ? `${s.latestBackup.name} (${formatBytes(s.latestBackup.bytes)})`
                      : t('None')
                  }
                />
                <StatusLine label={t('Latest backup time')} value={formatTimestamp(s.latestBackup?.mtime)} />
                <div className="mt-2">
                  <PanelState
                    state={backups}
                    loading={<SettingsLoading what={t('backups')} />}
                    error={(message, retry) => (
                      <SettingsLoadError what={t('backups')} message={message} onRetry={retry} />
                    )}
                    empty={<p className="text-[12px] text-[var(--text-muted)]">{t('No backups yet.')}</p>}
                    onRetry={() => void refresh()}
                  >
                    {(list) => (
                      <details>
                        <summary className="cursor-pointer text-[12px] text-[var(--text-secondary)]">
                          {tf('Restore from a backup ({n} available)', { n: list.length })}
                        </summary>
                        <ul className="mt-2 space-y-1">
                          {list.map((b) => (
                            <li
                              key={b.path}
                              className="flex items-center justify-between gap-2 rounded-md border border-[var(--panel-border)] px-2 py-1 text-[12px]"
                            >
                              <span>
                                <span className="font-mono">{b.name}</span>{' '}
                                <span className="text-[var(--text-muted)]">
                                  ({formatBytes(b.bytes)} · {formatTimestamp(b.mtime)})
                                </span>
                              </span>
                              <Button
                                variant="danger"
                                size="sm"
                                disabled={busy !== null}
                                onClick={() => {
                                  // Restore swaps the entire user database: confirm first, and
                                  // report where the previous file went afterwards.
                                  if (!window.confirm(restoreConfirmMessage(b))) return
                                  void runAction(
                                    'restore backup',
                                    'restore',
                                    () => window.api.persistence.restoreFromBackup(b.path),
                                    (data) => setInfo(restoreCompletionMessage(data as RestoreInfo | undefined))
                                  )
                                }}
                              >
                                {t('Restore')}
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </PanelState>
                </div>
              </SettingsRow>
            </SettingsSection>
          </>
        )}
      </PanelState>

      {/* The SQLCipher binding is not a dependency of every build, so the option cannot
          always succeed. The section renders only while the status is loading, when it
          failed to load, or when main reports the binding present. */}
      <PanelState
        state={encryption}
        loading={
          <SettingsSection label={t('Encryption')}>
            <SettingsLoading what={t('the encryption status')} />
          </SettingsSection>
        }
        error={(message, retry) => (
          <SettingsSection label={t('Encryption')}>
            <SettingsLoadError what={t('the encryption status')} message={message} onRetry={retry} />
          </SettingsSection>
        )}
        empty={null}
        onRetry={() => void refresh()}
      >
        {(enc) =>
          enc.bindingAvailable ? (
            <SettingsSection label={t('Encryption')}>
              <SettingsRow
                label={t('Database encryption')}
                hint={
                  enc.databaseEncrypted
                    ? t('The database is encrypted with your passphrase.')
                    : t('The database is not encrypted.')
                }
              >
                {!enc.databaseEncrypted ? (
                  <div className="max-w-sm space-y-2">
                    <div className="space-y-1">
                      <label htmlFor={newPassId} className="block text-[11px] text-[var(--text-muted)]">
                        {t('New passphrase')}
                      </label>
                      <Input
                        id={newPassId}
                        type="password"
                        autoComplete="new-password"
                        placeholder={t('At least 8 characters')}
                        value={encryptPassphrase}
                        onChange={(e) => setEncryptPassphrase(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <label htmlFor={confirmPassId} className="block text-[11px] text-[var(--text-muted)]">
                        {t('Confirm passphrase')}
                      </label>
                      <Input
                        id={confirmPassId}
                        type="password"
                        autoComplete="new-password"
                        value={encryptConfirm}
                        onChange={(e) => setEncryptConfirm(e.target.value)}
                      />
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={encryptDisabled}
                      onClick={() =>
                        void runAction(
                          'encrypt database',
                          'encrypt',
                          () => window.api.persistence.enableEncryption(encryptPassphrase),
                          () => {
                            setEncryptPassphrase('')
                            setEncryptConfirm('')
                            setInfo(t('Database encrypted. Restart DUIN to finish.'))
                          }
                        )
                      }
                    >
                      {busy === 'encrypt' ? t('Encrypting…') : t('Encrypt database')}
                    </Button>
                    <p className="text-[12px] text-[var(--text-muted)]">
                      {t('You will need to restart DUIN afterwards. The unencrypted file is kept beside it as a dated backup, so you can go back by hand.')}
                    </p>
                  </div>
                ) : (
                  <div className="max-w-sm space-y-2">
                    <div className="space-y-1">
                      <label htmlFor={currentPassId} className="block text-[11px] text-[var(--text-muted)]">
                        {t('Current passphrase')}
                      </label>
                      <Input
                        id={currentPassId}
                        type="password"
                        autoComplete="current-password"
                        value={decryptPassphrase}
                        onChange={(e) => setDecryptPassphrase(e.target.value)}
                      />
                    </div>
                    <Button
                      size="sm"
                      disabled={busy !== null || decryptPassphrase.length === 0}
                      onClick={() =>
                        void runAction(
                          'decrypt database',
                          'decrypt',
                          () => window.api.persistence.disableEncryption(decryptPassphrase),
                          () => {
                            setDecryptPassphrase('')
                            setInfo(t('Database decrypted. Restart DUIN to finish.'))
                          }
                        )
                      }
                    >
                      {busy === 'decrypt' ? t('Decrypting…') : t('Decrypt database')}
                    </Button>
                    <p className="text-[12px] text-[var(--text-muted)]">
                      {t('You will need to restart DUIN afterwards.')}
                    </p>
                  </div>
                )}
              </SettingsRow>
            </SettingsSection>
          ) : null
        }
      </PanelState>

      <SettingsBackupSection />
    </SettingsPage>
  )
}
