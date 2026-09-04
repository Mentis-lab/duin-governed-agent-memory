import { t } from '@/lib/i18n'
import { useCallback, useEffect, useState } from 'react'
import { useChatStore } from '@/stores/chat-store'
import { ActivityFeed } from '@/components/artifacts/ActivityFeed'
import { MarkdownRenderer } from '@/components/artifacts/MarkdownRenderer'
import { PanelEmptyState } from '@/components/ui/PanelEmptyState'

// The Artifacts surface: HTML and Markdown files the assistant created, read
// from disk (userData/artifacts/**) via window.api.artifacts. HTML opens in the
// transient artifact overlay; Markdown renders inline here. The live Activity
// feed still shows while a tool is running.

interface ArtifactFile {
  path: string
  name: string
  ext: 'html' | 'md'
  sizeBytes: number
  mtime: number
  relDir: string
}

function openHtmlArtifact(source: string): void {
  const opener = (window as unknown as { __openArtifact?: (t: string, s: string) => void }).__openArtifact
  opener?.('html', source)
}

// `pitch-a1b2c3d4.html` → `pitch`. Strip the extension and the 8-hex content
// hash the store appends, then de-slug.
function prettyName(name: string): string {
  const noExt = name.replace(/\.(html?|md|markdown)$/i, '')
  const noHash = noExt.replace(/-[0-9a-f]{8}$/i, '')
  // Research artifacts carry a trailing epoch-ms uniquifier ("…what is this about
  // 1782285720573") — machine bookkeeping, not a title. Strip it for display only;
  // the stored filename keeps its uniqueness.
  const noEpoch = noHash.replace(/[-_ ]1[0-9]{12}$/, '')
  const words = noEpoch.replace(/[-_]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name
}

function formatTime(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ms).toLocaleDateString()
}

const DocIcon = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
    <path d="M9 13h6M9 17h4" />
  </svg>
)

export function ArtifactsPanel(): React.ReactElement {
  const isStreaming = useChatStore((s) => s.isStreaming)
  const toolCalls = useChatStore((s) => s.toolCalls)
  const hasActivity = isStreaming || toolCalls.length > 0

  const [files, setFiles] = useState<ArtifactFile[] | null>(null)
  const [viewing, setViewing] = useState<{ name: string; content: string } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await window.api?.artifacts?.listFiles?.()
      setFiles(r?.success ? ((r.data as ArtifactFile[]) ?? []) : [])
    } catch {
      setFiles([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openFile = useCallback(async (f: ArtifactFile): Promise<void> => {
    try {
      const r = await window.api?.artifacts?.readFile?.(f.path)
      if (!r?.success || !r.data) return
      const content = (r.data as { content: string }).content
      if (f.ext === 'html') openHtmlArtifact(content)
      else setViewing({ name: prettyName(f.name), content })
    } catch {
      /* best-effort */
    }
  }, [])

  // Inline Markdown viewer.
  if (viewing) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-[var(--panel-border)] px-3 py-2 text-[12px] font-medium text-[var(--text-secondary)]">
          <button
            onClick={() => setViewing(null)}
            className="flex items-center gap-1 hover:text-[var(--text-primary)]"
            title={t('Back to artifacts')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="15 18 9 12 15 6" />
            </svg>
            {t('Artifacts')}
          </button>
          <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{viewing.name}</span>
        </div>
        {/* `doc-md` — a saved artifact is a document being read, so it takes the
            Document text size like the note and Library readers. */}
        <div className="doc-md min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <MarkdownRenderer content={viewing.content} />
        </div>
      </div>
    )
  }

  const list = files ?? []

  if (list.length === 0 && !hasActivity) {
    return (
      <PanelEmptyState
        icon={<span className="text-[var(--text-secondary)]">{DocIcon}</span>}
        title={t('No artifacts yet')}
        body="HTML and Markdown files the assistant creates will appear here."
      />
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {list.length > 0 && (
        <div className="flex flex-col overflow-y-auto">
          <div className="flex items-center gap-2 border-b border-[var(--panel-border)] px-3 py-2 text-[12px] font-medium text-[var(--text-secondary)]">
            <span className="flex h-5 w-5 items-center justify-center text-[var(--text-secondary)]">{DocIcon}</span>
            Artifacts
            <span className="text-[var(--text-tertiary)]">{list.length}</span>
            <button
              onClick={() => void load()}
              className="ml-auto text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              refresh
            </button>
          </div>
          {list.map((f) => (
            <button
              key={f.path}
              onClick={() => void openFile(f)}
              title={`Open ${f.name}`}
              className="flex items-center gap-3 border-b border-[var(--panel-border)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
            >
              <span className="shrink-0 rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-[11px] uppercase text-[var(--text-secondary)]">
                {f.ext}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[12px] text-[var(--text-primary)]">{prettyName(f.name)}</span>
                <span className="truncate text-[11px] text-[var(--text-tertiary)]">
                  {f.relDir ? `${f.relDir} · ` : ''}
                  {formatTime(f.mtime)}
                </span>
              </span>
              <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">Open ›</span>
            </button>
          ))}
        </div>
      )}

      {hasActivity && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex items-center gap-2 border-b border-[var(--panel-border)] px-3 py-2 text-[12px] font-medium text-[var(--text-secondary)]">
            <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]" aria-hidden />
            {t('Activity')}
          </div>
          <ActivityFeed />
        </div>
      )}
    </div>
  )
}
