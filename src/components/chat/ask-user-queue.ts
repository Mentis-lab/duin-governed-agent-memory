// U11 — the agent-question modal lost answers four different ways. This module
// holds every decision that used to be tangled into AskUserModal's render, so
// it can be tested (the renderer env here is node-only — no jsdom).
//
// The four losses:
//
//  (a) A single useState slot over a Map-based runtime. AskUserRuntime holds
//      Map<requestId, pending> and is designed AND tested for concurrency
//      (ask-user-runtime.test.ts), there is a second producer in
//      electron/ipc/workflows.ts, and `ask-user:list` is registered with zero
//      callers. A second question simply overwrote the first in the renderer:
//      the first was unrecoverable and its caller blocked until timeout.
//  (b) Answering after the 30s timeout closed the modal as if it had worked.
//      `ask-user:respond` returns { matched } and the renderer discarded it.
//  (c) In multi-select "Other..." only moved focus — it never joined `picked`,
//      so a mouse user's typed answer was dropped on Send. And the Space
//      branch had no input guard where the Enter branch did, so a space typed
//      in the notes field silently checked the first option.
//  (d) A backdrop click cancelled a blocking question with no confirmation.

export interface AskUserOption {
  label: string
  description?: string
  preview?: string
}

export interface AskUserAwaitingEvent {
  requestId: string
  question: string
  header: string
  options: AskUserOption[]
  multiSelect: boolean
  timeoutMs: number
  askedAt: number
}

/** One queued question. `timeoutMs: null` means "in flight but the deadline is
 *  unknown" — the shape produced by hydrating from `ask-user:list`, which
 *  reports only requestId/question/header/askedAt. */
export interface AskUserQueueEntry {
  requestId: string
  question: string
  header: string
  options: AskUserOption[]
  multiSelect: boolean
  timeoutMs: number | null
  askedAt: number
  /** True when reconstructed from `list()` rather than received live, so the
   *  UI can say the options are unavailable instead of pretending there were
   *  none. */
  hydrated?: boolean
}

/** What `ask-user:list` returns per in-flight question. */
export interface AskUserListedEntry {
  requestId: string
  question: string
  header: string
  askedAt: number
}

export type AskUserAnswer =
  | { kind: 'single'; label: string; header: string; notes?: string }
  | { kind: 'multi'; labels: string[]; header: string; notes?: string }
  | { kind: 'cancelled' }

export function toEntry(event: AskUserAwaitingEvent): AskUserQueueEntry {
  return {
    requestId: event.requestId,
    question: event.question,
    header: event.header,
    options: Array.isArray(event.options) ? event.options : [],
    multiSelect: !!event.multiSelect,
    timeoutMs: typeof event.timeoutMs === 'number' ? event.timeoutMs : null,
    askedAt: event.askedAt
  }
}

/** Append a newly-arrived question. Idempotent on requestId: the same event can
 *  legitimately arrive twice (two BrowserWindows, a re-broadcast), and that
 *  must not create two entries the user has to answer. */
export function enqueue(
  queue: readonly AskUserQueueEntry[],
  event: AskUserAwaitingEvent
): AskUserQueueEntry[] {
  const incoming = toEntry(event)
  const at = queue.findIndex((e) => e.requestId === incoming.requestId)
  if (at === -1) return [...queue, incoming]
  // A live event supersedes a hydrated stub — it carries the real options.
  const next = queue.slice()
  next[at] = incoming
  return next
}

export function dequeue(
  queue: readonly AskUserQueueEntry[],
  requestId: string
): AskUserQueueEntry[] {
  return queue.filter((e) => e.requestId !== requestId)
}

/**
 * Reconcile the local queue against the runtime's in-flight set.
 *
 * Two jobs: drop entries the runtime no longer holds (they timed out or were
 * cancelled while the renderer was away), and re-add ones the renderer never
 * saw — a reload drops the `ask-user:awaiting` broadcast on the floor and the
 * caller then blocks for its whole timeout with nothing on screen.
 *
 * `list()` cannot return options, so re-added entries are marked `hydrated`
 * with an empty option set: the free-text path still reaches the agent.
 */
export function reconcile(
  queue: readonly AskUserQueueEntry[],
  listed: readonly AskUserListedEntry[]
): AskUserQueueEntry[] {
  const inFlight = new Set(listed.map((l) => l.requestId))
  const kept = queue.filter((e) => inFlight.has(e.requestId))
  const known = new Set(kept.map((e) => e.requestId))
  const added: AskUserQueueEntry[] = listed
    .filter((l) => !known.has(l.requestId))
    .map((l) => ({
      requestId: l.requestId,
      question: l.question,
      header: l.header,
      options: [],
      multiSelect: false,
      timeoutMs: null,
      askedAt: l.askedAt,
      hydrated: true
    }))
  return [...kept, ...added]
}

/** Milliseconds left, or `null` when the deadline is unknown (hydrated entry). */
export function remainingMs(entry: AskUserQueueEntry, now: number): number | null {
  if (entry.timeoutMs === null) return null
  return Math.max(0, entry.askedAt + entry.timeoutMs - now)
}

/** U11(b) — an expired question must render as expired rather than accept an
 *  answer that the runtime has already resolved with `{kind:'timeout'}`. */
export function isExpired(entry: AskUserQueueEntry, now: number): boolean {
  return remainingMs(entry, now) === 0
}

/** The index of the synthetic "Other..." row. */
export function otherIndex(entry: AskUserQueueEntry): number {
  return entry.options.length
}

export interface AnswerDraft {
  entry: AskUserQueueEntry
  focusIdx: number
  picked: ReadonlySet<number>
  otherText: string
  notes: string
}

/**
 * Build the payload for `ask-user:respond`, or `null` when there is nothing
 * valid to send (so Send is a no-op instead of posting an empty choice).
 *
 * U11(c): in multi-select the "Other..." row participates in `picked` like any
 * other row. It previously only moved focus, so a mouse user who clicked it,
 * typed, and pressed Send had their answer silently dropped.
 */
export function buildAnswer(draft: AnswerDraft): AskUserAnswer | null {
  const { entry, focusIdx, picked, otherText, notes } = draft
  const trimmedNotes = notes.trim() || undefined
  const other = otherText.trim()
  const otherIdx = otherIndex(entry)

  if (entry.multiSelect) {
    const labels: string[] = []
    // Ascending rather than Set insertion order, so the agent sees the answer
    // in the order the options were presented.
    for (const idx of Array.from(picked).sort((a, b) => a - b)) {
      if (idx >= 0 && idx < entry.options.length) labels.push(entry.options[idx].label)
      else if (idx === otherIdx && other) labels.push(other)
    }
    if (labels.length === 0) return null
    return { kind: 'multi', labels, header: entry.header, notes: trimmedNotes }
  }

  if (focusIdx === otherIdx) {
    if (!other) return null
    return { kind: 'single', label: other, header: entry.header, notes: trimmedNotes }
  }
  if (focusIdx < 0 || focusIdx >= entry.options.length) return null
  return {
    kind: 'single',
    label: entry.options[focusIdx].label,
    header: entry.header,
    notes: trimmedNotes
  }
}

/**
 * U11(c) — the Space branch of the key handler had no input guard where the
 * Enter branch did, so typing a space in the notes field toggled the focused
 * option and Send then carried a choice the user never made.
 *
 * Duck-typed on purpose: node has no HTMLElement, and `closest` is absent on
 * plain fixtures. Deliberately NOT imported from hooks/shortcut-resolver —
 * this module must not depend on another directory's lifecycle.
 */
export function isTextEntryTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const el = target as {
    tagName?: unknown
    isContentEditable?: unknown
    closest?: (sel: string) => unknown
  }
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true
  if (el.isContentEditable === true) return true
  if (typeof el.closest === 'function') return !!el.closest('textarea, input')
  return false
}

/** Label for the queue position chip. `null` when there is nothing to
 *  disambiguate. */
export function queuePositionLabel(index: number, total: number): string | null {
  if (total <= 1) return null
  return `${index + 1} of ${total}`
}
