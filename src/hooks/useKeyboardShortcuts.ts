import { useEffect } from 'react'
import { useChatStore } from '@/stores/chat-store'
import { useUiStore } from '@/stores/ui-store'
import { pickAndAttachFiles } from '@/lib/attach-file'
import { resolveShortcut } from './shortcut-resolver'

export {
  resolveShortcut,
  isEditableTarget,
  type ShortcutAction,
  type ShortcutContext,
  type ShortcutKeyEvent
} from './shortcut-resolver'

// U8 — the key→action decision lives in `./shortcut-resolver.ts` (pure, no
// imports) so it can be unit tested; this hook is now only the wiring that
// reads store state, asks the resolver, and dispatches.
export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const chat = useChatStore.getState()
      const ui = useUiStore.getState()
      const action = resolveShortcut(e, {
        isStreaming: chat.isStreaming,
        settingsOpen: ui.settingsOpen,
        searchQuery: ui.searchQuery
      })
      if (action === null) return
      e.preventDefault()
      switch (action) {
        case 'newConversation':
          chat.createConversation()
          return
        case 'toggleWorkflowPalette':
          ui.toggleWorkflowPalette()
          return
        case 'toggleGlobalSearch':
          ui.toggleGlobalSearch()
          return
        case 'toggleSidebar':
          ui.toggleSidebar()
          return
        case 'attachFiles':
          void pickAndAttachFiles()
          return
        case 'toggleMemory':
          ui.toggleMemory()
          return
        case 'toggleQuickOpen':
          ui.toggleQuickOpen()
          return
        case 'tool:browser':
          return
        case 'tool:review':
          ui.toggleTool('review')
          return
        case 'tool:terminal':
          ui.toggleTool('terminal')
          return
        case 'tool:environment':
          return
        case 'tool:sources':
          ui.toggleTool('sources')
          return
        case 'toggleSettings':
          ui.toggleSettings()
          return
        case 'cancelStream':
          chat.cancelStream()
          return
        case 'closeSettings':
          ui.closeSettings()
          return
        case 'clearSearch':
          ui.setSearchQuery('')
          return
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
