import { t } from '@/lib/i18n'
import { useState } from 'react'
import { Toggle } from '@/components/ui/Toggle'
import { Button } from '@/components/ui/Button'
import type { ForkWorkspaceMode, SeedSourceKind } from '@/lib/types'

interface ForkDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: (opts: {
    seedKind: SeedSourceKind
    workspaceMode: ForkWorkspaceMode
    includeRagAttachments: boolean
  }) => Promise<void> | void
}

export function ForkDialog({ open, onClose, onConfirm }: ForkDialogProps) {
  const [seedKind, setSeedKind] = useState<SeedSourceKind>('message')
  const [workspaceMode, setWorkspaceMode] = useState<ForkWorkspaceMode>('current')
  const [includeRagAttachments, setIncludeRagAttachments] = useState(true)
  const [busy, setBusy] = useState(false)

  if (!open) return null

  const confirm = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onConfirm({ seedKind, workspaceMode, includeRagAttachments })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55">
      <div className="w-[360px] rounded-lg border border-[var(--panel-border)] bg-[var(--bg-secondary)] p-4 shadow-2xl">
        <div className="mb-3 font-mono text-[12px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          {t('Fork from message')}
        </div>
        <label className="mb-3 block text-[12px] text-[var(--text-secondary)]">
          <span className="mb-1 block">{t('Seed')}</span>
          <select
            value={seedKind}
            onChange={(e) => setSeedKind(e.target.value as SeedSourceKind)}
            className="w-full rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1.5 text-[16px] text-[var(--text-primary)]"
          >
            <option value="message">{t('Message')}</option>
            <option value="none">{t('No seed')}</option>
          </select>
        </label>
        <label className="mb-3 block text-[12px] text-[var(--text-secondary)]">
          <span className="mb-1 block">{t('Workspace')}</span>
          <select
            value={workspaceMode}
            onChange={(e) => setWorkspaceMode(e.target.value as ForkWorkspaceMode)}
            className="w-full rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1.5 text-[16px] text-[var(--text-primary)]"
          >
            <option value="current">{t('Current')}</option>
            <option value="inherit">{t('Source')}</option>
            <option value="none">{t('None')}</option>
          </select>
        </label>
        <label className="mb-4 flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
          <Toggle
            checked={includeRagAttachments}
            onChange={setIncludeRagAttachments}
            aria-label={t('Include attached sources')}
          />
          {t('Include attached sources')}
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-[16px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            {t('Cancel')}
          </button>
          <Button
            onClick={confirm}
            variant="primary"
            disabled={busy}
          >
            {t('Create')}
          </Button>
        </div>
      </div>
    </div>
  )
}
