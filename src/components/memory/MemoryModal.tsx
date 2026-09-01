import { t } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { IconButton } from '@/components/ui/IconButton'
import { useUiStore } from '@/stores/ui-store'
import { toast } from '@/stores/toast-store'
import { MemoryPanel } from './MemoryPanel'

interface DataPaths {
  userData: string
  dbPath: string
}

export function MemoryModal() {
  const open = useUiStore((s) => s.memoryOpen)
  const close = useUiStore((s) => s.closeMemory)
  const [paths, setPaths] = useState<DataPaths | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    window.api?.app
      ?.getDataDir?.()
      .then((res: { success: boolean; data?: DataPaths }) => {
        if (!cancelled && res.success && res.data) setPaths(res.data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open) return null

  const openFolder = () => {
    if (!paths?.userData) return
    window.api?.app?.openPath?.(paths.userData).catch(() => {
      toast.error('Could not open folder')
    })
  }

  const copyPath = async (p: string) => {
    try {
      await navigator.clipboard.writeText(p)
      toast.success('Path copied')
    } catch {
      toast.error('Could not copy path')
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('Memory')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={close}
    >
      <div
        className="relative flex h-[80vh] w-[min(720px,92vw)] flex-col overflow-hidden rounded-xl border border-[var(--panel-border)] bg-[var(--bg-secondary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 py-3">
          <div>
            <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">{t('Memory')}</h2>
            <p className="text-[12px] text-[var(--text-muted)]">
              {t('Facts the assistant remembers across conversations.')}
            </p>
          </div>
          <IconButton
            onClick={close}
            aria-label={t('Close')}
            title={t('Close (Esc)')}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </IconButton>
        </header>

        {paths && (
          <div className="flex flex-col gap-1 bg-[var(--bg-primary)] px-4 py-2 text-[11px] text-[var(--text-muted)]">
            <div className="flex items-center gap-2">
              <span className="shrink-0 font-mono uppercase tracking-wider">DB:</span>
              <code
                className="flex-1 truncate font-mono text-[var(--text-secondary)]"
                title={paths.dbPath}
              >
                {paths.dbPath}
              </code>
              <button
                type="button"
                onClick={() => copyPath(paths.dbPath)}
                className="rounded px-1.5 py-0.5 text-[11px] uppercase tracking-wider transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              >
                {t('Copy')}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="shrink-0 font-mono uppercase tracking-wider">{t('Folder:')}</span>
              <code
                className="flex-1 truncate font-mono text-[var(--text-secondary)]"
                title={paths.userData}
              >
                {paths.userData}
              </code>
              <button
                type="button"
                onClick={openFolder}
                className="rounded px-1.5 py-0.5 text-[11px] uppercase tracking-wider transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              >
                {t('Open')}
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          <MemoryPanel />
        </div>
      </div>
    </div>
  )
}
