import { useId } from 'react'
import { cn } from '@/duin/lib/utils'
import { t } from '@/lib/i18n'
import { Toggle } from '@/components/ui/Toggle'
import { flashWhenSaved, useSavedFlash } from './useSavedFlash'

export type RowTone = 'default' | 'warning' | 'danger'

const TONE_CLASS: Record<RowTone, string> = {
  default: 'border-[var(--panel-border)]',
  warning: 'border-[var(--warning)]/60',
  danger: 'border-[var(--error)]/60'
}

export interface SettingsRowProps {
  label: React.ReactNode
  hint?: React.ReactNode
  /** The control, rendered on the right. */
  control?: React.ReactNode
  /** Extra content under the label and hint: a list, a field block, a status line. */
  children?: React.ReactNode
  /** Show the transient "Saved" mark beside the control. */
  saved?: boolean
  tone?: RowTone
  /** Id the control should reference (aria-labelledby); one is generated when absent. */
  labelId?: string
  className?: string
}

/** The card every setting sits in: label and hint on the left, the control on the right. */
export function SettingsRow({
  label,
  hint,
  control,
  children,
  saved,
  tone = 'default',
  labelId,
  className
}: SettingsRowProps): React.ReactElement {
  const generated = useId()
  const id = labelId ?? generated
  return (
    <div className={cn('rounded-lg border bg-[var(--bg-primary)] p-3', TONE_CLASS[tone], className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div id={id} className="text-[13px] font-medium text-[var(--text-primary)]">
            {label}
          </div>
          {hint && <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">{hint}</p>}
        </div>
        {(control || saved) && (
          <div className="flex shrink-0 items-center gap-2">
            {saved && <SavedMark />}
            {control}
          </div>
        )}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  )
}

/** The mark an auto-applied write earns when the store confirms it. */
export function SavedMark(): React.ReactElement {
  return (
    <span aria-live="polite" className="font-mono text-[10px] uppercase tracking-wider text-[var(--success)]">
      {t('Saved')}
    </span>
  )
}

export interface ToggleRowProps {
  /** Plain string: it doubles as the switch's accessible name. */
  label: string
  hint?: React.ReactNode
  checked: boolean
  /**
   * Return the store's promise (updateSettings resolves true on a persisted write) to earn
   * the Saved mark. A handler that returns nothing shows no mark.
   */
  onChange: (next: boolean) => Promise<boolean | void> | boolean | void
  disabled?: boolean
  tone?: RowTone
  children?: React.ReactNode
  id?: string
}

/** A boolean setting: auto-applies, switch on the right, named after its label. */
export function ToggleRow({ label, hint, checked, onChange, disabled, tone, children, id }: ToggleRowProps): React.ReactElement {
  const { saved, flash } = useSavedFlash()
  return (
    <SettingsRow
      label={label}
      hint={hint}
      tone={tone}
      saved={saved}
      control={
        <Toggle
          id={id}
          checked={checked}
          disabled={disabled}
          aria-label={label}
          onChange={(next) => flashWhenSaved(onChange(next), flash)}
        />
      }
    >
      {children}
    </SettingsRow>
  )
}
