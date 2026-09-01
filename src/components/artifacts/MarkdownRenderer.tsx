import { Fragment, memo, type ReactNode } from 'react'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { CodeBlock } from './CodeBlock'
import { splitMarkdownBlocks, collectRefDefinitions } from './markdown-blocks.mjs'
import { autolinkText } from '@/lib/path-autolink'
import { useSettingsStore } from '@/stores/settings-store'
import { useBrainStore, type BrainGraphNode } from '@/stores/brain-store'
import { useUiStore } from '@/stores/ui-store'
import '@/styles/markdown.css'

interface MarkdownRendererProps {
  content: string
  sourceMessageId?: string
  /** Forwarded to CodeBlock so code fences skip Shiki while the message streams. */
  streaming?: boolean
}

// Fluidity J10: turn bare `path/file.ext[:line]` references in prose into
// clickable spans that fire `file:open` (the host handles routing it back
// through requestOpenFile so the file panel opens to the right line).
// Walks the children of prose-level components (p / li / td / strong / em
// / blockquote) and replaces string segments with autolinked variants.
// Text inside `<code>` / `<pre>` is not touched — those components are
// rendered by the CodeBlock / inline-code overrides without going through
// this transformer.
function transformChildren(children: ReactNode): ReactNode {
  if (children === null || children === undefined || children === false) return children
  if (typeof children === 'number' || typeof children === 'boolean') return children
  if (typeof children === 'string') {
    const segs = autolinkText(children)
    if (segs.length === 0) return children
    if (segs.length === 1 && segs[0].kind === 'text') return segs[0].value
    return (
      <>
        {segs.map((s, i) =>
          s.kind === 'text' ? (
            <Fragment key={i}>{s.value}</Fragment>
          ) : (
            <FileRefSpan key={i} path={s.path} line={s.line}>
              {s.raw}
            </FileRefSpan>
          )
        )}
      </>
    )
  }
  if (Array.isArray(children)) {
    return children.map((c, i) => (
      <Fragment key={i}>{transformChildren(c)}</Fragment>
    ))
  }
  // React element / fragment — leave the element alone; its own children
  // get walked when that component renders (we override the same set).
  return children
}

// A created doc "becomes a node anyway" — resolve a referenced file's slug
// (filename stem) to its brain-graph node so a click can open it in the right
// sidebar exactly like clicking a node. Node ids are frontmatter/filename slugs
// (e.g. C260513-…), never full paths, so we match on a normalized stem.
function resolveNodeForPath(path: string): BrainGraphNode | null {
  const base = (path.split(/[\\/]/).pop() || path).trim()
  const stem = base.replace(/\.[^.]+$/, '')
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const target = norm(stem)
  if (target.length < 4) return null // too short to match confidently
  const nodes = useBrainStore.getState().data?.nodes ?? []
  return (
    nodes.find((n) => norm(n.id) === target) ??
    nodes.find((n) => {
      const ni = norm(n.id)
      return ni.length > 3 && (ni.endsWith(target) || target.endsWith(ni))
    }) ??
    nodes.find((n) => norm(n.label) === target) ??
    null
  )
}

function openFileRef(path: string, line?: number): void {
  const w = window as unknown as {
    __openArtifact?: (type: string, source: string) => void
    api?: { files?: { openInVSCode?: (a: { targetPath?: string }) => Promise<unknown> } }
  }
  // Preferred path: open the doc as a NODE in the right sidebar (what the user
  // wants — a created doc opens like any node). Only when it doesn't resolve to
  // a graph node do we fall through to the generic in-app file open below.
  const node = resolveNodeForPath(path)
  if (node) {
    const ui = useUiStore.getState()
    // Switch the right panel to the Explorer surface (activeTool 'brain' →
    // BrainExplorerPanel) BEFORE setDetail — otherwise the panel stays on the
    // "Today" home and setDetail has no visible effect (it pinpointed the graph
    // but never opened the note). BrainExplorerPanel then fetches + shows the .md.
    ui.setActiveTool('brain')
    ui.setRightPanelCollapsed(false)
    const bs = useBrainStore.getState()
    bs.focusNode(node.id)
    bs.setDetail(node)
    return
  }
  // Prefer the in-app file panel via the same dispatcher the rest of the
  // app uses — this is the generic open path and always fires.
  const event = new CustomEvent('file:open', { detail: { path, line } })
  window.dispatchEvent(event)
  // VS Code is a developer affordance: only fall through to the VS Code IPC
  // when Coding Mode is on. Otherwise the in-app file panel above is the
  // sole open path (knowledge-worker default — no VS Code branding).
  const codingMode = useSettingsStore.getState().settings.agenticCodingMode
  if (codingMode && !w.__openArtifact && w.api?.files?.openInVSCode) {
    void w.api.files.openInVSCode({ targetPath: path })
  }
}

function FileRefSpan({
  path,
  line,
  children
}: {
  path: string
  line?: number
  children: ReactNode
}) {
  return (
    <span
      role="link"
      tabIndex={0}
      data-file-ref={path}
      data-file-line={line}
      onClick={(e) => {
        e.stopPropagation()
        openFileRef(path, line)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openFileRef(path, line)
        }
      }}
      title={line ? `Open ${path} at line ${line}` : `Open ${path}`}
      className="cursor-pointer underline decoration-[var(--text-muted)] decoration-dotted underline-offset-2 transition-colors hover:decoration-[var(--accent)] hover:text-[var(--accent)]"
    >
      {children}
    </span>
  )
}

// The brain sometimes emits Obsidian-style [[wikilinks]] (a vault convention);
// in chat prose they render as broken literals. Reduce to the readable label so
// the reference reads cleanly: [[target|alias]] -> alias, [[target]] -> target.
export function stripWikilinks(md: string): string {
  return md.replace(/\[\[([^\]\n]+?)\]\]/g, (_m, inner: string) => {
    const parts = inner.split('|')
    return (parts[parts.length - 1] || inner).trim()
  })
}

// The component overrides, as a factory closing over the message id + streaming flag. Extracted so BOTH
// the memoized closed-block renderers and the live open-block renderer share identical prose handling
// (autolink, CodeBlock, file-refs, tables). Recreating this object per render is cheap — the cost the
// incremental split removes is the <ReactMarkdown> PARSE + React reconcile of the whole growing doc.
function makeComponents(sourceMessageId: string | undefined, streaming: boolean | undefined): Components {
  return {
          pre({ children }) {
            return <>{children}</>
          },

          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '')
            const codeStr = String(children).replace(/\n$/, '')

            if (match) {
              return <CodeBlock code={codeStr} language={match[1]} sourceMessageId={sourceMessageId} streaming={streaming} />
            }

            // A fence with NO language still has to render as a BLOCK. `pre` above
            // returns a fragment (CodeBlock draws its own container), so without this
            // an unlabelled fence fell through to the inline-<code> branch below: no
            // <pre> ancestor means `white-space` is not preserved, so every newline
            // collapsed and the whole thing rendered as ONE line inside an inline
            // background pill. That is the common shape for terminal-style output —
            // box-drawing diagrams, tree listings, aligned tables are exactly what
            // people fence WITHOUT a language tag — so the worst-rendered content was
            // the content that most depends on being rendered verbatim.
            //
            // Rendered directly rather than via CodeBlock: no highlighting is wanted
            // (there is no language), and this avoids depending on how Shiki handles
            // an unknown grammar. `whitespace-pre` (not pre-wrap) so a wide diagram
            // scrolls instead of wrapping — a wrapped box-drawing line is unreadable.
            if (codeStr.includes('\n')) {
              return (
                <pre className="code-font my-2 overflow-x-auto rounded-md bg-[var(--bg-tertiary)] p-3 text-[12px] leading-snug whitespace-pre text-[var(--text-primary)]">
                  <code>{codeStr}</code>
                </pre>
              )
            }

            // Inline code that IS a single file/doc path (the common way the
            // model cites a created doc, e.g. `DUIN/Dev/…handoff.md`) — the
            // prose autolinker doesn't reach inside <code>, so wire it here so
            // the reference is clickable and opens as a node in the sidebar.
            const seg = autolinkText(codeStr)
            if (seg.length === 1 && seg[0].kind === 'link') {
              return (
                <FileRefSpan path={seg[0].path} line={seg[0].line}>
                  <code className={className} {...props}>
                    {children}
                  </code>
                </FileRefSpan>
              )
            }

            return (
              <code className={className} {...props}>
                {children}
              </code>
            )
          },

          a({ href, children }) {
            const handleClick = (e: React.MouseEvent) => {
              e.preventDefault()
              if (!href) return
              // D11 — `artifact://research/<filename>` links route the
              // markdown report into the right-panel via the standard
              // artifact channel. Falls back to opening the URL externally
              // if the research API is missing.
              if (href.startsWith('artifact://research/')) {
                const filename = href.replace(/^artifact:\/\/research\//, '')
                const w = window as unknown as {
                  api?: { research?: { read?: (f: string) => Promise<{ success: boolean; data?: { content: string } }> } }
                  __openArtifact?: (type: string, source: string) => void
                }
                if (w.api?.research?.read && w.__openArtifact) {
                  void w.api.research
                    .read(filename)
                    .then((r) => {
                      if (r.success && r.data) {
                        w.__openArtifact?.('markdown', r.data.content)
                      }
                    })
                    .catch((err) => console.warn('[MarkdownRenderer] research:read failed', err))
                  return
                }
              }
              if (window.api?.artifact?.openExternal) {
                window.api.artifact.openExternal(href)
              } else {
                window.open(href, '_blank')
              }
            }
            return (
              <a href={href} onClick={handleClick}>
                {children}
              </a>
            )
          },

          table({ children }) {
            return (
              <div className="markdown-table-wrapper">
                <table>{children}</table>
              </div>
            )
          },

          blockquote({ children }) {
            return <blockquote>{transformChildren(children)}</blockquote>
          },

          // Fluidity J10: prose-level wrappers run their children through
          // the autolink transformer. `code` (inline) and `pre` paths
          // bypass this — they render via the overrides above.
          p({ children }) {
            return <p>{transformChildren(children)}</p>
          },
          li({ children }) {
            return <li>{transformChildren(children)}</li>
          },
          td({ children }) {
            return <td>{transformChildren(children)}</td>
          },
          th({ children }) {
            return <th>{transformChildren(children)}</th>
          },
          strong({ children }) {
            return <strong>{transformChildren(children)}</strong>
          },
          em({ children }) {
            return <em>{transformChildren(children)}</em>
          }
  }
}

// One markdown BLOCK, memoized on its own content — a closed (stable) block skips re-render entirely
// while later tokens stream into the open block.
const BlockRenderer = memo(function BlockRenderer({ content, sourceMessageId, streaming }: MarkdownRendererProps) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={makeComponents(sourceMessageId, streaming)}>
      {content}
    </ReactMarkdown>
  )
})

// Incremental block-lex render (efficiency gain 1, borrowed from an open-source chat renderer's "Quicksilver" block lexer): split the streamed
// message into top-level blocks; render each as its OWN memoized <ReactMarkdown>. Closed blocks have
// stable content → memo skips them (parsed once); only the OPEN (last) block re-parses as tokens arrive.
// This turns the old whole-doc re-parse-per-token O(n²) into O(n) — verified by the render.markdown-scaling
// ratio probe. Bonus: a closed code fence gets Shiki-highlighted the moment it closes (streaming flag is
// only passed to the last block), instead of the whole message deferring highlight until fully done.
function MarkdownRendererImpl({ content, sourceMessageId, streaming }: MarkdownRendererProps) {
  const cleaned = stripWikilinks(content)
  const blocks = splitMarkdownBlocks(cleaned)
  if (blocks.length === 0) return <div className="markdown-body" />
  // Document-level definitions (reference links / footnotes) can live in a different block from their use;
  // appending them to each isolated block restores cross-block resolution (they render to nothing where
  // unreferenced). '' for the common case → block content unchanged → the memo/O(n) win is preserved.
  const defs = collectRefDefinitions(cleaned)
  return (
    <div className="markdown-body">
      {blocks.map((block, i) => (
        <BlockRenderer
          key={i}
          content={defs ? `${block}\n\n${defs}` : block}
          sourceMessageId={sourceMessageId}
          streaming={streaming && i === blocks.length - 1}
        />
      ))}
    </div>
  )
}

// Memoized: props are primitives (content, sourceMessageId), so a bubble that
// didn't change skips the full ReactMarkdown parse on unrelated re-renders.
export const MarkdownRenderer = memo(MarkdownRendererImpl)
