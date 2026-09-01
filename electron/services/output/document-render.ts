// document-render.ts — a SMALL, dependency-free Markdown → clean printable HTML
// renderer for the `generate_pdf_document` tool. The output is a full standalone
// HTML document with a print-oriented stylesheet (serif body, @page margins,
// page-break-friendly headings), which the artifact-export PDF path
// (exportArtifactPdf → Chromium printToPDF) turns into a .pdf deliverable — no
// office/markdown npm library.
//
// This is deliberately a MINIMAL CommonMark subset (headings, bold/italic/inline-
// code, links, ordered/unordered lists, blockquotes, fenced + indented code,
// horizontal rules, paragraphs). Everything is HTML-escaped first, so the input is
// never a script-injection vector; only whitelisted inline syntax is re-expanded.
// PURE and fully unit-testable: `renderMarkdownToHtml` (body fragment) and
// `renderMarkdownToPrintHtml` (full styled document).

export interface PrintDocOptions {
  /** Document title → <title> and an <h1> header when `heading` isn't false. */
  title?: string
  /** Set false to suppress the auto <h1> title header (body may carry its own). */
  heading?: boolean
}

/** Escape the five HTML-significant characters. Applied to ALL text before any
 *  inline markdown is re-expanded, so raw input can never inject markup. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Only allow safe link targets. Blocks `javascript:` / `data:` / other schemes
 *  that would smuggle script into the printed doc. Returns '' to drop the href. */
function safeUrl(rawUrl: string): string {
  const url = rawUrl.trim()
  if (/^(https?:|mailto:|tel:)/i.test(url)) return url
  if (/^[./#]/.test(url)) return url // relative / anchor
  return ''
}

/**
 * Expand INLINE markdown inside an already-HTML-escaped string. Order matters:
 * code spans first (their contents are literal), then links, then bold, italic.
 * PURE. Input MUST be pre-escaped (see escapeHtml).
 */
export function renderInline(escaped: string): string {
  let out = escaped
  // Inline code `…` — protect contents from further inline expansion by using a
  // placeholder pass.
  const codeSpans: string[] = []
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code>${code}</code>`)
    return `CODE${codeSpans.length - 1}`
  })
  // Links [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
    const href = safeUrl(url)
    return href ? `<a href="${href}">${text}</a>` : text
  })
  // Bold **…** or __…__
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  // Italic *…* or _…_
  out = out.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>')
  out = out.replace(/(^|[^_])_([^_\s][^_]*?)_/g, '$1<em>$2</em>')
  // Restore code spans.
  out = out.replace(/CODE(\d+)/g, (_m, i: string) => codeSpans[Number(i)] ?? '')
  return out
}

/**
 * Render a Markdown string to an HTML BODY fragment (no <html>/<head>). Block-level
 * line scanner: headings, fenced/indented code, blockquotes, ordered + unordered
 * lists, horizontal rules, and paragraphs. PURE.
 */
export function renderMarkdownToHtml(markdown: string): string {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  const html: string[] = []

  type ListKind = 'ul' | 'ol'
  let listStack: ListKind | null = null
  const closeList = (): void => {
    if (listStack) {
      html.push(`</${listStack}>`)
      listStack = null
    }
  }
  const openList = (kind: ListKind): void => {
    if (listStack === kind) return
    closeList()
    html.push(`<${kind}>`)
    listStack = kind
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block ```lang … ```
    const fence = /^\s*```(.*)$/.exec(line)
    if (fence) {
      closeList()
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++ // skip closing fence (or EOF)
      html.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    // Blank line — paragraph/list separator.
    if (line.trim() === '') {
      closeList()
      i++
      continue
    }

    // Horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeList()
      html.push('<hr>')
      i++
      continue
    }

    // Heading  # … ######
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = heading[1].length
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`)
      i++
      continue
    }

    // Blockquote  > …
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      closeList()
      const body: string[] = [quote[1]]
      i++
      while (i < lines.length) {
        const q = /^\s*>\s?(.*)$/.exec(lines[i])
        if (!q) break
        body.push(q[1])
        i++
      }
      html.push(`<blockquote>${renderInline(escapeHtml(body.join(' ').trim()))}</blockquote>`)
      continue
    }

    // Ordered list item  1. …
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ol) {
      openList('ol')
      html.push(`<li>${renderInline(escapeHtml(ol[1].trim()))}</li>`)
      i++
      continue
    }

    // Unordered list item  - / * / +
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (ul) {
      openList('ul')
      html.push(`<li>${renderInline(escapeHtml(ul[1].trim()))}</li>`)
      i++
      continue
    }

    // Paragraph — gather consecutive non-blank, non-block lines.
    closeList()
    const para: string[] = [line.trim()]
    i++
    while (i < lines.length) {
      const n = lines[i]
      if (
        n.trim() === '' ||
        /^\s*```/.test(n) ||
        /^(#{1,6})\s+/.test(n) ||
        /^\s*>\s?/.test(n) ||
        /^\s*\d+[.)]\s+/.test(n) ||
        /^\s*[-*+]\s+/.test(n) ||
        /^\s*([-*_])(\s*\1){2,}\s*$/.test(n)
      ) {
        break
      }
      para.push(n.trim())
      i++
    }
    html.push(`<p>${renderInline(escapeHtml(para.join(' ')))}</p>`)
  }

  closeList()
  return html.join('\n')
}

/** The print stylesheet — a clean, page-ready document look (serif body, sensible
 *  margins, page-break control). Inlined so the exported HTML/PDF is standalone. */
const PRINT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #ffffff; color: #1a1a1a; }
body {
  font-family: Georgia, 'Times New Roman', 'Songti SC', serif;
  font-size: 12pt; line-height: 1.6;
  max-width: 720px; margin: 0 auto; padding: 32px 40px;
}
h1, h2, h3, h4, h5, h6 {
  font-family: 'Helvetica Neue', Arial, 'PingFang SC', sans-serif;
  line-height: 1.25; margin: 1.4em 0 0.5em; color: #111;
  page-break-after: avoid;
}
h1 { font-size: 24pt; border-bottom: 2px solid #e0e0e0; padding-bottom: 0.3em; }
h2 { font-size: 18pt; }
h3 { font-size: 14pt; }
h4, h5, h6 { font-size: 12pt; }
p { margin: 0 0 0.9em; }
ul, ol { margin: 0 0 0.9em; padding-left: 1.6em; }
li { margin: 0.2em 0; }
a { color: #1a5fb4; text-decoration: underline; }
blockquote {
  margin: 0 0 0.9em; padding: 0.4em 1em; border-left: 4px solid #cfd8dc;
  color: #444; background: #f7f9fa; page-break-inside: avoid;
}
code {
  font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 0.9em;
  background: #f2f2f2; padding: 0.1em 0.35em; border-radius: 3px;
}
pre {
  background: #f6f8fa; border: 1px solid #e0e0e0; border-radius: 6px;
  padding: 12px 14px; overflow-x: auto; page-break-inside: avoid;
}
pre code { background: none; padding: 0; }
hr { border: none; border-top: 1px solid #e0e0e0; margin: 1.6em 0; }
@page { margin: 18mm; }
@media print { body { max-width: none; padding: 0; } }
`.trim()

/**
 * Render Markdown into a FULL standalone, print-styled HTML document. This is what
 * `generate_pdf_document` hands to exportArtifactPdf. PURE.
 */
export function renderMarkdownToPrintHtml(markdown: string, opts: PrintDocOptions = {}): string {
  const title = typeof opts.title === 'string' ? opts.title.trim() : ''
  const showHeading = opts.heading !== false && title !== ''
  const bodyHtml = renderMarkdownToHtml(markdown)
  const header = showHeading ? `<h1>${renderInline(escapeHtml(title))}</h1>\n` : ''
  const titleTag = title ? escapeHtml(title) : 'Document'
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleTag}</title>
<style>
${PRINT_CSS}
</style>
</head>
<body>
${header}${bodyHtml}
</body>
</html>`
}
