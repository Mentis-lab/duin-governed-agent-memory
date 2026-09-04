import { useEffect, useState, type ReactElement } from 'react'
import { BrainExplorerPanel } from '@/components/brain/BrainExplorerPanel'
import { useBrainStore } from '@/stores/brain-store'
import { useSettingsStore } from '@/stores/settings-store'
import { fetchBrainGraph } from '@/duin/lib/state'

// A note / entity in its own window. Mounted INSTEAD of <App/> when the renderer
// is launched with `?view=node&key=<node id>`.
//
// It reuses BrainExplorerPanel rather than re-implementing the detail pane, so
// the window and the side panel cannot drift in what they render or what they
// let you do — the panel already contains the editor, the delete affordance and
// the wikilink resolver.
//
// The graph has to be loaded first: this is a FRESH renderer process, so the
// brain store starts empty and `setDetail` alone would leave the panel with a
// node it cannot resolve links or neighbours for.

export function NodeWindow({ nodeId }: { nodeId: string }): ReactElement {
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading')

  // This is a FRESH renderer, and only App's init effect loads settings — so a detached
  // window painted with the DEFAULT appearance no matter what the operator had chosen:
  // wrong theme preset, no UI zoom, and (the reason this is here) no document reading
  // size, which would have made the one surface most likely to be read the only one the
  // new control could not reach. Fire-and-forget; the panel renders either way.
  useEffect(() => {
    void useSettingsStore.getState().loadSettings()
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const graph = await fetchBrainGraph()
        if (!alive) return
        useBrainStore.getState().setData(graph as never)
        const nodes = (graph as { nodes?: { id: string }[] } | null)?.nodes ?? []
        const found = nodes.find((n) => n.id === nodeId)
        if (found) {
          useBrainStore.getState().setDetail(found as never)
          setState('ready')
        } else {
          setState('missing')
        }
      } catch {
        if (alive) setState('missing')
      }
    })()
    return () => {
      alive = false
    }
  }, [nodeId])

  if (state === 'loading') {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--app-bg)] text-[13px] text-[var(--text-muted)]">
        Loading {nodeId}…
      </div>
    )
  }
  if (state === 'missing') {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--app-bg)] p-6 text-[13px] text-[var(--text-secondary)]">
        No live node with id “{nodeId}”. It may have been removed.
      </div>
    )
  }
  return (
    // `detached-surface` opts this window out of the 72ch reading-measure cap and
    // centres the prose so it grows with the window (see styles/markdown.css).
    // Without it a full-width window renders a narrow, left-pinned column.
    <div className="detached-surface h-screen w-screen bg-[var(--app-bg)]">
      <BrainExplorerPanel />
    </div>
  )
}
