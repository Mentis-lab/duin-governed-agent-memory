import { EditorView, Decoration, type DecorationSet, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view'
import { EditorState, type Range } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'

// P4+ — CodeMirror 6 live-preview (the Obsidian feel). A view-layer decoration
// pass over the RAW markdown buffer: rendered styling appears inline while the
// syntax markers are hidden, and the raw syntax REVEALS on the line the cursor
// is on. Nothing mutates the document (vault stays markdown-truth) — this is
// pure presentation. Covers: headings, bold/italic/strikethrough/inline-code,
// and [[wikilinks]] (rendered as clickable links).
//
// Mechanism (ixora pattern): recompute on doc/viewport/selection change, iterate
// the syntax tree + a wikilink regex over VISIBLE ranges only, and short-circuit
// any hide/replace when the cursor overlaps the construct.

function checkOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1]
}
function cursorInRange(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => checkOverlap([from, to], [r.from, r.to]))
}

const hidden = Decoration.replace({})

// Map lezer-markdown mark node names → the class to apply to the CONTENT and
// the mark node whose delimiters we hide when off the cursor line.
const EMPHASIS: Record<string, { content: string }> = {
  StrongEmphasis: { content: 'cm-md-strong' },
  Emphasis: { content: 'cm-md-em' },
  Strikethrough: { content: 'cm-md-strike' },
  InlineCode: { content: 'cm-md-code' }
}
const MARK_NODES = new Set(['EmphasisMark', 'CodeMark', 'StrikethroughMark'])

const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g

class WikilinkWidget extends WidgetType {
  constructor(readonly target: string) {
    super()
  }
  eq(other: WikilinkWidget): boolean {
    return other.target === this.target
  }
  toDOM(): HTMLElement {
    const a = document.createElement('span')
    a.className = 'cm-md-wikilink'
    a.textContent = this.target.split('|').pop()!.split('#')[0].trim()
    a.dataset.wikilink = this.target
    a.title = `Open [[${this.target}]]`
    return a
  }
  ignoreEvent(): boolean {
    return false
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const widgets: Range<Decoration>[] = []
  const { state } = view
  const tree = syntaxTree(state)

  for (const { from, to } of view.visibleRanges) {
    // 1. Standard markdown marks via the syntax tree.
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name
        // Headings: add a class to the whole line for scale/weight; hide the
        // leading `#`s only when the cursor isn't on that line.
        if (/^ATXHeading[1-6]$/.test(name)) {
          const level = Number(name.slice(-1))
          const line = state.doc.lineAt(node.from)
          widgets.push(
            Decoration.line({ class: `cm-md-h${level}` }).range(line.from)
          )
          if (!cursorInRange(state, line.from, line.to)) {
            // hide "### " prefix (marker + following space)
            const text = state.doc.sliceString(line.from, line.to)
            const m = /^#{1,6}\s/.exec(text)
            if (m) widgets.push(hidden.range(line.from, line.from + m[0].length))
          }
          return
        }
        const emph = EMPHASIS[name]
        if (emph) {
          if (!cursorInRange(state, node.from, node.to)) {
            widgets.push(Decoration.mark({ class: emph.content }).range(node.from, node.to))
          }
          return
        }
        if (MARK_NODES.has(name)) {
          // Hide the delimiter (e.g. **, `, ~~) unless the cursor is adjacent.
          const parentFrom = node.node.parent?.from ?? node.from
          const parentTo = node.node.parent?.to ?? node.to
          if (!cursorInRange(state, parentFrom, parentTo)) {
            widgets.push(hidden.range(node.from, node.to))
          }
        }
      }
    })

    // 2. Wikilinks via regex over the visible text (lezer-markdown doesn't know
    //    them). Render as a clickable widget unless the cursor is inside.
    const text = state.doc.sliceString(from, to)
    let m: RegExpExecArray | null
    WIKILINK_RE.lastIndex = 0
    while ((m = WIKILINK_RE.exec(text)) !== null) {
      const start = from + m.index
      const end = start + m[0].length
      if (cursorInRange(state, start, end)) continue
      widgets.push(
        Decoration.replace({ widget: new WikilinkWidget(m[1]) }).range(start, end)
      )
    }
  }

  // Decorations must be sorted by position (line decorations before others at
  // the same pos is handled by CM's builder when we pass sort=true).
  widgets.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide)
  return Decoration.set(widgets, true)
}

export interface WikilinkClickHandler {
  (target: string): void
}

/** The live-preview extension. `onWikilink` fires when a rendered wikilink is
 *  clicked (the host resolves + navigates). */
export function markdownLivePreview(onWikilink?: WikilinkClickHandler) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view)
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged || u.selectionSet) {
          this.decorations = buildDecorations(u.view)
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown: (e) => {
          const t = e.target as HTMLElement
          const link = t.closest('[data-wikilink]') as HTMLElement | null
          if (link && onWikilink) {
            onWikilink(link.dataset.wikilink!)
            return true
          }
          return false
        }
      }
    }
  )
  return [plugin, livePreviewTheme]
}

const livePreviewTheme = EditorView.baseTheme({
  '.cm-md-strong': { fontWeight: '700' },
  '.cm-md-em': { fontStyle: 'italic' },
  '.cm-md-strike': { textDecoration: 'line-through', opacity: '0.7' },
  '.cm-md-code': {
    fontFamily: 'ui-monospace, monospace',
    backgroundColor: 'color-mix(in srgb, var(--bg-tertiary) 60%, transparent)',
    borderRadius: '3px',
    padding: '0 3px'
  },
  '.cm-md-h1': { fontSize: '1.5em', fontWeight: '700', lineHeight: '1.3' },
  '.cm-md-h2': { fontSize: '1.3em', fontWeight: '700', lineHeight: '1.3' },
  '.cm-md-h3': { fontSize: '1.15em', fontWeight: '600' },
  '.cm-md-h4, .cm-md-h5, .cm-md-h6': { fontWeight: '600' },
  '.cm-md-wikilink': {
    color: 'var(--accent)',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    cursor: 'pointer'
  }
})
