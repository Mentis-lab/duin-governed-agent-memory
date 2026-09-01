import { useEffect, useRef } from 'react'
import { EditorView, keymap, drawSelection, highlightActiveLine, lineNumbers } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { html } from '@codemirror/lang-html'
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language'
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap
} from '@codemirror/autocomplete'

// CodeMirror 6 HTML source editor for the artifact workbench. Mirrors the
// imperative pattern of CodeMirrorEditor.tsx (one EditorView owned for the
// component's life; props drive create-once + external-value sync) but uses the
// monospace code surface + @codemirror/lang-html (tag/attr highlighting +
// autocomplete + bracket closing). Fully offline — no workers, no CDN.

const CODE_THEME = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12px',
    backgroundColor: 'var(--bg-primary)',
    color: 'var(--text-primary)'
  },
  '.cm-content': {
    // --font-code, NOT --font-mono: the latter is deliberately remapped to the UI
    // SANS stack for chrome, so reading it here rendered the source editor in a
    // proportional face.
    fontFamily: 'var(--font-code, "IBM Plex Mono", monospace)',
    padding: '10px',
    caretColor: 'var(--accent)'
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-primary)',
    color: 'var(--text-muted)',
    border: 'none'
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--bg-tertiary) 40%, transparent)'
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-scroller': { overflow: 'auto', lineHeight: '1.6' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 26%, transparent)'
  }
})

export function HtmlSourceEditor({
  value,
  onChange,
  autoFocus = false
}: {
  value: string
  onChange: (next: string) => void
  autoFocus?: boolean
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // Create the editor once.
  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          autocompletion(),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab
          ]),
          html(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
          CODE_THEME,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString())
          })
        ]
      })
    })
    viewRef.current = view
    if (autoFocus) view.focus()
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Create-once; value synced by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync an externally-changed value (opening a different artifact) without
  // clobbering the cursor on the user's own keystrokes.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />
}
