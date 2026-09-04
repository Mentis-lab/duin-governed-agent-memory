import { t } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { externalLinkComponents } from '@/lib/markdown-external-link'
import remarkGfm from 'remark-gfm'
import type { RagDocument } from '@/lib/types'
import { PdfView } from './PdfView'
import '@/styles/markdown.css' // shared .markdown-body prose styles (same as notes/chat)

// P3b/P3b+ — document detail, rendered INLINE in the right-side Library panel
// (the same place a node's detail opens in the Explorer — NOT a modal popup).
//   • PDF          → PDF.js fidelity render (toggle to the reader text).
//   • iWork        → first-page JPEG preview + extracted text.
//   • everything else → reader view (extracted text as rendered markdown).

function isPdfDoc(doc: RagDocument): boolean {
  return doc.mime === 'application/pdf' || /\.pdf$/i.test(doc.displayName)
}
function isIWorkDoc(doc: RagDocument): boolean {
  return /vnd\.apple\.(pages|numbers|keynote)/.test(doc.mime ?? '') || /\.(pages|numbers|key)$/i.test(doc.displayName)
}
// An OCR'd image doc: show the SOURCE image beside its extracted (OCR) text so it
// reads as "source + transcript" instead of a bare wall of text. Additive — only
// affects raster-image documents (which only exist when DUIN_OCR ingested them).
function isImageDoc(doc: RagDocument): boolean {
  return /^image\//.test(doc.mime ?? '') || /\.(png|jpe?g|webp|bmp|tiff?|gif)$/i.test(doc.displayName)
}

export function DocumentViewer({
  doc,
  onBack
}: {
  doc: RagDocument
  onBack: () => void
}): React.ReactElement {
  const pdf = isPdfDoc(doc)
  const iwork = isIWorkDoc(doc)
  const image = isImageDoc(doc)
  const [mode, setMode] = useState<'view' | 'text'>(pdf ? 'view' : 'text')
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  // Source-image data URL for an image doc (from the on-disk source file).
  const [imageSrc, setImageSrc] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    window.api.rag.document
      .text(doc.id)
      .then((res) => {
        if (!live) return
        if (res?.success) setText(res.data ?? '')
        else setError(res?.error ?? 'Failed to load document')
      })
      .catch((e: unknown) => live && setError(String(e)))
    if (iwork) {
      window.api.rag.document
        .preview(doc.id)
        .then((res) => live && res?.success && setPreview(res.data ?? null))
        .catch(() => {})
    }
    if (image) {
      // Pull the raw source bytes (base64 + mime) and build a data URL so the
      // original image renders above its OCR transcript. Best-effort — on failure
      // we simply show the text alone (today's behavior).
      window.api.rag.document
        .file(doc.id)
        .then((res) => {
          if (!live || !res?.success || !res.data) return
          const { base64, mime } = res.data
          if (base64) setImageSrc(`data:${mime || 'image/png'};base64,${base64}`)
        })
        .catch(() => {})
    }
    return () => {
      live = false
    }
  }, [doc.id, iwork, image])

  const readerText = (
    <>
      {error && <p className="text-[12px] text-[var(--error)]">Error: {error}</p>}
      {!error && text === null && (
        <p className="text-[12px] text-[var(--text-muted)]">Loading…</p>
      )}
      {!error && text !== null && text.trim() === '' && (
        <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
          No extractable text — this may be a scan or a format without a text layer (e.g. modern
          Pages/Keynote). The original file is still stored and indexed by title.
        </p>
      )}
      {!error && text !== null && text.trim() !== '' && (
        <div className="markdown-body doc-md">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ ...externalLinkComponents }}>{text}</ReactMarkdown>
        </div>
      )}
    </>
  )

  return (
    <div className="flex h-full min-h-0 flex-col px-3 pb-3">
      {/* Header: back to the list (like the node-detail ← Back), title, PDF/Text toggle. */}
      <div className="flex shrink-0 items-center gap-2 pb-2">
        <button
          onClick={onBack}
          className="rounded px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        >
          ← Back
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-[var(--text-primary)]" title={doc.sourcePath ?? doc.displayName}>
            {doc.displayName}
          </div>
          <div className="truncate text-[11px] text-[var(--text-muted)]">
            {doc.mime ?? 'document'} · {doc.chunkCount} chunk{doc.chunkCount === 1 ? '' : 's'}
          </div>
        </div>
        {pdf && (
          <div className="flex shrink-0 overflow-hidden rounded border border-[var(--panel-border)] text-[11px]">
            {(['view', 'text'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-2 py-0.5 ${mode === m ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
              >
                {m === 'view' ? 'PDF' : 'Text'}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded border border-[var(--panel-border)] p-3">
        {pdf && mode === 'view' ? (
          <PdfView documentId={doc.id} />
        ) : (
          <>
            {iwork && preview && (
              <img
                src={`data:image/jpeg;base64,${preview}`}
                alt={t('Document preview')}
                className="mb-3 w-full rounded border border-[var(--panel-border)]"
              />
            )}
            {image && imageSrc && (
              <img
                src={imageSrc}
                alt={doc.displayName}
                className="mb-3 w-full rounded border border-[var(--panel-border)]"
              />
            )}
            {readerText}
          </>
        )}
      </div>
    </div>
  )
}
