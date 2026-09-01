import { t } from '@/lib/i18n'
import { useEffect, useRef, useState } from 'react'
import type { BundledLanguage, Highlighter } from 'shiki'
import ReactMarkdown from 'react-markdown'
import { externalLinkComponents } from '@/lib/markdown-external-link'
import remarkGfm from 'remark-gfm'
import '@/styles/markdown.css'

const ARTIFACT_LANGUAGES = new Set(['html', 'svg', 'mermaid', 'jsx', 'tsx', 'react', 'canvas'])

/** A JSON Canvas document, sniffed for the case where the model fenced it as
 *  ```json rather than ```canvas. Requires BOTH keys to be canvas-shaped so an
 *  ordinary JSON blob that happens to have a `nodes` array isn't hijacked. */
function looksLikeCanvas(code: string): boolean {
  const t = code.trimStart()
  if (!t.startsWith('{')) return false
  try {
    const o = JSON.parse(t) as Record<string, unknown>
    const nodes = o.nodes
    const edges = o.edges
    if (!Array.isArray(nodes) || (edges !== undefined && !Array.isArray(edges))) return false
    // At least one node carrying the required spec fields.
    return nodes.some(
      (n) =>
        !!n &&
        typeof n === 'object' &&
        typeof (n as Record<string, unknown>).id === 'string' &&
        typeof (n as Record<string, unknown>).type === 'string'
    )
  } catch {
    return false
  }
}

function detectArtifactType(code: string, lang: string): string | null {
  if (ARTIFACT_LANGUAGES.has(lang)) {
    return lang === 'react' || lang === 'jsx' || lang === 'tsx' ? 'jsx' : lang
  }
  if (lang === 'json' && looksLikeCanvas(code)) return 'canvas'
  const trimmed = code.trimStart()
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    return 'html'
  }
  if (!lang || lang === 'javascript' || lang === 'typescript') {
    if (/\breturn\s*\(?\s*<[A-Z]/.test(code) || /<[A-Z][a-zA-Z]*[\s/>]/.test(code)) {
      return 'jsx'
    }
  }
  return null
}

let shikiPromise: Promise<Highlighter> | null = null

// Preload only the common grammars; everything else is loaded on demand (see
// ensureLang). Loading all ~33 up front pulled several MB of lang chunks (cpp
// alone is 626 KB) on the first code block, regardless of the code's language.
const DEFAULT_LANGS = [
  'javascript', 'typescript', 'tsx', 'jsx', 'json', 'bash', 'shell',
  'python', 'html', 'css', 'markdown', 'yaml', 'sql', 'diff'
]

function getShiki(): Promise<Highlighter> {
  if (!shikiPromise) {
    shikiPromise = import('shiki').then((mod) =>
      mod.createHighlighter({
        // Dual theme: light tokens (github-light) for the light app surface, dark
        // tokens (one-dark-pro) for the dark one. Emitted as CSS vars and picked by
        // data-theme-mode in index.css, so a theme toggle recolors code with no re-highlight.
        themes: ['github-light', 'one-dark-pro'],
        langs: DEFAULT_LANGS
      })
    ) as Promise<Highlighter>
  }
  return shikiPromise
}

// Lazy-load a single grammar if it isn't already loaded; returns the usable lang
// id, or 'text' when the language isn't a known bundled grammar.
async function ensureLang(highlighter: Highlighter, lang: string): Promise<string> {
  if (!lang || lang === 'text') return 'text'
  if (highlighter.getLoadedLanguages().includes(lang as BundledLanguage)) return lang
  try {
    await highlighter.loadLanguage(lang as BundledLanguage)
    return lang
  } catch {
    return 'text'
  }
}

interface CodeBlockProps {
  code: string
  language?: string
  sourceMessageId?: string
  /** True while the message is still streaming: `code` grows every frame, so
   *  skip Shiki (re-tokenizing a growing block 60×/s saturates the main thread)
   *  and show the plain-<pre> fallback. Highlighting runs once on finalize. */
  streaming?: boolean
}

// A fenced ```markdown / ```md block is a document, not code — rendered formatted.
export function isMarkdownLang(language?: string): boolean {
  const l = (language ?? '').toLowerCase()
  return l === 'markdown' || l === 'md'
}

export function CodeBlock({ code, language, streaming }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // A fenced ```markdown block is a DOCUMENT, not code — render it formatted by
  // default (same .markdown-body view as the node explorer), with a Source toggle.
  const [showSource, setShowSource] = useState(false)
  const codeRef = useRef<HTMLDivElement>(null)

  const lang = language?.toLowerCase() ?? ''
  const detectedType = detectArtifactType(code, lang)
  const isArtifact = detectedType !== null
  const isMarkdownDoc = isMarkdownLang(lang)

  useEffect(() => {
    // Don't tokenize a still-growing streaming block every frame — the plain
    // <pre> fallback renders it live; the final (non-streaming) render highlights.
    if (isArtifact || streaming) return

    let cancelled = false
    getShiki()
      .then(async (highlighter) => {
        if (cancelled) return
        const langId = await ensureLang(highlighter, lang) // lazy-loads the grammar if needed
        if (cancelled) return
        const result = highlighter.codeToHtml(code, {
          lang: langId as BundledLanguage,
          themes: { light: 'github-light', dark: 'one-dark-pro' },
          defaultColor: false
        })
        setHtml(result)
      })
      .catch(() => {
        if (!cancelled) setHtml(null)
      })
    return () => {
      cancelled = true
    }
  }, [code, lang, isArtifact, streaming])

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleOpenArtifact = () => {
    if (!detectedType) return
    window.api?.artifact?.render(detectedType, code)
    const opener = (window as unknown as Record<string, unknown>).__openArtifact
    if (typeof opener === 'function') {
      ;(opener as (t: string, s: string) => void)(detectedType, code)
    }
  }

  const actions = (
    <div className="flex items-center gap-2">
      {isMarkdownDoc && (
        <button
          onClick={() => setShowSource((v) => !v)}
          className="text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
        >
          {showSource ? 'Rendered' : 'Source'}
        </button>
      )}
      <button
        onClick={handleCopy}
        className="text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )

  if (isArtifact) {
    const previewLines = code.split('\n').slice(0, 4).join('\n')
    return (
      <div className="my-2 overflow-hidden rounded-lg border border-[var(--panel-border)] bg-[var(--bg-primary)]">
        <div className="flex items-center justify-between border-b border-[var(--panel-border)] bg-[var(--bg-tertiary)] px-3 py-1.5">
          <span className="font-mono text-[12px] text-[var(--accent)]">{detectedType}</span>
          {actions}
        </div>
        <pre className="overflow-hidden px-3 py-2 code-font text-[12px] text-[var(--text-muted)]">
          <code>{previewLines}</code>
        </pre>
        <button
          onClick={handleOpenArtifact}
          className="w-full border-t border-[var(--panel-border)] bg-[var(--bg-secondary)] px-3 py-2 text-[12px] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--bg-tertiary)]"
        >
          {t('Open artifact')}
        </button>
      </div>
    )
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-[var(--panel-border)] bg-[var(--bg-primary)]">
      <div className="flex items-center justify-between border-b border-[var(--panel-border)] bg-[var(--bg-tertiary)] px-3 py-1.5">
        <span className="font-mono text-[12px] text-[var(--text-muted)]">{isMarkdownDoc ? 'document' : lang || 'text'}</span>
        {actions}
      </div>
      {isMarkdownDoc && !showSource ? (
        <div className="markdown-body px-4 py-3">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ ...externalLinkComponents }}>{code}</ReactMarkdown>
        </div>
      ) : html ? (
        <div
          ref={codeRef}
          // Shiki emits its own <pre><code>, so the font is forced here. It used to name
          // IBM Plex Mono / Fira Code directly — NEITHER is installed or bundled, so this
          // fell through to the generic `monospace` with no box-drawing and no fixed-width
          // CJK fallback. Route it through --font-code like every other code surface.
          className="overflow-x-auto text-[12px] [&_code]:![font-family:var(--font-code)] [&_code]:![font-variant-ligatures:none] [&_pre]:!m-0 [&_pre]:p-3"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto p-3 code-font text-[12px] text-[var(--text-secondary)]">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}
