import { t, tf } from '@/lib/i18n'
import { useCallback, useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { PanelState } from '@/components/ui/PanelState'
import {
  ProviderKeyCard,
  SettingsLoadError,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  type KeyStatus
} from '@/components/ui/settings'
import { invoke, query } from '@/lib/ipc-client'
import { describeError } from '@/lib/result'
import { panelFromResult, panelLoading, type PanelStatus } from '@/lib/panel-state'
import { useDirtyGuard } from '@/hooks/useDirtyGuard'
import { toast } from '@/stores/toast-store'
import { ensurePlaintextConsentIfNeeded } from '@/lib/keychain-consent'
import {
  deleteTargetProvider,
  deleteDisabledReason,
  canDeleteKey
} from './current-info-delete'

// Current-information provider settings panel. Lets the user pick the finance/weather
// provider and (where required) store the API key in the main-process keychain. Sports
// uses TheSportsDB only, so it's a status row, not a chooser.
//
// `window.api.currentInfo` is exposed from electron/preload.ts.

type Kind = 'finance' | 'weather' | 'sports'
type FinanceProvider = 'finnhub' | 'alphavantage'
type WeatherProvider = 'open-meteo' | 'openweather'

interface ProviderStatus {
  finance: { provider: FinanceProvider; hasKey: boolean }
  weather: { provider: WeatherProvider; hasKey: boolean; keyRequired: boolean }
  sports: { provider: 'thesportsdb'; hasKey: boolean; keyRequired: boolean }
}

interface CurrentInfoSnapshot {
  settings: { financeProvider: FinanceProvider; weatherProvider: WeatherProvider }
  status: ProviderStatus
}

interface TestResult {
  ok: boolean
  reason?: string
}

const FINANCE_LABEL: Record<FinanceProvider, string> = {
  finnhub: 'Finnhub',
  alphavantage: 'Alpha Vantage'
}
const FINANCE_DOCS: Record<FinanceProvider, string> = {
  finnhub: 'https://finnhub.io/dashboard',
  alphavantage: 'https://www.alphavantage.co/support/#api-key'
}
const WEATHER_LABEL: Record<WeatherProvider, string> = {
  'open-meteo': 'Open-Meteo',
  openweather: 'OpenWeatherMap'
}
const WEATHER_DOCS: Record<WeatherProvider, string | null> = {
  'open-meteo': null,
  openweather: 'https://openweathermap.org/api'
}

/**
 * Key status for the provider the dropdown shows. Main reports `hasKey` only for the SAVED
 * provider, so for an unsaved switch the honest answer is `unknown` — not "No key", which
 * would be a claim about a slot nobody read.
 */
function draftKeyStatus(saved: { provider: string; hasKey: boolean }, draftProvider: string): KeyStatus {
  if (draftProvider !== saved.provider) return 'unknown'
  return saved.hasKey ? 'stored' : 'none'
}

export function CurrentInfoSettings() {
  const [snapshot, setSnapshot] = useState<PanelStatus<CurrentInfoSnapshot>>(panelLoading())
  const [financeProvider, setFinanceProvider] = useState<FinanceProvider>('finnhub')
  const [weatherProvider, setWeatherProvider] = useState<WeatherProvider>('open-meteo')
  const [busy, setBusy] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<Kind, TestResult | null>>({
    finance: null,
    weather: null,
    sports: null
  })
  const financeSelectId = useId()
  const weatherSelectId = useId()

  const refresh = useCallback(async () => {
    const r = await query<CurrentInfoSnapshot>('live data providers', () => window.api.currentInfo.getProvider())
    if (r.ok) {
      setFinanceProvider(r.data.settings.financeProvider)
      setWeatherProvider(r.data.settings.weatherProvider)
    }
    setSnapshot(panelFromResult(r))
  }, [])

  useEffect(() => {
    setSnapshot(panelLoading())
    void refresh()
  }, [refresh])

  const status = snapshot.phase === 'ready' ? snapshot.data.status : null
  const savedFinance = snapshot.phase === 'ready' ? snapshot.data.settings.financeProvider : null
  const savedWeather = snapshot.phase === 'ready' ? snapshot.data.settings.weatherProvider : null
  const financeDirty = savedFinance !== null && financeProvider !== savedFinance
  const weatherDirty = savedWeather !== null && weatherProvider !== savedWeather
  useDirtyGuard('settings:currentInfo:providers', t('the live data providers form'), financeDirty || weatherDirty)

  /** Persist a provider switch (optionally with a key). `apiKey` null deletes the stored key. */
  const write = async (
    kind: 'finance' | 'weather',
    provider: string,
    opts: { apiKey?: string | null },
    label: string
  ): Promise<boolean> => {
    setBusy(kind)
    setTestResult((r) => ({ ...r, [kind]: null }))
    try {
      // The preload types `apiKey` as string-only; main's handler takes `null` to delete the key
      // (electron/ipc/current-info.ts). The cast is the renderer-side half of that contract.
      await invoke('save the provider', () =>
        window.api.currentInfo.setProvider(kind, provider, opts as { apiKey?: string })
      )
      await refresh()
      return true
    } catch (e) {
      toast.error(describeError(e, tf('Could not save the {name} settings', { name: label })))
      return false
    } finally {
      setBusy(null)
    }
  }

  const switchProvider = async (kind: 'finance' | 'weather') => {
    // A SWITCH targets the dropdown draft by definition (a delete never does — see deleteKey).
    const provider = { finance: financeProvider, weather: weatherProvider }[kind]
    const label = kind === 'finance' ? t('stock quotes') : t('weather')
    if (await write(kind, provider, {}, label)) toast.success(tf('{name} provider updated', { name: label }))
  }

  const saveKey = async (kind: 'finance' | 'weather', key: string): Promise<boolean> => {
    // SEC-10: only consent-gate when a real key is being persisted.
    const consent = await ensurePlaintextConsentIfNeeded()
    if (!consent) return false
    const provider = { finance: financeProvider, weather: weatherProvider }[kind]
    const label = kind === 'finance' ? FINANCE_LABEL[financeProvider] : WEATHER_LABEL[weatherProvider]
    const ok = await write(kind, provider, { apiKey: key }, label)
    if (ok) toast.success(tf('{name} key saved', { name: label }))
    return ok
  }

  const testProvider = async (kind: Kind) => {
    const label = kind === 'finance' ? t('Stock quotes') : kind === 'weather' ? t('Weather') : t('Sports')
    setBusy(kind)
    setTestResult((r) => ({ ...r, [kind]: null }))
    try {
      const r = await query<TestResult>('the provider test', () => window.api.currentInfo.test(kind))
      if (!r.ok) {
        setTestResult((s) => ({ ...s, [kind]: { ok: false, reason: r.error } }))
        toast.error(tf('{name} test failed: {reason}', { name: label, reason: r.error }))
        return
      }
      setTestResult((s) => ({ ...s, [kind]: r.data }))
      if (r.data.ok) toast.success(tf('{name} provider works', { name: label }))
      else toast.error(tf('{name} test failed: {reason}', { name: label, reason: r.data.reason ?? t('unknown error') }))
    } finally {
      setBusy(null)
    }
  }

  const deleteKey = async (kind: 'finance' | 'weather') => {
    // U13: the target is the SAVED provider, never the dropdown draft. Aiming at the draft
    // deleted the newly-selected provider's empty slot, left the real key on disk, and
    // switched the live provider on the way past.
    const provider = deleteTargetProvider(kind, status)
    if (!provider) return
    // Re-check rather than trusting the button: status can change under an open panel.
    // `draft` is read ONLY to detect an unsaved switch, never passed as the target.
    const draft = { finance: financeProvider, weather: weatherProvider }[kind]
    const blocked = deleteDisabledReason(kind, status, draft)
    if (blocked) {
      toast.error(blocked)
      return
    }
    const label = kind === 'finance' ? FINANCE_LABEL[provider as FinanceProvider] : WEATHER_LABEL[provider as WeatherProvider]
    if (await write(kind, provider, { apiKey: null }, label)) toast.success(tf('{name} key deleted', { name: label }))
  }

  const resultLine = (kind: Kind): React.ReactNode => {
    const r = testResult[kind]
    if (!r) return null
    return (
      <p className={`text-[12px] ${r.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>
        {r.ok ? t('Works.') : (r.reason ?? t('failed'))}
      </p>
    )
  }

  return (
    <SettingsPage
      purpose={
        <>
          {t('Live data for chat: stock quotes, weather and sports. Weather and sports work without a key.')}{' '}
          {t('Stored encrypted on this computer and sent only to that provider.')}
        </>
      }
    >
      <PanelState
        state={snapshot}
        loading={<SettingsLoading what={t('live data providers')} />}
        error={(message, retry) => <SettingsLoadError what={t('live data providers')} message={message} onRetry={retry} />}
        empty={<p className="text-[12px] text-[var(--text-muted)]">{t('No live data providers are available in this build.')}</p>}
        isEmpty={(data) => !data.status}
        onRetry={() => void refresh()}
      >
        {(data) => {
          const finance = data.status.finance
          const weather = data.status.weather
          const sports = data.status.sports
          const financeKeyStatus = draftKeyStatus(finance, financeProvider)
          // Both finance providers need a key: a switch is only safe once one is stored for
          // the target. A typed key goes through the key card, which saves the switch with it.
          const financeSwitchBlocked = financeDirty && financeKeyStatus !== 'stored'
          const weatherNeedsKey = weatherProvider === 'openweather'
          const weatherKeyStatus = weatherNeedsKey ? draftKeyStatus(weather, weatherProvider) : 'stored'
          const weatherSwitchBlocked = weatherDirty && weatherNeedsKey && weatherKeyStatus !== 'stored'
          const financeDeleteBlocked = deleteDisabledReason('finance', data.status, financeProvider)
          const weatherDeleteBlocked = deleteDisabledReason('weather', data.status, weatherProvider)
          return (
            <>
              <SettingsSection label={t('Stock quotes')}>
                <SettingsRow
                  label={t('Provider')}
                  hint={
                    finance.hasKey
                      ? tf('{name} is saved with a key.', { name: FINANCE_LABEL[finance.provider] })
                      : t('Both providers need a key. Quotes fail until one is saved.')
                  }
                  tone={finance.hasKey ? 'default' : 'warning'}
                  control={
                    <>
                      <label htmlFor={financeSelectId} className="sr-only">
                        {t('Stock quotes provider')}
                      </label>
                      <Select
                        id={financeSelectId}
                        value={financeProvider}
                        onChange={(e) => setFinanceProvider(e.target.value as FinanceProvider)}
                        disabled={busy === 'finance'}
                      >
                        <option value="finnhub">{t('Finnhub')}</option>
                        <option value="alphavantage">{t('Alpha Vantage')}</option>
                      </Select>
                      {financeDirty && (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => void switchProvider('finance')}
                          disabled={busy === 'finance' || financeSwitchBlocked}
                        >
                          {t('Save')}
                        </Button>
                      )}
                      <Button size="sm" onClick={() => void testProvider('finance')} disabled={busy === 'finance' || !finance.hasKey}>
                        {t('Test')}
                      </Button>
                    </>
                  }
                >
                  {financeSwitchBlocked && (
                    <p className="mb-2 text-[12px] text-[var(--text-muted)]">
                      {tf('Paste the {name} key below to switch to it.', { name: FINANCE_LABEL[financeProvider] })}
                    </p>
                  )}
                  <ProviderKeyCard
                    name={FINANCE_LABEL[financeProvider]}
                    status={financeKeyStatus}
                    note={
                      financeKeyStatus === 'unknown'
                        ? t('Whether a key is saved for this provider is known once you switch to it.')
                        : undefined
                    }
                    docs={{ href: FINANCE_DOCS[financeProvider], label: t('Get a key') }}
                    busy={busy === 'finance'}
                    onSave={(key) => saveKey('finance', key)}
                    onDelete={canDeleteKey('finance', data.status, financeProvider) ? () => deleteKey('finance') : undefined}
                  >
                    {financeDeleteBlocked && finance.hasKey && financeProvider !== finance.provider && (
                      <p className="text-[12px] text-[var(--text-muted)]">{financeDeleteBlocked}</p>
                    )}
                    {resultLine('finance')}
                  </ProviderKeyCard>
                </SettingsRow>
              </SettingsSection>

              <SettingsSection label={t('Weather')}>
                <SettingsRow
                  label={t('Provider')}
                  hint={
                    !weather.keyRequired
                      ? t('Open-Meteo is free and needs no key.')
                      : weather.hasKey
                        ? t('OpenWeatherMap is saved with a key.')
                        : t('OpenWeatherMap needs a key. Weather fails until one is saved.')
                  }
                  tone={weather.keyRequired && !weather.hasKey ? 'warning' : 'default'}
                  control={
                    <>
                      <label htmlFor={weatherSelectId} className="sr-only">
                        {t('Weather provider')}
                      </label>
                      <Select
                        id={weatherSelectId}
                        value={weatherProvider}
                        onChange={(e) => setWeatherProvider(e.target.value as WeatherProvider)}
                        disabled={busy === 'weather'}
                      >
                        <option value="open-meteo">{t('Open-Meteo (free, no key)')}</option>
                        <option value="openweather">{t('OpenWeatherMap')}</option>
                      </Select>
                      {weatherDirty && (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => void switchProvider('weather')}
                          disabled={busy === 'weather' || weatherSwitchBlocked}
                        >
                          {t('Save')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        onClick={() => void testProvider('weather')}
                        disabled={busy === 'weather' || (weather.keyRequired && !weather.hasKey)}
                      >
                        {t('Test')}
                      </Button>
                    </>
                  }
                >
                  {weatherSwitchBlocked && (
                    <p className="mb-2 text-[12px] text-[var(--text-muted)]">
                      {t('Paste the OpenWeatherMap key below to switch to it.')}
                    </p>
                  )}
                  {weatherNeedsKey ? (
                    <ProviderKeyCard
                      name={WEATHER_LABEL.openweather}
                      status={weatherKeyStatus}
                      note={
                        weatherKeyStatus === 'unknown'
                          ? t('Whether a key is saved for this provider is known once you switch to it.')
                          : undefined
                      }
                      docs={WEATHER_DOCS.openweather ? { href: WEATHER_DOCS.openweather, label: t('Get a key') } : undefined}
                      busy={busy === 'weather'}
                      onSave={(key) => saveKey('weather', key)}
                      onDelete={canDeleteKey('weather', data.status, weatherProvider) ? () => deleteKey('weather') : undefined}
                    >
                      {weatherDeleteBlocked && weather.keyRequired && weather.hasKey && weatherProvider !== weather.provider && (
                        <p className="text-[12px] text-[var(--text-muted)]">{weatherDeleteBlocked}</p>
                      )}
                      {resultLine('weather')}
                    </ProviderKeyCard>
                  ) : (
                    resultLine('weather')
                  )}
                </SettingsRow>
              </SettingsSection>

              <SettingsSection label={t('Sports')}>
                <SettingsRow
                  label={
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                          !sports.keyRequired || sports.hasKey ? 'bg-[var(--success)]' : 'bg-[var(--warning)]'
                        }`}
                      />
                      TheSportsDB
                    </span>
                  }
                  hint={t('Sports lookups use the free TheSportsDB service. Nothing to set up.')}
                  control={
                    <Button size="sm" onClick={() => void testProvider('sports')} disabled={busy === 'sports'}>
                      {t('Test')}
                    </Button>
                  }
                >
                  {resultLine('sports')}
                </SettingsRow>
              </SettingsSection>
            </>
          )
        }}
      </PanelState>
    </SettingsPage>
  )
}
