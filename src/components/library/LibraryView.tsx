import { t } from '@/lib/i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import { IconButton } from '@/components/ui/IconButton'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { PanelEmptyState } from '@/components/ui/PanelEmptyState'
import { useRagStore } from '@/stores/rag-store'
import { DocumentViewer } from './DocumentViewer'
import type { RagDocument, RagDocumentStatus } from '@/lib/types'

// Library — DOCUMENTS-FIRST. The panel leads with your documents across every
// collection; collections are a filter, not a gate. Drop files anywhere to add;
// click a document to read it. The RAG mechanics (collections, embedder) live
// behind the ⚙ so the default surface reads as "my documents", not a console.

// ── helpers ──────────────────────────────────────────────────────────────────

/** A rough file-type glyph from mime/name. */
function docIcon(d: RagDocument): string {
  const n = `${d.mime ?? ''} ${d.displayName}`.toLowerCase()
  if (/pdf/.test(n)) return '📕'
  if (/(sheet|excel|xlsx|numbers|csv)/.test(n)) return '📊'
  if (/(presentation|powerpoint|pptx|keynote)/.test(n)) return '📽'
  if (/(image|png|jpe?g|gif|webp|svg)/.test(n)) return '🖼'
  if (/(md|markdown|txt|rtf|word|doc|pages)/.test(n)) return '📄'
  return '📄'
}

type ChipTone = 'ok' | 'busy' | 'warn' | 'muted'
const BUSY: ReadonlySet<RagDocumentStatus> = new Set(['queued', 'loading', 'chunking', 'embedding'])

/** Human status for a document — the RAG phase, demoted to plain language. */
function docStatus(d: RagDocument): { label: string; tone: ChipTone; detail?: string } {
  if (d.status === 'ready') {
    return d.chunkCount > 0
      ? { label: 'indexed', tone: 'ok' }
      : { label: 'no searchable text', tone: 'muted' }
  }
  if (BUSY.has(d.status)) return { label: 'indexing…', tone: 'busy' }
  if (d.status === 'error') return { label: 'not indexed', tone: 'warn', detail: d.statusDetail }
  if (d.status === 'stale') return { label: 'stale', tone: 'muted' }
  return { label: d.status, tone: 'muted' }
}

const TONE_CLASS: Record<ChipTone, string> = {
  ok: 'text-[var(--success)]',
  busy: 'text-[var(--accent)]',
  warn: 'text-[var(--warning)]',
  muted: 'text-[var(--text-muted)]'
}

/** Absolute paths from a FileList (Electron exposes the real path via the
 *  preload webUtils bridge, else the legacy File.path). Mirrors IngestDropzone. */
function collectPaths(files: FileList | null): string[] {
  if (!files) return []
  const out: string[] = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i] as File & { path?: string }
    const getPath = (window as { api?: { app?: { getPathForFile?: (f: File) => string } } }).api?.app
      ?.getPathForFile
    const p = getPath ? getPath(f) : f.path
    if (typeof p === 'string' && p) out.push(p)
  }
  return out
}

function dateLabel(ms?: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

// ── component ────────────────────────────────────────────────────────────────

export function LibraryView(): React.ReactElement {
  const collections = useRagStore((s) => s.collections)
  const documents = useRagStore((s) => s.documents)
  const embedders = useRagStore((s) => s.embedders)
  const activeEmbedderId = useRagStore((s) => s.activeEmbedderId)
  const loadCollections = useRagStore((s) => s.loadCollections)
  const loadDocuments = useRagStore((s) => s.loadDocuments)
  const loadEmbedders = useRagStore((s) => s.loadEmbedders)
  const createCollection = useRagStore((s) => s.createCollection)
  const setActiveEmbedder = useRagStore((s) => s.setActiveEmbedder)
  const submitIngest = useRagStore((s) => s.submitIngest)
  const reingestDocument = useRagStore((s) => s.reingestDocument)
  const deleteDocument = useRagStore((s) => s.deleteDocument)
  const bindProgress = useRagStore((s) => s.bindProgress)
  const unbindProgress = useRagStore((s) => s.unbindProgress)

  const [viewDoc, setViewDoc] = useState<RagDocument | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<string>('all') // 'all' | collectionId
  const [manageOpen, setManageOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Load collections + embedders + subscribe to ingest progress once.
  useEffect(() => {
    void loadCollections()
    void loadEmbedders()
    bindProgress()
    return () => unbindProgress()
  }, [loadCollections, loadEmbedders, bindProgress, unbindProgress])

  // Load every collection's documents so the aggregate view is complete.
  useEffect(() => {
    for (const c of collections) void loadDocuments(c.id)
  }, [collections, loadDocuments])

  const collName = useMemo(() => new Map(collections.map((c) => [c.id, c.name])), [collections])

  // All documents across collections, newest activity first.
  const allDocs = useMemo(() => {
    const out: RagDocument[] = []
    for (const c of collections) out.push(...(documents.get(c.id) ?? []))
    return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }, [collections, documents])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return allDocs
      .filter((d) => filter === 'all' || d.collectionId === filter)
      .filter((d) => !q || d.displayName.toLowerCase().includes(q))
  }, [allDocs, filter, query])

  // Where a drop / add lands: the active filter if it's a real collection, else
  // the first collection, auto-creating one on first use so "just add a doc"
  // never requires a collection ceremony.
  async function resolveTarget(): Promise<string | null> {
    if (filter !== 'all') return filter
    if (collections[0]) return collections[0].id
    const created = await createCollection({ name: 'My Documents' })
    return created?.id ?? null
  }

  async function addPaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    const target = await resolveTarget()
    if (!target) return
    void submitIngest(
      target,
      paths.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() ?? p }))
    )
  }

  // A clicked document opens INLINE (the reader/PDF viewer), swapping the list.
  if (viewDoc) {
    return <DocumentViewer doc={viewDoc} onBack={() => setViewDoc(null)} />
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        void addPaths(collectPaths(e.dataTransfer.files))
      }}
      className={`flex h-full min-h-0 flex-col gap-2 px-3 pb-3 ${
        dragOver ? 'rounded-lg outline-2 outline-dashed outline-[var(--accent)]' : ''
      }`}
    >
      {/* Header: search + Add + manage */}
      <div className="flex items-center gap-2 pt-0.5">
        <div className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12px] text-[var(--text-muted)]">
            🔍
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search documents…')}
            className="w-full rounded-lg border border-[var(--panel-border)] bg-[var(--bg-primary)] py-1.5 pl-7 pr-2 text-[12px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)]"
          />
        </div>
        <Button variant="primary" className="flex rounded-lg"
          onClick={() => fileRef.current?.click()}
        >
          + Add
        </Button>
        <button
          onClick={() => setManageOpen((v) => !v)}
          title={t('Collections & indexing settings')}
          aria-label={t('Manage')}
          className={`shrink-0 rounded-lg border border-[var(--panel-border)] p-1.5 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] ${
            manageOpen ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : ''
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void addPaths(collectPaths(e.target.files))
            if (fileRef.current) fileRef.current.value = ''
          }}
        />
      </div>

      {/* Collection filter chips */}
      {collections.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-1">
          <FilterChip label={t('All')} active={filter === 'all'} onClick={() => setFilter('all')} />
          {collections.map((c) => (
            <FilterChip
              key={c.id}
              label={c.name}
              active={filter === c.id}
              onClick={() => setFilter(c.id)}
            />
          ))}
        </div>
      )}

      {/* Manage disclosure — the demoted RAG mechanics */}
      {manageOpen && (
        <div className="flex shrink-0 flex-col gap-2 rounded-lg border border-[var(--panel-border)] bg-[var(--bg-primary)] p-2">
          <div className="flex items-center gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('New collection…')}
              className="min-w-0 flex-1 rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1 text-[12px] text-[var(--text-primary)] placeholder-[var(--text-muted)]"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newName.trim()) {
                  void createCollection({ name: newName.trim() })
                  setNewName('')
                }
              }}
            />
            <button
              disabled={!newName.trim()}
              onClick={async () => {
                await createCollection({ name: newName.trim() })
                setNewName('')
              }}
              className="shrink-0 rounded border border-[var(--panel-border)] px-2 py-1 text-[11px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
              {t('Create')}
            </button>
          </div>
          <label className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
            Embedder
            <Select
              value={activeEmbedderId ?? ''}
              onChange={(e) => void setActiveEmbedder(e.target.value)}
              className="min-w-0 flex-1"
            >
              {embedders.length === 0 && <option value="">Loading…</option>}
              {embedders.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          </label>
        </div>
      )}

      {/* Document list */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {rows.length === 0 ? (
          <EmptyState hasDocs={allDocs.length > 0} onAdd={() => fileRef.current?.click()} />
        ) : (
          <ul className="flex flex-col">
            {rows.map((d) => (
              <DocumentRow
                key={d.id}
                doc={d}
                collection={collName.get(d.collectionId) ?? ''}
                onOpen={() => setViewDoc(d)}
                onReingest={() => void reingestDocument(d.id)}
                onDelete={() => {
                  if (confirm(`Delete "${d.displayName}"?`)) void deleteDocument(d.id)
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── sub-components ────────────────────────────────────────────────────────────

function FilterChip({
  label,
  active,
  onClick
}: {
  label: string
  active: boolean
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      className={`max-w-[140px] truncate rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
        active
          ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]'
          : 'border-[var(--panel-border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
      }`}
    >
      {label}
    </button>
  )
}

function DocumentRow({
  doc,
  collection,
  onOpen,
  onReingest,
  onDelete
}: {
  doc: RagDocument
  collection: string
  onOpen: () => void
  onReingest: () => void
  onDelete: () => void
}): React.ReactElement {
  const status = docStatus(doc)
  return (
    <li className="group relative flex items-center gap-2.5 border-b border-[var(--border)] py-2 pl-1 pr-1 last:border-b-0">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
        <span className="shrink-0 text-[16px] leading-none">{docIcon(doc)}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[12px] font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)]">
            {doc.displayName}
          </span>
          <span className="truncate text-[11px] text-[var(--text-muted)]">
            {[collection, dateLabel(doc.ingestedAt)].filter(Boolean).join(' · ')}
            {(collection || doc.ingestedAt) && ' · '}
            <span className={TONE_CLASS[status.tone]} title={status.detail}>
              {status.label}
            </span>
          </span>
        </span>
      </button>
      {/* Row actions — appear on hover so the row stays clean. */}
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {doc.sourcePath && (
          <IconButton
            onClick={onReingest}
            title={t('Re-index from source')}
          >
            ↻
          </IconButton>
        )}
        <IconButton tone="danger"
          onClick={onDelete}
          title={t('Remove')}
          aria-label={t('Remove document')}
        >
          ×
        </IconButton>
      </span>
    </li>
  )
}

function EmptyState({ hasDocs, onAdd }: { hasDocs: boolean; onAdd: () => void }): React.ReactElement {
  return (
    <PanelEmptyState
      icon={<span className="text-[20px]">📄</span>}
      title={hasDocs ? 'No documents match your search.' : 'No documents yet.'}
      body={
        hasDocs
          ? undefined
          : 'Drop a PDF, Office doc, or note anywhere here — it opens instantly and gets indexed for search in the background.'
      }
      action={
        hasDocs ? undefined : (
          <Button variant="primary" className="rounded-lg font-semibold" onClick={onAdd}>
            {t('Add documents')}
          </Button>
        )
      }
    />
  )
}
