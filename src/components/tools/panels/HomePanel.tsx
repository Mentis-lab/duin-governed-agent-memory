import { t, tf } from '@/lib/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useUiStore, type SettingsTabId, type ToolId } from '@/stores/ui-store'
import { useNoticesStore } from '@/stores/notices-store'
import { followDeepLink } from '@/lib/follow-deep-link'
import { Button } from '@/components/ui/Button'
import { loadHomeInputs, saveSeen } from './home/home-data'
import {
  ageShort,
  composeHome,
  snapshotOf,
  type AliveLine,
  type HomeModel,
  type Target,
  type Tone
} from './home/home-model'

// Home — the one operator surface. Three questions, top to bottom: what needs you, is the
// machine alive, what changed. ONE focal item floats; every other line is flat and takes you
// to the detailed surface it folds (Status, Learning, Automations, Background tasks, After
// action), which keep their ToolIds but no longer sit in the launcher.
//
// Dynamic by construction: every event the folded surfaces listen to re-composes the model,
// a visibility-gated poll covers the rest, and loads are single-flight with a trailing rerun.

const POLL_MS = 30_000
const SOFT_FLOOR_MS = 15_000

const DOT: Record<Tone, string> = {
  ok: 'bg-[var(--success)]',
  warn: 'bg-[var(--warning)]',
  crit: 'bg-[var(--error)]',
  muted: 'bg-[var(--text-muted)]'
}

const TONE_WORD: Record<Tone, () => string> = {
  ok: () => t('fine'),
  warn: () => t('worth a look'),
  crit: () => t('needs fixing'),
  muted: () => t('unknown')
}

function Dot({ tone }: { tone: Tone }): React.ReactElement {
  return <span aria-hidden className={`mt-[5px] inline-block h-2 w-2 shrink-0 rounded-full ${DOT[tone]}`} />
}

function Chevron(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-[var(--text-muted)]">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

function SectionLabel({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between px-1 pb-1.5 pt-4 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
      <span>{children}</span>
      {aside}
    </div>
  )
}

const ROW =
  'group flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--bg-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] active:translate-y-px'

function timeLabel(ts: number, now: number): string {
  const d = new Date(ts)
  const sameDay = now - ts < 24 * 60 * 60 * 1000 && d.getDate() === new Date(now).getDate()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function HomePanel(): React.ReactElement {
  const [model, setModel] = useState<HomeModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const inflight = useRef<Promise<void> | null>(null)
  const rerun = useRef(false)
  const lastLoad = useRef(0)
  const markRead = useNoticesStore((s) => s.markRead)

  const load = useCallback((): Promise<void> => {
    if (inflight.current) {
      rerun.current = true
      return inflight.current
    }
    inflight.current = (async () => {
      do {
        rerun.current = false
        try {
          const inputs = await loadHomeInputs()
          setModel(composeHome(inputs, t, tf))
          setError(null)
          saveSeen(snapshotOf(inputs))
          lastLoad.current = Date.now()
          setUpdatedAt(lastLoad.current)
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        }
      } while (rerun.current)
    })().finally(() => {
      inflight.current = null
    })
    return inflight.current
  }, [])

  // Every signal the folded surfaces react to, plus a visibility-gated poll for what has no
  // signal (stalls, spend, schedules). A soft refresh on focus keeps the window snappy to
  // come back to without paying a full gather on every alt-tab.
  useEffect(() => {
    void load()
    const w = window as unknown as { api?: Record<string, Record<string, unknown>> }
    const offs: (() => void)[] = []
    const sub = (group: string, name: string): void => {
      try {
        const fn = w.api?.[group]?.[name] as ((cb: () => void) => (() => void) | void) | undefined
        const off = fn?.(() => void load())
        if (typeof off === 'function') offs.push(off)
      } catch {
        /* a missing bridge just means no live signal from that source */
      }
    }
    sub('notices', 'onChanged')
    sub('brain', 'onUpdated')
    sub('brain', 'onBuild')
    sub('settings', 'onKeychainChanged')
    sub('operator', 'onChanged')
    sub('loops', 'onFired')
    sub('loops', 'onLoopEvent')
    sub('connections', 'onUpdated')
    const soft = (): void => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastLoad.current >= SOFT_FLOOR_MS) void load()
    }
    const timer = setInterval(soft, POLL_MS)
    document.addEventListener('visibilitychange', soft)
    window.addEventListener('focus', soft)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', soft)
      window.removeEventListener('focus', soft)
      for (const off of offs) off()
    }
  }, [load])

  const go = useCallback((target: Target): void => {
    const ui = useUiStore.getState()
    switch (target.type) {
      case 'tool':
        ui.setActiveTool(target.tool as ToolId)
        return
      case 'settings':
        ui.openSettings(target.tab as SettingsTabId)
        return
      case 'deepLink':
        if (!followDeepLink(target.link)) ui.setActiveTool('homeStatus')
        return
      default:
        return
    }
  }, [])

  const openNeed = useCallback(
    (id: string, deepLink: string | null, needsDecision: boolean): void => {
      if (!needsDecision) void markRead([id])
      if (deepLink && followDeepLink(deepLink)) return
      useUiStore.getState().setActiveTool('homeStatus')
    },
    [markRead]
  )

  if (!model) {
    return (
      <div className="flex h-full flex-col overflow-hidden p-3" aria-busy="true">
        <div className="min-h-[76px] rounded-xl border border-[var(--panel-border)] bg-[var(--bg-primary)] motion-safe:animate-pulse" />
        <div className="mt-4 space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-7 rounded-md bg-[var(--bg-tertiary)]/60 motion-safe:animate-pulse" />
          ))}
        </div>
        {error && <p className="mt-3 text-[12px] text-[var(--error)]">{error}</p>}
      </div>
    )
  }

  const now = updatedAt ?? Date.now()
  const focal = model.focal
  const focalFrame =
    focal.tone === 'crit'
      ? 'border-[var(--error)]/50 bg-[var(--error)]/10'
      : focal.tone === 'warn'
        ? 'border-[var(--warning)]/50 bg-[var(--warning)]/10'
        : 'border-[var(--accent)]/40 bg-[var(--accent-dim)]'

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1">
        {/* The one thing first. Only this block carries a tinted frame. */}
        <section aria-label={t('First')} className={`rounded-xl border p-3.5 ${focalFrame}`}>
          <h2 className="text-[15px] font-semibold leading-snug text-[var(--text-primary)]">{focal.title}</h2>
          {focal.why && <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">{focal.why}</p>}
          {focal.action && (
            <Button
              variant="primary"
              className="mt-2.5 rounded-lg font-semibold active:translate-y-px"
              onClick={() => go(focal.action!.to)}
            >
              {focal.action.label}
            </Button>
          )}
        </section>

        {model.needs.length > 0 && (
          <section aria-label={t('Needs you')}>
            <SectionLabel
              aside={
                model.needsTotal > model.needs.length + 1 ? (
                  <button onClick={() => go({ type: 'tool', tool: 'homeStatus' })} className="normal-case tracking-normal text-[var(--accent)] hover:underline">
                    {tf('all {n}', { n: model.needsTotal })}
                  </button>
                ) : undefined
              }
            >
              {t('Needs you')}
            </SectionLabel>
            <ul className="divide-y divide-[var(--panel-border)]/70">
              {model.needs.map((n) => (
                <li key={n.id}>
                  <button className={ROW} onClick={() => openNeed(n.id, n.deepLink, n.needsDecision)}>
                    <Dot tone={n.severity === 'error' ? 'crit' : n.severity === 'warning' ? 'warn' : n.needsDecision ? 'warn' : 'muted'} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-[var(--text-primary)]">{n.title}</span>
                      {n.why && <span className="block truncate text-[12px] text-[var(--text-secondary)]">{n.why}</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-[11px] tabular-nums text-[var(--text-muted)]">
                      {n.needsDecision && <span className="font-medium text-[var(--accent)]">{t('Decide')}</span>}
                      {ageShort(now, n.createdAt)}
                      <Chevron />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-label={t('Alive')}>
          <SectionLabel>{t('Alive')}</SectionLabel>
          <ul className="divide-y divide-[var(--panel-border)]/70">
            {model.alive.map((line: AliveLine) => (
              <li key={line.id}>
                <button className={ROW} onClick={() => go(line.to)} title={TONE_WORD[line.tone]()}>
                  <Dot tone={line.tone} />
                  <span className="w-[72px] shrink-0 pt-px text-[12px] text-[var(--text-muted)]">{line.label}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-[var(--text-primary)]">{line.value}</span>
                    {line.why && <span className="block truncate text-[12px] text-[var(--text-secondary)]">{line.why}</span>}
                  </span>
                  <span className="pt-0.5"><Chevron /></span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label={t('What changed')}>
          <SectionLabel
            aside={
              <span className="normal-case tracking-normal tabular-nums">
                {model.since ? tf('since {time}', { time: timeLabel(model.since, now) }) : t('this session')}
              </span>
            }
          >
            {t('What changed')}
          </SectionLabel>
          {model.changed.length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] text-[var(--text-secondary)]">{t('Quiet. Nothing moved.')}</p>
          ) : (
            <ul className="divide-y divide-[var(--panel-border)]/70">
              {model.changed.map((c) => (
                <li key={c.id}>
                  <button className={ROW} onClick={() => go(c.to)}>
                    <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-[var(--text-primary)]">{c.text}</span>
                    <span className="pt-0.5"><Chevron /></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {model.unreadable.length > 0 && (
          <p className="mt-3 px-2 text-[11px] text-[var(--text-muted)]">
            {tf('Could not read: {what}', { what: model.unreadable.join(', ') })}
          </p>
        )}
        {error && <p className="mt-2 px-2 text-[11px] text-[var(--error)]">{error}</p>}
      </div>

      {/* Tertiary: when this was true, and the detailed surfaces this one folds. */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-[var(--panel-border)] px-3 py-2 text-[11px] text-[var(--text-muted)]">
        <button onClick={() => void load()} className="tabular-nums hover:text-[var(--text-primary)]">
          {updatedAt ? tf('Updated {time}', { time: timeLabel(updatedAt, now) }) : t('Updating')}
        </button>
        <span className="flex flex-wrap items-center gap-x-2">
          <span>{t('Details')}</span>
          {(
            [
              ['homeStatus', t('Status')],
              ['learning', t('Learning')],
              ['automations', t('Automations')],
              ['background', t('Background')],
              ['afterAction', t('After action')]
            ] as [ToolId, string][]
          ).map(([id, label]) => (
            <button key={id} onClick={() => go({ type: 'tool', tool: id })} className="hover:text-[var(--text-primary)] hover:underline">
              {label}
            </button>
          ))}
        </span>
      </div>
    </div>
  )
}
