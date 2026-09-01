import { t } from '@/lib/i18n'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useUiStore } from '@/stores/ui-store'
import { useBrainStore } from '@/stores/brain-store'
import { DEFAULT_KIND_COLOR } from '@/duin/lib/graph-schemes'
import { forLight, isLightMode } from '@/duin/lib/light-color'

// Global search command palette (Cmd/Ctrl+K) — Phase 2 (search-only): note/doc
// hits + graph-node hits, jump-to-node, open-in-DocView. Backed by
// window.api.brain.search -> /state/search -> the existing hybrid retriever.
//
// Design-taste: one focal input, a single divide-y hairline across grouped
// results, entity kind shown as a LEFT-EDGE color dot (not a filled pill),
// reserved row height (skeleton, no layout shift), empty state = recent nodes,
// explicit no-results + error rows. Keyboard: up/down across groups, Enter
// opens, Cmd/Ctrl+Enter reveals-in-graph.

interface NoteHit {
  file: string
  title: string
  breadcrumb: string
  snippet: string
  score: number
}
interface NodeHit {
  id: string
  label: string
  kind: string
  layer?: string
  degree: number
}
type Row =
  | { type: 'node'; node: NodeHit }
  | { type: 'note'; note: NoteHit }

const NODE_COLOR = (kind: string): string => {
  const c = DEFAULT_KIND_COLOR[kind] ?? '#94a3b8'
  // Pale dark-field node hues (yellow/lime) vanish on the light search surface.
  return isLightMode() ? forLight(c) : c
}

// Open a vault note / graph node natively: the Brain Explorer right-panel reads
// detailNode and renders DocView for vault notes. Mirrors brain-shell's pickNode.
function openNote(file: string, title: string): void {
  useBrainStore.getState().setDetail({ id: file, kind: 'page', label: title, layer: 'vault' })
  useUiStore.getState().setActiveTool('brain')
}
function openNode(node: NodeHit): void {
  const store = useBrainStore.getState()
  store.focusNode(node.id) // jump-to-node: bumps focusToken -> brain-shell.focusNode()
  store.setDetail({ id: node.id, kind: node.kind, label: node.label, layer: node.layer })
  useUiStore.getState().setActiveTool('brain')
}
// Cmd/Ctrl+Enter — reveal in the graph without opening the detail pane.
function revealInGraph(id: string): void {
  useBrainStore.getState().focusNode(id)
  useUiStore.getState().setActiveTool('brain')
}

export function GlobalSearchPalette(): ReactElement | null {
  const visible = useUiStore((s) => s.globalSearchVisible)
  const close = useUiStore((s) => s.closeGlobalSearch)
  const graphData = useBrainStore((s) => s.data)

  const [query, setQuery] = useState('')
  const [notes, setNotes] = useState<NoteHit[]>([])
  const [nodes, setNodes] = useState<NodeHit[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  // Guards against out-of-order responses: only the latest query's result wins.
  const reqRef = useRef(0)

  // Recent nodes for the empty state — top-degree-ish picks from the already
  // loaded graph (no extra IPC). Degrades to [] when the graph hasn't loaded.
  const recentNodes = useMemo<NodeHit[]>(() => {
    const src = graphData?.nodes ?? []
    return src
      .filter((n) => n.kind !== 'core' && n.kind !== 'folder' && n.kind !== 'index')
      .slice(0, 8)
      .map((n) => ({ id: n.id, label: n.label, kind: n.kind, layer: n.layer, degree: 0 }))
  }, [graphData])

  // Reset on open + focus the input.
  useEffect(() => {
    if (!visible) return
    setQuery('')
    setNotes([])
    setNodes([])
    setError(null)
    setActiveIdx(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [visible])

  // Debounced search. One IPC call returns both groups; the modal never blocks
  // (opens instantly, shows a skeleton while the call is in flight).
  useEffect(() => {
    if (!visible) return
    const q = query.trim()
    if (!q) {
      setNotes([])
      setNodes([])
      setLoading(false)
      setError(null)
      return
    }
    const token = ++reqRef.current
    setLoading(true)
    setError(null)
    const t = setTimeout(() => {
      void window.api.brain
        .search(q)
        .then((res) => {
          if (token !== reqRef.current) return // a newer query superseded this one
          if (res.success && res.data) {
            setNodes(res.data.nodes ?? [])
            setNotes(res.data.notes ?? [])
            setError(null)
          } else {
            setNodes([])
            setNotes([])
            setError(res.error ?? 'Search failed.')
          }
          setLoading(false)
        })
        .catch((e: unknown) => {
          if (token !== reqRef.current) return
          setNodes([])
          setNotes([])
          setError(e instanceof Error ? e.message : String(e))
          setLoading(false)
        })
    }, 120)
    return () => clearTimeout(t)
  }, [query, visible])

  // Flat, keyboard-navigable row list (node group then note group).
  const rows = useMemo<Row[]>(() => {
    const showRecent = !query.trim()
    const nodeRows: Row[] = (showRecent ? recentNodes : nodes).map((node) => ({ type: 'node', node }))
    const noteRows: Row[] = (showRecent ? [] : notes).map((note) => ({ type: 'note', note }))
    return [...nodeRows, ...noteRows]
  }, [query, nodes, notes, recentNodes])

  useEffect(() => {
    setActiveIdx(0)
  }, [query])

  const act = (row: Row, reveal: boolean): void => {
    if (row.type === 'node') {
      if (reveal) revealInGraph(row.node.id)
      else openNode(row.node)
    } else if (reveal) {
      revealInGraph(row.note.file)
    } else {
      openNote(row.note.file, row.note.title)
    }
    close()
  }

  // Key handling on the input so it works while typing.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(rows.length - 1, i + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(0, i - 1))
      return
    }
    if (e.key === 'Enter') {
      const row = rows[activeIdx]
      if (!row) return
      e.preventDefault()
      act(row, e.metaKey || e.ctrlKey)
    }
  }

  if (!visible) return null

  const showRecent = !query.trim()
  const nodeGroup = showRecent ? recentNodes : nodes
  const noteGroup = showRecent ? [] : notes
  const nodeOffset = 0
  const noteOffset = nodeGroup.length
  const hasAnyResult = rows.length > 0

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/35 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
      data-testid="global-search-palette"
    >
      <div className="flex max-h-[64vh] w-[min(680px,calc(100vw-32px))] flex-col overflow-hidden rounded-lg border border-[var(--panel-border)] bg-[var(--bg-primary)] shadow-2xl">
        {/* One focal input. */}
        <div className="border-b border-[var(--panel-border)] p-3">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('Search notes and graph...')}
            className="w-full bg-transparent px-1 py-1 text-[14px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
        </div>

        <div className="min-h-0 flex-1 divide-y divide-[var(--panel-border)] overflow-y-auto">
          {/* Error row — explicit, never a dead modal. */}
          {error && (
            <div className="px-4 py-3 text-[12px] text-[var(--error)]">{error}</div>
          )}

          {/* Skeleton — reserve row height so results don't shift layout in. */}
          {loading && !error && (
            <div className="px-2 py-1.5">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex h-[46px] items-center gap-3 px-2">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--bg-tertiary)]" />
                  <div className="flex-1">
                    <div className="h-3 w-1/3 rounded bg-[var(--bg-tertiary)]" />
                    <div className="mt-1.5 h-2.5 w-2/3 rounded bg-[var(--bg-tertiary)]" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Nodes group (or recent nodes when the query is empty). */}
          {!error && !loading && nodeGroup.length > 0 && (
            <div className="py-1">
              <div className="px-4 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                {showRecent ? 'Recent nodes' : 'Nodes'}
              </div>
              {nodeGroup.map((node, i) => {
                const idx = nodeOffset + i
                const isActive = idx === activeIdx
                return (
                  <button
                    key={`node:${node.id}`}
                    type="button"
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={(e) => act({ type: 'node', node }, e.metaKey || e.ctrlKey)}
                    className={`flex h-[46px] w-full items-center gap-3 px-4 text-left transition-colors ${
                      isActive ? 'bg-[var(--bg-tertiary)]' : 'hover:bg-[var(--bg-tertiary)]'
                    }`}
                  >
                    {/* LEFT-EDGE color dot = kind (category as edge, not a filled pill). */}
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: NODE_COLOR(node.kind) }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-[var(--text-primary)]">
                        {node.label}
                      </span>
                      <span className="block truncate text-[11px] text-[var(--text-muted)]">
                        {node.kind}
                        {node.degree > 0 ? ` · ${node.degree} links` : ''}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Notes / docs group. */}
          {!error && !loading && noteGroup.length > 0 && (
            <div className="py-1">
              <div className="px-4 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                Notes &amp; docs
              </div>
              {noteGroup.map((note, i) => {
                const idx = noteOffset + i
                const isActive = idx === activeIdx
                return (
                  <button
                    key={`note:${note.file}`}
                    type="button"
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={(e) => act({ type: 'note', note }, e.metaKey || e.ctrlKey)}
                    className={`flex min-h-[46px] w-full items-start gap-3 px-4 py-2 text-left transition-colors ${
                      isActive ? 'bg-[var(--bg-tertiary)]' : 'hover:bg-[var(--bg-tertiary)]'
                    }`}
                  >
                    <span
                      className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: NODE_COLOR('page') }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-[12px] font-medium text-[var(--text-primary)]">
                          {note.title}
                        </span>
                        {note.breadcrumb && (
                          <span className="truncate text-[11px] text-[var(--text-muted)]">
                            {note.breadcrumb}
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 line-clamp-1 text-[11px] text-[var(--text-secondary)]">
                        {note.snippet}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Explicit no-results row. */}
          {!error && !loading && !showRecent && !hasAnyResult && (
            <div className="px-4 py-3 text-[12px] text-[var(--text-muted)]">
              No matches for &ldquo;{query.trim()}&rdquo;.
            </div>
          )}

          {/* Empty state with no graph loaded yet. */}
          {!error && !loading && showRecent && nodeGroup.length === 0 && (
            <div className="px-4 py-3 text-[12px] text-[var(--text-muted)]">
              {t('Type to search your notes and graph.')}
            </div>
          )}
        </div>

        {/* Footer hint. */}
        <div className="flex items-center gap-4 border-t border-[var(--panel-border)] px-4 py-2 text-[11px] text-[var(--text-muted)]">
          <span>
            <kbd className="font-mono">{t('Enter')}</kbd> open
          </span>
          <span>
            <kbd className="font-mono">Cmd/Ctrl+Enter</kbd> reveal in graph
          </span>
          <span>
            <kbd className="font-mono">{t('Esc')}</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
