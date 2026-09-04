import { useState } from 'react'
import { cn } from '@/duin/lib/utils'
import { t, tf } from '@/lib/i18n'
import { Button } from '@/components/ui/Button'
import { SecretField } from './SecretField'
import { SavedMark } from './SettingsRow'
import { flashWhenSaved, useSavedFlash } from './useSavedFlash'

/**
 * Whether a key is on file. `unknown` is a real state — the read failed or has not
 * answered — and renders as such; the cards this replaces painted it as "No key".
 */
export type KeyStatus = 'stored' | 'none' | 'unknown'

const DOT: Record<KeyStatus, string> = {
  stored: 'bg-[var(--success)]',
  none: 'bg-[var(--text-muted)]',
  unknown: 'bg-[var(--warning)]'
}

export function keyStatusLabel(status: KeyStatus): string {
  if (status === 'stored') return t('Key saved')
  if (status === 'none') return t('No key')
  return t('Status unavailable')
}

export interface ProviderKeyCardProps {
  name: string
  status: KeyStatus
  /** A line under the name: the free tier, what the key unlocks. */
  note?: React.ReactNode
  docs?: { href: string; label: string }
  /** Return the promise of the write to earn the Saved mark; the box clears on success. */
  onSave: (key: string) => Promise<boolean | void> | boolean | void
  onDelete?: () => Promise<boolean | void> | boolean | void
  onTest?: () => Promise<boolean | void> | boolean | void
  busy?: boolean
  /** Controls on the right of the header (a "Use this provider" button, a chip). */
  actions?: React.ReactNode
  /** Content under the field (a warning, a second field). */
  children?: React.ReactNode
  className?: string
}

/**
 * The one card for "a key for X". Header with a status dot, an optional note and docs
 * link, a masked field with Save, and Test / Delete only when a key is actually stored.
 */
export function ProviderKeyCard({
  name,
  status,
  note,
  docs,
  onSave,
  onDelete,
  onTest,
  busy,
  actions,
  children,
  className
}: ProviderKeyCardProps): React.ReactElement {
  const [draft, setDraft] = useState('')
  const { saved, flash } = useSavedFlash()
  const fieldLabel = tf('{name} API key', { name })

  const save = (): void => {
    const key = draft.trim()
    if (!key) return
    Promise.resolve(onSave(key))
      .then((ok) => {
        if (ok === true) {
          setDraft('')
          flash()
        }
      })
      .catch(() => {
        /* the caller toasted */
      })
  }

  return (
    <div className={cn('rounded-lg border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span aria-hidden className={cn('inline-block h-2 w-2 shrink-0 rounded-full', DOT[status])} />
            <span className="text-[13px] font-medium text-[var(--text-primary)]">{name}</span>
            <span className="text-[11px] text-[var(--text-muted)]">{keyStatusLabel(status)}</span>
            {saved && <SavedMark />}
          </div>
          {note && <p className="mt-1 text-[12px] text-[var(--text-muted)]">{note}</p>}
          {docs && (
            <a
              href={docs.href}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-[12px] text-[var(--accent)] underline-offset-2 hover:underline"
            >
              {docs.label} →
            </a>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <SecretField
          aria-label={fieldLabel}
          value={draft}
          onChange={setDraft}
          onSubmit={save}
          placeholder={status === 'stored' ? t('Paste a new key to replace it') : t('Paste API key')}
          disabled={busy}
          className="min-w-[240px] flex-1"
        />
        <Button variant="primary" size="sm" onClick={save} disabled={busy || !draft.trim()}>
          {t('Save key')}
        </Button>
        {status === 'stored' && onTest && (
          <Button size="sm" onClick={() => flashWhenSaved(onTest(), flash)} disabled={busy}>
            {t('Test')}
          </Button>
        )}
        {status === 'stored' && onDelete && (
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (typeof window !== 'undefined' && !window.confirm(tf('Delete the {name} key?', { name }))) return
              void onDelete()
            }}
          >
            {t('Delete')}
          </Button>
        )}
      </div>
      {children && <div className="mt-2">{children}</div>}
    </div>
  )
}
