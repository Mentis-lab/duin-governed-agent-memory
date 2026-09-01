import { forwardRef } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/duin/lib/utils'

// The single source of truth for lamprey buttons. Captures the ad-hoc button
// "looks" that were repeated inline across ~550 raw <button> elements — WITHOUT
// changing their appearance (same tokens, same dominant sizing px-3 py-1.5
// text-[12px]). Variants map 1:1 to the patterns the audit found:
//   primary   — accent fill (30x)          secondary — bordered, neutral (33x, DEFAULT)
//   outline   — bordered card button        ghost     — borderless, hover fill
//   danger    — error-toned                 pill      — rounded accent chip
// Override anything per-instance via className (tailwind-merge resolves conflicts).
const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-[color,background-color,border-color,transform] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/50 active:translate-y-px active:opacity-95 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-[var(--accent)] text-[var(--on-accent)] hover:opacity-90',
        secondary:
          'border border-[var(--panel-border)] bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]',
        outline:
          'border border-[var(--panel-border)] bg-[var(--bg-primary)] text-[var(--text-primary)] hover:border-[var(--accent)]',
        ghost:
          'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]',
        danger:
          'border border-[var(--panel-border)] bg-transparent text-[var(--error)] hover:bg-[var(--error)]/10',
        pill: 'rounded-full bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/15'
      },
      size: {
        sm: 'px-2 py-1 text-[11px]',
        md: 'px-3 py-1.5 text-[12px]',
        lg: 'px-4 py-2 text-[12px]'
      }
    },
    defaultVariants: { variant: 'secondary', size: 'md' }
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type = 'button', ...props },
  ref
) {
  return <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
})

export { buttonVariants }
