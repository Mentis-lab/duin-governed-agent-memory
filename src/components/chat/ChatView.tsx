import { t } from '@/lib/i18n'
import { memo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { IconButton } from '@/components/ui/IconButton'
import { useChatStore } from '@/stores/chat-store'
import { useSkillsStore } from '@/stores/skills-store'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { AttachmentPreview } from './AttachmentPreview'
import { FileDropZone } from './FileDropZone'
import { BrainMap } from '@/duin/components/brain-shell'
import { useBrainStore } from '@/stores/brain-store'
import { TokenTicker } from './TokenTicker'
import { PlanModeBanner } from './PlanModeBanner'
import { ChapterSidebar } from './ChapterSidebar'
import { ChapterQuickJumper } from './ChapterQuickJumper'
import { SpawnTaskTray } from './SpawnTaskTray'
import { LineageChip } from './LineageChip'

// Shared chat column: max-width cap + internal padding. Messages and the
// input pill both use this so they sit in the same centered column no
// matter how wide the surrounding chat area gets. `max-w-4xl` (896 px) is
// the comfortable-reading width; `px-6` keeps content off the column edge.
export const CHAT_COLUMN_CLASS = 'chat-col mx-auto w-full max-w-5xl px-6'
// When the chat window is expanded, the column drops its reading-width cap and
// fills the widened panel (padding only), so the text scales with the expand
// instead of leaving a right-side gutter.
// The `chat-col-expanded` marker also drops the inner per-paragraph reading-measure
// cap (markdown.css) — without it the 72ch cap on <p>/<li>/headings keeps the text
// narrow even though the column is max-w-none, leaving a right-side gutter.
export const CHAT_COLUMN_EXPANDED_CLASS = 'chat-col-expanded mx-auto w-full max-w-none px-8'

interface ChatViewProps {
  // Pixels of right-side padding applied to the chat-column. When the
  // floating Environment card is visible the parent passes the card's
  // width here so the centered max-w-4xl content (messages + input pill)
  // re-centers within the remaining space — same effect as expanding
  // the right sidebar would have, but achieved by padding the chat-
  // column itself (inside its border, on the same bg-primary surface)
  // so no separator line appears between chat and card. Animates in
  // lockstep with the card's entry/exit.
  rightInset?: number
}

// One durable-queue chip: shows the queued prompt, with inline edit (double-click / pencil),
// up/down reorder, "send now", and remove. Local state holds the draft only while editing so a
// keystroke doesn't churn the whole ChatView tree.
function QueuedChip({
  index,
  total,
  content,
  onEdit,
  onRemove,
  onSendNow,
  onMoveUp,
  onMoveDown
}: {
  index: number
  total: number
  content: string
  onEdit: (text: string) => void
  onRemove: () => void
  onSendNow: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(content)

  const commit = () => {
    const t = draft.trim()
    if (t && t !== content) onEdit(t)
    else setDraft(content) // revert an empty/unchanged edit
    setEditing(false)
  }

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-[11px] text-[var(--text-secondary)]">
      <span className="shrink-0 rounded bg-[var(--accent)]/15 px-1 font-medium text-[var(--accent)]">
        queued {index + 1}
      </span>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setDraft(content)
              setEditing(false)
            }
          }}
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-1 py-0.5 text-[11px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />
      ) : (
        <span
          className="min-w-0 flex-1 cursor-text truncate"
          title={t('Double-click to edit')}
          onDoubleClick={() => {
            setDraft(content)
            setEditing(true)
          }}
        >
          {content}
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={index === 0}
          title={t('Move up')}
          className="px-0.5 text-[var(--text-secondary)] enabled:hover:text-[var(--text)] disabled:opacity-30"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={index === total - 1}
          title={t('Move down')}
          className="px-0.5 text-[var(--text-secondary)] enabled:hover:text-[var(--text)] disabled:opacity-30"
        >
          ↓
        </button>
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setDraft(content)
              setEditing(true)
            }}
            title={t('Edit')}
            className="px-0.5 text-[var(--text-secondary)] hover:text-[var(--text)]"
          >
            ✎
          </button>
        )}
        <button
          type="button"
          onClick={onSendNow}
          title={t('Send now (jump the queue)')}
          className="rounded px-1 font-medium text-[var(--accent)] hover:bg-[var(--accent)]/10"
        >
          send now
        </button>
        <button
          type="button"
          onClick={onRemove}
          title={t('Remove from queue')}
          className="px-0.5 text-[var(--text-secondary)] hover:text-[var(--text)]"
        >
          ×
        </button>
      </div>
    </div>
  )
}

// Memoized: the chat surface is heavy (message list + streaming), and App
// re-renders for unrelated UI state (menus, dialogs, active tool). With a
// stable `rightInset` prop, memo keeps those App renders from reconciling the
// whole chat tree.
function ChatViewImpl({ rightInset = 0 }: ChatViewProps = {}) {
  const reducedMotion = usePrefersReducedMotion()
  // Scoped subscription: re-render only when one of these fields changes (shallow),
  // not on every unrelated chat-store mutation (tool calls, run phase, vitals ticks).
  const {
    messages,
    isStreaming,
    streamingContent,
    streamStartedAt,
    activeConversationId,
    sendMessage,
    cancelStream,
    activeModel,
    chatDismissed,
    setChatDismissed,
    expanded,
    setExpanded,
    messageQueue,
    enqueueMessage,
    removeQueued,
    editQueued,
    reorderQueue,
    sendQueuedNow
  } = useChatStore(
    useShallow((s) => ({
      messages: s.messages,
      isStreaming: s.isStreaming,
      streamingContent: s.streamingContent,
      streamStartedAt: s.streamStartedAt,
      activeConversationId: s.activeConversationId,
      sendMessage: s.sendMessage,
      cancelStream: s.cancelStream,
      activeModel: s.activeModel,
      chatDismissed: s.chatDismissed,
      setChatDismissed: s.setChatDismissed,
      expanded: s.chatExpanded,
      setExpanded: s.setChatExpanded,
      messageQueue: s.messageQueue,
      enqueueMessage: s.enqueueMessage,
      removeQueued: s.removeQueued,
      editQueued: s.editQueued,
      reorderQueue: s.reorderQueue,
      sendQueuedNow: s.sendQueuedNow
    }))
  )
  // Active skills are read fresh at send time (see handleSend) — no render
  // subscription needed here; a slash-method sets them in the same tick as send.
  // `expanded` comes from the store (see chat-store `chatExpanded`) because App
  // has to drop the chat column's inner gutter while expanded — the panel cannot
  // widen past that gutter from the inside.
  // The chat is a popup bubble over the brain; `chatDismissed` (in the store)
  // hides it without losing the conversation. A new send OR selecting any
  // conversation re-opens it (selectConversation clears the flag).
  // DUIN-style node context: a picked graph node scopes the chat. The live
  // selection lives in brain-store; the PINNED (per-conversation) snapshot lives
  // in chat-store and survives the note being closed. Show whichever is present.
  const chatContext = useBrainStore((s) => s.chatContext)
  const setChatContext = useBrainStore((s) => s.setChatContext)
  const pinnedContext = useChatStore((s) =>
    activeConversationId ? s.conversationContexts[activeConversationId] : undefined
  )
  const clearConversationContext = useChatStore((s) => s.clearConversationContext)
  const effectiveContext = chatContext ?? pinnedContext ?? null

  const handleSend = (content: string) => {
    setChatDismissed(false)
    // Read the active skills FRESH at send time, not the render-captured closure:
    // a method slash-command activates its skills (setActiveSkillIds) immediately
    // before calling onSend in the same tick, so the captured `activeSkillIds`
    // would be stale and the method's skills would miss their own turn.
    const skills = useSkillsStore.getState().activeSkillIds
    // The "About the …" context prefix + per-conversation pinning now live in
    // chat-store.sendMessage (which reads brain-store.chatContext), so send the
    // RAW text here — queued turns also pick up the pinned context at drain time.
    if (isStreaming) {
      enqueueMessage(content, skills)
      return
    }
    sendMessage(content, skills)
  }

  // Queued prompts — editable, reorderable, send-now chips above the composer. The queue is durable
  // (persisted in chat-store), so these edits survive a reload/crash until they drain.
  //
  // The queue is ONE global list, but each entry belongs to the chat it was typed into, so only
  // this conversation's entries are shown and numbered — an entry parked while the user is
  // elsewhere reappears when they come back to its chat. (Without that filter a queued prompt
  // drains into whatever chat happens to be on screen.) The ORIGINAL index travels with each
  // entry so edit/remove/send-now still address the right slot in the global list, while the
  // visible position drives display numbering and the move-up/down affordances.
  const visibleQueue = messageQueue
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => !q.conversationId || q.conversationId === activeConversationId)
  const queueChips =
    visibleQueue.length > 0 ? (
      <div className="mb-1.5 flex flex-col gap-1 px-1">
        {visibleQueue.map(({ q, i }, n) => (
          <QueuedChip
            key={i}
            index={n}
            total={visibleQueue.length}
            content={q.content}
            onEdit={(text) => editQueued(i, text)}
            onRemove={() => removeQueued(i)}
            onSendNow={() => sendQueuedNow(i)}
            // Reorder against the adjacent VISIBLE neighbour's global index — stepping i±1 would
            // swap across an entry belonging to another conversation.
            onMoveUp={() => n > 0 && reorderQueue(i, visibleQueue[n - 1].i)}
            onMoveDown={() => n < visibleQueue.length - 1 && reorderQueue(i, visibleQueue[n + 1].i)}
          />
        ))}
      </div>
    ) : null

  // The chat overlay is open when there's a live conversation with messages and
  // it hasn't been dismissed. When closed, the native composer floats over the brain.
  const chatOpen = !!activeConversationId && messages.length > 0 && !chatDismissed

  // "Asking in context" chip — shown above the composer when a node is selected.
  const contextChip = effectiveContext ? (
    <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px]">
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-[var(--text-secondary)]">
        <span className="size-2 rounded-full bg-[var(--accent)]" />
        <span className="max-w-[220px] truncate">{effectiveContext.label}</span>
        <button
          onClick={() => {
            setChatContext(null)
            clearConversationContext(activeConversationId)
          }}
          aria-label={t('Clear context')}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          ✕
        </button>
      </span>
      <span className="text-[var(--text-muted)]">asking in context</span>
    </div>
  ) : null

  // The DUIN brain knowledge-graph is ALWAYS the home surface (chromeless: its
  // own lens bar + file rail are suppressed — those get rebuilt lamprey-native).
  // The chat is a popup BUBBLE floating over the brain (DUIN-style), so asking
  // never hides the graph. Right-anchored; the graph stays visible behind it.
  return (
    <div
      className="relative isolate flex min-w-0 flex-1 flex-col overflow-hidden"
      style={{
        paddingRight: rightInset,
        transition: reducedMotion ? undefined : 'padding-right 220ms cubic-bezier(0.2, 0.8, 0.2, 1)'
      }}
    >
      <FileDropZone />
      <PlanModeBanner conversationId={activeConversationId} />
      <LineageChip />
      <ChapterSidebar conversationId={activeConversationId} />
      <ChapterQuickJumper conversationId={activeConversationId} />

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <BrainMap
          onAsk={(text) => handleSend(text)}
          onChat={(prefill) => handleSend(prefill)}
          onOpenView={() => {}}
          chromeless
        />

        {/* Native lamprey composer, centered over the brain — replaces DUIN's
            "Ask your brain…" omnibox. Hidden while the chat overlay is open
            (the overlay carries its own composer). */}
        {!chatOpen && (
          <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center px-4">
            {/* min-w keeps the composer usable when the right panel + sidebar
                squeeze the center column below ~2xl; it overflows the narrow
                column (centered over the graph) rather than collapsing so the
                placeholder wraps. pointer-events re-enabled on the box itself. */}
            <div className="pointer-events-auto w-full max-w-2xl min-w-[20rem]">
              <AttachmentPreview />
              {contextChip}
              {queueChips}
              <ChatInput onSend={handleSend} onCancel={cancelStream} isStreaming={isStreaming} />
            </div>
          </div>
        )}

        {chatOpen && (
          <div
            className={`absolute inset-0 z-30 flex items-center justify-center ${expanded ? 'p-0' : 'p-6'}`}
            onMouseDown={(e) => {
              // Expanded fills the whole surface, so there is no backdrop to click — only the
              // collapsed (floating) window leaves a dismiss margin around itself.
              if (!expanded && e.target === e.currentTarget) setChatDismissed(true)
            }}
          >
            {/* Expanded → drop the reading-width + height caps and the outer gutter (p-0 above)
                so the panel fills its whole column, hiding the brain graph behind it. App also
                drops the column's own 8px inset while expanded (chat-store `chatExpanded`), so
                the panel reaches the same substrate gap the Sidebar and right panel sit on —
                and it keeps the app's --panel-radius there rather than squaring off, so an
                expanded chat reads as the same kind of surface as every other panel.
                Collapsed → a floating rounded card capped at max-w-2xl / max-h-[80vh]. */}
            <div className={`flex h-full w-full flex-col overflow-hidden border border-[var(--panel-border)] bg-[var(--panel-bg)]/97 shadow-2xl backdrop-blur-md transition-all ${expanded ? 'max-h-none max-w-none rounded-[var(--panel-radius)]' : 'max-h-[80vh] max-w-2xl rounded-2xl'}`}>
            <div className="flex items-center justify-between border-b border-[var(--panel-border)] px-3 py-2">
              <span className="text-[12px] font-medium text-[var(--text-secondary)]">{t('Chat with your brain')}</span>
              <div className="flex items-center gap-0.5">
                <IconButton
                  onClick={() => setExpanded(!expanded)}
                  aria-label={expanded ? 'Shrink chat' : 'Expand chat'}
                  title={expanded ? 'Shrink' : 'Expand'}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {expanded ? (
                      <path d="M9 9H4m0 0V4m0 5l6-6M15 15h5m0 0v5m0-5l-6 6" />
                    ) : (
                      <path d="M4 14v6h6M20 10V4h-6M14 4h6v6M10 20H4v-6" />
                    )}
                  </svg>
                </IconButton>
                <IconButton
                  onClick={() => setChatDismissed(true)}
                  aria-label={t('Close chat')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </IconButton>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <MessageList
                messages={messages}
                isStreaming={isStreaming}
                streamingContent={streamingContent}
                streamStartedAt={streamStartedAt}
                activeModel={activeModel}
                expanded={expanded}
              />
            </div>
            <div className="border-t border-[var(--panel-border)] p-2">
              {/* AgentRunBanner (the bottom "DUIN Working" phase pill) removed —
                  the per-turn Activity Timeline now shows the working state
                  inline in the transcript, so the bottom pill was redundant. */}
              <SpawnTaskTray />
              <TokenTicker />
              <AttachmentPreview />
              {contextChip}
              {queueChips}
              <ChatInput onSend={handleSend} onCancel={cancelStream} isStreaming={isStreaming} />
            </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export const ChatView = memo(ChatViewImpl)
