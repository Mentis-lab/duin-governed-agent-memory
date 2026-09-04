import { useEffect, useState } from 'react'
import { cn } from '@/duin/lib/utils'
import { t, tf } from '@/lib/i18n'
import { Input } from '@/components/ui/Input'
import { SettingsRow, type RowTone } from './SettingsRow'
import { commitNumber, type NumberSpec } from './number-commit'
import { flashWhenSaved, useSavedFlash } from './useSavedFlash'

export interface NumberFieldProps {
  id?: string
  'aria-label': string
  value: number
  spec?: NumberSpec
  /** Shown after the box: "seconds", "tokens (0 = off)". */
  unit?: string
  /** When set and different from `value`, a "Reset · N" link restores it. */
  defaultValue?: number
  /** Return the store's promise to earn the Saved mark. */
  onCommit: (next: number) => Promise<boolean | void> | boolean | void
  disabled?: boolean
  className?: string
}

/**
 * A number the operator can actually type into: the draft is free text until blur or
 * Enter, then commitNumber() clamps once and the value is written. Escape reverts.
 */
export function NumberField({
  id,
  'aria-label': ariaLabel,
  value,
  spec,
  unit,
  defaultValue,
  onCommit,
  disabled,
  className
}: NumberFieldProps): React.ReactElement {
  const [draft, setDraft] = useState(String(value))
  const [focused, setFocused] = useState(false)
  // Follow the stored value while the operator is not typing (another surface, a reset).
  useEffect(() => {
    if (!focused) setDraft(String(value))
  }, [value, focused])
  const { saved, flash } = useSavedFlash()

  const commit = (): void => {
    const next = commitNumber(draft, value, spec)
    setDraft(String(next))
    if (next !== value) flashWhenSaved(onCommit(next), flash)
  }

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Input
        id={id}
        type="text"
        inputMode="decimal"
        aria-label={ariaLabel}
        value={draft}
        disabled={disabled}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          commit()
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            setDraft(String(value))
            e.currentTarget.blur()
          }
        }}
        className="w-28 text-right font-mono"
      />
      {unit && <span className="text-[11px] text-[var(--text-muted)]">{unit}</span>}
      {saved && (
        <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--success)]">{t('Saved')}</span>
      )}
      {defaultValue !== undefined && defaultValue !== value && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setDraft(String(defaultValue))
            flashWhenSaved(onCommit(defaultValue), flash)
          }}
          className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)] underline-offset-2 hover:underline disabled:opacity-50"
        >
          {tf('Reset · {value}', { value: defaultValue })}
        </button>
      )}
    </div>
  )
}

export interface NumberRowProps extends Omit<NumberFieldProps, 'aria-label' | 'className'> {
  /** Plain string: it doubles as the field's accessible name. */
  label: string
  hint?: React.ReactNode
  tone?: RowTone
}

/** A number setting as a card row: label and hint on the left, the field on the right. */
export function NumberRow({ label, hint, tone, ...field }: NumberRowProps): React.ReactElement {
  return <SettingsRow label={label} hint={hint} tone={tone} control={<NumberField aria-label={label} {...field} />} />
}
