// DUIN brain mark — inline SVG so the node follows the active theme.
//
// The line uses currentColor (inherits the surrounding text color), and the node
// is fill="var(--accent)" — the exact token the theme presets set on <html>
// (see src/styles/apply-theme.ts), so switching preset in Settings recolors the
// logo instantly. Rendered inline (not <img src={svg}>) precisely so --accent can
// reach the node; a CSS variable cannot cross into an <img>.

type Props = {
  /** Width in px; height scales to the mark's 150×120 ratio. */
  size?: number
  /** Accessible label; omit for decorative use (renders aria-hidden). */
  title?: string
  className?: string
}

export function DuinMark({ size = 26, title, className }: Props) {
  return (
    <svg
      viewBox="0 0 150 120"
      width={size}
      height={(size * 120) / 150}
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth={6.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M50 96 C29 93 18 74 25 55 C29 43 41 37 51 41 C51 29 67 21 81 27 C87 17 105 19 111 31 C125 32 133 50 126 65 C120 82 107 93 89 90 C69 87 57 73 64 59 C69 49 84 47 93 55"
      />
      <circle cx={50} cy={96} r={6.2} fill="var(--accent, #d97757)" />
    </svg>
  )
}
