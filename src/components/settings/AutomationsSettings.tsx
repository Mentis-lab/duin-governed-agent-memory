import { useCallback, useEffect, useState } from 'react'
import { t, tf } from '@/lib/i18n'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Toggle } from '@/components/ui/Toggle'
import { PanelState } from '@/components/ui/PanelState'
import {
  SettingsLink,
  SettingsLoadError,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
  ToggleRow
} from '@/components/ui/settings'
import { useDirtyGuard } from '@/hooks/useDirtyGuard'
import { invoke, query } from '@/lib/ipc-client'
import { panelFromResult, panelLoading, type PanelStatus } from '@/lib/panel-state'
import { describeError } from '@/lib/result'
import { toast } from '@/stores/toast-store'
import { useModelStore } from '@/stores/model-store'
import { useSettingsStore } from '@/stores/settings-store'
import type { Automation, CronValidation } from '@/stores/automations-store'
import { AUTONOMY_CONFIRM_MESSAGE, autonomyChangeNeedsConfirm } from './LoopSettings'

// Settings → Automations, section "Scheduled": the two switches, the create form, and the
// list. A schedule fires only when BOTH switches are on (automations-runner.ts gates cron
// dispatch on backgroundAutonomy AND automationsEnabled), so both live here, one under the
// other, with a warning row when the first is on and the second is off.
//
// No "every minute" preset: the runner floors the same automation at one dispatch per
// 5 minutes, so offering it would promise a cadence that silently never happens.

const DEFAULT_CRON = '0 9 * * *'
const FIELD_LABEL = 'block text-[11px] font-medium text-[var(--text-secondary)]'
const TEXTAREA =
  'w-full resize-y rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12px] leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] disabled:opacity-50'

const automationsApi = (): typeof window.api.automations | undefined => window.api?.automations

export function AutomationsSettings(): React.ReactElement {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const models = useModelStore((s) => s.models)

  const [items, setItems] = useState<PanelStatus<Automation[]>>(panelLoading())
  const [busyId, setBusyId] = useState<string | null>(null)

  const [label, setLabel] = useState('')
  const [cron, setCron] = useState(DEFAULT_CRON)
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [cronCheck, setCronCheck] = useState<CronValidation | null>(null)
  const [adding, setAdding] = useState(false)

  const anyFieldFilled =
    label.trim() !== '' || prompt.trim() !== '' || model !== '' || cron.trim() !== DEFAULT_CRON
  useDirtyGuard('settings:automations:new', t('the new automation form'), anyFieldFilled)

  const schedulesOn = settings.automationsEnabled === true
  const autonomy = settings.backgroundAutonomy === true

  const refresh = useCallback(async () => {
    setItems(panelFromResult(await query<Automation[]>(t('automations'), automationsApi()?.list)))
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const checkCron = useCallback(async (expr: string) => {
    const api = automationsApi()
    const trimmed = expr.trim()
    if (!trimmed) {
      setCronCheck({ valid: false, error: t('A schedule is required.') })
      return
    }
    const r = await query<CronValidation>(t('the schedule check'), api ? () => api.validateCron(trimmed) : undefined)
    setCronCheck(r.ok ? r.data : null)
  }, [])

  const pickPreset = (expr: string): void => {
    setCron(expr)
    void checkCron(expr)
  }

  const confirmAutonomy = (next: boolean): Promise<boolean> | false => {
    if (
      autonomyChangeNeedsConfirm(next) &&
      typeof window.confirm === 'function' &&
      !window.confirm(t(AUTONOMY_CONFIRM_MESSAGE))
    ) {
      return false
    }
    return updateSettings({ backgroundAutonomy: next })
  }

  const handleCreate = async (): Promise<void> => {
    const name = label.trim()
    if (!name || !cron.trim() || !prompt.trim()) {
      toast.error(t('Name, schedule, and prompt are required.'))
      return
    }
    if (cronCheck && !cronCheck.valid) {
      toast.error(cronCheck.error ?? t('That schedule does not parse.'))
      return
    }
    const api = automationsApi()
    setAdding(true)
    try {
      await invoke(
        t('add automation'),
        api
          ? () => api.create({ label: name, cron: cron.trim(), prompt: prompt.trim(), model: model || undefined })
          : undefined
      )
      toast.success(tf('Added "{name}".', { name }))
      setLabel('')
      setPrompt('')
      setModel('')
      setCron(DEFAULT_CRON)
      setCronCheck(null)
      await refresh()
    } catch (e) {
      toast.error(describeError(e, t('Could not add the automation.')))
    } finally {
      setAdding(false)
    }
  }

  const toggleEnabled = async (a: Automation, next: boolean): Promise<void> => {
    const api = automationsApi()
    setBusyId(a.id)
    try {
      await invoke(t('update automation'), api ? () => api.update(a.id, { enabled: next }) : undefined)
    } catch (e) {
      toast.error(describeError(e, t('Could not update the automation.')))
    } finally {
      setBusyId(null)
      await refresh()
    }
  }

  const runNow = async (a: Automation): Promise<void> => {
    const api = automationsApi()
    toast.info(tf('Running "{name}"…', { name: a.label }))
    setBusyId(a.id)
    try {
      await invoke(t('run automation'), api ? () => api.runNow(a.id) : undefined)
      toast.success(tf('"{name}" finished.', { name: a.label }))
    } catch (e) {
      toast.error(describeError(e, t('The run failed.')))
    } finally {
      setBusyId(null)
      await refresh()
    }
  }

  const remove = async (a: Automation): Promise<void> => {
    if (!window.confirm(tf('Delete the automation "{name}"?', { name: a.label }))) return
    const api = automationsApi()
    setBusyId(a.id)
    try {
      await invoke(t('delete automation'), api ? () => api.delete(a.id) : undefined)
      toast.success(tf('Deleted "{name}".', { name: a.label }))
    } catch (e) {
      toast.error(describeError(e, t('Could not delete the automation.')))
    } finally {
      setBusyId(null)
      await refresh()
    }
  }

  const presets = [
    { label: t('Every 5 minutes'), expr: '*/5 * * * *' },
    { label: t('Every hour'), expr: '0 * * * *' },
    { label: t('Daily at 9am'), expr: '0 9 * * *' },
    { label: t('Weekdays at 5pm'), expr: '0 17 * * 1-5' }
  ]

  const cronLine = !cronCheck
    ? t('Cron format: minute, hour, day of month, month, weekday. Pick a preset or type your own.')
    : cronCheck.valid
      ? (cronCheck.description ?? t('Valid schedule')) +
        (cronCheck.nextFireAt
          ? ' · ' + tf('next run {when}', { when: new Date(cronCheck.nextFireAt).toLocaleString() })
          : '')
      : (cronCheck.error ?? t('That schedule does not parse.'))

  return (
    <SettingsSection
      label={t('Scheduled')}
      description={t('Runs your prompt as a read-only agent over your vault at the times you set, and keeps the last answer here.')}
    >
      <ToggleRow
        label={t('Run automations on their schedule')}
        hint={t('Off by default. A scheduled run is a real agent turn and costs tokens. Run now always works. The same automation fires at most once every 5 minutes.')}
        checked={schedulesOn}
        onChange={(next) => updateSettings({ automationsEnabled: next })}
      />
      <ToggleRow
        label={t('Background autonomy')}
        hint={
          <>
            {t('Lets schedules and loops run unattended and use tools. They stay confined to your vault unless Full computer access is on')}{' '}
            (<SettingsLink tab="general">{t('General')}</SettingsLink>).{' '}
            {t('DUIN also tunes its own retrieval settings on a timer; every change is snapshotted and can be undone. When off, nothing runs unattended and DUIN never edits its own settings.')}
          </>
        }
        checked={autonomy}
        onChange={confirmAutonomy}
      />
      {schedulesOn && !autonomy && (
        <SettingsRow
          tone="warning"
          label={t('Schedules are paused until Background autonomy is on.')}
          hint={t('Turn on Background autonomy above and they start firing. Run now still works.')}
        />
      )}

      <SettingsRow label={t('New automation')} hint={t('A name, a schedule, and the question you want answered.')}>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="automation-name" className={FIELD_LABEL}>
                {t('Name')}
              </label>
              <Input
                id="automation-name"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t('Morning catch-up')}
                disabled={adding}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="automation-model" className={FIELD_LABEL}>
                {t('Model')}
              </label>
              <Select
                id="automation-model"
                className="w-full"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={adding}
              >
                <option value="">{t('Follow my provider order')}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.id}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <label htmlFor="automation-cron" className={FIELD_LABEL}>
              {t('Schedule')}
            </label>
            <Input
              id="automation-cron"
              className="font-mono"
              value={cron}
              onChange={(e) => {
                setCron(e.target.value)
                setCronCheck(null)
              }}
              onBlur={() => void checkCron(cron)}
              placeholder={DEFAULT_CRON}
              spellCheck={false}
              disabled={adding}
            />
            <div className="flex flex-wrap gap-1">
              {presets.map((p) => (
                <Button key={p.expr} size="sm" variant="ghost" onClick={() => pickPreset(p.expr)} disabled={adding}>
                  {p.label}
                </Button>
              ))}
            </div>
            <p
              aria-live="polite"
              className={'text-[11px] ' + (cronCheck && !cronCheck.valid ? 'text-[var(--error)]' : 'text-[var(--text-muted)]')}
            >
              {cronLine}
            </p>
          </div>
          <div className="space-y-1">
            <label htmlFor="automation-prompt" className={FIELD_LABEL}>
              {t('Prompt')}
            </label>
            <textarea
              id="automation-prompt"
              className={TEXTAREA}
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('Every morning: what did I leave open yesterday?')}
              disabled={adding}
            />
          </div>
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => void handleCreate()} disabled={adding}>
              {adding ? t('Saving…') : t('Add automation')}
            </Button>
          </div>
        </div>
      </SettingsRow>

      <PanelState
        state={items}
        loading={<SettingsLoading what={t('automations')} />}
        error={(message, retry) => <SettingsLoadError what={t('automations')} message={message} onRetry={retry} />}
        empty={<p className="text-[12px] text-[var(--text-muted)]">{t('No automations yet.')}</p>}
        onRetry={() => void refresh()}
      >
        {(list) => (
          <>
            {list.map((a) => (
              <SettingsRow
                key={a.id}
                label={a.label}
                hint={
                  <span className="font-mono text-[11px]">
                    {a.scheduleLabel ? `${a.scheduleLabel} · ` : ''}
                    {a.cron}
                    {a.model ? ` · ${a.model}` : ''}
                  </span>
                }
                control={
                  <>
                    <Button size="sm" variant="ghost" disabled={busyId === a.id} onClick={() => void runNow(a)}>
                      {t('Run now')}
                    </Button>
                    <Button size="sm" variant="danger" disabled={busyId === a.id} onClick={() => void remove(a)}>
                      {t('Delete')}
                    </Button>
                    <Toggle
                      checked={a.enabled}
                      disabled={busyId === a.id}
                      aria-label={tf('Run "{name}" on its schedule', { name: a.label })}
                      onChange={(next) => void toggleEnabled(a, next)}
                    />
                  </>
                }
              >
                <p className="break-words text-[12px] text-[var(--text-secondary)]">{a.prompt}</p>
                {a.lastRunAt ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11px] text-[var(--text-muted)]">
                      {tf('Last run {when}', { when: new Date(a.lastRunAt).toLocaleString() })}
                    </summary>
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-[var(--bg-secondary)] p-2 font-mono text-[11px] text-[var(--text-secondary)]">
                      {a.lastResult || t('(no output)')}
                    </pre>
                  </details>
                ) : null}
              </SettingsRow>
            ))}
          </>
        )}
      </PanelState>
    </SettingsSection>
  )
}
