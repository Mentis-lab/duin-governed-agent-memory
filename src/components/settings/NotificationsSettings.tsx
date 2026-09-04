import { t } from '@/lib/i18n'
import { useCallback, useEffect, useState } from 'react'
import { useSettingsStore } from '@/stores/settings-store'
import { toast } from '@/stores/toast-store'
import { invoke, query } from '@/lib/ipc-client'
import { describeError } from '@/lib/result'
import { panelFromResult, panelLoading, panelReady, type PanelStatus } from '@/lib/panel-state'
import { PanelState } from '@/components/ui/PanelState'
import { Select } from '@/components/ui/Select'
import { SettingsPage, SettingsSection, ToggleRow, SettingsLoadError, SettingsLoading } from '@/components/ui/settings'

// The on-ramp for a subsystem that shipped complete and unreachable: six watchers, a
// quiet-hours window and the daily digest all existed, were tested, and had no control
// anywhere in the app. Everything here writes a key a main-process service already reads.

type WatcherKey = 'jobFail' | 'task' | 'forecast' | 'forecastOwed' | 'confidentMiss' | 'calibration'

interface WatchDef {
  key: WatcherKey
  label: () => string
  hint: () => string
}

// Every watcher main reads (watchers.ts, parseWatchersConfig) has a row. All six live in
// the settings defaults (settings-store.ts / default-app-settings.ts), so each key written
// here round-trips through settings.json and back.
const WATCHERS: WatchDef[] = [
  {
    key: 'jobFail',
    label: () => t('A scheduled job fails'),
    hint: () => t('The most useful one to leave on: it only speaks up when something broke.')
  },
  {
    key: 'task',
    label: () => t('A high-priority task appears'),
    hint: () => t('When something lands marked P0 or urgent.')
  },
  {
    key: 'forecast',
    label: () => t('A forecast resolves'),
    hint: () => t('When a prediction you made comes due and gets scored.')
  },
  {
    key: 'forecastOwed',
    label: () => t('A forecast is overdue for review'),
    hint: () => t('When a prediction is past its review date and still has no verdict from you.')
  },
  {
    key: 'confidentMiss',
    label: () => t('A confident prediction was wrong'),
    hint: () => t('When a prediction you were at least 60% sure of turned out wrong.')
  },
  {
    key: 'calibration',
    label: () => t('Your calibration drifts'),
    hint: () => t('When a confidence tier starts missing by more than it should.')
  }
]

interface DigestSchedule {
  enabled: boolean
  hour: number
  minute: number
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)

export function NotificationsSettings(): React.ReactElement {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const watchers = settings?.watchers
  const [digest, setDigest] = useState<PanelStatus<DigestSchedule>>(panelLoading())

  const digestWhat = t('the daily digest schedule')

  const loadDigest = useCallback(async () => {
    setDigest(panelLoading())
    const r = await query(digestWhat, () => window.api.notifications.getDigestSchedule())
    setDigest(panelFromResult(r))
  }, [digestWhat])

  useEffect(() => {
    void loadDigest()
  }, [loadDigest])

  const setWatcher = (key: WatcherKey, value: boolean): Promise<boolean> | void => {
    if (!watchers) return
    return updateSettings({ watchers: { ...watchers, [key]: value } })
  }

  const setQuietHours = (start: number, end: number): Promise<boolean> | void => {
    if (!watchers) return
    return updateSettings({ watchers: { ...watchers, quietHours: { start, end } } })
  }

  // Main normalizes the schedule (clamps the hour and minute) and returns what it
  // actually armed; that, not the draft, is what the row shows afterwards.
  const saveDigest = async (next: DigestSchedule): Promise<boolean> => {
    try {
      const applied = await invoke(t('save the daily digest'), () => window.api.notifications.setDigestSchedule(next))
      setDigest(panelReady(applied))
      return true
    } catch (e) {
      toast.error(describeError(e, t('Could not save the daily digest')))
      return false
    }
  }

  // Quiet hours are "on" when start and end differ (main reads start === end as
  // disabled). Each picker hides the other bound's hour, so editing one bound can never
  // make them equal and switch the window off mid-edit.
  const quiet = watchers?.quietHours ?? { start: 0, end: 0 }
  const quietOn = quiet.start !== quiet.end

  return (
    <SettingsPage purpose={t('Tell me when — these land in Home under Needs you, and as a desktop notification.')}>
      <SettingsSection
        label={t('Tell me when')}
        description={t('Anything that happens while a watcher is off is not recorded, so turn on what you would want to know about.')}
      >
        {WATCHERS.map((w) => (
          <ToggleRow
            key={w.key}
            label={w.label()}
            hint={w.hint()}
            checked={watchers?.[w.key] === true}
            disabled={!watchers}
            onChange={(v) => setWatcher(w.key, v)}
          />
        ))}
      </SettingsSection>

      <SettingsSection label={t('Quiet hours')}>
        <ToggleRow
          label={t('Quiet hours')}
          hint={t('Stop desktop notifications during these hours. They still land in Home, so a 3am failure waits for you in the morning instead of getting lost.')}
          checked={quietOn}
          disabled={!watchers}
          onChange={(on) => (on ? setQuietHours(22, 7) : setQuietHours(0, 0))}
        >
          {quietOn && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-[var(--text-secondary)]">
              <span className="flex items-center gap-2">
                <label htmlFor="quiet-hours-start">{t('Start')}</label>
                <HourSelect
                  id="quiet-hours-start"
                  label={t('Quiet hours start')}
                  value={quiet.start}
                  exclude={quiet.end}
                  onChange={(h) => void setQuietHours(h, quiet.end)}
                />
              </span>
              <span className="flex items-center gap-2">
                <label htmlFor="quiet-hours-end">{t('End')}</label>
                <HourSelect
                  id="quiet-hours-end"
                  label={t('Quiet hours end')}
                  value={quiet.end}
                  exclude={quiet.start}
                  onChange={(h) => void setQuietHours(quiet.start, h)}
                />
              </span>
            </div>
          )}
        </ToggleRow>
      </SettingsSection>

      <SettingsSection label={t('Daily digest')}>
        <PanelState
          state={digest}
          loading={<SettingsLoading what={digestWhat} />}
          error={(message, retry) => <SettingsLoadError what={digestWhat} message={message} onRetry={retry} />}
          empty={null}
          isEmpty={() => false}
          onRetry={() => void loadDigest()}
        >
          {(schedule) => (
            <ToggleRow
              label={t('Daily digest')}
              hint={t('One notification a day pointing you back at your brain. Only fires while DUIN is running.')}
              checked={schedule.enabled}
              onChange={(on) => saveDigest({ ...schedule, enabled: on })}
            >
              {schedule.enabled && (
                <div className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
                  <label htmlFor="digest-hour">{t('Time')}</label>
                  <HourSelect
                    id="digest-hour"
                    label={t('Digest hour')}
                    value={schedule.hour}
                    onChange={(h) => void saveDigest({ ...schedule, hour: h })}
                  />
                </div>
              )}
            </ToggleRow>
          )}
        </PanelState>
      </SettingsSection>
    </SettingsPage>
  )
}

function HourSelect({
  id,
  label,
  value,
  exclude,
  onChange
}: {
  id: string
  label: string
  value: number
  /** An hour never offered — the other bound of a window that must stay open. */
  exclude?: number
  onChange: (hour: number) => void
}): React.ReactElement {
  return (
    <Select
      id={id}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="tabular-nums"
    >
      {HOURS.filter((h) => h !== exclude).map((h) => (
        <option key={h} value={h}>
          {String(h).padStart(2, '0')}:00
        </option>
      ))}
    </Select>
  )
}
