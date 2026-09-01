import { useCallback, useRef } from 'react'

/**
 * Reusable drag-to-resize for a panel whose width is expressed as a CSS
 * variable on <html> (e.g. `width: var(--sidebar-width)`).
 *
 * Why a CSS variable instead of React state: dragging fires pointer events
 * faster than the display refreshes. Routing each one through a Zustand
 * setter re-rendered the whole app subtree (chat list + panels) and wrote
 * localStorage every frame. Here the drag writes ONLY the CSS variable —
 * once per animation frame (rAF-coalesced) — so the browser reflows the
 * flex row with zero React reconciliation. The store (and localStorage) are
 * touched exactly once, on release, via `onCommit`.
 *
 * The handle uses pointer capture so moves stay locked to it even over a
 * canvas or iframe underneath. Escape cancels and restores the start width.
 */
export interface DragResizeOptions {
  /** Committed width at the moment the drag starts (px). */
  getStartWidth: () => number
  /** 'right' = handle on the panel's right edge (delta = +x); 'left' = right-side panel growing leftward (delta = -x). */
  edge: 'left' | 'right'
  min: number
  /** Static ceiling. Ignored when `getMax` is supplied. */
  max: number
  /** Ceiling resolved at pointerdown. Use this when the real limit depends on
   *  the viewport (so the drag and the commit clamp identically and the panel
   *  can't snap back on release). */
  getMax?: () => number
  /** CSS custom property to drive on <html>, e.g. '--sidebar-width'. */
  cssVar: string
  /** Called once on release with the final clamped width (persist here). */
  onCommit: (width: number) => void
  /** Optional drag-state toggle (e.g. to disable a width transition while dragging). */
  onDragChange?: (dragging: boolean) => void
}

export function useDragResize(options: DragResizeOptions) {
  // Keep the latest options in a ref so the returned handler is stable and
  // never needs to be re-created (no churn in the consumer's deps).
  const optsRef = useRef(options)
  optsRef.current = options

  return useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const o = optsRef.current
    const el = e.currentTarget as HTMLElement
    const pid = e.pointerId
    try {
      el.setPointerCapture(pid)
    } catch {
      /* capture unsupported — element listeners still fire */
    }

    const root = document.documentElement
    const startX = e.clientX
    const startWidth = o.getStartWidth()
    // Resolved once per drag: it depends on the viewport and the other panel's
    // width, neither of which moves mid-drag.
    const max = Math.max(o.min, o.getMax?.() ?? o.max)
    let latest = startWidth
    let frame = 0

    const clampAt = (clientX: number) => {
      const delta = o.edge === 'right' ? clientX - startX : startX - clientX
      return Math.max(o.min, Math.min(max, Math.round(startWidth + delta)))
    }
    const paint = () => {
      frame = 0
      root.style.setProperty(o.cssVar, `${latest}px`)
    }

    const onMove = (me: PointerEvent) => {
      latest = clampAt(me.clientX)
      if (!frame) frame = requestAnimationFrame(paint)
    }
    const teardown = () => {
      if (frame) {
        cancelAnimationFrame(frame)
        frame = 0
      }
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey)
      try {
        el.releasePointerCapture(pid)
      } catch {
        /* already released */
      }
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      o.onDragChange?.(false)
    }
    const onUp = () => {
      root.style.setProperty(o.cssVar, `${latest}px`)
      teardown()
      o.onCommit(latest)
    }
    const onCancel = () => {
      root.style.setProperty(o.cssVar, `${startWidth}px`)
      teardown()
      o.onCommit(startWidth)
    }
    const onKey = (ke: KeyboardEvent) => {
      if (ke.key === 'Escape') onCancel()
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    o.onDragChange?.(true)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey)
  }, [])
}
