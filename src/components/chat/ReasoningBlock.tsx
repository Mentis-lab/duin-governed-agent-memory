import { t } from '@/lib/i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownRenderer } from '@/components/artifacts/MarkdownRenderer'
import { stripAnsi } from '@/lib/ansi'

interface ReasoningBlockProps {
  content: string
  isThinking?: boolean
}

export function ReasoningBlock({ content: raw, isThinking = false }: ReasoningBlockProps) {
  // Belt-and-braces ANSI strip. Main now strips at ingest
  // (duin-bridge.ts / providers/registry.ts), so live reasoning arrives clean —
  // but rows PERSISTED before that fix still carry raw escapes in SQLite, and
  // this card renders markdown, not a terminal, so an `ESC[1m` shows up as a
  // literal "1m". Also keeps the char counter below honest, since it used to
  // include the invisible escape bytes.
  const content = useMemo(() => stripAnsi(raw), [raw])

  // Auto-expand while the model is actively thinking; collapse once the
  // reasoning block closes so the final answer is the focus.
  const [expanded, setExpanded] = useState(isThinking)
  const [userOverride, setUserOverride] = useState(false)

  useEffect(() => {
    if (userOverride) return
    setExpanded(isThinking)
  }, [isThinking, userOverride])

  // Keep the streaming chain-of-thought pinned to its latest line -- new
  // reasoning appends at the bottom, so follow it there while thinking instead
  // of leaving the user staring at the stale top of a long trace.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (isThinking && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [content, isThinking])

  if (!content && !isThinking) return null

  const handleToggle = () => {
    setUserOverride(true)
    setExpanded((v) => !v)
  }

  return (
    <div className="mb-2 overflow-hidden rounded-2xl border border-[var(--panel-border)] bg-[var(--bg-primary)] shadow-sm">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
      >
        <span className="flex items-center gap-2">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {expanded ? <path d="M6 9l6 6 6-6" /> : <path d="M9 6l6 6-6 6" />}
          </svg>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={isThinking ? 'animate-pulse' : ''}
            aria-hidden
          >
            <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
            <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
            <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
          </svg>
          <span className="uppercase tracking-wider">{t('Reasoning')}</span>
          {isThinking && (
            <span className="rounded-full bg-[var(--accent-dim)] px-2 py-0.5 text-[11px] text-[var(--accent)]">
              thinking...
            </span>
          )}
        </span>
        <span className="text-[12px] text-[var(--text-muted)]">
          {content.length} {content.length === 1 ? 'char' : 'chars'}
        </span>
      </button>
      {expanded && (
        <div
          ref={scrollRef}
          className="max-h-[260px] overflow-auto border-t border-[var(--panel-border)] px-3 py-2 text-[12px] leading-relaxed text-[var(--text-secondary)]"
        >
          <MarkdownRenderer content={content} streaming={isThinking} />
        </div>
      )}
    </div>
  )
}
