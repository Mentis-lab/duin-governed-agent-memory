import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import PdfWorker from './pdf-worker?worker' // wraps the pdfjs worker so the Uint8Array polyfill loads first

// P3b+ — PDF fidelity view (PDF.js). Renders the ORIGINAL pdf (fetched as bytes
// from the main process) to canvases, so the Library viewer shows the real
// document, not just extracted text. Capped page count keeps big PDFs snappy.

// Worker init: in the packaged app the renderer runs from file://, where the old
// `workerSrc = <file:// url to .mjs>` fails to load (a module worker can't be
// fetched cross the file:// origin as a classic script) — which silently broke
// the PDF view. Vite's `?worker` import bundles the worker and gives a
// constructor that instantiates correctly under file://; bind it via workerPort.
pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker()

const MAX_PAGES = 30

export function PdfView({ documentId }: { documentId: string }): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<string>('Loading PDF…')
  const [error, setError] = useState<string | null>(null)
  const [truncatedFrom, setTruncatedFrom] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await window.api.rag.document.file(documentId)
        if (!res?.success || !res.data?.base64) {
          throw new Error(res?.error ?? 'original file unavailable')
        }
        const bin = atob(res.data.base64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const pdf = await pdfjs.getDocument({ data: bytes }).promise
        if (cancelled) return
        const host = hostRef.current
        if (!host) return
        host.innerHTML = ''
        const pages = Math.min(pdf.numPages, MAX_PAGES)
        if (pdf.numPages > MAX_PAGES) setTruncatedFrom(MAX_PAGES)
        for (let p = 1; p <= pages; p++) {
          if (cancelled) break
          setStatus(`Rendering ${p}/${pages}…`)
          const page = await pdf.getPage(p)
          const viewport = page.getViewport({ scale: 1.4 })
          const canvas = document.createElement('canvas')
          const ctx = canvas.getContext('2d')
          if (!ctx) continue
          canvas.width = viewport.width
          canvas.height = viewport.height
          canvas.style.width = '100%'
          canvas.style.maxWidth = `${viewport.width}px`
          canvas.style.display = 'block'
          canvas.style.margin = '0 auto 12px'
          canvas.className = 'rounded border border-[var(--panel-border)] shadow-sm'
          host.appendChild(canvas)
          await page.render({ canvas, canvasContext: ctx, viewport }).promise
        }
        if (!cancelled) setStatus('')
      } catch (e) {
        if (!cancelled) setError((e as Error)?.message ?? String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [documentId])

  return (
    <div>
      {error && <p className="text-[12px] text-[var(--error)]">PDF view failed: {error} (the reader-text view still works).</p>}
      {!error && status && <p className="text-[12px] text-[var(--text-muted)]">{status}</p>}
      <div ref={hostRef} />
      {truncatedFrom !== null && (
        <p className="text-[11px] text-[var(--text-muted)]">
          Showing first {truncatedFrom} pages. Full text is in the reader view.
        </p>
      )}
    </div>
  )
}
