import { useEffect, useMemo, useRef, useState } from 'react'
import { useMemoryStore } from '@/stores/memory-store'
import { MemoryTypeBadge } from './MemoryTypeBadge'
import { spliceWikilink } from './wikilink-splice'

// Floating autocomplete for `[[slug]]` references in a memory body.
//
// Owns the textarea ref so it can:
//   1. detect when the user just typed `[[`,
//   2. read the partial match between `[[` and the caret,
//   3. position itself under the caret line,
//   4. let arrow-up / arrow-down / enter pick a candidate,
//   5. insert the picked slug + closing `]]` back into the textarea
//      without losing the rest of the body around it.

interface Props {
  textarea: HTMLTextAreaElement | null
  onPicked?: (slug: string) => void
}

export function MemoryLinkPicker({ textarea, onPicked }: Props) {
  const entries = useMemoryStore((s) => s.entries)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const mirrorRef = useRef<HTMLDivElement | null>(null)

  const matches = useMemo(() => {
    if (!open) return []
    const q = query.toLowerCase()
    const all = entries
      .map((e) => ({ name: e.name, type: e.type, description: e.description }))
      .filter((e) => !q || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q))
      .slice(0, 8)
    return all
  }, [entries, query, open])

  // Detect `[[` typing + extract the partial query. The mirror div
  // re-renders the textarea text up to the caret to measure where
  // the picker should pop up.
  useEffect(() => {
    if (!textarea) return
    const onInput = () => {
      const value = textarea.value
      const caret = textarea.selectionStart ?? value.length
      const prefix = value.slice(0, caret)
      const match = /\[\[([^[\]\n]{0,40})$/.exec(prefix)
      if (!match) {
        setOpen(false)
        return
      }
      setQuery(match[1])
      setHighlight(0)
      setOpen(true)
      // Position the popup just below the textarea for simplicity
      // (line-precise caret positioning is fragile across font + line-
      // height combos and not worth the complexity for an autocomplete).
      const rect = textarea.getBoundingClientRect()
      setPosition({ top: rect.bottom + window.scrollY + 4, left: rect.left + window.scrollX })
    }

    const onKey = (e: KeyboardEvent) => {
      if (!open) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((h) => Math.min(h + 1, Math.max(matches.length - 1, 0)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) => Math.max(h - 1, 0))
      } else if (e.key === 'Enter') {
        if (matches.length === 0) return
        e.preventDefault()
        commit(matches[highlight].name)
      } else if (e.key === 'Escape') {
        setOpen(false)
      }
    }

    const commit = (slug: string) => {
      const value = textarea.value
      const caret = textarea.selectionStart ?? value.length
      const spliced = spliceWikilink(value, caret, slug)

      // Write through React's OWN value setter, not the element property.
      //
      // React installs a `value` setter on the node and keeps a _valueTracker beside
      // it. A plain `textarea.value = x` goes THROUGH that setter, so the tracker is
      // updated too — and when the dispatched 'input' arrives React compares tracker
      // to node, sees them equal, and concludes nothing changed. onChange never fires.
      // You watch the link land in the textarea, React's controlled state never learns
      // about it, and Save (which reads state, not the DOM) writes the note without it.
      //
      // Calling the prototype's native setter bypasses React's, leaving the tracker
      // holding the OLD value, so the same dispatch now reads as a real change.
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )?.set
      if (nativeSetter) nativeSetter.call(textarea, spliced.text)
      else textarea.value = spliced.text

      textarea.setSelectionRange(spliced.caret, spliced.caret)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      setOpen(false)
      onPicked?.(slug)
    }

    textarea.addEventListener('input', onInput)
    textarea.addEventListener('keydown', onKey)
    return () => {
      textarea.removeEventListener('input', onInput)
      textarea.removeEventListener('keydown', onKey)
    }
  }, [textarea, open, matches, highlight, onPicked])

  if (!open || matches.length === 0) return <div ref={mirrorRef} aria-hidden="true" className="hidden" />

  return (
    <ul
      className="fixed z-50 max-h-64 w-72 overflow-y-auto rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] text-[12px] shadow-lg"
      style={{ top: position.top, left: position.left }}
    >
      {matches.map((m, i) => (
        <li
          key={m.name}
          className={`flex items-center justify-between gap-2 px-2 py-1.5 ${i === highlight ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <code className="truncate font-mono text-[11px] text-[var(--text-primary)]">
              {m.name}
            </code>
          </span>
          <MemoryTypeBadge type={m.type} compact />
        </li>
      ))}
    </ul>
  )
}
