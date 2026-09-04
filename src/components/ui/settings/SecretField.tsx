import { useState } from 'react'
import { cn } from '@/duin/lib/utils'
import { t } from '@/lib/i18n'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'

export interface SecretFieldProps {
  id?: string
  'aria-label': string
  value: string
  onChange: (next: string) => void
  /** Enter submits. */
  onSubmit?: () => void
  placeholder?: string
  disabled?: boolean
  className?: string
}

/** A masked input with a Show/Hide toggle. Shows only what the operator is typing, never a stored secret. */
export function SecretField({
  id,
  'aria-label': ariaLabel,
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  className
}: SecretFieldProps): React.ReactElement {
  const [shown, setShown] = useState(false)
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Input
        id={id}
        type={shown ? 'text' : 'password'}
        aria-label={ariaLabel}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onSubmit) {
            e.preventDefault()
            onSubmit()
          }
        }}
        className="font-mono"
      />
      <Button size="sm" aria-pressed={shown} onClick={() => setShown((v) => !v)} disabled={disabled}>
        {shown ? t('Hide') : t('Show')}
      </Button>
    </div>
  )
}
