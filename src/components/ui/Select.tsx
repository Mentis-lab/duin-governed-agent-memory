import { forwardRef } from 'react'
import { cn } from '@/duin/lib/utils'

// Single source of truth for lamprey <select> dropdowns — captures the dominant
// ad-hoc select look (bordered, bg-primary, px-2 py-1.5 text-[12px], accent
// focus) that was repeated inline across the app with drift (bg-tertiary vs
// bg-primary, text-[11px] vs text-[12px]). Native <select> passthrough. NOT
// full-width by default (most usages are inline next to a label) — add `w-full`
// via className for form fields. Override per instance via className.
export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          'rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)] disabled:opacity-50',
          className
        )}
        {...props}
      >
        {children}
      </select>
    )
  }
)
