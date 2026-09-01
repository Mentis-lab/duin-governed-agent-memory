import { t } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { Toggle } from '@/components/ui/Toggle'
import { useSettingsStore } from '@/stores/settings-store'

// The on-ramp for a subsystem that shipped complete and unreachable: six watchers, a
// quiet-hours window and the daily digest all existed, were tested, and had no control
// anywhere in the app. Everything here writes a key a main-process service already reads.

interface WatchDef {
  key: 'forecast' | 'calibration' | 'task' | 'jobFail'
  label: string
  hint: string
}

// Only the four watchers that DEFAULT_APP_SETTINGS declares are offered. The other two
// (`forecastOwed`, `confidentMiss`) exist in the parser but not in the settings default
// block, so surfacing them here would write a key nothing round-trips.
const WATCHERS: WatchDef[] = [
  {
    key: 'jobFail',
    label: 'A scheduled job fails',
    hint: 'The most useful one to leave on: it only speaks up when something broke.'
  },
  {
    key: 'task',
    label: 'A high-priority task appears',
    hint: 'When something lands marked P0 or urgent.'
  },
  {
    key: 'forecast',
    label: 'A forecast resolves',
    hint: 'When a prediction you made comes due and gets scored.'
  },
  {
    key: 'calibration',
    label: 'Your calibration drifts',
    hint: 'When a confidence tier starts missing by more than it should.'
  }
]

const HOURS = Array.from({ length: 24 }, (_, i) => i)

export function NotificationsSettings(): React.ReactElement {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const watchers = settings?.watchers
  const [digest, setDigest] = useState<{ enabled: boolean; hour: number; minute: number } | null>(
    null
  )

  useEffect(() => {
    void (async () => {
      const r = await window.api?.notifications?.getDigestSchedule?.()
      if (r?.success && r.data) setDigest(r.data)
    })()
  }, [])

  const setWatcher = (key: WatchDef['key'], value: boolean): void => {
    if (!watchers) return
    void updateSettings({ watchers: { ...watchers, [key]: value } })
  }

  const setQuietHours = (start: number, end: number): void => {
    if (!watchers) return
    void updateSettings({ watchers: { ...watchers, quietHours: { start, end } } })
  }

  const saveDigest = (next: { enabled: boolean; hour: number; minute: number }): void => {
    setDigest(next)
    void window.api?.notifications?.setDigestSchedule?.(next)
  }

  const quiet = watchers?.quietHours ?? { start: 0, end: 0 }
  const quietOn = quiet.start !== quiet.end

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-[14px] font-medium text-[var(--text-primary)]">{t('Tell me when')}</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
          These arrive in Status under &ldquo;Needs you&rdquo;, and as a desktop notification.
          Anything that happens while these are off is not recorded, so turn on what you
          would want to know about.
        </p>
        <div className="mt-3 divide-y divide-[var(--panel-border)]">
          {WATCHERS.map((w) => (
            <label
              key={w.key}
              htmlFor={`watch-${w.key}`}
              className="flex cursor-pointer items-start gap-3 py-2.5"
            >
              <Toggle
                id={`watch-${w.key}`}
                checked={watchers?.[w.key] === true}
                onChange={() => setWatcher(w.key, !(watchers?.[w.key] === true))}
                aria-label={w.label}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-[var(--text-primary)]">{w.label}</span>
                <span className="mt-0.5 block text-[12px] text-[var(--text-muted)]">{w.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-[14px] font-medium text-[var(--text-primary)]">{t('Quiet hours')}</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
          Stop desktop notifications during these hours. They still land in Status, so a
          3am failure is waiting for you in the morning rather than lost.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Toggle
            id="quiet-hours"
            checked={quietOn}
            onChange={() => (quietOn ? setQuietHours(0, 0) : setQuietHours(22, 7))}
            aria-label={t('Quiet hours')}
          />
          <label htmlFor="quiet-hours" className="text-[13px] text-[var(--text-primary)]">
            {t('Enabled')}
          </label>
          {quietOn && (
            <span className="flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
              <span>from</span>
              <HourSelect
                label={t('Quiet hours start')}
                value={quiet.start}
                onChange={(h) => setQuietHours(h, quiet.end)}
              />
              <span>to</span>
              <HourSelect
                label={t('Quiet hours end')}
                value={quiet.end}
                onChange={(h) => setQuietHours(quiet.start, h)}
              />
            </span>
          )}
        </div>
      </section>

      <section>
        <h3 className="text-[14px] font-medium text-[var(--text-primary)]">{t('Daily digest')}</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
          One notification a day pointing you back at your brain. Only fires while DUIN is
          running.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Toggle
            id="daily-digest"
            checked={digest?.enabled === true}
            onChange={() =>
              saveDigest({
                enabled: !(digest?.enabled === true),
                hour: digest?.hour ?? 8,
                minute: digest?.minute ?? 0
              })
            }
            aria-label={t('Daily digest')}
          />
          <label htmlFor="daily-digest" className="text-[13px] text-[var(--text-primary)]">
            {t('Enabled')}
          </label>
          {digest?.enabled && (
            <span className="flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
              <span>at</span>
              <HourSelect
                label={t('Digest hour')}
                value={digest.hour}
                onChange={(h) => saveDigest({ ...digest, hour: h })}
              />
            </span>
          )}
        </div>
      </section>
    </div>
  )
}

function HourSelect({
  label,
  value,
  onChange
}: {
  label: string
  value: number
  onChange: (hour: number) => void
}): React.ReactElement {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-1.5 py-1 text-[12px] tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
    >
      {HOURS.map((h) => (
        <option key={h} value={h}>
          {String(h).padStart(2, '0')}:00
        </option>
      ))}
    </select>
  )
}
