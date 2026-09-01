import { t } from '@/lib/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/duin/lib/utils'
import { SurfaceIcon } from '@/components/icons/SurfaceIcon'
import { useUiStore } from '@/stores/ui-store'
import { toast } from '@/stores/toast-store'
import { HtmlSourceEditor } from '@/components/editor/HtmlSourceEditor'
import { VisualHtmlEditor, type VisualHtmlEditorHandle } from '@/components/editor/VisualHtmlEditor'
import { CanvasEditor } from '@/components/artifacts/CanvasEditor'

// A default document name from the HTML's own <title> / first <h1>, else generic.
function deriveArtifactName(html: string): string {
  const raw =
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
    ''
  const clean = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  return clean || 'artifact'
}

interface ArtifactPanelProps {
  artifactType: string | null
  artifactSource: string | null
  onClose: () => void
}

// 'split' retired 2026-07-27 (operator request). Removed from the union rather than just
// hiding its tab, so the half-width branches it used to gate cannot linger as unreachable
// code that reads like a live feature.
type Mode = 'preview' | 'code' | 'visual'

// How long to wait after the last keystroke before re-rendering the native
// preview. The render writes a temp file + reloads the WebContentsView, so we
// debounce to avoid thrashing on every character.
const RENDER_DEBOUNCE_MS = 350

// The right panel's drag handle (.resize-handle-v-left) is 10px wide at
// `left: -5px`, so half of it lies INSIDE the panel. The native preview is an
// OS-level WebContentsView composited above the DOM — wherever it sits, it eats
// the pointer, and the DOM handle underneath never sees pointerdown. Publishing
// bounds flush to the panel edge therefore halved the grab target to the 5px
// sliver in the column gap, which is the "drag-to-expand barely works" report.
// Inset the preview past the handle's inner reach so all 10px stay grabbable.
const HANDLE_GUTTER_PX = 6

export function ArtifactPanel({ artifactType, artifactSource, onClose }: ArtifactPanelProps) {
  const previewRef = useRef<HTMLDivElement>(null)
  const [downloaded, setDownloaded] = useState(false)
  const [savedLib, setSavedLib] = useState(false)
  const [mode, setMode] = useState<Mode>('preview')
  const [source, setSource] = useState(artifactSource ?? '')
  const renderTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Latest source without re-triggering the mode effect on every keystroke.
  const sourceRef = useRef(source)
  sourceRef.current = source
  const visualEditorRef = useRef<VisualHtmlEditorHandle>(null)

  // Freshest source for an export/persist action. In Visual mode a GrapesJS edit
  // reaches `source` only via a 400ms debounce, so a click within that window
  // would otherwise read a stale buffer; flush forces the pending export first
  // (and returns it synchronously, since the setSource it triggers has not yet
  // applied). Outside Visual mode the ref is null and we use `source` as-is.
  const freshestSource = useCallback(
    () => visualEditorRef.current?.flush() ?? source,
    [source]
  )

  const type = artifactType ?? 'html'
  const previewVisible = mode === 'preview'

  // New artifact opened → reset the editable buffer, snap to Preview, and render
  // it into the native view (so the panel is self-sufficient regardless of how
  // it was opened).
  useEffect(() => {
    const s = artifactSource ?? ''
    setSource(s)
    setMode('preview')
    if (s && artifactType) window.api?.artifact?.render(artifactType, s)
  }, [artifactSource, artifactType])

  const publishBounds = useCallback(() => {
    if (!previewRef.current || !window.api) return
    const rect = previewRef.current.getBoundingClientRect()
    // A DEGENERATE rect must never be published. The native view is an OS-level
    // WebContentsView positioned purely by these numbers — it has no DOM stacking and no
    // layout of its own — so publishing 0x0 pins it invisible with nothing to recover it:
    // a ResizeObserver fires on SIZE changes, and once it is 0x0 the element that would
    // report a better rect is the one that never changed.
    //
    // (This guard is defensive only. It was once believed to explain the "clicked the
    // artifact, nothing appeared until I closed the panel" report; it did not. That was
    // App.tsx mounting the tool branch instead of the artifact branch — see the
    // precedence comment there. Keep the guard; don't credit it with that fix.)
    if (rect.width < 1 || rect.height < 1) return
    window.api.artifact.resize({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    })
  }, [])

  // Coalesce to one publish per frame. Every publish is an async IPC round-trip ending in a
  // native setBounds, and a drag-to-resize emits ResizeObserver callbacks far faster than
  // frames — so publishing on every callback floods the main process with bounds that are
  // already stale by the time they land, and the native view visibly lags and stutters
  // behind the pane edge you are dragging. One per frame is all the compositor can use.
  const boundsRaf = useRef<number | null>(null)
  const reportBounds = useCallback(() => {
    if (boundsRaf.current != null) return
    boundsRaf.current = requestAnimationFrame(() => {
      boundsRaf.current = null
      publishBounds()
    })
  }, [publishBounds])

  // Show the native preview only in preview/split; hide it when an editor owns
  // the whole body. Re-render the current source on entry so edits made in Code
  // or Visual mode are reflected the moment you switch back to a preview.
  useEffect(() => {
    if (!window.api) return
    if (previewVisible) {
      window.api.artifact.render(type, sourceRef.current)
      window.api.artifact.show?.()
      reportBounds()
    } else {
      window.api.artifact.hide()
    }
  }, [previewVisible, reportBounds, type])

  // Keep the native view aligned to the preview sub-pane as it resizes.
  useEffect(() => {
    if (!previewRef.current || !previewVisible) return
    const observer = new ResizeObserver(reportBounds)
    observer.observe(previewRef.current)
    reportBounds()

    // A ResizeObserver only sees SIZE. The preview pane also MOVES without resizing —
    // the chat bubble closing, the right panel re-laying out, a sibling tool releasing
    // the slot — and each of those leaves the native view parked at stale coordinates
    // while the DOM says otherwise. Re-measure after paint, and once more shortly
    // after, so a pane that was mid-transition (or not yet laid out) when this effect
    // ran still ends up publishing a real rect.
    const raf = requestAnimationFrame(reportBounds)
    const settle = setTimeout(reportBounds, 250)
    // Position is viewport-relative, so anything that moves the viewport invalidates it.
    window.addEventListener('resize', reportBounds)
    window.addEventListener('scroll', reportBounds, true)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
      clearTimeout(settle)
      window.removeEventListener('resize', reportBounds)
      window.removeEventListener('scroll', reportBounds, true)
    }
  }, [previewVisible, reportBounds, mode])

  // Debounced live re-render as the user edits the source.
  const handleSourceChange = useCallback(
    (next: string) => {
      setSource(next)
      if (renderTimer.current) clearTimeout(renderTimer.current)
      renderTimer.current = setTimeout(() => {
        window.api?.artifact?.render(type, next)
      }, RENDER_DEBOUNCE_MS)
    },
    [type]
  )

  useEffect(
    () => () => {
      if (renderTimer.current) clearTimeout(renderTimer.current)
    },
    []
  )

  // Safety net: whenever this panel unmounts — closed via ✕, right-panel
  // collapse, a tool taking the slot, or a viewport switch — hide the native
  // artifact overlay so it can never outlive the panel as a stuck, un-closable
  // WebContentsView pinned on top of the app.
  useEffect(
    () => () => {
      window.api?.artifact?.hide?.()
    },
    []
  )

  // GrapesJS visual changes update the shared source buffer; its own canvas is
  // the preview, and switching back to Preview re-renders from source.
  const handleVisualChange = useCallback((next: string) => {
    setSource(next)
  }, [])

  // The visual canvas + its panels need room; widen the shared right panel on
  // entry (clamped by the store to the panel's max width).
  useEffect(() => {
    if (mode === 'visual') {
      const { rightPanelWidth, setRightPanelWidth } = useUiStore.getState()
      setRightPanelWidth(Math.max(rightPanelWidth, 760))
    }
  }, [mode])


  const handleDownload = () => {
    const ext =
      type === 'svg' ? 'svg' : type === 'mermaid' ? 'mmd' : type === 'canvas' ? 'canvas' : 'html'
    const mime =
      type === 'svg' ? 'image/svg+xml' : type === 'canvas' ? 'application/json' : 'text/html'
    const blob = new Blob([freshestSource()], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `artifact.${ext}`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    setDownloaded(true)
    setTimeout(() => setDownloaded(false), 1600)
  }

  const handleSaveToLibrary = async () => {
    if (savedLib) return
    const src = freshestSource()
    const r = await window.api?.artifact?.saveToLibrary?.(deriveArtifactName(src), src)
    if (r?.success && r.data) {
      setSavedLib(true)
      setTimeout(() => setSavedLib(false), 1800)
      // An overwrite must not render as a clean create: distinct artifacts collide on one
      // derived filename (both fall back to 'artifact' with no <title>/<h1>), so name the
      // tombstone the prior version was preserved as.
      const { title, replaced } = r.data as { title: string; replaced?: string }
      toast.success(
        replaced
          ? `Saved "${title}" to your library — replaced the previous page, preserved as ${replaced}`
          : `Saved "${title}" to your library: now a page in your brain`
      )
    } else {
      toast.error(r?.error || 'Could not save to library')
    }
  }

  const handleOpenInWindow = () => {
    if (window.api) window.api.artifact.openInWindow(type, freshestSource())
  }

  const handleHide = () => {
    window.api?.artifact?.hide()
    onClose()
  }

  const modeBtn = (m: Mode, label: string) => (
    <button
      key={m}
      onClick={() => setMode(m)}
      title={label}
      className={cn(
        'shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-[12px] transition-colors',
        mode === m
          ? 'bg-[var(--accent-dim)] text-[var(--accent)]'
          : 'text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-secondary)]'
      )}
    >
      {label}
    </button>
  )

  const actionBtn = (label: string, onClick: () => void, title: string) => (
    <button
      onClick={onClick}
      title={title}
      className="shrink-0 whitespace-nowrap rounded px-2 py-1 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-secondary)]"
    >
      {label}
    </button>
  )

  // Width + the left-edge resize handle are owned by the shared right-panel
  // container in App.tsx (same persisted width as Home/Tools) — this panel just
  // fills it.
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        {/* Header */}
        <div className="flex h-12 shrink-0 items-center gap-2 bg-[var(--bg-tertiary)] px-3">
          {/* Identity — collapses first (label truncates) when space is tight.
              The type pill (`html`) was dropped 2026-07-27 (operator request):
              Preview/Code/Visual already say what this is, and the pill only
              competed with them for the header's tightest row. */}
          <div className="flex min-w-0 shrink items-center gap-2">
            <SurfaceIcon id="artifacts" className="h-5 w-5 shrink-0 text-[var(--text-secondary)]" />
            <span className="truncate text-[14px] font-medium text-[var(--text-secondary)]">{t('Artifact')}</span>
          </div>
          {/* Mode tabs — pushed to the right by ml-auto; kept at full size. */}
          <div className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md bg-[var(--bg-primary)] p-0.5">
            {modeBtn('preview', 'Preview')}
            {modeBtn('code', 'Code')}
            {modeBtn('visual', 'Visual')}
          </div>
          {/* Secondary actions — clip gracefully at narrow widths so they never
              push the close button off-screen. */}
          <div className="flex min-w-0 shrink items-center gap-1 overflow-hidden">
            {actionBtn(savedLib ? 'Saved ✓' : 'Save to Library', () => void handleSaveToLibrary(), 'Save into your library as a page node')}
            {actionBtn(downloaded ? 'Saved' : 'Download', handleDownload, 'Download as file')}
            {actionBtn('Window', handleOpenInWindow, 'Open in a new window')}
          </div>
          {/* Close — pinned last and never clipped, so the panel is always closable. */}
          {actionBtn('✕', handleHide, 'Close panel')}
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1">
          {mode === 'code' && (
            <div className="min-w-0 flex-1">
              <HtmlSourceEditor value={source} onChange={handleSourceChange} autoFocus />
            </div>
          )}
          {previewVisible && (
            <div
              ref={previewRef}
              className={cn('bg-[#1a1a2e]', 'flex-1')}
              // Leaves the resize handle's inner half uncovered — see
              // HANDLE_GUTTER_PX. Bounds are measured from this element, so the
              // native view follows the inset automatically.
              style={{ marginLeft: HANDLE_GUTTER_PX }}
            />
          )}
          {mode === 'visual' && (
            <div className="min-w-0 flex-1">
              {/* The HTML visual editor is GrapesJS and only understands HTML.
                  A canvas gets its own node editor in the same slot. */}
              {type === 'canvas' ? (
                <CanvasEditor value={source} onChange={handleVisualChange} />
              ) : (
                <VisualHtmlEditor
                  ref={visualEditorRef}
                  value={source}
                  onChange={handleVisualChange}
                />
              )}
            </div>
          )}
        </div>
    </div>
  )
}
