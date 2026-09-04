// PanelKit — the one visual system for a right-panel surface. Home set the grammar; Learning
// and Decisions adopt it here so three surfaces read as one product: a section label in small
// caps, rows separated by a hairline (no card walls), one accent used identically, colour only
// for status, verbs as quiet text buttons with the primary verb in the accent, and a calm one-line
// empty state. Every piece is deliberately small; the panels compose them.

import type { ReactNode } from 'react'

export type Tone = 'ok' | 'warn' | 'crit' | 'muted' | 'accent'

const DOT: Record<Tone, string> = {
  ok: 'bg-[var(--success)]',
  warn: 'bg-[var(--warning)]',
  crit: 'bg-[var(--error)]',
  muted: 'bg-[var(--text-muted)]',
  accent: 'bg-[var(--accent)]'
}

export function ToneDot({ tone, title }: { tone: Tone; title?: string }): React.ReactElement {
  return <span aria-hidden title={title} className={`mt-[5px] inline-block h-2 w-2 shrink-0 rounded-full ${DOT[tone]}`} />
}

/** The summary line under the surface title: a few counts, and a quiet action on the right. */
export function PanelSummary({ parts, action }: { parts: string[]; action?: ReactNode }): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-2 px-1 pb-1 text-[12px] text-[var(--text-secondary)]">
      <span className="min-w-0 truncate tabular-nums">{parts.filter(Boolean).join(' · ')}</span>
      {action}
    </div>
  )
}

export function PanelSection({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }): React.ReactElement {
  return (
    <section aria-label={label}>
      <div className="flex items-baseline justify-between px-1 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        <span>{label}</span>
        {aside && <span className="normal-case tracking-normal">{aside}</span>}
      </div>
      {children}
    </section>
  )
}

/** A list whose rows are separated by one hairline. */
export function RowList({ children }: { children: ReactNode }): React.ReactElement {
  return <ul className="divide-y divide-[var(--panel-border)]/70">{children}</ul>
}

interface RowProps {
  dot?: Tone
  /** The main line. */
  primary: ReactNode
  /** The line under it, muted. */
  secondary?: ReactNode
  /** Right-aligned verbs or meta. */
  actions?: ReactNode
  /** When set, the primary block is a button. */
  onOpen?: () => void
  title?: string
  /** A left accent edge for the rows that need the operator. */
  emphasis?: boolean
  struck?: boolean
}

export function Row({ dot, primary, secondary, actions, onOpen, title, emphasis, struck }: RowProps): React.ReactElement {
  const body = (
    <>
      {dot && <ToneDot tone={dot} />}
      <span className="min-w-0 flex-1">
        <span className={`block text-[12.5px] leading-snug text-[var(--text-primary)] ${struck ? 'line-through decoration-[var(--text-muted)] text-[var(--text-secondary)]' : ''}`}>{primary}</span>
        {secondary && <span className="mt-0.5 block text-[11px] leading-snug text-[var(--text-muted)]">{secondary}</span>}
      </span>
    </>
  )
  return (
    <li className={`flex items-start gap-2 px-2 py-2 ${emphasis ? 'border-l-2 border-[var(--accent)] bg-[var(--accent-dim)]/60' : ''}`}>
      {onOpen ? (
        <button onClick={onOpen} title={title} className="flex min-w-0 flex-1 items-start gap-2 rounded-md text-left transition-colors hover:text-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-2">{body}</div>
      )}
      {actions && <span className="flex shrink-0 items-center gap-2 pt-0.5">{actions}</span>}
    </li>
  )
}

interface VerbProps {
  tone?: 'accent' | 'quiet' | 'danger'
  onClick: () => void
  disabled?: boolean
  title?: string
  children: ReactNode
}

/** A verb is text, not a box: the accent for the one you most likely want, quiet for the
 *  rest, and danger only reveals itself on hover. */
export function Verb({ tone = 'quiet', onClick, disabled, title, children }: VerbProps): React.ReactElement {
  const cls =
    tone === 'accent'
      ? 'font-medium text-[var(--accent)] hover:underline'
      : tone === 'danger'
        ? 'text-[var(--text-muted)] hover:text-[var(--error)]'
        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded px-1 text-[11px] transition-colors active:translate-y-px disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${cls}`}
    >
      {children}
    </button>
  )
}

/** A tertiary group that starts closed: "Vetoed (4)". */
export function Folded({ label, count, open, onToggle, children }: { label: string; count: number; open: boolean; onToggle: () => void; children: ReactNode }): React.ReactElement {
  return (
    <div className="pt-2">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        <span>{label}</span>
        <span className="tabular-nums normal-case tracking-normal">{count}</span>
      </button>
      {open && children}
    </div>
  )
}

/** One calm line, and at most one thing to do. */
export function CalmEmpty({ text, action }: { text: string; action?: ReactNode }): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-3 text-[12px] text-[var(--text-secondary)]">
      <span>{text}</span>
      {action}
    </div>
  )
}
