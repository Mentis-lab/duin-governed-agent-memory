import { t } from '@/lib/i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useMemoryStore } from '@/stores/memory-store'
import { useUiStore } from '@/stores/ui-store'
import { toast } from '@/stores/toast-store'
import type { MemoryFile, MemorySource, MemoryType } from '@/lib/types'
import { MEMORY_SOURCE_LABELS } from '@/lib/types'

/** Canonical display order for provenance chips — strongest evidence first,
 *  'unknown' last so the unlabelled backlog never leads the control. */
const MEMORY_SOURCE_ORDER: readonly MemorySource[] = [
  'user-explicit',
  'session',
  'inferred',
  'reflection',
  'imported',
  'unknown'
]
import { MemoryLinkGraph } from './MemoryLinkGraph'
import { MemoryEditor } from './MemoryEditor'
import { MEMORY_TYPE_LABELS, MemoryTypeBadge } from './MemoryTypeBadge'

type TabKey = 'all' | MemoryType

const TABS: TabKey[] = ['all', 'user', 'feedback', 'project', 'reference']
const TAB_LABEL: Record<TabKey, string> = { all: 'All', ...MEMORY_TYPE_LABELS }

// The global memory lane (matches DEFAULT_PROJECT_SLUG in the electron memory-store).
// Memories the chat agent saved inside a project now carry that project's slug (#2);
// everything unattributed lives here.
const GLOBAL_SLUG = '__global__'
const projectLabel = (slug: string): string => (slug === GLOBAL_SLUG ? 'Global' : slug)

interface EditorState {
  open: boolean
  initial?: MemoryFile | null
  draft?: { name?: string; type?: MemoryType; body?: string; description?: string }
}

export function MemoryPanel() {
  const entries = useMemoryStore((s) => s.entries)
  const exportMemories = useMemoryStore((s) => s.exportMemories)
  const importMemories = useMemoryStore((s) => s.importMemories)
  const clearAll = useMemoryStore((s) => s.clearAll)
  const duplicateEntry = useMemoryStore((s) => s.duplicateEntry)

  const [activeTab, setActiveTab] = useState<TabKey>('all')
  // Per-project lane filter (#3). Only surfaces once memories actually span more than
  // one project — until then it's noise, so the panel looks exactly as it did before.
  const [projectFilter, setProjectFilter] = useState<string>('all')
  const [sourceFilter, setSourceFilter] = useState<'all' | MemorySource>('all')
  const [menuOpen, setMenuOpen] = useState(false)
  const [consolidating, setConsolidating] = useState(false)
  const [editor, setEditor] = useState<EditorState>({ open: false })
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Fluidity J4 — when ChatInput's `#…` shortcut bumps memorySeedToken,
  // auto-open the editor with the description prefilled. The seed is
  // consumed atomically so a re-render won't reopen the editor.
  const memorySeedToken = useUiStore((s) => s.memorySeedToken)
  useEffect(() => {
    if (memorySeedToken === 0) return
    const description = useUiStore.getState().consumeMemorySeedDescription()
    setEditor({
      open: true,
      draft: { type: 'feedback', description }
    })
  }, [memorySeedToken])

  // Live `memory:changed` subscription so external edits and other
  // panel writes refresh the view without forcing a parent reload.
  useEffect(() => {
    const api = (window as any).api
    const unsubscribe = api?.memory?.onChanged?.(() => {
      useMemoryStore.getState().receiveChanged([])
    })
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

  // Distinct project lanes present in memory (Global first). The selector only shows
  // when this has more than one entry — until #2 accrues project-attributed memories,
  // everything is Global and the panel stays unchanged.
  const projectSlugs = useMemo(() => {
    const s = new Set<string>()
    for (const e of entries) s.add(e.projectSlug || GLOBAL_SLUG)
    return [...s].sort((a, b) => (a === GLOBAL_SLUG ? -1 : b === GLOBAL_SLUG ? 1 : a.localeCompare(b)))
  }, [entries])
  // If the active project lane empties out (all its memories deleted), fall back to All
  // so the view never gets stuck on an empty, no-longer-present project.
  useEffect(() => {
    if (projectFilter !== 'all' && !projectSlugs.includes(projectFilter)) setProjectFilter('all')
  }, [projectSlugs, projectFilter])

  // Project lane scoping happens BEFORE the type tabs, so tab counts reflect the
  // selected lane (recomputed locally rather than from the store's global counts).
  const projectScoped = useMemo(
    () =>
      projectFilter === 'all' ? entries : entries.filter((e) => (e.projectSlug || GLOBAL_SLUG) === projectFilter),
    [entries, projectFilter]
  )
  const tabCounts = useMemo(() => {
    const c: Record<TabKey, number> = { all: 0, user: 0, feedback: 0, project: 0, reference: 0 }
    for (const e of projectScoped) {
      c.all += 1
      c[e.type] += 1
    }
    return c
  }, [projectScoped])
  // Which provenances actually occur in this project's memories, in canonical order.
  const presentSources = useMemo(() => {
    const seen = new Set<MemorySource>()
    for (const e of projectScoped) seen.add(e.source ?? 'unknown')
    return MEMORY_SOURCE_ORDER.filter((s) => seen.has(s))
  }, [projectScoped])
  const filtered = useMemo(() => {
    const byType = activeTab === 'all' ? projectScoped : projectScoped.filter((e) => e.type === activeTab)
    const list =
      sourceFilter === 'all' ? byType : byType.filter((e) => (e.source ?? 'unknown') === sourceFilter)
    return [...list].sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type)
      const left = (a.description || a.name).toLowerCase()
      const right = (b.description || b.name).toLowerCase()
      return left.localeCompare(right)
    })
  }, [projectScoped, activeTab, sourceFilter])

  const handleExport = async () => {
    setMenuOpen(false)
    const json = await exportMemories()
    if (!json) return
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `duin-memory-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      await importMemories(text)
    } catch (err) {
      toast.error(`Import failed: ${(err as Error).message}`)
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleClearAll = async () => {
    setMenuOpen(false)
    if (!confirm('Clear all memory entries? This cannot be undone.')) return
    await clearAll()
  }

  const handleConsolidate = async () => {
    if (activeTab === 'all' || consolidating) return
    // Consolidation hands a model authority to rewrite and delete these files. Both other
    // destructive actions in this panel confirm first (Clear All above, the row Delete
    // below); this one skipped it, so a single mis-click on an enabled button was the whole
    // ceremony. Prior content is recoverable from `.trash` either way, but recovery is a
    // manual dig through tombstones — cheap to avoid, expensive to undo.
    const count = tabCounts[activeTab] ?? 0
    const label = TAB_LABEL[activeTab].toLowerCase()
    if (
      !confirm(
        `Consolidate ${count} ${label} memory entries?\n\n` +
          'A model will merge near-duplicates, rewriting some entries and deleting others. ' +
          'Replaced and deleted content is recoverable from the memory .trash folder, but this is not an undo.'
      )
    )
      return
    setConsolidating(true)
    try {
      const typedEntries = entries.filter((entry) => entry.type === activeTab)
      const result = await window.api.workflows.run({
        name: 'consolidate-memory',
        args: { type: activeTab, entries: typedEntries }
      })
      if (!result.success) {
        toast.error(`Consolidation failed: ${result.error}`)
        return
      }
      toast.success(`Consolidating ${TAB_LABEL[activeTab].toLowerCase()} memory`)
    } catch (err) {
      toast.error(`Consolidation failed: ${(err as Error).message}`)
    } finally {
      setConsolidating(false)
    }
  }

  const openNew = (type?: MemoryType) => {
    setEditor({ open: true, draft: { type: type ?? (activeTab === 'all' ? 'feedback' : activeTab) } })
  }

  const openEdit = (entry: MemoryFile) => {
    setEditor({ open: true, initial: entry })
  }

  if (editor.open) {
    return (
      <div className="border-t border-[var(--panel-border)] px-2 py-2">
        <MemoryEditor
          initial={editor.initial}
          initialDraft={editor.draft}
          onClose={() => setEditor({ open: false })}
        />
      </div>
    )
  }

  return (
    <div className="border-t border-[var(--panel-border)] px-2 py-2">
      <div className="flex items-center justify-between px-2 py-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
            {t('Memory')}
          </span>
          {tabCounts.all > 0 && (
            <span className="rounded bg-[var(--bg-tertiary)] px-1 text-[12px] text-[var(--text-secondary)]">
              {tabCounts.all}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {activeTab !== 'all' && (
            <button
              type="button"
              onClick={handleConsolidate}
              disabled={consolidating || (tabCounts[activeTab] ?? 0) < 2}
              title={t('Consolidate this memory type')}
              className="rounded px-1.5 py-0.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('Consolidate')}
            </button>
          )}
          <button
            onClick={() => openNew()}
            title={t('Add memory entry')}
            className="rounded px-1.5 py-0.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--accent)]"
          >
            +
          </button>
          <div className="relative">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              title={t('Memory actions')}
              className="rounded px-1.5 py-0.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            >
              ...
            </button>
            {menuOpen && (
              <>
                <button
                  type="button"
                  onClick={() => setMenuOpen(false)}
                  className="fixed inset-0 z-10 cursor-default bg-transparent"
                  aria-label={t('Close menu')}
                />
                <div className="absolute right-0 top-full z-20 mt-1 w-40 overflow-hidden rounded border border-[var(--panel-border)] bg-[var(--bg-tertiary)] shadow-lg">
                  <button
                    onClick={handleExport}
                    className="block w-full px-3 py-1.5 text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)]"
                  >
                    {t('Export JSON')}
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false)
                      fileInputRef.current?.click()
                    }}
                    className="block w-full px-3 py-1.5 text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)]"
                  >
                    {t('Import JSON')}
                  </button>
                  <Button variant="danger" className="block w-full border-t text-left hover:bg-[var(--bg-primary)]"
                    onClick={handleClearAll}
                  >
                    {t('Clear all')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleImportFile}
      />

      {/* Provenance filter. Shown only once more than one source is actually present:
          on a vault where everything is 'unknown' the control would be a row of
          chips that all do nothing. */}
      {presentSources.length > 1 && (
        <div className="mt-1 flex items-center gap-1 overflow-x-auto px-1 pb-1">
          <span className="shrink-0 pr-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
            {t('Source')}
          </span>
          {(['all', ...presentSources] as ('all' | MemorySource)[]).map((src) => {
            const isActive = sourceFilter === src
            return (
              <button
                key={src}
                type="button"
                onClick={() => setSourceFilter(src)}
                title={src === 'all' ? 'Every provenance' : MEMORY_SOURCE_LABELS[src]}
                className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  isActive
                    ? 'bg-[var(--accent)] text-[var(--bg-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {src === 'all' ? 'Any source' : MEMORY_SOURCE_LABELS[src]}
              </button>
            )
          })}
        </div>
      )}

      {projectSlugs.length > 1 && (
        <div className="mt-1 flex items-center gap-1 overflow-x-auto px-1 pb-1">
          <span className="shrink-0 pr-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
            {t('Project')}
          </span>
          {(['all', ...projectSlugs] as string[]).map((slug) => {
            const isActive = projectFilter === slug
            return (
              <button
                key={slug}
                type="button"
                onClick={() => setProjectFilter(slug)}
                className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  isActive
                    ? 'bg-[var(--accent)] text-[var(--bg-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {slug === 'all' ? 'All projects' : projectLabel(slug)}
              </button>
            )
          })}
        </div>
      )}

      <div className="mt-1 flex items-center gap-1 overflow-x-auto px-1 pb-1">
        {TABS.map((tab) => {
          const c = tabCounts[tab] ?? 0
          const isActive = activeTab === tab
          return (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider transition-colors ${
                isActive
                  ? 'bg-[var(--accent)] text-[var(--bg-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <span>{TAB_LABEL[tab]}</span>
              <span
                className={`rounded ${
                  isActive ? 'bg-black/20' : 'bg-[var(--bg-tertiary)]'
                } px-1 text-[11px]`}
              >
                {c}
              </span>
            </button>
          )
        })}
      </div>

      {filtered.length === 0 ? (
        <p className="px-2 py-3 text-[12px] leading-relaxed text-[var(--text-muted)]">
          {activeTab === 'all'
            ? 'Tell me something to remember.'
            : `No ${TAB_LABEL[activeTab].toLowerCase()} memories yet.`}
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {filtered.map((entry) => (
            <li key={entry.name}>
              <MemoryRow
                entry={entry}
                onOpen={() => openEdit(entry)}
                onDuplicate={async () => {
                  const dup = await duplicateEntry(entry.name)
                  if (dup) openEdit(dup)
                }}
                onDelete={async () => {
                  if (!confirm(`Delete "${entry.name}"?`)) return
                  await useMemoryStore.getState().deleteEntry(entry.name)
                }}
              />
            </li>
          ))}
        </ul>
      )}

      <MemoryLinkGraph
        onPick={(target) =>
          setEditor({
            open: true,
            draft: {
              name: target,
              type: 'reference',
              body: ''
            }
          })
        }
      />
    </div>
  )
}

interface MemoryRowProps {
  entry: MemoryFile
  onOpen: () => void
  onDuplicate: () => void | Promise<void>
  onDelete: () => void | Promise<void>
}

function MemoryRow({ entry, onOpen, onDuplicate, onDelete }: MemoryRowProps) {
  return (
    <div className="group flex items-start gap-2 rounded border-l-2 border-transparent px-2 py-1 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
      <MemoryTypeBadge type={entry.type} compact />
      <button
        type="button"
        onClick={onOpen}
        title={entry.description || entry.body}
        className="line-clamp-2 min-w-0 flex-1 text-left leading-snug"
      >
        <span className="block truncate font-medium text-[var(--text-primary)]">
          {entry.description || entry.name}
        </span>
        <span className="block truncate font-mono text-[11px] text-[var(--text-muted)]">
          {entry.name}
          {entry.source && entry.source !== 'unknown' && (
            <span className="ml-1.5 font-sans not-italic text-[var(--text-muted)]">
              · {MEMORY_SOURCE_LABELS[entry.source]}
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={onDuplicate}
        title={t('Duplicate')}
        className="hidden rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--accent)] group-hover:block"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>
      <button
        type="button"
        onClick={onDelete}
        title={t('Delete')}
        className="hidden rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--error)] group-hover:block"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        </svg>
      </button>
    </div>
  )
}
