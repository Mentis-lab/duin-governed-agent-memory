import { forwardRef } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/duin/lib/utils'

// Icon-only buttons (no text) — square padding, muted glyph, hover fill. Captures
// the ad-hoc `rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]
// hover:text-...` pattern repeated for close/remove/toggle glyphs. Pair with an
// aria-label for accessibility.
const iconButtonVariants = cva(
  'inline-flex shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/50 hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      size: { sm: 'p-1', md: 'p-1.5', lg: 'p-2' },
      tone: { default: '', danger: 'hover:text-[var(--error)]' }
    },
    defaultVariants: { size: 'sm', tone: 'default' }
  }
)

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButtonVariants> {}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, size, tone, type = 'button', ...props },
  ref
) {
  return <button ref={ref} type={type} className={cn(iconButtonVariants({ size, tone }), className)} {...props} />
})
