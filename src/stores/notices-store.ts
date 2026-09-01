import { create } from 'zustand'

// Renderer mirror of the main-process notice inbox. Counts arrive on every change
// broadcast so the Status pill can show what is waiting without anyone opening the
// panel — that ambient signal is the difference between an inbox and a room nobody
// walks into.

export type NoticeKind = 'watch' | 'approval' | 'loop' | 'automation' | 'digest'
export type NoticeSeverity = 'info' | 'warning' | 'error'

export interface Notice {
  id: string
  kind: NoticeKind
  severity: NoticeSeverity
  title: string
  body: string
  deepLink: string | null
  createdAt: number
  readAt: number | null
  needsDecision: boolean
  resolvedAt: number | null
  actionId?: string
  dedupKey?: string
  count: number
}

export interface NoticeCounts {
  unread: number
  needsDecision: number
}

interface NoticesState {
  notices: Notice[]
  counts: NoticeCounts
  loading: boolean
  error: string | null
  loadNotices: () => Promise<void>
  refreshCounts: () => Promise<void>
  setCounts: (counts: NoticeCounts) => void
  markRead: (ids: string[]) => Promise<void>
  markAllRead: () => Promise<void>
}

export const useNoticesStore = create<NoticesState>((set, get) => ({
  notices: [],
  counts: { unread: 0, needsDecision: 0 },
  loading: false,
  error: null,

  loadNotices: async () => {
    set({ loading: true })
    try {
      const r = await window.api?.notices?.list?.({ limit: 200 })
      if (!r?.success) {
        set({ error: r?.error ?? 'Could not read the inbox', loading: false })
        return
      }
      const data = r.data as { notices: Notice[]; counts: NoticeCounts }
      set({ notices: data.notices ?? [], counts: data.counts, error: null, loading: false })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false })
    }
  },

  refreshCounts: async () => {
    try {
      const r = await window.api?.notices?.counts?.()
      if (r?.success) set({ counts: r.data as NoticeCounts })
    } catch {
      // A failed count refresh must never surface — the badge just stays as it was.
    }
  },

  setCounts: (counts) => set({ counts }),

  markRead: async (ids) => {
    if (ids.length === 0) return
    // Optimistic: the row should stop looking unread the instant it is opened, and the
    // broadcast that follows reconciles the counts anyway.
    const now = Date.now()
    set((s) => ({
      notices: s.notices.map((n) => (ids.includes(n.id) && n.readAt === null ? { ...n, readAt: now } : n))
    }))
    await window.api?.notices?.markRead?.(ids)
    await get().refreshCounts()
  },

  markAllRead: async () => {
    const now = Date.now()
    set((s) => ({
      notices: s.notices.map((n) => (n.readAt === null ? { ...n, readAt: now } : n))
    }))
    await window.api?.notices?.markAllRead?.()
    await get().refreshCounts()
  }
}))
