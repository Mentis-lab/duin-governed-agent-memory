import { create } from 'zustand'

// Fluidity J9: in-transcript notice queue. Async events (background turns
// completing, wake-ups landing, side-chat replies) that happen WHILE the
// user is reading the affected conversation surface here as inline rows
// in MessageList instead of stealing focus with a toast. Toasts remain
// the fallback for off-conversation events and for errors.
//
// Each notice carries a conversationId so MessageList can filter to the
// active conversation, plus a timestamp so the interleave with the real
// message list is stable.

/**
 * The four-way verdict the feedback channel collects on a proactive notice.
 * Mirrors FeedbackAction in electron/services/feedback-observations.ts (kept as
 * a local union so the renderer doesn't import main-process types).
 */
export type NoticeFeedbackAction = 'act' | 'snooze' | 'dismiss' | 'not-relevant'

export interface InlineNotice {
  id: string
  conversationId: string
  title: string
  message: string
  ts: number
  /** Optional click handler — used by some callers to jump the user back
   *  to a related artifact / dashboard panel. */
  onActivate?: () => void
  /**
   * When true, the notice is a proactive surface that earns a feedback row
   * (act/snooze/dismiss/not-relevant). MessageList records each verdict via
   * window.api.feedback.record. Informational notices leave this unset.
   */
  feedbackEnabled?: boolean
  /**
   * The detector class that produced this notice (aggregation key for the
   * loudness gate / governor). Falls back to a coarse label until real
   * detectors land. Ignored when feedbackEnabled is unset.
   */
  detectorClass?: string
}

interface InlineNoticesState {
  // Keyed by conversationId so notices don't leak between conversations.
  // Each conversation accumulates a small ring of recent notices.
  byConv: Record<string, InlineNotice[]>
  push: (notice: InlineNotice) => void
  forConversation: (conversationId: string) => InlineNotice[]
  dismiss: (conversationId: string, noticeId: string) => void
  clearConversation: (conversationId: string) => void
}

const RING_SIZE = 50

export const useInlineNoticesStore = create<InlineNoticesState>((set, get) => ({
  byConv: {},
  push: (notice) =>
    set((s) => {
      const cur = s.byConv[notice.conversationId] ?? []
      // De-dupe by id so a re-attach doesn't double-render.
      if (cur.some((n) => n.id === notice.id)) return s
      const next = [...cur, notice]
      const trimmed = next.length > RING_SIZE ? next.slice(next.length - RING_SIZE) : next
      return { byConv: { ...s.byConv, [notice.conversationId]: trimmed } }
    }),
  forConversation: (conversationId) => get().byConv[conversationId] ?? [],
  dismiss: (conversationId, noticeId) =>
    set((s) => {
      const cur = s.byConv[conversationId]
      if (!cur) return s
      return {
        byConv: {
          ...s.byConv,
          [conversationId]: cur.filter((n) => n.id !== noticeId)
        }
      }
    }),
  clearConversation: (conversationId) =>
    set((s) => {
      if (!(conversationId in s.byConv)) return s
      const next = { ...s.byConv }
      delete next[conversationId]
      return { byConv: next }
    })
}))
