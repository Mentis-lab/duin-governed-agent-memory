import { t } from '@/lib/i18n'
import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import type { Message } from '@/lib/types'
import { parseReasoning } from '@/lib/reasoning'
import { MessageBubble } from './MessageBubble'
import { StreamingText } from './StreamingText'
import { StreamStatusLine } from './StreamStatusLine'
import { DocumentCardRow } from './DocumentCardRow'
import { InlineApprovalChip } from './InlineApprovalChip'
import { useInlineApprovalsStore } from '@/stores/inline-approvals-store'
import { ProposedEditCard } from './ProposedEditCard'
import { useProposedEditsStore } from '@/stores/proposed-edits-store'
import { TranscriptNotice } from './TranscriptNotice'
import { useInlineNoticesStore } from '@/stores/inline-notices-store'
import type { InlineNotice, NoticeFeedbackAction } from '@/stores/inline-notices-store'
import { useChatStore } from '@/stores/chat-store'
import { CHAT_COLUMN_CLASS, CHAT_COLUMN_EXPANDED_CLASS } from './ChatView'
import { ChapterDivider } from './ChapterDivider'
import { useChaptersStore, type Chapter } from '@/stores/chapters-store'
import {
  CompressedRegionPill,
  isCompressedSummaryMessage
} from './CompressedRegionPill'
import { DeepResearchBanner } from './DeepResearchBanner'

interface MessageListProps {
  messages: Message[]
  isStreaming: boolean
  streamingContent: string
  streamStartedAt: number | null
  activeModel: string
  /** When the chat window is expanded, the column fills the widened panel. */
  expanded?: boolean
}

// Pixels from the bottom of the scroll container that still count as "near
// the bottom". If the user is within this, auto-scroll follows new content;
// if they've scrolled further up, we leave them alone.
const STICK_THRESHOLD_PX = 120

function InlineApprovalQueue() {
  const queue = useInlineApprovalsStore((s) => s.queue)
  const dismiss = useInlineApprovalsStore((s) => s.dismiss)
  if (queue.length === 0) return null
  return (
    <>
      {queue.map((req, i) => (
        <InlineApprovalChip
          key={req.callId}
          request={req}
          // Only the first chip claims global keystrokes — successive chips
          // wait their turn. Once the leader resolves, the next becomes
          // active via this index check on next render.
          autoFocus={i === 0}
          onResolved={() => dismiss(req.callId)}
        />
      ))}
    </>
  )
}

// Reviewable / reversible proposed-edit CARDs for the active conversation.
// Hydrated from the persisted store (survives reload / AFK) and kept live by
// the `chat:edit-proposed` subscription wired in useChat. Rendered in the
// transcript — like the InlineApprovalQueue — because a pending card is a
// user-actionable surface, not historical noise. Terminal cards (applied /
// discarded / conflict) stay visible as a record of what happened.
function ProposedEditQueue() {
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const proposals = useProposedEditsStore((s) => s.proposals)
  const storeConvId = useProposedEditsStore((s) => s.conversationId)
  const loadForConversation = useProposedEditsStore((s) => s.loadForConversation)

  useEffect(() => {
    if (activeConversationId && activeConversationId !== storeConvId) {
      void loadForConversation(activeConversationId)
    }
  }, [activeConversationId, storeConvId, loadForConversation])

  if (!activeConversationId || proposals.length === 0) return null
  return (
    <>
      {proposals.map((p) => (
        <ProposedEditCard key={p.id} proposal={p} />
      ))}
    </>
  )
}

function SystemMarker({ content }: { content: string }) {
  return (
    <div
      role="separator"
      className="my-3 flex items-center gap-3 px-2 text-[12px] uppercase tracking-wider text-[var(--text-muted)]"
    >
      <span className="h-px flex-1 bg-[var(--border)]" />
      <span>{content}</span>
      <span className="h-px flex-1 bg-[var(--border)]" />
    </div>
  )
}

function MessageListImpl({
  messages,
  isStreaming,
  streamingContent,
  streamStartedAt,
  activeModel,
  expanded = false
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  // Mutable flag we update on user scroll — avoids a React state round-trip
  // (which would re-render the message list on every wheel tick).
  const stuckToBottomRef = useRef(true)
  const activeConversationId = useChatStore((s) => s.activeConversationId)

  // Track whether the user is currently anchored at/near the bottom. We
  // use this to decide whether new chunks should drag the viewport down.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      stuckToBottomRef.current = distanceFromBottom <= STICK_THRESHOLD_PX
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // Prime with current position.
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Opening/switching to a conversation → re-anchor to the newest message.
  // Without this, the scroll-position primer marks a long history as "not at
  // the bottom" (it renders scrolled to the top), so the auto-scroll effect
  // below never runs and you land at the top instead of the latest message.
  // Reset the stick flag so the auto-scroll effect drags to the bottom once
  // the new conversation's messages render.
  useEffect(() => {
    stuckToBottomRef.current = true
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activeConversationId])

  // Auto-scroll new content into view, but ONLY if the user is still
  // anchored at the bottom. Scrolled-up readers stay where they are even
  // while output streams in.
  useEffect(() => {
    if (!stuckToBottomRef.current) return
    const el = scrollRef.current
    if (!el) return
    // Use scrollTop = scrollHeight directly so we don't trigger a smooth
    // animation that lags behind the stream.
    el.scrollTop = el.scrollHeight
  }, [messages, streamingContent, isStreaming])

  // Live chain-of-thought streamed off the provider's reasoning channel
  // (DeepSeek `delta.reasoning_content` / OpenRouter `delta.reasoning` /
  // DashScope enable_thinking). Distinct from the visible content stream
  // so the ReasoningBlock can show up as soon as the FIRST thought
  // arrives — even before any answer body does. Falls back to the
  // inline-<think> parse for EVERY model now, because the contract
  // requires every assistant turn to lead with <think>…</think>.
  const streamingReasoning = useChatStore((s) => s.streamingReasoning)
  const streamingDocuments = useChatStore((s) => s.streamingDocuments)
  const parsed = (() => {
    if (streamingReasoning) {
      return { reasoning: streamingReasoning, body: streamingContent, isThinking: true }
    }
    return parseReasoning(streamingContent)
  })()
  // Show the streaming card the moment EITHER channel has activity, not just
  // the body channel. Reasoning often lands first and runs for many seconds
  // before the model commits to its first answer token.
  const hasStreamingActivity = !!streamingContent || !!streamingReasoning

  // Track 2 / E2 — chapters are anchored to a timestamp, not directly
  // to a message id. Build a map from "before message at index i" → list
  // of chapter rows whose createdAt fits between messages[i-1] and
  // messages[i]. Late-arriving chapters (after the last message) land
  // in the "afterAll" bucket and render at the bottom.
  const chapters = useChaptersStore((s) => s.chapters)
  const { byBefore, afterAll } = useMemo(() => {
    const byBefore: Record<number, Chapter[]> = {}
    const afterAll: Chapter[] = []
    if (chapters.length === 0) return { byBefore, afterAll }
    const sorted = [...chapters].sort((a, b) => a.createdAt - b.createdAt)
    for (const c of sorted) {
      const idx = messages.findIndex((m) => m.timestamp >= c.createdAt)
      if (idx === -1) afterAll.push(c)
      else (byBefore[idx] ??= []).push(c)
    }
    return { byBefore, afterAll }
  }, [chapters, messages])

  // Fluidity J9: interleave inline notices (async events) with messages
  // by timestamp. Same bucket pattern chapters use, so the render loop
  // only needs to know about per-index buckets.
  const activeConvId = useChatStore((s) => s.activeConversationId)
  const allNotices = useInlineNoticesStore((s) => s.byConv)
  const dismissNotice = useInlineNoticesStore((s) => s.dismiss)
  const { noticesByBefore, noticesAfterAll } = useMemo(() => {
    const byBefore: Record<number, ReturnType<typeof useInlineNoticesStore.getState>['byConv'][string]> = {}
    const afterAll: typeof byBefore[number] = []
    if (!activeConvId) return { noticesByBefore: byBefore, noticesAfterAll: afterAll }
    const notices = allNotices[activeConvId] ?? []
    if (notices.length === 0) return { noticesByBefore: byBefore, noticesAfterAll: afterAll }
    const sorted = [...notices].sort((a, b) => a.ts - b.ts)
    for (const n of sorted) {
      const idx = messages.findIndex((m) => m.timestamp > n.ts)
      if (idx === -1) afterAll.push(n)
      else (byBefore[idx] ??= []).push(n)
    }
    return { noticesByBefore: byBefore, noticesAfterAll: afterAll }
  }, [allNotices, activeConvId, messages])

  // DUIN nervous system (organ #1): a verdict on a proactive notice. Persist
  // the typed observation (best-effort — never block the UI on it), then clear
  // the surface; every verdict retires the nudge once it's been recorded.
  // detectorClass falls back to the notice title until real detectors land.
  const handleNoticeFeedback = useCallback(
    (notice: InlineNotice, action: NoticeFeedbackAction) => {
      try {
        void window.api?.feedback?.record({
          sourceCardId: notice.id,
          sourceKind: 'notice',
          action,
          detectorClass: notice.detectorClass ?? notice.title,
          conversationId: notice.conversationId,
          title: notice.title
        })
      } catch {
        // Recording is best-effort; a missing bridge must not wedge the click.
      }
      dismissNotice(notice.conversationId, notice.id)
    },
    [dismissNotice]
  )

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto py-4 [scrollbar-gutter:stable]">
      {/* Belt-and-suspenders centering: flex wrapper guarantees horizontal
          centering even if Tailwind's mx-auto can't compute against the
          parent's flex context. */}
      <div className="flex w-full justify-center">
        <div className={expanded ? CHAT_COLUMN_EXPANDED_CLASS : CHAT_COLUMN_CLASS}>
          {/* D12 — Deep Research Banner pinned at top of MessageList */}
          {activeConvId && <DeepResearchBanner conversationId={activeConvId} />}
          {(() => {
            // UB-6 (Unburdening Phase, 2026-06-10) — the R7 planner-attachment
            // pre-walk ("Show pipeline trace" plumbing) is excised with the
            // pipeline. Historical pipeline rows (stage planner/reviewer/
            // composer) render as ordinary messages with a muted legacy chip
            // (K3) so the audit trail is never lost.
            const renderItems: Array<{ msg: Message; index: number }> = []
            for (let i = 0; i < messages.length; i++) {
              const m = messages[i]
              if (m.compressedInto) continue
              renderItems.push({ msg: m, index: i })
            }

            return renderItems.map((item) => {
              const i = item.index
              const msg = item.msg
              const compressed = isCompressedSummaryMessage(msg)
              return (
                <div key={msg.id} data-message-id={msg.id}>
                  {byBefore[i]?.map((c) => (
                    <ChapterDivider key={c.id} chapter={c} />
                  ))}
                  {noticesByBefore[i]?.map((n) => (
                    <TranscriptNotice
                      key={n.id}
                      notice={n}
                      onDismiss={() => dismissNotice(n.conversationId, n.id)}
                      onFeedback={(action) => handleNoticeFeedback(n, action)}
                    />
                  ))}
                  {compressed ? (
                    <CompressedRegionPill message={msg} />
                  ) : msg.role === 'system' ? (
                    <SystemMarker content={msg.content} />
                  ) : (
                    <MessageBubble message={msg} />
                  )}
                </div>
              )
            })
          })()}
          {afterAll.map((c) => (
            <ChapterDivider key={c.id} chapter={c} />
          ))}
          {noticesAfterAll.map((n) => (
            <TranscriptNotice
              key={n.id}
              notice={n}
              onDismiss={() => dismissNotice(n.conversationId, n.id)}
              onFeedback={(action) => handleNoticeFeedback(n, action)}
            />
          ))}
          {/* Tool-call cards do NOT render inside the transcript anymore —
              they live behind the ToolActivityChip in the input pill row.
              The chat panel stays clean during exploration bursts; the
              chip materializes when work is happening and disappears
              when there is none. InlineApprovalQueue below still renders
              inline because approval chips are user-actionable, not
              historical noise. */}
          {/* Fluidity J5 — inline approval chips for previously-approved,
              non-destructive (server, tool) pairs. The first chip in the
              queue auto-focuses so 1/2/3 keystrokes land without a click. */}
          <InlineApprovalQueue />

          {/* Reviewable / reversible proposed-edit cards — the non-coder
              edit-approval surface. Persisted, so they survive reload. */}
          <ProposedEditQueue />

          {isStreaming && (hasStreamingActivity || streamStartedAt) && (
            <div className="mb-3 flex justify-start">
              {/* Streaming bubble mirrors the persisted assistant bubble:
                  no background, no border, no padding — plain text on the
                  chat surface. Keeps the streamed body, reasoning card,
                  and status line visually identical to the bubble that
                  takes its place once the stream finishes, so users don't
                  see a card-to-no-card pop on completion. */}
              {/* `chat-md` is what sets the transcript's reading size, and this
                  container did not carry it — so the stream rendered at
                  .markdown-body's own 1rem while the persisted bubble
                  (MessageBubble, 'chat-md w-full ...') rendered at
                  --chat-font-size. The answer visibly SHRANK the moment it
                  finished. The note above about mirroring the persisted bubble
                  covered background, border and padding and stopped there. */}
              <div className="chat-md w-full">
                {/* Only the reasoning + answer stream in the transcript now.
                    The tool "working" signal lives organically in the composer
                    (ToolActivityChip pulses while tools run; the send button
                    becomes Stop) rather than as an inline tool timeline. */}
                {hasStreamingActivity ? (
                  <StreamingText
                    content={streamingContent}
                    reasoning={streamingReasoning || undefined}
                    isThinking={!!streamingReasoning && !streamingContent}
                    model={activeModel}
                  />
                ) : (
                  <div className="flex items-center text-[var(--text-muted)]">
                    <svg
                      width="26"
                      height="26"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="animate-pulse text-[var(--accent)]"
                      role="img"
                      aria-label={t('Thinking')}
                    >
                      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
                      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
                      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
                    </svg>
                  </div>
                )}
                <StreamStatusLine
                  startedAt={streamStartedAt}
                  content={parsed.body}
                  reasoning={parsed.reasoning}
                />
                {streamingDocuments.length > 0 && (
                  <DocumentCardRow documents={streamingDocuments} />
                )}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  )
}

// Memoized so a parent (ChatView) re-render caused by input/typing state does
// not reconcile the entire message list; it re-renders only when its own props
// (messages, streaming state, active model) actually change.
export const MessageList = memo(MessageListImpl)
