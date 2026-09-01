import { useEffect, useRef } from 'react'
import { EditorView, keymap, drawSelection, highlightActiveLine } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput } from '@codemirror/language'
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands'
import { markdownLivePreview } from './markdownDecorations'
import { wikilinkAutocomplete } from './wikilinkComplete'

// P4 — CodeMirror 6 markdown editor (the note-making core). Replaces the plain
// <textarea>: raw markdown stays the buffer (no lossy WYSIWYG model — the vault
// is markdown-truth), with syntax highlighting, line wrapping, undo history, and
// solid CJK/IME input (CM6's view layer preserves the composing node across
// redraws — the reason we chose CM6 over a ProseMirror model). Live-preview
// decorations + wikilink autocomplete + backlinks are the next increments.
//
// Wrapped imperatively: one EditorView owned across the component's life; React
// props drive create (once) + external-value sync (open a different note).

const NOTE_THEME = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'var(--bg-primary)',
    color: 'var(--text-primary)'
  },
  '.cm-content': {
    // Match the app's UI font (IBM Plex Sans) rather than a code-editor monospace,
    // so writing a note reads like the rest of DUIN, not a terminal. (The app's
    // --font-mono is itself IBM Plex Sans by design — see styles/index.css — so
    // this keeps the whole surface on one type system.)
    fontFamily: 'var(--font-sans)',
    fontSize: '14px',
    padding: '12px',
    caretColor: 'var(--accent)'
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--bg-tertiary) 45%, transparent)' },
  '.cm-scroller': { overflow: 'auto', lineHeight: '1.65' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)'
  }
})

export function CodeMirrorEditor({
  value,
  onChange,
  autoFocus = false,
  noteTitles = [],
  onOpenWikilink
}: {
  value: string
  onChange: (next: string) => void
  autoFocus?: boolean
  /** Vault note titles for `[[wikilink]]` autocomplete. */
  noteTitles?: string[]
  /** Fires when a rendered `[[wikilink]]` is clicked (host resolves + opens). */
  onOpenWikilink?: (target: string) => void
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Keep the latest callbacks/data without recreating the editor.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const titlesRef = useRef(noteTitles)
  titlesRef.current = noteTitles
  const onWikilinkRef = useRef(onOpenWikilink)
  onWikilinkRef.current = onOpenWikilink

  // Create the editor once.
  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          indentOnInput(),
          highlightActiveLine(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown({ base: markdownLanguage, codeLanguages: [] }),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
          markdownLivePreview((target) => onWikilinkRef.current?.(target)),
          wikilinkAutocomplete(() => titlesRef.current),
          NOTE_THEME,
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
    // Intentionally create-once; value is synced by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync an externally-changed value (e.g. opening a different note) into the
  // editor without clobbering the cursor on the user's own keystrokes.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  return <div ref={hostRef} className="h-full min-h-[60vh] w-full overflow-hidden rounded-md border border-[var(--panel-border)] focus-within:border-[var(--accent)]" />
}
