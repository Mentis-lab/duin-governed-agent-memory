import { t } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'
import { useAutomationsStore, automationHealth } from '@/stores/automations-store'
import type { Automation } from '@/stores/automations-store'
import { CronEditor } from './CronEditor'
import { RunHistoryViewer } from './RunHistoryViewer'

/** The schedule in words. Falls back to the raw expression only when it won't parse —
 *  which is itself worth seeing, since an unparseable cron is why the runner disables one. */
function describeSchedule(cron: string, label: string | null): string {
  return label ?? cron
}

/** Coarse "when next" for the list. Precision beyond this is noise while scanning. */
function formatWhen(ts: number): string {
  const diff = ts - Date.now()
  if (diff <= 0) return 'due'
  const minutes = Math.round(diff / 60_000)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `in ${hours}h`
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

/**
 * Healthy / Paused / Auto-disabled.
 *
 * These three were one pixel — the toggle — so an automation the runner had killed was
 * indistinguishable from one the operator switched off on purpose.
 */
function HealthChip({ automation }: { automation: Automation }) {
  const health = automationHealth(automation)
  if (health === 'healthy') return null // the common case needs no badge; absence IS the signal
  const isDead = health === 'auto-disabled'
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
        isDead ? 'bg-red-500/15 text-red-400' : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
      }`}
      title={isDead ? 'DUIN turned this off after a failure' : 'You turned this off'}
    >
      {isDead ? 'Auto-disabled' : 'Paused'}
    </span>
  )
}

// G1 — Automations / cron panel.
//
// List of scheduled tasks. "+ New" opens an inline editor row. Each
// row exposes enable-toggle, run-now, edit, delete, and a collapsible
// last-run preview. The CronEditor handles validation + human preview.

interface DraftForm {
  id?: string
  label: string
  cron: string
  prompt: string
  model: string
  enabled: boolean
}

const emptyDraft = (): DraftForm => ({
  label: '',
  cron: '*/5 * * * *',
  prompt: '',
  model: '',
  enabled: true
})

export function AutomationsPanel() {
  const automations = useAutomationsStore((s) => s.automations)
  const refresh = useAutomationsStore((s) => s.refresh)
  const create = useAutomationsStore((s) => s.create)
  const update = useAutomationsStore((s) => s.update)
  const remove = useAutomationsStore((s) => s.remove)
  const runNow = useAutomationsStore((s) => s.runNow)
  const loading = useAutomationsStore((s) => s.loading)

  const [draft, setDraft] = useState<DraftForm | null>(null)
  const [cronValid, setCronValid] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openNew = () => {
    setDraft(emptyDraft())
    setCronValid(false)
  }

  const openEdit = (a: Automation) => {
    setDraft({
      id: a.id,
      label: a.label,
      cron: a.cron,
      prompt: a.prompt,
      model: a.model ?? '',
      enabled: a.enabled
    })
    setCronValid(true)
  }

  const closeDraft = () => setDraft(null)

  const handleSave = async () => {
    if (!draft) return
    if (!draft.label.trim() || !draft.prompt.trim() || !cronValid) return
    if (draft.id) {
      const ok = await update(draft.id, {
        label: draft.label.trim(),
        cron: draft.cron,
        prompt: draft.prompt,
        model: draft.model.trim() || undefined,
        enabled: draft.enabled
      })
      if (ok) closeDraft()
    } else {
      const created = await create({
        label: draft.label.trim(),
        cron: draft.cron,
        prompt: draft.prompt,
        model: draft.model.trim() || undefined
      })
      if (created) closeDraft()
    }
  }

  return (
    <div className="flex h-full flex-col gap-2 p-2 text-[12px] text-[var(--text-primary)]">
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
          Automations · {automations.length}
        </span>
        <Button
          onClick={openNew}
          variant="primary"
          size="sm"
        >
          + New
        </Button>
      </div>

      {draft && (
        <div className="flex flex-col gap-2 rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] p-2">
          <div className="grid grid-cols-[80px_1fr] items-center gap-2">
            <label className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
              {t('Label')}
            </label>
            <input
              type="text"
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              placeholder={t('Friendly name')}
              className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] text-[var(--text-primary)]"
            />
            <label className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
              {t('Cron')}
            </label>
            <CronEditor
              value={draft.cron}
              onChange={(cron) => setDraft({ ...draft, cron })}
              onValidityChange={setCronValid}
            />
            <label className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
              {t('Model')}
            </label>
            <input
              type="text"
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              placeholder="(optional: defaults to deepseek-v4-flash)"
              className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] text-[var(--text-primary)]"
            />
            <label className="self-start pt-1 text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
              {t('Prompt')}
            </label>
            <textarea
              value={draft.prompt}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              rows={3}
              placeholder={t('Body sent to the model on each fire')}
              className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] text-[var(--text-primary)]"
            />
          </div>
          {draft.id && (
            <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
              <Toggle
                checked={draft.enabled}
                onChange={(v) => setDraft({ ...draft, enabled: v })}
                aria-label={t('Enabled')}
              />
              {t('Enabled')}
            </label>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={closeDraft}
              className="rounded px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
            >
              {t('Cancel')}
            </button>
            <Button
              onClick={handleSave}
              variant="primary"
              disabled={!draft.label.trim() || !draft.prompt.trim() || !cronValid}
            >
              {draft.id ? 'Save' : 'Create'}
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto pr-1">
        {loading && automations.length === 0 ? (
          <p className="px-2 py-3 text-[11px] text-[var(--text-muted)]">Loading…</p>
        ) : automations.length === 0 ? (
          <p className="px-2 py-3 text-[11px] text-[var(--text-muted)]">
            No automations yet. Click + New to schedule a task.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {automations.map((a) => (
              <li
                key={a.id}
                className="rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)]"
              >
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <Toggle
                    checked={a.enabled}
                    onChange={(v) => update(a.id, { enabled: v })}
                    aria-label={a.enabled ? 'Disable' : 'Enable'}
                  />
                  <button
                    type="button"
                    onClick={() => setExpanded((curr) => (curr === a.id ? null : a.id))}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-medium text-[var(--text-primary)]">
                        {a.label}
                      </span>
                      <HealthChip automation={a} />
                    </span>
                    {/* The schedule in words, with the raw expression kept on hover for
                        anyone who wants it. `0 21 * * 0` is not something to read at a glance. */}
                    <span
                      className="block truncate text-[11px] text-[var(--text-muted)]"
                      title={`${a.cron} · ${a.model || 'auto (provider policy)'}`}
                    >
                      {describeSchedule(a.cron, a.scheduleLabel)}
                      {a.enabled && a.nextRunAt ? ` · next ${formatWhen(a.nextRunAt)}` : ''}
                    </span>
                    {/* The runner writes a reason whenever IT turns an automation off. Showing
                        it is the difference between "you paused this" and "this is broken". */}
                    {!a.enabled && a.disabledReason && (
                      <span className="mt-0.5 block text-[11px] leading-snug text-red-400">
                        {a.disabledReason}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => runNow(a.id)}
                    className="rounded px-2 py-0.5 text-[11px] uppercase tracking-wider text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--accent)]"
                    title={t('Run now')}
                  >
                    {t('Run')}
                  </button>
                  <button
                    type="button"
                    onClick={() => openEdit(a)}
                    className="rounded px-2 py-0.5 text-[11px] uppercase tracking-wider text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                  >
                    {t('Edit')}
                  </button>
                  <Button variant="danger" className="uppercase tracking-wider"
                    onClick={() => {
                      if (confirm(`Delete "${a.label}"?`)) void remove(a.id)
                    }}
                  >
                    {t('Del')}
                  </Button>
                </div>
                {expanded === a.id && (
                  <div className="border-t border-[var(--panel-border)] bg-[var(--bg-primary)]">
                    <pre className="px-2 py-1.5 text-[11px] text-[var(--text-secondary)] whitespace-pre-wrap">
                      {a.prompt}
                    </pre>
                    <RunHistoryViewer automationId={a.id} lastRunAt={a.lastRunAt} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
