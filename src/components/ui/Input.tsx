import { forwardRef } from 'react'
import { cn } from '@/duin/lib/utils'

// Single source of truth for lamprey text inputs — captures the dominant ad-hoc
// input look (bordered, bg-primary, px-2 py-1.5 text-[12px], accent focus) that
// was repeated across ~120 raw <input> elements. No visual change; override per
// instance via className.
export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'w-full rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] disabled:opacity-50',
          className
        )}
        {...props}
      />
    )
  }
)
