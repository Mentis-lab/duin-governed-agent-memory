import { t, tf } from '@/lib/i18n'
import { useEffect, useMemo, useState } from 'react'
import { fetchEntityCard, mergeEntity, type EntityCardData, type EntityCardFact } from '@/duin/lib/state'
import { toast } from '@/stores/toast-store'

/**
 * The card for a derived entity (person, project, topic, org, decision, event…): what the brain
 * already knows about it, joined by the brain from the construction cache, the claim ledger, the
 * aliases, the served graph and the notes, plus a model-written description when a model is
 * available. The description is the one focal element; everything under it is flat rows.
 *
 * Loads in two steps so the card never waits on a model: the joined material first (no model
 * call), then the description when none matches the card's current material.
 */
interface Props {
  id: string
  /** The served label (changes when the operator names the node; the card refetches on it). */
  label: string
  kind: string
  /** The kind's dot colour, from the Explorer's palette. */
  dot: string
  onOpen: (id: string) => void
}

const FACTS_FOLDED = 10
const SOURCES_FOLDED = 6

const day = (iso: string | null): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString()
}

const modelName = (model: string): string => {
  if (model.startsWith('ollama:')) return `${model.slice('ollama:'.length).replace(/:latest$/u, '')} (${t('local')})`
  return model
}

function SectionLabel({ text, aside }: { text: string; aside?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{text}</div>
      {aside}
    </div>
  )
}

function Verb({ label, onClick, disabled, title }: { label: string; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="shrink-0 rounded px-1 text-[11px] text-[var(--accent)] transition-colors hover:bg-[var(--bg-tertiary)] active:translate-y-px disabled:opacity-50"
    >
      {label}
    </button>
  )
}

function FactRow({ f, entity, onOpen }: { f: EntityCardFact; entity: string; onOpen: (id: string) => void }) {
  const left = f.direction === 'subject' ? entity : f.other
  const right = f.direction === 'subject' ? f.other : entity
  const when = f.validUntil ? tf('until {date}', { date: f.validUntil }) : f.validFrom ? tf('since {date}', { date: f.validFrom }) : ''
  return (
    <div className={`flex items-baseline gap-1.5 border-b border-[var(--panel-border)] py-1 text-[12px] leading-snug last:border-b-0 ${f.current ? '' : 'opacity-60'}`}>
      <span className="min-w-0 flex-1 break-words">
        <span className={f.direction === 'subject' ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}>{left}</span>{' '}
        <span className="text-[var(--text-muted)]">{f.relation.replace(/_/g, ' ')}</span>{' '}
        <span className={f.direction === 'subject' ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}>{right}</span>
        {!f.current && <span className="ml-1 text-[11px] text-[var(--text-muted)]">({t('no longer current')})</span>}
      </span>
      {when && <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{when}</span>}
      {f.note && (
        <button type="button" onClick={() => onOpen(f.note)} title={f.note} className="shrink-0 text-[11px] text-[var(--text-muted)] hover:text-[var(--accent)]">
          {t('source')}
        </button>
      )}
    </div>
  )
}

export function EntityCard({ id, label, kind, dot, onOpen }: Props) {
  const [card, setCard] = useState<EntityCardData | null>(null)
  const [enrichAvailable, setEnrichAvailable] = useState(false)
  const [phase, setPhase] = useState<'loading' | 'describing' | 'ready' | 'error'>('loading')
  const [allFacts, setAllFacts] = useState(false)
  const [allSources, setAllSources] = useState(false)
  const [merging, setMerging] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    setPhase('loading')
    setAllFacts(false)
    setAllSources(false)
    ;(async () => {
      try {
        const first = await fetchEntityCard(id, false)
        if (!alive) return
        setCard(first.card)
        setEnrichAvailable(first.enrichAvailable)
        if (first.card.enrichment || !first.enrichAvailable) {
          setPhase('ready')
          return
        }
        setPhase('describing')
        const second = await fetchEntityCard(id, true)
        if (!alive) return
        setCard(second.card)
        setPhase('ready')
      } catch {
        if (alive) setPhase('error')
      }
    })()
    return () => {
      alive = false
    }
  }, [id, label, tick])

  const redescribe = async (): Promise<void> => {
    setPhase('describing')
    try {
      const r = await fetchEntityCard(id, true, true)
      setCard(r.card)
    } catch {
      /* the previous description stays on screen */
    }
    setPhase('ready')
  }

  const merge = async (canonicalId: string): Promise<void> => {
    if (!card) return
    setMerging(canonicalId)
    try {
      await mergeEntity(card.label, canonicalId)
      toast.success(t('Merged. The graph folds them on its next build.'))
      setTick((v) => v + 1)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setMerging(null)
    }
  }

  const relationGroups = useMemo(() => {
    const m = new Map<string, EntityCardData['relations']>()
    for (const r of card?.relations ?? []) {
      const list = m.get(r.type) ?? []
      list.push(r)
      m.set(r.type, list)
    }
    return [...m.entries()]
  }, [card])

  if (phase === 'error' && !card) {
    return (
      <div className="space-y-2 text-[12px] text-[var(--text-muted)]">
        <p>{t('Could not load this entity.')}</p>
        <Verb label={t('Retry')} onClick={() => setTick((v) => v + 1)} />
      </div>
    )
  }
  if (!card) return <p className="text-[12px] text-[var(--text-muted)]">{t('Loading…')}</p>

  const e = card.enrichment
  const thin = card.factsTotal === 0 && card.sourcesTotal === 0 && card.relationsTotal === 0
  const facts = allFacts ? card.facts : card.facts.slice(0, FACTS_FOLDED)
  const sources = allSources ? card.sources : card.sources.slice(0, SOURCES_FOLDED)

  return (
    <div className="space-y-4">
      {/* identity line */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} />
          <span className="uppercase tracking-wide">{kind}</span>
        </span>
        {card.labelBy === 'operator' && (
          <span>
            {t('named by you')}
            {card.extractedLabel ? `, ${tf('extracted as {name}', { name: card.extractedLabel })}` : ''}
          </span>
        )}
        {card.aliases.length > 0 && (
          <span>
            {t('Also known as')} {card.aliases.join(', ')}
          </span>
        )}
      </div>

      {/* the focal element: what it is */}
      <div className="space-y-1.5">
        {e ? (
          <>
            <p className="text-[14px] leading-relaxed text-[var(--text-primary)]">{e.description}</p>
            {e.attributes.length > 0 && (
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
                {e.attributes.map((a) => (
                  <div key={a.key} className="contents">
                    <span className="text-[var(--text-muted)]">{a.key.replace(/_/g, ' ')}</span>
                    <span className="break-words text-[var(--text-primary)]">{a.value.replace(/_/g, ' ')}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
              <span>{tf('Described by {model}', { model: modelName(e.model) })}</span>
              {phase === 'describing' ? <span>{t('Describing from what the brain knows…')}</span> : enrichAvailable && <Verb label={t('Refresh')} onClick={redescribe} />}
            </div>
          </>
        ) : phase === 'describing' ? (
          <p className="text-[12px] text-[var(--text-muted)] motion-safe:animate-pulse">{t('Describing from what the brain knows…')}</p>
        ) : thin ? (
          <p className="text-[12px] text-[var(--text-muted)]">{t('Only its name is known so far. It came from an earlier extraction run.')}</p>
        ) : enrichAvailable ? (
          <Verb label={t('Describe')} onClick={redescribe} />
        ) : (
          <p className="text-[12px] text-[var(--text-muted)]">{t('Connect a model to get a written description.')}</p>
        )}
      </div>

      {card.mergeCandidates.length > 0 && (
        <div className="space-y-1">
          <SectionLabel text={t('Looks like the same thing')} />
          {card.mergeCandidates.map((m) => (
            <div key={m.id} className="flex items-center gap-2 border-l-2 border-[var(--accent)] py-1 pl-2 text-[12px]">
              <button type="button" onClick={() => onOpen(m.id)} className="min-w-0 flex-1 truncate text-left text-[var(--text-primary)] hover:text-[var(--accent)]" title={m.id}>
                {m.label} <span className="text-[var(--text-muted)]">{m.kind}</span>
              </button>
              <Verb label={t('Merge into this')} onClick={() => void merge(m.id)} disabled={merging != null} />
            </div>
          ))}
        </div>
      )}

      {card.facts.length > 0 && (
        <div className="space-y-1">
          <SectionLabel
            text={`${t('What the brain knows')} (${card.factsTotal})`}
            aside={card.facts.length > FACTS_FOLDED ? <Verb label={allFacts ? t('Show fewer') : tf('Show all {n}', { n: card.facts.length })} onClick={() => setAllFacts((v) => !v)} /> : undefined}
          />
          <div>
            {facts.map((f, i) => (
              <FactRow key={`${f.direction}|${f.relation}|${f.other}|${i}`} f={f} entity={card.label} onOpen={onOpen} />
            ))}
          </div>
        </div>
      )}

      {card.sources.length > 0 && (
        <div className="space-y-1">
          <SectionLabel
            text={`${t('Where it appears')} (${card.sourcesTotal})`}
            aside={card.sources.length > SOURCES_FOLDED ? <Verb label={allSources ? t('Show fewer') : tf('Show all {n}', { n: card.sources.length })} onClick={() => setAllSources((v) => !v)} /> : undefined}
          />
          <div>
            {sources.map((s) => (
              <div key={s.path} className="border-b border-[var(--panel-border)] py-1 last:border-b-0">
                <div className="flex items-baseline gap-2">
                  <button type="button" onClick={() => onOpen(s.path)} title={s.path} className="min-w-0 flex-1 truncate text-left text-[12px] text-[var(--text-primary)] hover:text-[var(--accent)]">
                    {s.title}
                  </button>
                  {s.mtime != null && <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{day(new Date(s.mtime).toISOString())}</span>}
                </div>
                {s.snippet && <p className="text-[12px] leading-snug text-[var(--text-muted)]">{s.snippet}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {relationGroups.length > 0 && (
        <div className="space-y-1.5">
          <SectionLabel text={`${t('Connected')} (${card.relationsTotal})`} />
          {relationGroups.map(([type, list]) => (
            <div key={type} className="flex flex-wrap items-baseline gap-1">
              <span className="mr-1 text-[11px] text-[var(--text-muted)]">{type}</span>
              {list.map((r) => (
                <button
                  key={`${r.dir}-${r.id}`}
                  type="button"
                  onClick={() => onOpen(r.id)}
                  title={`${r.dir === 'in' ? '← ' : ''}${r.id}`}
                  className="max-w-full truncate rounded-full border border-[var(--panel-border)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                >
                  {r.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="space-y-0.5 text-[11px] text-[var(--text-muted)]">
        {card.firstSeen && card.lastSeen && <div>{tf('First seen {a}, last {b}', { a: day(card.firstSeen), b: day(card.lastSeen) })}</div>}
        <div className="break-all font-mono">{card.id}</div>
      </div>
    </div>
  )
}
