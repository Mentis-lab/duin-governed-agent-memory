import { t } from '@/lib/i18n'
import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { toast } from '@/stores/toast-store'
import { postCorrection, runReflect } from '@/duin/lib/state'

interface MessageActionsProps {
  content: string
  onFork?: () => void
  onPin?: () => void
  /** Save the reply into global memory. Returns true on success (drives the ✓ flash). */
  onRemember?: () => Promise<boolean>
  /** The user prompt this reply answered — gives a correction more context (optional). */
  prompt?: string
  /**
   * Whose message this row belongs to. `'user'` renders COPY ONLY.
   *
   * The whole row used to be gated behind `!isUser` in MessageBubble, so your own messages had
   * no copy button at all — and re-sending or quoting something you had already typed meant
   * retyping it. The rest of the row is genuinely assistant-only (you do not teach DUIN by
   * rating your own prompt, and fork/bookmark anchor on a reply), so the variant hides those
   * rather than showing controls that do nothing useful here.
   */
  variant?: 'assistant' | 'user'
}

type Vote = 'up' | 'down' | null

// Shared glyph wrapper — matches the app's inline-SVG convention (see
// Titlebar.tsx): viewBox 0 0 24 24, currentColor stroke so the icons theme
// automatically. Sized ~18px to read crisply inside the 64px action buttons.
interface GlyphProps {
  children: React.ReactNode
}

function Glyph({ children }: GlyphProps) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

const CopyGlyph = (
  <Glyph>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Glyph>
)

const ThumbsUpGlyph = (
  <Glyph>
    <path d="M7 10v12" />
    <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
  </Glyph>
)

const ThumbsDownGlyph = (
  <Glyph>
    <path d="M17 14V2" />
    <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
  </Glyph>
)

const ForkGlyph = (
  <Glyph>
    <circle cx="12" cy="18" r="3" />
    <circle cx="6" cy="6" r="3" />
    <circle cx="18" cy="6" r="3" />
    <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
    <path d="M12 12v3" />
  </Glyph>
)

// Bookmark (formerly "Pin as memory chapter") — an in-chat navigation marker.
const BookmarkGlyph = (
  <Glyph>
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </Glyph>
)

// Save to memory — a brain glyph (this reply becomes durable memory the brain draws on).
const MemoryGlyph = (
  <Glyph>
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
  </Glyph>
)

// Small inline check for the ✓ confirmation flash on an action button.
const CheckGlyph = (
  <Glyph>
    <path d="M20 6L9 17l-5-5" />
  </Glyph>
)

interface ActionButtonProps {
  icon: React.ReactNode
  title: string
  onClick: () => void
  active?: boolean
}

function ActionButton({ icon, title, onClick, active }: ActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
        active
          ? 'bg-[var(--accent-dim)] text-[var(--accent)] ring-1 ring-[var(--accent)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
      }`}
    >
      {icon}
    </button>
  )
}

export function MessageActions({
  content,
  onFork,
  onPin,
  onRemember,
  prompt,
  variant = 'assistant'
}: MessageActionsProps) {
  const isUserRow = variant === 'user'
  const [vote, setVote] = useState<Vote>(null)
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)
  const [savingMem, setSavingMem] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy to clipboard')
    }
  }

  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  // 👎 captures an operator correction into the learning loop; 👍 captures a positive
  // (reinforcement). Both fire a cheap reflect so taste recompiles. Best-effort — a
  // brain that's down just no-ops, never blocks the UI.
  const handleVote = (v: Vote) => {
    if (v === 'up') {
      setVote((prev) => (prev === 'up' ? null : 'up'))
      void postCorrection({ polarity: 'positive', ai_output: content, correction: '' })
        .then((r) => {
          if (r.ok) {
            toast.success('Logged 👍: reinforces this')
            void runReflect().catch(() => {})
          }
        })
        .catch(() => {})
    } else {
      setVote((prev) => (prev === 'down' ? null : 'down')) // toggles the note box
    }
  }

  const sendCorrection = async () => {
    const why = note.trim()
    if (!why) {
      setVote(null)
      return
    }
    setBusy(true)
    try {
      const r = await postCorrection({
        polarity: 'correction',
        ai_output: content,
        why,
        correction: why,
        skill: 'chat',
        artifact: prompt ? `reply to: ${prompt.slice(0, 80)}` : 'chat reply'
      })
      if (r.ok) {
        toast.success('Logged: DUIN will learn from this')
        void runReflect().catch(() => {})
      } else {
        toast.error(r.error || 'Could not log correction')
      }
    } catch {
      toast.error('Could not reach the brain')
    } finally {
      setBusy(false)
      setNote('')
      setVote(null)
    }
  }

  const handleSave = async () => {
    if (savingMem || saved || !onRemember) return
    setSavingMem(true)
    const ok = await onRemember().catch(() => false)
    setSavingMem(false)
    if (ok) {
      setSaved(true)
      setTimeout(() => setSaved(false), 1600)
    }
  }

  const handleFork = () => {
    if (onFork) onFork()
    else toast.info('Fork from this message: coming soon')
  }

  const handlePin = () => {
    if (onPin) onPin()
    else toast.info('Bookmark: coming soon')
  }

  return (
    <div className="mt-2 pl-1">
      {/* One grouped row, three intents: USE it (copy) · TEACH DUIN (👍/👎) ·
          KEEP it (save to memory / fork / bookmark). Each gives an inline
          confirmation instead of relying on a fleeting toast. */}
      <div className="flex items-center gap-1">
        {copied ? (
          <button
            type="button"
            title={t('Copied ✓')}
            aria-label={t('Copied')}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent-dim)] text-[var(--accent)]"
          >
            {CheckGlyph}
          </button>
        ) : (
          <ActionButton
            icon={CopyGlyph}
            title={isUserRow ? 'Copy message' : 'Copy reply'}
            onClick={handleCopy}
          />
        )}

        {!isUserRow && (
          <>
        <span className="mx-0.5 h-4 w-px bg-[var(--panel-border)]" aria-hidden />
        <ActionButton
          icon={ThumbsUpGlyph}
          title={t('Good answer: reinforce it (teaches DUIN)')}
          onClick={() => handleVote('up')}
          active={vote === 'up'}
        />
        <ActionButton
          icon={ThumbsDownGlyph}
          title={t('Needs work: tell DUIN what to fix')}
          onClick={() => handleVote('down')}
          active={vote === 'down'}
        />

        <span className="mx-0.5 h-4 w-px bg-[var(--panel-border)]" aria-hidden />
        {onRemember && (
          <ActionButton
            icon={saved ? CheckGlyph : MemoryGlyph}
            title={saved ? 'Saved to memory ✓' : 'Save this reply to your memory'}
            onClick={() => void handleSave()}
            active={saved}
          />
        )}
        <ActionButton icon={ForkGlyph} title={t('Fork to a new chat from here')} onClick={handleFork} />
        <ActionButton icon={BookmarkGlyph} title={t('Bookmark this point in the chat')} onClick={handlePin} />
          </>
        )}
      </div>
      {!isUserRow && vote === 'down' && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            autoFocus
            value={note}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void sendCorrection()
              if (e.key === 'Escape') {
                setNote('')
                setVote(null)
              }
            }}
            placeholder={t('What should it have said? (this teaches DUIN)')}
            className="h-7 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-[12px] outline-none focus:border-[var(--accent)]"
          />
          <Button variant="primary" className="h-7"
            disabled={busy || !note.trim()}
            onClick={() => void sendCorrection()}
          >
            {busy ? '…' : 'Teach'}
          </Button>
        </div>
      )}
    </div>
  )
}
