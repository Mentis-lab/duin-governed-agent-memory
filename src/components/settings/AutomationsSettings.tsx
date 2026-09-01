import { t } from '@/lib/i18n'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { Toggle } from '@/components/ui/Toggle'
import { toast } from '@/stores/toast-store'
import { useModelStore } from '@/stores/model-store'
import { useSettingsStore } from '@/stores/settings-store'

interface Automation {
  id: string
  label: string
  cron: string
  prompt: string
  model: string | null
  enabled: boolean
  createdAt: number
  lastRunAt: number | null
  lastResult: string | null
}

// No "every minute" preset: the runner floors the same automation at one dispatch per
// 5 minutes, so offering it would promise a cadence that silently never happens.
const CRON_HINTS: { label: string; expr: string }[] = [
  { label: 'every 5 minutes', expr: '*/5 * * * *' },
  { label: 'top of every hour', expr: '0 * * * *' },
  { label: 'daily at 9am', expr: '0 9 * * *' },
  { label: 'weekdays at 5pm', expr: '0 17 * * 1-5' }
]

export function AutomationsSettings() {
  const [items, setItems] = useState<Automation[]>([])
  const [label, setLabel] = useState('')
  const [cron, setCron] = useState('0 9 * * *')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const models = useModelStore((s) => s.models)
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const refresh = useCallback(async () => {
    if (!window.api?.automations) return
    const res = await window.api.automations.list()
    if (res.success) setItems(res.data as Automation[])
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleCreate = async () => {
    if (!label.trim() || !cron.trim() || !prompt.trim()) {
      toast.error('label, cron, and prompt are required')
      return
    }
    setBusy(true)
    const res = await window.api?.automations?.create({
      label: label.trim(),
      cron: cron.trim(),
      prompt: prompt.trim(),
      model: model || undefined
    })
    setBusy(false)
    if (!res?.success) {
      toast.error(res?.error ?? 'create failed')
      return
    }
    setLabel('')
    setPrompt('')
    void refresh()
  }

  const toggleEnabled = async (a: Automation) => {
    await window.api?.automations?.update(a.id, { enabled: !a.enabled })
    void refresh()
  }
  const runNow = async (a: Automation) => {
    toast.info(`Running "${a.label}"…`)
    const res = await window.api?.automations?.runNow(a.id)
    if (!res?.success) toast.error(res?.error ?? 'run failed')
    else toast.success('Done')
    void refresh()
  }
  const remove = async (a: Automation) => {
    if (!confirm(`Delete automation "${a.label}"?`)) return
    await window.api?.automations?.delete(a.id)
    void refresh()
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[14px] font-medium text-[var(--text-primary)]">{t('Automations')}</h2>
        <p className="mt-1 text-[12px] text-[var(--text-muted)]">
          Cron-scheduled prompts. Each automation runs its prompt as a one-shot call to the
          selected model. Results are saved as "last run output" — no streaming UI. Local-only:
          your computer must be running for the schedule to fire.
        </p>
      </div>

      <div className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
        <h3 className="mb-2 text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
          {t('New automation')}
        </h3>
        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="label, e.g. 'morning PR triage'"
            className="rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1 text-[12px] outline-none focus:border-[var(--accent)]"
          />
          <input
            type="text"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="cron (min hour dom month dow), e.g. 0 9 * * *"
            className="rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1 font-mono text-[12px] outline-none focus:border-[var(--accent)]"
          />
          <div className="flex flex-wrap gap-1">
            {CRON_HINTS.map((h) => (
              <button
                key={h.expr}
                type="button"
                onClick={() => setCron(h.expr)}
                className="rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
              >
                {h.label}
              </button>
            ))}
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="prompt: e.g. 'Summarize today's open issues across the repo.'"
            className="rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1 text-[12px] outline-none focus:border-[var(--accent)]"
          />
          <Select
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">(use default model)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.id}
              </option>
            ))}
          </Select>
          <div className="flex justify-end">
            <button
              onClick={handleCreate}
              disabled={busy}
              className="rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-3 py-1 text-[12px] hover:border-[var(--accent)] disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Add automation'}
            </button>
          </div>
        </div>
      </div>

      <div className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
        <div className="flex items-start gap-3">
          <Toggle
            id="automations-enabled"
            checked={settings?.automationsEnabled === true}
            onChange={() =>
              void updateSettings({ automationsEnabled: !(settings?.automationsEnabled === true) })
            }
            aria-label={t('Run automations on their schedule')}
            className="mt-0.5"
          />
          <label htmlFor="automations-enabled" className="min-w-0 flex-1 cursor-pointer">
            <span className="block text-[13px] text-[var(--text-primary)]">
              {t('Run automations on their schedule')}
            </span>
            <span className="mt-0.5 block text-[12px] text-[var(--text-muted)]">
              Off by default. Each scheduled run dispatches a real agent that can use tools and
              costs tokens, so this is a separate yes from background autonomy. Running one by
              hand always works. Whatever the schedule says, the same automation runs at most
              once every 5 minutes.
            </span>
          </label>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
          Configured ({items.length})
        </h3>
        {items.length === 0 && (
          <p className="text-[12px] text-[var(--text-muted)]">{t('No automations yet.')}</p>
        )}
        {items.map((a) => (
          <div
            key={a.id}
            className="mb-2 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-2 text-[12px]"
          >
            <div className="flex items-start gap-2">
              <Toggle
                checked={a.enabled}
                onChange={() => void toggleEnabled(a)}
                aria-label={t('Enabled')}
                className="mt-1"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{a.label}</span>
                  <span className="font-mono text-[11px] text-[var(--accent)]">{a.cron}</span>
                  {a.model && (
                    <span className="text-[11px] text-[var(--text-muted)]">· {a.model}</span>
                  )}
                </div>
                <p className="mt-1 break-all text-[11px] text-[var(--text-muted)]">{a.prompt}</p>
                {a.lastRunAt && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11px] text-[var(--text-muted)]">
                      last run {new Date(a.lastRunAt).toLocaleString()}
                    </summary>
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-[var(--bg-secondary)] p-2 font-mono text-[11px] text-[var(--text-secondary)]">
                      {a.lastResult || '(no output)'}
                    </pre>
                  </details>
                )}
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                <button
                  onClick={() => void runNow(a)}
                  className="rounded px-2 py-0.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  run now
                </button>
                <Button variant="danger"
                  onClick={() => void remove(a)}
                >
                  delete
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
