// pdfjs worker entry, wrapped so the Uint8Array base64/hex polyfill runs in the WORKER's global
// scope BEFORE pdfjs code executes. The polyfill import is listed first, so (per ES module
// evaluation order) it runs before pdfjs-dist registers its worker handler — which is what calls
// `.toHex()` and crashed under Chromium 134. Bundled via `?worker` from PdfView.tsx.
import '../../polyfills/uint8array-encoding'
import 'pdfjs-dist/build/pdf.worker.min.mjs'
