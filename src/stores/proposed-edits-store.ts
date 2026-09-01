import { create } from 'zustand'
import type { ProposedEditProposal } from '@/lib/types'

// Renderer store for proposed-edit CARDs. One list per active conversation.
// Hydrated on conversation switch via `proposedEdit:list` (so cards survive
// reload / AFK) and kept live by the `chat:edit-proposed` event, which fires
// on both a new card and every status change. Mirrors the chapters-store
// shape: load-for-conversation + apply-event + clear.
//
// The card ACTIONS live on the card component (direct IPC); this store only
// holds display state and upserts rows as events arrive.

interface ProposedEditsState {
  proposals: ProposedEditProposal[]
  conversationId: string | null

  loadForConversation: (conversationId: string) => Promise<void>
  /** Upsert a row from a `chat:edit-proposed` event (new card or status
   *  change). Ignored when it belongs to a different conversation than the
   *  one currently loaded. */
  applyProposed: (event: { conversationId: string; proposal: ProposedEditProposal }) => void
  clear: () => void
}

export const useProposedEditsStore = create<ProposedEditsState>((set, get) => ({
  proposals: [],
  conversationId: null,

  loadForConversation: async (conversationId: string) => {
    if (!window.api?.proposedEdit?.list) {
      set({ conversationId, proposals: [] })
      return
    }
    set({ conversationId, proposals: [] })
    const r = await window.api.proposedEdit.list(conversationId)
    // Drop the result if the active conversation changed while we awaited.
    if (get().conversationId !== conversationId) return
    if (r.success) set({ proposals: (r.data as ProposedEditProposal[]) ?? [] })
  },

  applyProposed: ({ conversationId, proposal }) => {
    const active = get().conversationId
    if (active && active !== conversationId) return
    set((s) => {
      const idx = s.proposals.findIndex((p) => p.id === proposal.id)
      if (idx === -1) {
        return {
          proposals: [...s.proposals, proposal].sort((a, b) => a.createdAt - b.createdAt)
        }
      }
      const next = s.proposals.slice()
      next[idx] = proposal
      return { proposals: next }
    })
  },

  clear: () => set({ proposals: [], conversationId: null })
}))
