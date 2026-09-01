import { t } from '@/lib/i18n'
import { useRagStore } from '@/stores/rag-store'
import type { RagDocument, RagDocumentStatus } from '@/lib/types'

// Stable empty reference — a `?? []` INSIDE a zustand selector returns a new
// array every render, which makes useSyncExternalStore loop forever (React
// #185, blank screen). Return this shared constant instead.
const EMPTY_DOCS: RagDocument[] = []

const STATUS_STYLES: Record<RagDocumentStatus, { dot: string; label: string }> = {
  queued: { dot: 'bg-[var(--text-muted)]', label: 'queued' },
  loading: { dot: 'bg-amber-500', label: 'loading' },
  chunking: { dot: 'bg-amber-500', label: 'chunking' },
  embedding: { dot: 'bg-amber-500', label: 'embedding' },
  ready: { dot: 'bg-green-500', label: 'ready' },
  error: { dot: 'bg-red-500', label: 'error' },
  stale: { dot: 'bg-[var(--text-muted)]', label: 'stale' }
}

export function DocumentTable({
  collectionId,
  onOpen
}: {
  collectionId: string
  onOpen: (doc: RagDocument) => void
}) {
  const documents = useRagStore((s) => s.documents.get(collectionId) ?? EMPTY_DOCS)
  const loading = useRagStore((s) => s.documentsLoading.has(collectionId))
  const reingest = useRagStore((s) => s.reingestDocument)
  const remove = useRagStore((s) => s.deleteDocument)

  if (loading && documents.length === 0) {
    return (
      <p className="text-[11px] text-[var(--text-muted)]">
        Loading documents…
      </p>
    )
  }
  if (documents.length === 0) {
    return (
      <p className="text-[11px] text-[var(--text-muted)]">
        {t('Drop files into the dropzone above to start indexing.')}
      </p>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded border border-[var(--panel-border)]">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-[var(--bg-secondary)]">
          <tr className="text-left text-[var(--text-muted)]">
            <th className="px-2 py-1">{t('Name')}</th>
            <th className="px-2 py-1">{t('Status')}</th>
            <th className="px-2 py-1">{t('Chunks')}</th>
            <th className="px-2 py-1">{t('Ingested')}</th>
            <th className="px-2 py-1" />
          </tr>
        </thead>
        <tbody>
          {documents.map((doc) => (
            <DocumentRow
              key={doc.id}
              doc={doc}
              onView={() => onOpen(doc)}
              onReingest={() => reingest(doc.id)}
              onDelete={() => {
                if (confirm(`Delete "${doc.displayName}"?`)) remove(doc.id)
              }}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DocumentRow({
  doc,
  onView,
  onReingest,
  onDelete
}: {
  doc: RagDocument
  onView: () => void
  onReingest: () => void
  onDelete: () => void
}) {
  const style = STATUS_STYLES[doc.status]
  return (
    <tr className="border-t border-[var(--panel-border)]/50">
      <td className="truncate px-2 py-1" title={doc.sourcePath ?? doc.displayName}>
        <button
          onClick={onView}
          className="truncate text-left text-[var(--text-primary)] hover:text-[var(--accent)] hover:underline"
          title={t('Open document')}
        >
          {doc.displayName}
        </button>
      </td>
      <td className="px-2 py-1">
        <span className="flex items-center gap-1.5">
          <span
            className={`h-2 w-2 rounded-full ${style.dot}`}
            aria-hidden
          />
          <span className="text-[var(--text-secondary)]">{style.label}</span>
          {doc.status === 'error' && doc.statusDetail && (
            <span
              className="ml-1 truncate text-red-400"
              title={doc.statusDetail}
            >
              · {doc.statusDetail}
            </span>
          )}
        </span>
      </td>
      <td className="px-2 py-1 text-[var(--text-secondary)]">{doc.chunkCount}</td>
      <td className="px-2 py-1 text-[var(--text-muted)]">
        {doc.ingestedAt
          ? new Date(doc.ingestedAt).toLocaleString()
          : '—'}
      </td>
      <td className="px-2 py-1 text-right">
        <button
          onClick={onView}
          className="mr-2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          title={t('Open document')}
          aria-label={t('Open document')}
        >
          ⤢
        </button>
        {doc.sourcePath && (
          <button
            onClick={onReingest}
            className="mr-2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            title={t('Reindex from source')}
          >
            ↻
          </button>
        )}
        <button
          onClick={onDelete}
          className="text-[var(--text-muted)] hover:text-red-400"
          title={t('Delete')}
          aria-label={t('Delete document')}
        >
          ×
        </button>
      </td>
    </tr>
  )
}
