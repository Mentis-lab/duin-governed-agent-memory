import { t } from '@/lib/i18n'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { Button } from '@/components/ui/Button'
import { MarkdownRenderer } from '@/components/artifacts/MarkdownRenderer'
import {
  enqueue,
  dequeue,
  reconcile,
  remainingMs,
  isExpired,
  buildAnswer,
  isTextEntryTarget,
  queuePositionLabel,
  otherIndex,
  type AskUserAwaitingEvent,
  type AskUserQueueEntry,
  type AskUserListedEntry
} from './ask-user-queue'

// H6 — Modal surfaced when a workflow or subagent invokes ask_user_question
// (or `askUser(...)` in workflow sandbox). Chip-style options + an
// auto-appended "Other" free-text path. The caller's promise stays parked
// in the main-process runtime until the user picks (or timeout fires); the
// modal just relays the choice back via ask-user:respond.
//
// U11 — this used to hold ONE question in useState over a Map-based runtime
// with two producers, so a second question destroyed the first. It is now a
// queue, hydrated from `ask-user:list` on mount; all of the queue/answer logic
// lives in ./ask-user-queue.ts where it can be tested (node-only vitest env).
export function AskUserModal() {
  const [queue, setQueue] = useState<AskUserQueueEntry[]>([])
  const [focusIdx, setFocusIdx] = useState<number>(0)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [otherText, setOtherText] = useState<string>('')
  const [notes, setNotes] = useState<string>('')
  const [now, setNow] = useState<number>(() => Date.now())
  /** Set when the runtime reported `{ matched: false }` — the question was
   *  already resolved (timed out / cancelled) before the answer landed. */
  const [staleAnswer, setStaleAnswer] = useState<string | null>(null)

  const event = queue.length > 0 ? queue[0] : null

  useEffect(() => {
    if (!window.api?.askUser) return
    const dispose = window.api.askUser.onAwaiting((raw) => {
      setQueue((q) => enqueue(q, raw as AskUserAwaitingEvent))
    })
    return typeof dispose === 'function' ? dispose : undefined
  }, [])

  // U11(a) — a renderer reload drops the `ask-user:awaiting` broadcast on the
  // floor and the caller then blocks for its whole timeout with nothing on
  // screen. `ask-user:list` was registered with zero callers; this is the
  // caller. It also prunes entries the runtime no longer holds.
  useEffect(() => {
    if (!window.api?.askUser?.list) return
    let cancelled = false
    void (async () => {
      try {
        const res = await window.api.askUser.list()
        if (cancelled || !res?.success || !Array.isArray(res.data)) return
        setQueue((q) => reconcile(q, res.data as AskUserListedEntry[]))
      } catch (err) {
        console.error('[AskUserModal] list failed:', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Reset the per-question draft whenever the head of the queue changes.
  const headId = event?.requestId ?? null
  useEffect(() => {
    setFocusIdx(0)
    setPicked(new Set())
    setOtherText('')
    setNotes('')
    setStaleAnswer(null)
  }, [headId])

  // Countdown. Ticks wall-clock `now` rather than a mount-relative elapsed
  // count, so a question that was already half-expired when the renderer
  // picked it up shows the truth.
  useEffect(() => {
    if (!event || event.timeoutMs === null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [event])

  const left = event ? remainingMs(event, now) : null
  const expired = event ? isExpired(event, now) : false
  const locked = expired || staleAnswer !== null

  const dismiss = useCallback((requestId: string) => {
    setQueue((q) => dequeue(q, requestId))
  }, [])

  const submit = useCallback(
    async (answer: unknown) => {
      if (!event) return
      const requestId = event.requestId
      try {
        const res = await window.api?.askUser.respond({ requestId, answer })
        // U11(b) — the runtime reports whether the pending entry was still
        // there. Discarding this closed the modal as if a post-timeout answer
        // had been delivered.
        if (res && res.success && res.data && res.data.matched === false) {
          setStaleAnswer(
            'That question had already timed out, so your answer was not delivered. The agent moved on without it.'
          )
          return
        }
      } catch (err) {
        console.error('[AskUserModal] respond failed:', err)
      }
      dismiss(requestId)
    },
    [event, dismiss]
  )

  const cancel = useCallback(() => {
    if (!event) return
    // Once the question is resolved on the runtime side (timed out, or a
    // respond that came back unmatched) there is nothing left to cancel —
    // sending the `cancelled` sentinel would just come back unmatched again
    // and the modal would never close.
    if (locked) {
      dismiss(event.requestId)
      return
    }
    void submit({ kind: 'cancelled' })
  }, [event, locked, dismiss, submit])

  const confirm = useCallback(() => {
    if (!event || locked) return
    const answer = buildAnswer({ entry: event, focusIdx, picked, otherText, notes })
    if (!answer) return
    void submit(answer)
  }, [event, locked, picked, focusIdx, otherText, notes, submit])

  const otherIdx = useMemo(() => (event ? otherIndex(event) : 0), [event])

  const togglePicked = useCallback((idx: number) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }, [])

  // Keyboard nav
  useEffect(() => {
    if (!event) return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
        return
      }
      if (locked) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusIdx((i) => Math.min(i + 1, event?.options.length ?? 0))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusIdx((i) => Math.max(0, i - 1))
      } else if (e.key === 'Enter' && !isTextEntryTarget(e.target)) {
        e.preventDefault()
        confirm()
      } else if (event && event.multiSelect && e.key === ' ' && !isTextEntryTarget(e.target)) {
        // U11(c) — this branch had no target guard where the Enter branch
        // above did, so a space typed in the notes field silently checked the
        // focused option and Send then carried a choice the user never made.
        e.preventDefault()
        togglePicked(focusIdx)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [event, locked, focusIdx, cancel, confirm, togglePicked])

  if (!event) return null

  const position = queuePositionLabel(0, queue.length)

  const optionRows = event.options.map((opt, i) => {
    const isFocused = focusIdx === i
    const isPicked = picked.has(i)
    return (
      <button
        key={`opt-${i}`}
        type="button"
        disabled={locked}
        onClick={() => {
          setFocusIdx(i)
          if (event.multiSelect) {
            togglePicked(i)
          } else {
            // single-select click = submit immediately for snappy UX
            void submit({
              kind: 'single',
              label: opt.label,
              header: event.header,
              notes: notes.trim() || undefined
            })
          }
        }}
        className={
          'w-full rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ' +
          (isFocused
            ? 'border-[var(--accent)] bg-[var(--accent)]/10'
            : 'border-[var(--panel-border)] bg-[var(--bg-secondary)] hover:border-[var(--accent)]/60')
        }
      >
        <div className="flex items-center gap-2">
          {event.multiSelect && (
            <span
              className={
                'inline-flex h-4 w-4 items-center justify-center rounded border ' +
                (isPicked
                  ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                  : 'border-[var(--panel-border)] bg-transparent')
              }
              aria-hidden
            >
              {isPicked ? '✓' : ''}
            </span>
          )}
          <span className="text-[12px] font-medium text-[var(--text-primary)]">{opt.label}</span>
        </div>
        {opt.description && (
          <div className="mt-1 text-[12px] text-[var(--text-muted)]">{opt.description}</div>
        )}
      </button>
    )
  })

  const focusedOption =
    focusIdx >= 0 && focusIdx < event.options.length ? event.options[focusIdx] : null

  const otherPicked = picked.has(otherIdx)

  return (
    <div
      role="dialog"
      aria-label={t('Question from agent')}
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[2px]"
    >
      {/* U11(d) — the backdrop had onClick={cancel}. A stray click outside the
          card answered a BLOCKING question with the `cancelled` sentinel and
          the agent took a phantom "user cancelled" branch. Cancelling is
          deliberate: the X, the Cancel button, or Escape. */}
      <div className="flex max-h-[80vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-[var(--panel-border)] bg-[var(--bg-primary)] shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-[var(--accent)]/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--accent)]">
              {event.header.slice(0, 12)}
            </span>
            {position && (
              <span className="rounded-full border border-[var(--panel-border)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
                {position}
              </span>
            )}
            <span className="text-[11px] text-[var(--text-muted)]">
              {expired
                ? 'expired'
                : left === null
                  ? 'waiting'
                  : `${Math.ceil(left / 1000)}s`}{' '}
              · {event.multiSelect ? 'multi-select' : 'pick one'}
            </span>
          </div>
          <button
            type="button"
            onClick={cancel}
            className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            aria-label={locked ? 'Dismiss' : 'Cancel'}
          >
            ✕
          </button>
        </div>

        {(expired || staleAnswer) && (
          <div className="mx-4 mb-2 rounded border border-[var(--warning)] bg-[var(--warning)]/10 px-2 py-1.5 text-[12px] text-[var(--text-primary)]">
            {staleAnswer ??
              'This question timed out. The agent has already continued without an answer.'}
          </div>
        )}

        {event.hydrated && !expired && (
          <div className="mx-4 mb-2 rounded border border-[var(--panel-border)] px-2 py-1.5 text-[12px] text-[var(--text-muted)]">
            Recovered after a reload — the preset options are no longer available. Type an answer
            below, or cancel.
          </div>
        )}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex w-1/2 min-w-0 flex-col gap-2 overflow-y-auto p-4">
            <div className="text-[14px] font-medium text-[var(--text-primary)]">
              {event.question}
            </div>
            <div className="mt-2 flex flex-col gap-1.5">{optionRows}</div>
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                setFocusIdx(otherIdx)
                // U11(c) — in multi-select "Other..." used to only take focus
                // and never join `picked`, so a mouse user's typed answer was
                // dropped on Send.
                if (event.multiSelect) togglePicked(otherIdx)
              }}
              className={
                'mt-1 w-full rounded-lg border px-3 py-2 text-left text-[12px] transition-colors disabled:opacity-50 ' +
                (focusIdx === otherIdx
                  ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                  : 'border-[var(--panel-border)] bg-[var(--bg-secondary)] hover:border-[var(--accent)]/60')
              }
            >
              <div className="flex items-center gap-2">
                {event.multiSelect && (
                  <span
                    className={
                      'inline-flex h-4 w-4 items-center justify-center rounded border ' +
                      (otherPicked
                        ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                        : 'border-[var(--panel-border)] bg-transparent')
                    }
                    aria-hidden
                  >
                    {otherPicked ? '✓' : ''}
                  </span>
                )}
                <span className="font-medium text-[var(--text-primary)]">Other…</span>
              </div>
              <div className="mt-1 text-[12px] text-[var(--text-muted)]">
                {t('Type a custom answer below.')}
              </div>
            </button>
            {(focusIdx === otherIdx || otherPicked) && (
              <input
                type="text"
                autoFocus
                disabled={locked}
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                placeholder={t('Your answer…')}
                className="rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] disabled:opacity-50"
              />
            )}
          </div>

          <div className="flex w-1/2 min-w-0 flex-col overflow-y-auto p-4">
            {focusedOption?.preview ? (
              <div className="prose prose-sm max-w-none text-[12px] text-[var(--text-primary)]">
                <MarkdownRenderer content={focusedOption.preview} />
              </div>
            ) : (
              <div className="text-[12px] italic text-[var(--text-muted)]">
                {focusedOption?.description ?? 'Focus an option to see details.'}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 bg-[var(--bg-secondary)] px-4 py-3">
          <input
            type="text"
            value={notes}
            disabled={locked}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('Optional notes for the agent…')}
            className="min-w-0 flex-1 rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] disabled:opacity-50"
          />
          <button
            type="button"
            onClick={cancel}
            className="rounded-md border border-[var(--panel-border)] px-3 py-1 text-[12px] text-[var(--text-muted)] hover:border-[var(--accent)]/60 hover:text-[var(--text-primary)]"
          >
            {locked ? 'Dismiss' : 'Cancel'}
          </button>
          <Button variant="primary" disabled={locked} onClick={confirm}>
            {t('Send')}
          </Button>
        </div>
      </div>
    </div>
  )
}
