import { useEffect, useState } from 'react'
import { cn } from '@/duin/lib/utils'
import { t } from '@/lib/i18n'
import { flashWhenSaved, useSavedFlash } from './useSavedFlash'

export interface DraftTextareaProps {
  id?: string
  'aria-label': string
  value: string
  /** Called on blur (and Ctrl/Cmd+Enter) when the draft differs from `value`. */
  onCommit: (next: string) => Promise<boolean | void> | boolean | void
  rows?: number
  placeholder?: string
  disabled?: boolean
  className?: string
}

/**
 * Free text that is a DRAFT until you leave it. The textarea it replaces was bound to the
 * store value, which only updates after the serialized settings write resolves, so fast
 * typing dropped characters, the caret jumped, and Chinese and Japanese composition broke.
 */
export function DraftTextarea({
  id,
  'aria-label': ariaLabel,
  value,
  onCommit,
  rows = 4,
  placeholder,
  disabled,
  className
}: DraftTextareaProps): React.ReactElement {
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setDraft(value)
  }, [value, focused])
  const { saved, flash } = useSavedFlash()

  const commit = (): void => {
    if (draft === value) return
    flashWhenSaved(onCommit(draft), flash)
  }

  return (
    <div className="space-y-1">
      <textarea
        id={id}
        aria-label={ariaLabel}
        value={draft}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          commit()
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            commit()
          }
        }}
        className={cn(
          'w-full resize-y rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] px-3 py-2 text-[12px] leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] disabled:opacity-50',
          className
        )}
      />
      <div className="flex h-4 items-center justify-end">
        {saved ? (
          <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--success)]">{t('Saved')}</span>
        ) : draft !== value ? (
          <span className="text-[10px] text-[var(--text-muted)]">{t('Saves when you leave the box')}</span>
        ) : null}
      </div>
    </div>
  )
}
