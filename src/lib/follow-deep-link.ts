import { parseDeepLink } from '@/lib/deep-link'
import { useUiStore } from '@/stores/ui-store'
import { useChatStore } from '@/stores/chat-store'

// The action half of deep links. Kept apart from the parser so `deep-link.ts` stays
// pure and unit-testable without dragging the store graph into the test.

/** Navigate to whatever a link names. Returns false when the link resolved to nothing,
 *  so a caller can decide whether to say so rather than appearing to work. */
export function followDeepLink(raw: string | null | undefined): boolean {
  const link = parseDeepLink(raw)
  if (!link) return false

  switch (link.kind) {
    case 'tool':
      useUiStore.getState().setActiveTool(link.toolId)
      return true
    case 'customize':
      useUiStore.getState().openCustomize(link.column)
      return true
    case 'settings':
      useUiStore.getState().openSettings(link.tab)
      return true
    case 'conversation':
      void useChatStore.getState().selectConversation(link.conversationId)
      return true
  }
}
