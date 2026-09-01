import { t } from '@/lib/i18n'
import { useEffect, useMemo, useState } from 'react'
import { MarkdownRenderer } from '@/components/artifacts/MarkdownRenderer'

// Browsing what a skill actually SHIPS, not just its definition. The Agent Skills
// convention puts executable code in `scripts/`, long-form docs in `references/` and
// templates/images in `assets/`, all loaded on demand — so a skill's behaviour often
// lives in files the definition only names. This is the surface that makes them
// visible: pick a file, read it rendered or raw.

export interface SkillFileEntry {
  path: string
  size: number
  kind: 'text' | 'image' | 'binary'
}

interface SkillFileContent {
  path: string
  size: number
  kind: SkillFileEntry['kind']
  text?: string
  dataUri?: string
  tooLarge?: boolean
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path) || path === 'SKILL.md'
}

/** The conventional directories carry meaning the agent acts on, so label them
 *  rather than leaving the user to infer it from a path prefix. */
function groupOf(path: string): string {
  const top = path.includes('/') ? path.slice(0, path.indexOf('/')) : ''
  if (top === 'scripts') return 'Scripts · run by the agent'
  if (top === 'references') return 'References · read on demand'
  if (top === 'assets') return 'Assets · templates and images'
  if (!top) return 'Skill'
  return top
}

interface SkillFileBrowserProps {
  skillId: string
  /** Rendered instead of the fetched content when `SKILL.md` is selected, so the
   *  definition stays editable in place rather than becoming read-only here. */
  definitionSlot?: React.ReactNode
}

export function SkillFileBrowser({ skillId, definitionSlot }: SkillFileBrowserProps) {
  const [files, setFiles] = useState<SkillFileEntry[] | null>(null)
  const [selected, setSelected] = useState('SKILL.md')
  const [content, setContent] = useState<SkillFileContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [raw, setRaw] = useState(false)

  useEffect(() => {
    let live = true
    void (async () => {
      const r = await window.api?.skills?.listFiles?.(skillId)
      if (!live) return
      if (!r?.success) {
        setError(r?.error ?? 'Could not read this skill&rsquo;s files')
        setFiles([])
        return
      }
      setFiles((r.data as SkillFileEntry[]) ?? [])
    })()
    return () => {
      live = false
    }
  }, [skillId])

  // The definition is supplied by the parent (it owns the editable draft), so only
  // fetch when the user picks one of the bundled files.
  useEffect(() => {
    if (selected === 'SKILL.md' && definitionSlot) {
      setContent(null)
      return
    }
    let live = true
    setContent(null)
    void (async () => {
      const r = await window.api?.skills?.readFile?.(skillId, selected)
      if (!live) return
      if (!r?.success) {
        setError(r?.error ?? `Could not read ${selected}`)
        return
      }
      setError(null)
      setContent(r.data as SkillFileContent)
    })()
    return () => {
      live = false
    }
  }, [skillId, selected, definitionSlot])

  const grouped = useMemo(() => {
    const out = new Map<string, SkillFileEntry[]>()
    for (const f of files ?? []) {
      const g = groupOf(f.path)
      const list = out.get(g)
      if (list) list.push(f)
      else out.set(g, [f])
    }
    return [...out.entries()]
  }, [files])

  if (files === null) {
    return (
      <div className="px-3 py-4 text-center text-[12px] text-[var(--text-muted)]">
        Reading skill files…
      </div>
    )
  }

  const count = files.length
  const showDefinition = selected === 'SKILL.md' && !!definitionSlot

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          aria-label={t('Choose a file in this skill')}
          className="min-w-0 flex-1 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        >
          {grouped.map(([group, entries]) => (
            <optgroup key={group} label={group}>
              {entries.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">
          {count} file{count === 1 ? '' : 's'}
        </span>
        {isMarkdown(selected) && !showDefinition && (
          <div className="flex shrink-0 items-center gap-0.5 rounded border border-[var(--panel-border)] p-0.5">
            <button
              onClick={() => setRaw(false)}
              aria-pressed={!raw}
              title={t('Rendered')}
              className={`rounded px-1.5 py-0.5 text-[11px] ${!raw ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
            <button
              onClick={() => setRaw(true)}
              aria-pressed={raw}
              title={t('Source')}
              className={`rounded px-1.5 py-0.5 text-[11px] ${raw ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {error && !showDefinition && (
        <div className="rounded border border-[var(--error)] bg-[var(--error)]/10 px-2 py-1.5 text-[11px] text-[var(--error)]">
          {error}
        </div>
      )}

      {showDefinition ? (
        definitionSlot
      ) : content ? (
        <SkillFileView content={content} raw={raw} />
      ) : (
        !error && (
          <div className="px-3 py-4 text-center text-[12px] text-[var(--text-muted)]">Reading…</div>
        )
      )}
    </div>
  )
}

function SkillFileView({ content, raw }: { content: SkillFileContent; raw: boolean }) {
  if (content.tooLarge) {
    return (
      <div className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-3 py-6 text-center text-[12px] text-[var(--text-muted)]">
        {content.kind === 'binary' ? 'Binary file' : `${formatSize(content.size)} — too large to preview`}
        <div className="mt-1 text-[11px]">
          The agent can still read it; this viewer only shows text and images.
        </div>
      </div>
    )
  }
  if (content.dataUri) {
    return (
      <div className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-2">
        <img
          src={content.dataUri}
          alt={content.path}
          className="mx-auto max-h-72 max-w-full object-contain"
        />
        <div className="mt-1 text-center text-[11px] text-[var(--text-muted)]">
          {formatSize(content.size)}
        </div>
      </div>
    )
  }
  if (typeof content.text !== 'string') return null
  if (!raw && isMarkdown(content.path)) {
    return (
      <div className="max-h-72 overflow-y-auto rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
        <MarkdownRenderer content={content.text} />
      </div>
    )
  }
  return (
    <pre className="max-h-72 overflow-auto rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-2 font-mono text-[11px] leading-relaxed text-[var(--text-primary)]">
      {content.text}
    </pre>
  )
}
