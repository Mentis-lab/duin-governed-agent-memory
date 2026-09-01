import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import grapesjs, { type Editor } from 'grapesjs'
import 'grapesjs/dist/css/grapes.min.css'
import { createDebouncedExport, type DebouncedExport } from './debounced-export'

// Phase 2 of the artifact workbench: a GrapesJS (BSD-3) drag-and-drop VISUAL
// editor. Round-trips arbitrary HTML: loads the current source, lets the user
// select/move/style elements + drop in blocks, and exports a self-contained
// document string back through onChange — the same string contract the rest of
// the panel (render / Code / Preview) already uses. Fully offline (bundled JS+CSS).
//
// Create-once + export-on-change (debounced). We deliberately do NOT sync the
// `value` prop back into GrapesJS after mount — GrapesJS owns the buffer while
// Visual mode is active, and the panel remounts this component fresh each time
// you re-enter Visual mode, so it always starts from the latest source.

const EXPORT_DEBOUNCE_MS = 400

// Full dark theme for GrapesJS's chrome. Driven by GrapesJS's four documented
// theme-hook classes (one-bg/two-color/three-bg/four-color) so it recolors every
// panel, then a few specifics for the canvas, inputs, blocks, and selection
// badges. Injected AFTER grapes.min.css so it wins the cascade.
const DARK_CSS = `
.gjs-one-bg { background-color: var(--bg-secondary); }
.gjs-two-color { color: var(--text-secondary); }
.gjs-three-bg { background-color: var(--accent); color: #fff; }
.gjs-four-color, .gjs-four-color-h:hover { color: var(--accent); }

.gjs-pn-panel { border-color: var(--panel-border); }
.gjs-pn-btn { color: var(--text-muted); }
.gjs-pn-btn.gjs-pn-active, .gjs-pn-btn:hover { color: var(--accent); }
.gjs-cv-canvas, .gjs-cv-canvas__frames { background-color: var(--bg-primary); }

.gjs-sm-sector-title, .gjs-block-category .gjs-title,
.gjs-layer-title, .gjs-clm-tags, .gjs-trt-header { border-color: var(--panel-border); }

.gjs-field, .gjs-field input, .gjs-field select, .gjs-field textarea,
.gjs-sm-field input, .gjs-sm-field select, .gjs-clm-select, .gjs-color-warn {
  background-color: var(--bg-primary); color: var(--text-primary); border-color: var(--panel-border);
}
.gjs-field-integer .gjs-field-arrows { background-color: var(--bg-tertiary); }

.gjs-block { background-color: var(--bg-tertiary); color: var(--text-secondary); border: 1px solid var(--panel-border); }
.gjs-block:hover { color: var(--accent); border-color: var(--accent); }
.gjs-block svg { fill: currentColor; }

.gjs-toolbar, .gjs-badge, .gjs-com-badge, .gjs-com-badge-mid { background-color: var(--accent); color: #fff; }
.gjs-selected, .gjs-selected-parent { outline-color: var(--accent) !important; }
`

// GrapesJS imports a full doc as body CHILDREN (the wrapper === body), so the
// original <body …> attributes (its inline background etc.) are dropped. Capture
// them from the source and re-apply on both the canvas (so the editor shows the
// real background) and export (so the round-trip is faithful).
function bodyAttrsOf(src: string): string {
  return src.match(/<body([^>]*)>/i)?.[1] ?? ''
}

function fullDoc(editor: Editor, bodyAttrs: string): string {
  const html = editor.getHtml()
  const css = editor.getCss()
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css ?? ''}</style></head><body${bodyAttrs}>${html}</body></html>`
}

export interface VisualHtmlEditorHandle {
  // Force any debounced export to fire NOW and return the latest document (or
  // null if nothing is pending). Save/Download/Copy call this before reading the
  // shared source: a normal debounced emit routes through React setState, which
  // has NOT applied by the time a synchronous click handler reads `source`, so
  // without this pull those actions would persist a document up to 400ms stale.
  flush: () => string | null
}

export const VisualHtmlEditor = forwardRef<
  VisualHtmlEditorHandle,
  {
    value: string
    onChange: (html: string) => void
  }
>(function VisualHtmlEditor({ value, onChange }, ref): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const exportRef = useRef<DebouncedExport<string> | null>(null)

  useImperativeHandle(ref, () => ({ flush: () => exportRef.current?.flush() ?? null }), [])

  useEffect(() => {
    if (!hostRef.current) return
    const editor = grapesjs.init({
      container: hostRef.current,
      height: '100%',
      width: 'auto',
      fromElement: false,
      storageManager: false,
      components: value,
      blockManager: {
        blocks: [
          { id: 'section', label: 'Section', content: '<section style="padding:24px"></section>' },
          { id: 'text', label: 'Text', content: '<div style="padding:8px">New text</div>' },
          { id: 'heading', label: 'Heading', content: '<h2 style="margin:8px 0">Heading</h2>' },
          { id: 'button', label: 'Button', content: '<button style="padding:8px 16px;border-radius:8px">Button</button>' },
          { id: 'image', label: 'Image', content: { type: 'image' } },
          { id: 'divider', label: 'Divider', content: '<hr style="border:none;border-top:1px solid #333;margin:16px 0">' }
        ]
      }
    })
    editorRef.current = editor
    const bodyAttrs = bodyAttrsOf(value)

    // Apply the original <body> style to the canvas body so the editor shows the
    // artifact's real background (GrapesJS drops body attributes on import).
    editor.on('load', () => {
      const style = bodyAttrs.match(/style="([^"]*)"/i)?.[1]
      const canvasBody = editor.Canvas.getBody()
      if (style && canvasBody) canvasBody.style.cssText = style
    })

    const exporter = createDebouncedExport(
      () => fullDoc(editor, bodyAttrs),
      (html) => onChangeRef.current(html),
      EXPORT_DEBOUNCE_MS
    )
    exportRef.current = exporter
    editor.on('update', () => exporter.schedule())

    return () => {
      // Flush (not just cancel) the armed export before teardown: switching to
      // Code/Preview/Split unmounts this component, and the old cleanup dropped
      // any edit made <400ms earlier, so the switched-to view rendered a stale
      // source. Flushing pushes that last edit into the shared buffer first.
      exporter.flush()
      editor.destroy()
      editorRef.current = null
      exportRef.current = null
    }
    // Create-once; see header note on why value isn't synced after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <style>{DARK_CSS}</style>
      <div ref={hostRef} className="h-full w-full" />
    </>
  )
})
