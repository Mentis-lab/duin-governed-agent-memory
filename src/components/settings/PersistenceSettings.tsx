import { t } from '@/lib/i18n'
import { useCallback, useEffect, useState } from 'react'
import {
  restoreConfirmMessage,
  restoreCompletionMessage,
  type RestoreInfo
} from '@/components/persistence/restore-copy'

// Persistence Phase / PS10 — the Settings panel that surfaces every
// PS1–PS9 lever and live status.
//
// Read sections:
//   - DB / WAL / SHM file sizes (PS2).
//   - Last WAL checkpoint result (PS2): ok flag, pages moved, duration.
//   - Last integrity check (PS4): ok flag, raw result, timestamp.
//   - Backup directory + latest backup metadata (PS5).
//   - Encryption status (PS9): binding available, db encrypted,
//     passphrase stored.
//
// Action sections:
//   - "Run integrity check now" — re-runs PRAGMA integrity_check on
//     demand (PS4). Useful after a suspected corruption.
//   - "Force checkpoint now" — runs wal_checkpoint(TRUNCATE) on demand
//     (PS2). Visible WAL shrinkage in the status above proves the call.
//   - "Create backup now" — async snapshot (PS5).
//   - "Restore from backup…" — list of backups; click one to restore.
//     Atomic file swap + relaunch prompt.
//   - Encryption: enable + disable + change-passphrase forms,
//     conditional on bindingAvailable.

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

function StatusRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-[12px]">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="font-mono text-[var(--text-primary)]">{value}</span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="mb-2 border-b border-[var(--panel-border)] pb-1 text-[12px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
        {title}
      </div>
      {children}
    </div>
  )
}

export function PersistenceSettings(): React.ReactElement {
  const [status, setStatus] = useState<PersistenceStatus | null>(null)
  const [encryption, setEncryption] = useState<EncryptionStatus | null>(null)
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  // Encryption form state
  const [encryptPassphrase, setEncryptPassphrase] = useState('')
  const [encryptConfirm, setEncryptConfirm] = useState('')
  const [decryptPassphrase, setDecryptPassphrase] = useState('')

  const refresh = useCallback(async () => {
    if (!window.api?.persistence) return
    try {
      const [s, e, b] = await Promise.all([
        window.api.persistence.getStatus(),
        window.api.persistence.getEncryptionStatus(),
        window.api.persistence.listBackups()
      ])
      if (s.success) setStatus(s.data)
      if (e.success) setEncryption(e.data)
      if (b.success) setBackups(b.data)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runAction = async (
    label: string,
    fn: () => Promise<{ success: boolean; data?: unknown; error?: string }>,
    onSuccess?: (data: unknown) => void
  ): Promise<void> => {
    setBusy(label)
    setError(null)
    setInfo(null)
    try {
      const result = await fn()
      if (!result.success) {
        setError(result.error ?? `${label} failed`)
        return
      }
      setInfo(`${label} complete.`)
      onSuccess?.(result.data)
      await refresh()
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(null)
    }
  }

  if (!window.api?.persistence) {
    return (
      <div className="text-[12px] text-[var(--text-muted)]">
        Persistence APIs unavailable — this view requires the Electron preload
        bridge.
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {error && (
        <div className="mb-3 rounded border border-[var(--error)] bg-[var(--error)]/10 px-2 py-1 text-[12px] text-[var(--text-primary)]">
          {error}
        </div>
      )}
      {info && (
        <div className="mb-3 rounded border border-[var(--success)] bg-[var(--success)]/10 px-2 py-1 text-[12px] text-[var(--text-primary)]">
          {info}
        </div>
      )}

      <Section title={t('Database files')}>
        <StatusRow label={t('Path')} value={status?.dbPath ?? '—'} />
        <StatusRow label={t('Main DB')} value={formatBytes(status?.dbBytes ?? null)} />
        <StatusRow label="WAL" value={formatBytes(status?.walBytes ?? null)} />
        <StatusRow label="SHM" value={formatBytes(status?.shmBytes ?? null)} />
      </Section>

      <Section title={t('Last checkpoint (PS2)')}>
        <StatusRow
          label={t('Result')}
          value={
            status?.lastCheckpoint
              ? status.lastCheckpoint.ok
                ? `ok — ${status.lastCheckpoint.pagesCheckpointed} of ${status.lastCheckpoint.pagesInWal} pages moved`
                : `busy (no pages moved)`
              : 'no checkpoint yet'
          }
        />
        <StatusRow
          label={t('Duration')}
          value={status?.lastCheckpoint ? `${status.lastCheckpoint.durationMs} ms` : '—'}
        />
        <div className="mt-2">
          <button
            disabled={busy !== null}
            onClick={() =>
              runAction('Force checkpoint', () => window.api.persistence.forceCheckpoint())
            }
            className="rounded border border-[var(--border)] px-2 py-1 text-[12px] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            {busy === 'Force checkpoint' ? 'Checkpointing…' : 'Force checkpoint now'}
          </button>
        </div>
      </Section>

      <Section title={t('Last integrity check (PS4)')}>
        <StatusRow
          label={t('Result')}
          value={
            status?.lastIntegrity ? (
              status.lastIntegrity.ok ? (
                <span className="text-[var(--success)]">ok</span>
              ) : (
                <span className="text-[var(--error)]">{status.lastIntegrity.result}</span>
              )
            ) : (
              'never run'
            )
          }
        />
        <StatusRow label={t('Ran at')} value={formatTimestamp(status?.lastIntegrity?.ranAt)} />
        <StatusRow
          label={t('Duration')}
          value={status?.lastIntegrity ? `${status.lastIntegrity.durationMs} ms` : '—'}
        />
        <div className="mt-2">
          <button
            disabled={busy !== null}
            onClick={() =>
              runAction('Run integrity check', () =>
                window.api.persistence.runIntegrityCheck()
              )
            }
            className="rounded border border-[var(--border)] px-2 py-1 text-[12px] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            {busy === 'Run integrity check' ? 'Checking…' : 'Run integrity check now'}
          </button>
        </div>
      </Section>

      <Section title={`Backups (PS5): ${status?.backupCount ?? 0} kept`}>
        <StatusRow label={t('Backup directory')} value={status?.backupDir ?? '—'} />
        <StatusRow
          label={t('Latest backup')}
          value={
            status?.latestBackup
              ? `${status.latestBackup.name} (${formatBytes(status.latestBackup.bytes)})`
              : 'none'
          }
        />
        <StatusRow
          label={t('Latest backup time')}
          value={formatTimestamp(status?.latestBackup?.mtime)}
        />
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            disabled={busy !== null}
            onClick={() =>
              runAction('Create backup', () => window.api.persistence.createBackup())
            }
            className="rounded border border-[var(--border)] px-2 py-1 text-[12px] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            {busy === 'Create backup' ? 'Backing up…' : 'Create backup now'}
          </button>
        </div>
        {backups.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-[12px] text-[var(--text-secondary)]">
              Restore from backup ({backups.length} available)
            </summary>
            <ul className="mt-2 space-y-1">
              {backups.map((b) => (
                <li
                  key={b.path}
                  className="flex items-center justify-between gap-2 rounded border border-[var(--border)] px-2 py-1 text-[12px]"
                >
                  <span>
                    <span className="font-mono">{b.name}</span>{' '}
                    <span className="text-[var(--text-muted)]">
                      ({formatBytes(b.bytes)} · {formatTimestamp(b.mtime)})
                    </span>
                  </span>
                  <button
                    disabled={busy !== null}
                    onClick={() => {
                      // U9: restore swaps the entire user database. It used to
                      // fire on this single click with no confirmation at all.
                      if (!window.confirm(restoreConfirmMessage(b))) return
                      void runAction(
                        `Restore ${b.name}`,
                        () => window.api.persistence.restoreFromBackup(b.path),
                        // Overwrites runAction's generic "<label> complete." —
                        // the operator needs the pre-restore path and the
                        // relaunch instruction, not just "complete".
                        (data) => setInfo(restoreCompletionMessage(data as RestoreInfo | undefined))
                      )
                    }}
                    className="rounded border border-[var(--warning)] bg-[var(--warning)]/10 px-2 py-0.5 text-[12px] hover:bg-[var(--warning)]/20 disabled:opacity-50"
                  >
                    {t('Restore')}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>

      {/* Release M11 (A4 F13): the SQLCipher binding (better-sqlite3-multiple-ciphers) is not a
          dependency of this build, so the option cannot succeed — hide it rather than tell a
          user to install an npm package into a packaged app. Renders only when the main
          process reports the binding present (or is still loading). */}
      {(encryption === null || encryption.bindingAvailable) && (
      <Section title={t('Encryption (PS9)')}>
        {encryption === null ? (
          <div className="text-[12px] text-[var(--text-muted)]">loading…</div>
        ) : (
          <>
            <StatusRow
              label={t('Status')}
              value={
                encryption.databaseEncrypted ? (
                  <span className="text-[var(--success)]">encrypted</span>
                ) : (
                  'plaintext'
                )
              }
            />
            {!encryption.databaseEncrypted ? (
              <div className="mt-2 space-y-2">
                <input
                  type="password"
                  placeholder={t('New passphrase (min 8 chars)')}
                  value={encryptPassphrase}
                  onChange={(e) => setEncryptPassphrase(e.target.value)}
                  className="w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-[12px]"
                />
                <input
                  type="password"
                  placeholder={t('Confirm passphrase')}
                  value={encryptConfirm}
                  onChange={(e) => setEncryptConfirm(e.target.value)}
                  className="w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-[12px]"
                />
                <button
                  disabled={
                    busy !== null ||
                    encryptPassphrase.length < 8 ||
                    encryptPassphrase !== encryptConfirm
                  }
                  onClick={() =>
                    runAction('Encrypt database', () =>
                      window.api.persistence.enableEncryption(encryptPassphrase)
                    )
                  }
                  className="rounded border border-[var(--error)] bg-[var(--error)]/10 px-2 py-1 text-[12px] hover:bg-[var(--error)]/20 disabled:opacity-50"
                >
                  {busy === 'Encrypt database' ? 'Encrypting…' : 'Encrypt database'}
                </button>
                <div className="text-[var(--text-muted)]">
                  Requires app relaunch. The plaintext file is moved aside as a
                  timestamped backup so you can roll back manually if needed.
                </div>
              </div>
            ) : (
              <div className="mt-2 space-y-2">
                <input
                  type="password"
                  placeholder={t('Current passphrase')}
                  value={decryptPassphrase}
                  onChange={(e) => setDecryptPassphrase(e.target.value)}
                  className="w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-[12px]"
                />
                <button
                  disabled={busy !== null || decryptPassphrase.length === 0}
                  onClick={() =>
                    runAction('Decrypt database', () =>
                      window.api.persistence.disableEncryption(decryptPassphrase)
                    )
                  }
                  className="rounded border border-[var(--border)] px-2 py-1 text-[12px] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                >
                  {busy === 'Decrypt database' ? 'Decrypting…' : 'Decrypt database'}
                </button>
              </div>
            )}
          </>
        )}
      </Section>
      )}
    </div>
  )
}
