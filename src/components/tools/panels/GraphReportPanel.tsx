import { t } from '@/lib/i18n'
import { useCallback, useEffect, useState } from 'react'
import { useBrainStore } from '@/stores/brain-store'
import { useSettingsStore } from '@/stores/settings-store'
import { fetchDoc, saveDoc } from '@/duin/lib/state'
import { toast } from '@/stores/toast-store'
import { chipColors, forLight } from '@/duin/lib/light-color'

// Graph Report — the structural-analytics surface for the brain graph, rendered
// native (lamprey panel) and fed by the brain over IPC
// (window.api.brain.graphReport). CSP is connect-src 'none', so we read through
// IPC, not a direct fetch. Cold-data-safe: it analyses the existing wikilink/
// frontmatter graph with no model, embeddings, or warm metabolism.

// Mirrors electron/services/brain/graph-insight.ts GraphInsight (the electron
// tsconfig can't import across the src/ boundary — same precedent as graph-source).
interface Community {
  id: number
  size: number
  label: string
  track: string
  color: string
  topNodes: { id: string; label: string; degree: number }[]
}
interface Bridge {
  sourceLabel: string
  targetLabel: string
  commALabel: string
  commBLabel: string
  type: string
  provenance: 'declared' | 'inferred' | 'ambiguous'
  count: number
  surprise: number
}
interface LinkSuggestion {
  source: string
  target: string
  sourceLabel: string
  targetLabel: string
  wikilink: string
  kind: 'island' | 'silo-bridge'
  reason: string
  confidence: number
}
interface GraphInsight {
  generated: string
  stats: { nodes: number; edges: number; communities: number; isolated: number }
  edgeProvenance: { declared: number; inferred: number; ambiguous: number }
  communities: Community[]
  highDegree: { id: string; label: string; degree: number; track?: string }[]
  bridges: Bridge[]
  suggestedQuestions: string[]
  linkSuggestions: LinkSuggestion[]
}
interface HistoryRow {
  date: string
  nodes: number
  edges: number
  communities: number
  isolated: number
}

/** Tiny inline sparkline (no deps) over a numeric series. */
function Sparkline({ values, color }: { values: number[]; color: string }): React.ReactElement | null {
  if (values.length < 2) return null
  const w = 120
  const h = 24
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / span) * (h - 2) - 1}`)
    .join(' ')
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}

const PROV_COLOR: Record<Bridge['provenance'], string> = {
  declared: '#2dd4bf',
  inferred: '#a78bfa',
  ambiguous: '#fb923c'
}

export function GraphReportPanel(): React.ReactElement {
  const [insight, setInsight] = useState<GraphInsight | null>(null)
  const [markdown, setMarkdown] = useState<string>('')
  const [history, setHistory] = useState<HistoryRow[]>([])
  const isLight = useSettingsStore((s) => s.settings.themeMode) === 'light'
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [applied, setApplied] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState<string | null>(null)

  const focusNode = useBrainStore((s) => s.focusNode)
  const setDetail = useBrainStore((s) => s.setDetail)
  const setChatContext = useBrainStore((s) => s.setChatContext)
  const graphNodes = useBrainStore((s) => s.data?.nodes)

  // Open a graph node by id (OrgsPanel pattern); resolve kind/label from the
  // brain-store graph when available so the detail panel + chat context match.
  const openNode = (id: string, label: string): void => {
    const node = (graphNodes ?? []).find((n) => n.id === id)
    focusNode(id)
    setDetail((node ?? { id, label }) as never)
    setChatContext({ id, label: node ? String(node.label) : label, kind: node?.kind ?? 'note' })
  }

  // Pull the latest graph report (+ optional history). Lifted out of the effect
  // so applyLink can refetch after a successful link, dropping the now-satisfied
  // suggestion from the list.
  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await window.api?.brain?.graphReport?.()
      if (r?.success) {
        const d = r.data as { insight: GraphInsight; markdown: string }
        setInsight(d.insight)
        setMarkdown(d.markdown ?? '')
        setError(null)
      } else setError(r?.error ?? 'graph report failed')
    } catch (e) {
      setError((e as Error)?.message ?? 'graph report failed')
    }
    try {
      const h = await window.api?.brain?.graphHistory?.()
      if (h?.success && Array.isArray(h.data)) setHistory(h.data as HistoryRow[])
    } catch {
      /* history is optional */
    }
  }, [])

  // Apply a suggested link: append the [[wikilink]] to the source note's body.
  const applyLink = async (s: LinkSuggestion, key: string): Promise<void> => {
    if (applying) return
    setApplying(key)
    try {
      const current = await fetchDoc(s.source)
      if (current.includes(s.wikilink)) {
        setApplied((prev) => new Set(prev).add(key))
        toast.info('Link already present')
        return
      }
      const next = `${current.replace(/\s*$/, '')}\n\nRelated: ${s.wikilink}\n`
      await saveDoc(s.source, next)
      setApplied((prev) => new Set(prev).add(key))
      toast.success(`Linked ${s.wikilink} in ${s.sourceLabel}`)
      // Refetch so the now-satisfied suggestion drops from the list.
      void load()
    } catch (e) {
      toast.error((e as Error)?.message ?? 'Could not apply link')
    } finally {
      setApplying(null)
    }
  }

  useEffect(() => {
    void load()
    const off = window.api?.brain?.onUpdated?.(() => void load())
    return () => {
      off?.()
    }
  }, [load])

  const copy = async (text: string, tag: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(tag)
      setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1200)
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  const card = 'rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-2.5'
  const copyBtn =
    'rounded border border-[var(--panel-border)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'

  return (
    <div className="flex h-full flex-col overflow-hidden p-3 text-[12px]">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-semibold text-[var(--text-primary)]">{t('Graph Report')}</span>
        {insight && (
          <span className="rounded-full bg-[var(--accent)]/15 px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]">
            {insight.stats.communities} clusters
          </span>
        )}
        {markdown && (
          <button className={copyBtn + ' ml-auto'} onClick={() => void copy(markdown, 'report')}>
            {copied === 'report' ? 'Copied ✓' : 'Copy report'}
          </button>
        )}
      </div>
      <p className="mb-2 text-[11px] text-[var(--text-muted)]">
        {t('Clusters, hubs, and surprising cross-cluster links in your brain — structural, no model needed.')}
      </p>

      <div className="flex-1 space-y-3 overflow-y-auto">
        {insight === null && error === null && (
          <div className="text-[12px] text-[var(--text-muted)]">Analysing the graph…</div>
        )}
        {error !== null && (
          <div className={card + ' text-[12px] text-[var(--text-secondary)]'}>
            Couldn&apos;t build the report: {error}. Add notes to your brain (Settings → Brain) so the graph
            has structure to analyse.
          </div>
        )}

        {insight && (
          <>
            <div className="text-[11px] text-[var(--text-muted)]">
              {insight.stats.nodes} notes · {insight.stats.edges} links · {insight.stats.isolated} unlinked ·{' '}
              {insight.edgeProvenance.declared} declared / {insight.edgeProvenance.inferred} inferred /{' '}
              {insight.edgeProvenance.ambiguous} ambiguous edges
            </div>

            {history.length >= 2 && (
              <div className={card}>
                <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
                  <span>Growth · {history.length} snapshots</span>
                  <span>
                    {history[0].nodes} → {history[history.length - 1].nodes} notes
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <div>
                    <div className="text-[11px] text-[var(--text-muted)]">notes</div>
                    <Sparkline values={history.map((h) => h.nodes)} color={isLight ? forLight('#34d399') : '#34d399'} />
                  </div>
                  <div>
                    <div className="text-[11px] text-[var(--text-muted)]">links</div>
                    <Sparkline values={history.map((h) => h.edges)} color={isLight ? forLight('#60a5fa') : '#60a5fa'} />
                  </div>
                </div>
              </div>
            )}

            <section>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                {t('Clusters')}
              </div>
              <div className="space-y-1.5">
                {insight.communities.slice(0, 12).map((c) => (
                  <div key={c.id} className={card}>
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: c.color }}
                        aria-hidden
                      />
                      <span className="font-medium text-[var(--text-primary)]">{c.label}</span>
                      <span className="ml-auto text-[11px] text-[var(--text-muted)]">{c.size} notes</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-1.5 gap-y-0.5 text-[11px] text-[var(--text-secondary)]">
                      {c.topNodes.map((n, ni) => (
                        <button
                          key={n.id}
                          type="button"
                          title={t('Open in the Brain graph')}
                          onClick={() => openNode(n.id, n.label)}
                          className="cursor-pointer text-left hover:text-[var(--accent)]"
                        >
                          {n.label} ({n.degree}){ni < c.topNodes.length - 1 ? ',' : ''}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {insight.bridges.length > 0 && (
              <section>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  {t('Surprising connections')}
                </div>
                <div className="space-y-1.5">
                  {insight.bridges.map((b, i) => (
                    <div key={i} className={card}>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-[var(--text-primary)]">
                          {b.commALabel} ↔ {b.commBLabel}
                        </span>
                        <span
                          className="rounded px-1.5 py-0.5 text-[11px] font-medium"
                          style={chipColors(PROV_COLOR[b.provenance], isLight)}
                          title={t('Edge provenance: declared = user-written link; inferred = model-derived; ambiguous = low-confidence')}
                        >
                          {b.provenance}
                        </span>
                        <span className="ml-auto text-[11px] text-[var(--text-muted)]">
                          surprise {b.surprise}
                          {b.count > 1 ? ` · ${b.count}` : ''}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-[var(--text-secondary)]">
                        e.g. {b.sourceLabel} → {b.targetLabel}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                {t('Hubs')}
              </div>
              <div className={card}>
                {insight.highDegree.map((h) => (
                  <div key={h.id} className="flex items-center gap-2 py-0.5 text-[12px]">
                    <button
                      type="button"
                      title={t('Open in the Brain graph')}
                      onClick={() => openNode(h.id, h.label)}
                      className="cursor-pointer text-left text-[var(--text-primary)] hover:text-[var(--accent)]"
                    >
                      {h.label}
                    </button>
                    <span className="ml-auto text-[11px] text-[var(--text-muted)]">{h.degree} links</span>
                  </div>
                ))}
              </div>
            </section>

            {insight.suggestedQuestions.length > 0 && (
              <section>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  {t('Questions to explore')}
                </div>
                <ul className="list-disc space-y-1 pl-4 text-[12px] text-[var(--text-secondary)]">
                  {insight.suggestedQuestions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              </section>
            )}

            {insight.linkSuggestions.length > 0 && (
              <section>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Suggested links{' '}
                  <span className="font-normal normal-case">· review before adding</span>
                </div>
                <div className="space-y-1.5">
                  {insight.linkSuggestions.map((s, i) => {
                    // Key the per-row state by the suggestion's OWN identity, not its list
                    // position. applyLink refetches and reindexes the list, so after applying
                    // one suggestion `apl3` referred to a different row — the wrong entry showed
                    // "Applied ✓" and the one actually applied looked untouched.
                    const rowId = `${s.source}->${s.target}:${s.wikilink}`
                    return (
                    <div key={rowId} className={card}>
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 truncate text-[12px] text-[var(--text-primary)]">
                          in <span className="font-medium">{s.sourceLabel}</span> add{' '}
                          <code className="rounded bg-[var(--panel-bg)] px-1 text-[11px]">{s.wikilink}</code>
                        </span>
                        <button
                          className={copyBtn + ' ml-auto shrink-0'}
                          onClick={() => void copy(s.wikilink, `lnk:${rowId}`)}
                        >
                          {copied === `lnk:${rowId}` ? '✓' : 'Copy'}
                        </button>
                        <button
                          className={copyBtn + ' shrink-0'}
                          disabled={applying === `apl:${rowId}` || applied.has(`apl:${rowId}`)}
                          onClick={() => void applyLink(s, `apl:${rowId}`)}
                          title={`Append ${s.wikilink} to ${s.sourceLabel}`}
                        >
                          {applied.has(`apl:${rowId}`)
                            ? 'Applied ✓'
                            : applying === `apl:${rowId}`
                              ? 'Applying…'
                              : 'Apply'}
                        </button>
                      </div>
                      <div className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
                        {s.reason} ({s.kind})
                      </div>
                    </div>
                    )
                  })}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
