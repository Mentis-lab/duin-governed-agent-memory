import { create } from 'zustand'
import { useUiStore } from '@/stores/ui-store'

// Shared state between the center brain GRAPH (DUIN's ported force-graph) and
// the lamprey-native Brain Explorer panel (lens chips + folder/file tree). The
// graph publishes its fetched data here; the explorer reads it to build the
// tree and writes lens + selection back; the graph reacts to both. This is the
// seam that lets DUIN's graph live in the center while its navigation is
// rebuilt as native lamprey UI in the right Workspace panel.

export interface BrainGraphNode {
  id: string
  kind: string
  label: string
  layer?: string
  declared?: number
  group?: string
  tags?: string[]
  date?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any
}
export interface BrainGraphData {
  nodes: BrainGraphNode[]
  links: { source: string; target: string; type: string }[]
  core?: string
}

interface BrainState {
  data: BrainGraphData | null
  lens: string
  /** Node the explorer asked the graph to focus; bumped via a token so repeat
   *  clicks on the same node re-focus. */
  focusId: string | null
  focusToken: number
  /** Node whose detail (markdown / info) the native Explorer should show —
   *  replaces DUIN's Sheet slide-over in chromeless mode. */
  detailNode: BrainGraphNode | null
  /** Node the chat is scoped to (DUIN's omnibox "asking in context" chip). The
   *  composer shows a chip + prepends this node's context to the sent message. */
  chatContext: { id: string; label: string; kind: string } | null
  setData: (d: BrainGraphData | null) => void
  setLens: (l: string) => void
  focusNode: (id: string | null) => void
  setDetail: (n: BrainGraphNode | null) => void
  setChatContext: (c: { id: string; label: string; kind: string } | null) => void
}

export const useBrainStore = create<BrainState>((set) => ({
  data: null,
  lens: 'all',
  focusId: null,
  focusToken: 0,
  detailNode: null,
  chatContext: null,
  setData: (data) => set({ data }),
  setLens: (lens) => set({ lens }),
  focusNode: (focusId) => set((s) => ({ focusId, focusToken: s.focusToken + 1 })),
  // U3. Selecting another node UNMOUNTS the note editor's content (BrainExplorer's
  // detailNode effect calls setEditing(false) unconditionally), so clicking a
  // [[wikilink]] inside your own unsaved paragraph destroyed it. Consult the dirty
  // registry first. Imported lazily to keep brain-store ← ui-store one-directional
  // (import-x/no-cycle is an error in this repo).
  setDetail: (detailNode) => {
    if (detailNode !== null && !useUiStore.getState().confirmDiscard('brain:')) return
    useUiStore.getState().clearDirty('brain:note-editor')
    set({ detailNode })
  },
  setChatContext: (chatContext) => set({ chatContext })
}))

// Debug-only: when launched with BF_DEBUG_PORT (preload sets __duinDebug.on),
// expose the store so automated in-app QA (CDP) can drive detail selection
// deterministically instead of relying on brittle blind clicks. No-op in normal
// user runs.
if (
  typeof window !== 'undefined' &&
  (window as { __duinDebug?: { on?: boolean } }).__duinDebug?.on
) {
  ;(window as unknown as { __duinBrainStore?: unknown }).__duinBrainStore = useBrainStore
}
