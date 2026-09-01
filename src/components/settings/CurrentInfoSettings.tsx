import { t } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { toast } from '@/stores/toast-store'
import { ensurePlaintextConsentIfNeeded } from '@/lib/keychain-consent'
import {
  deleteTargetProvider,
  deleteDisabledReason,
  canDeleteKey
} from './current-info-delete'

// Current-information provider settings panel. Lets the user pick the
// finance/weather provider and (where required) store the API key in the
// main-process keychain. Sports uses TheSportsDB only, so it's a status row,
// not a chooser.
//
// `window.api.currentInfo` is exposed from electron/preload.ts. The cast
// below keeps this file independently type-checkable.

type Kind = 'finance' | 'weather' | 'sports'
type FinanceProvider = 'finnhub' | 'alphavantage'
type WeatherProvider = 'open-meteo' | 'openweather'

interface ProviderStatus {
  finance: { provider: FinanceProvider; hasKey: boolean }
  weather: { provider: WeatherProvider; hasKey: boolean; keyRequired: boolean }
  sports: { provider: 'thesportsdb'; hasKey: boolean; keyRequired: boolean }
}

interface CurrentInfoApi {
  setProvider: (
    kind: Kind,
    provider: string,
    opts?: { apiKey?: string | null }
  ) => Promise<{ success: boolean; data?: any; error?: string }>
  getProvider: (kind?: Kind) => Promise<{ success: boolean; data?: any; error?: string }>
  test: (kind: Kind) => Promise<{ success: boolean; data?: { ok: boolean; reason?: string }; error?: string }>
}

function getApi(): CurrentInfoApi | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { api?: { currentInfo?: CurrentInfoApi } }
  return w.api?.currentInfo ?? null
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
  'open-meteo': 'Open-Meteo (free, no key)',
  openweather: 'OpenWeatherMap'
}
const WEATHER_DOCS: Record<WeatherProvider, string | null> = {
  'open-meteo': null,
  openweather: 'https://openweathermap.org/api'
}

export function CurrentInfoSettings() {
  const [status, setStatus] = useState<ProviderStatus | null>(null)
  const [financeProvider, setFinanceProvider] = useState<FinanceProvider>('finnhub')
  const [weatherProvider, setWeatherProvider] = useState<WeatherProvider>('open-meteo')
  const [financeKey, setFinanceKey] = useState('')
  const [weatherKey, setWeatherKey] = useState('')
  const [showFinanceKey, setShowFinanceKey] = useState(false)
  const [showWeatherKey, setShowWeatherKey] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<Kind, { ok: boolean; reason?: string } | null>>(
    { finance: null, weather: null, sports: null }
  )

  const refresh = async () => {
    const api = getApi()
    if (!api) return
    const res = await api.getProvider()
    if (res.success && res.data) {
      const settings = res.data.settings as {
        financeProvider: FinanceProvider
        weatherProvider: WeatherProvider
      }
      setFinanceProvider(settings.financeProvider)
      setWeatherProvider(settings.weatherProvider)
      setStatus(res.data.status as ProviderStatus)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const saveFinance = async () => {
    const api = getApi()
    if (!api) return
    const trimmed = financeKey.trim()
    // SEC-10: only consent-gate when a real key is being persisted. A
    // provider switch without a key payload doesn't touch the keychain.
    if (trimmed) {
      const consent = await ensurePlaintextConsentIfNeeded()
      if (!consent) return
    }
    setBusy('finance')
    setTestResult((r) => ({ ...r, finance: null }))
    try {
      const res = await api.setProvider('finance', financeProvider, {
        apiKey: trimmed ? trimmed : undefined
      })
      if (!res.success) {
        toast.error(`Failed to save finance settings: ${res.error ?? 'unknown error'}`)
        return
      }
      if (trimmed) toast.success(`${FINANCE_LABEL[financeProvider]} key saved`)
      else toast.success('Finance provider updated')
      setFinanceKey('')
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const saveWeather = async () => {
    const api = getApi()
    if (!api) return
    const trimmed = weatherKey.trim()
    // SEC-10: same per-key gate as finance — provider switches without a
    // key payload don't reach the keychain.
    if (trimmed) {
      const consent = await ensurePlaintextConsentIfNeeded()
      if (!consent) return
    }
    setBusy('weather')
    setTestResult((r) => ({ ...r, weather: null }))
    try {
      const res = await api.setProvider('weather', weatherProvider, {
        apiKey: trimmed ? trimmed : undefined
      })
      if (!res.success) {
        toast.error(`Failed to save weather settings: ${res.error ?? 'unknown error'}`)
        return
      }
      if (trimmed) toast.success(`${WEATHER_LABEL[weatherProvider]} key saved`)
      else toast.success('Weather provider updated')
      setWeatherKey('')
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const testProvider = async (kind: Kind) => {
    const api = getApi()
    if (!api) return
    setBusy(kind)
    setTestResult((r) => ({ ...r, [kind]: null }))
    try {
      const res = await api.test(kind)
      if (!res.success || !res.data) {
        const reason = res.error ?? 'unknown error'
        setTestResult((r) => ({ ...r, [kind]: { ok: false, reason } }))
        toast.error(`${kind} test failed: ${reason}`)
        return
      }
      setTestResult((r) => ({ ...r, [kind]: res.data! }))
      if (res.data.ok) toast.success(`${kind} provider OK`)
      else toast.error(`${kind} test failed: ${res.data.reason ?? 'unknown error'}`)
    } finally {
      setBusy(null)
    }
  }

  const deleteKey = async (kind: 'finance' | 'weather') => {
    const api = getApi()
    if (!api) return
    // U13: the target is the SAVED provider, never the dropdown draft. Aiming
    // at the draft deleted the newly-selected provider's empty slot, left the
    // real key on disk, and toasted success — and switched the live provider
    // on the way past, because setProvider persists the switch before it acts
    // on `apiKey: null`.
    const provider = deleteTargetProvider(kind, status)
    if (!provider) return
    // Re-check rather than trusting the button: status can change under an
    // open panel (a Save in another window, a refresh mid-hover).
    // NB: read as `draft` and used ONLY to detect an unsaved switch. It is
    // deliberately never passed as the delete target.
    const draft = { finance: financeProvider, weather: weatherProvider }[kind]
    const blocked = deleteDisabledReason(kind, status, draft)
    if (blocked) {
      toast.error(blocked)
      return
    }
    if (!confirm(`Delete the stored ${kind} API key for ${provider}?`)) return
    setBusy(kind)
    try {
      const res = await api.setProvider(kind, provider, { apiKey: null })
      if (!res.success) {
        toast.error(`Failed to delete ${kind} key: ${res.error ?? 'unknown error'}`)
        return
      }
      toast.success(`${kind} key deleted for ${provider}`)
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const openDocs = (url: string | null) => {
    if (!url) return
    const w = window as unknown as {
      api?: { artifact?: { openExternal?: (u: string) => void } }
    }
    w.api?.artifact?.openExternal?.(url)
  }

  const financeStatus = status?.finance
  const weatherStatus = status?.weather
  const sportsStatus = status?.sports
  // Draft-derived: governs the key INPUT (you type a key for the provider you
  // are switching TO). Destructive actions must not use it — see
  // current-info-delete.ts.
  const weatherKeyRequired = weatherProvider === 'openweather'
  const financeDeleteBlocked = deleteDisabledReason('finance', status, financeProvider)
  const weatherDeleteBlocked = deleteDisabledReason('weather', status, weatherProvider)

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-mono text-[16px] font-semibold text-[var(--text-primary)]">{t('Current information')}</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
          Configure providers for the <code>finance_quote</code>, <code>weather_lookup</code>, and{' '}
          <code>sports_lookup</code> tools. Keys are stored in the main-process keychain and never reach
          the renderer.
        </p>
      </div>

      {/* Finance */}
      <div className="space-y-2 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={`inline-block h-2 w-2 rounded-full ${
              financeStatus?.hasKey ? 'bg-[var(--success)]' : 'bg-[var(--warning)]'
            }`}
          />
          <span className="font-mono text-[12px] font-semibold text-[var(--text-primary)]">{t('Finance')}</span>
          <span className="font-mono text-[12px] text-[var(--text-muted)]">
            {financeStatus?.hasKey ? 'Key stored' : 'No key'}
          </span>
        </div>
        {/* Both finance providers require a key, so "No key" means the TOOL is
            dead, not merely that a default is in use. Say which tool. */}
        {financeStatus && !financeStatus.hasKey && (
          <div className="text-[12px] text-[var(--warning)]">
            {t('finance_quote will fail until a key is saved — both providers require one.')}
          </div>
        )}
        <label className="block font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
          {t('Provider')}
        </label>
        <select
          value={financeProvider}
          onChange={(e) => setFinanceProvider(e.target.value as FinanceProvider)}
          className="w-full rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1.5 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        >
          <option value="finnhub">{t('Finnhub')}</option>
          <option value="alphavantage">{t('Alpha Vantage')}</option>
        </select>
        <a
          href={FINANCE_DOCS[financeProvider]}
          onClick={(e) => {
            e.preventDefault()
            openDocs(FINANCE_DOCS[financeProvider])
          }}
          className="inline-block font-mono text-[12px] text-[var(--accent)] hover:underline"
        >
          Get a {FINANCE_LABEL[financeProvider]} key →
        </a>
        <div className="flex gap-2">
          <input
            type={showFinanceKey ? 'text' : 'password'}
            value={financeKey}
            onChange={(e) => setFinanceKey(e.target.value)}
            placeholder={financeStatus?.hasKey ? 'Replace key…' : 'Paste API key'}
            className="flex-1 rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1.5 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <Button variant="secondary"
            onClick={() => setShowFinanceKey((s) => !s)}
          >
            {showFinanceKey ? 'Hide' : 'Show'}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="primary"
            onClick={saveFinance}
            disabled={busy === 'finance'}
          >
            {t('Save')}
          </Button>
          <Button variant="secondary"
            onClick={() => testProvider('finance')}
            disabled={busy === 'finance' || !financeStatus?.hasKey}
          >
            {t('Test')}
          </Button>
          <Button variant="danger"
            onClick={() => deleteKey('finance')}
            disabled={busy === 'finance' || !canDeleteKey('finance', status, financeProvider)}
            title={deleteDisabledReason('finance', status, financeProvider) ?? undefined}
          >
            {t('Delete key')}
          </Button>
          {financeDeleteBlocked && financeStatus?.hasKey && (
            <span className="text-[12px] text-[var(--text-muted)]">{financeDeleteBlocked}</span>
          )}
          {testResult.finance && (
            <span
              className={`text-[12px] ${
                testResult.finance.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'
              }`}
            >
              {testResult.finance.ok ? 'OK' : testResult.finance.reason ?? 'failed'}
            </span>
          )}
        </div>
      </div>

      {/* Weather */}
      <div className="space-y-2 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={`inline-block h-2 w-2 rounded-full ${
              !weatherStatus?.keyRequired || weatherStatus?.hasKey
                ? 'bg-[var(--success)]'
                : 'bg-[var(--warning)]'
            }`}
          />
          <span className="font-mono text-[12px] font-semibold text-[var(--text-primary)]">{t('Weather')}</span>
          <span className="font-mono text-[12px] text-[var(--text-muted)]">
            {!weatherStatus?.keyRequired
              ? 'No key required'
              : weatherStatus.hasKey
                ? 'Key stored'
                : 'No key'}
          </span>
        </div>
        <label className="block font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
          {t('Provider')}
        </label>
        <select
          value={weatherProvider}
          onChange={(e) => setWeatherProvider(e.target.value as WeatherProvider)}
          className="w-full rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1.5 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        >
          <option value="open-meteo">{t('Open-Meteo (free, no key)')}</option>
          <option value="openweather">{t('OpenWeatherMap')}</option>
        </select>
        {WEATHER_DOCS[weatherProvider] && (
          <a
            href={WEATHER_DOCS[weatherProvider] ?? '#'}
            onClick={(e) => {
              e.preventDefault()
              openDocs(WEATHER_DOCS[weatherProvider])
            }}
            className="inline-block font-mono text-[12px] text-[var(--accent)] hover:underline"
          >
            Get an {WEATHER_LABEL[weatherProvider]} key →
          </a>
        )}
        {weatherKeyRequired && (
          <div className="flex gap-2">
            <input
              type={showWeatherKey ? 'text' : 'password'}
              value={weatherKey}
              onChange={(e) => setWeatherKey(e.target.value)}
              placeholder={weatherStatus?.hasKey ? 'Replace key…' : 'Paste API key'}
              className="flex-1 rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1.5 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
            <Button variant="secondary"
              onClick={() => setShowWeatherKey((s) => !s)}
            >
              {showWeatherKey ? 'Hide' : 'Show'}
            </Button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="primary"
            onClick={saveWeather}
            disabled={busy === 'weather'}
          >
            {t('Save')}
          </Button>
          <Button variant="secondary"
            onClick={() => testProvider('weather')}
            disabled={
              busy === 'weather' || (weatherStatus?.keyRequired === true && !weatherStatus.hasKey)
            }
          >
            {t('Test')}
          </Button>
          {/* U13: keyed off the SAVED provider, not the dropdown draft. With
              open-meteo saved, `weatherKeyRequired` (draft-derived) rendered
              this button and open-meteo's forced `hasKey: true` left it
              ENABLED — one click switched the live provider to a keyless
              OpenWeatherMap and broke weather_lookup. */}
          {weatherStatus?.keyRequired === true && (
            <Button variant="danger"
              onClick={() => deleteKey('weather')}
              disabled={busy === 'weather' || !canDeleteKey('weather', status, weatherProvider)}
              title={deleteDisabledReason('weather', status, weatherProvider) ?? undefined}
            >
              {t('Delete key')}
            </Button>
          )}
          {weatherDeleteBlocked && weatherStatus?.keyRequired === true && (
            <span className="text-[12px] text-[var(--text-muted)]">{weatherDeleteBlocked}</span>
          )}
          {testResult.weather && (
            <span
              className={`text-[12px] ${
                testResult.weather.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'
              }`}
            >
              {testResult.weather.ok ? 'OK' : testResult.weather.reason ?? 'failed'}
            </span>
          )}
        </div>
      </div>

      {/* Sports */}
      <div className="space-y-2 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
        <div className="flex items-center gap-2">
          <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-[var(--success)]" />
          <span className="font-mono text-[12px] font-semibold text-[var(--text-primary)]">{t('Sports')}</span>
          <span className="font-mono text-[12px] text-[var(--text-muted)]">
            TheSportsDB · no key required
          </span>
        </div>
        <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
          Sports lookups use the free TheSportsDB v1 endpoints. No configuration required.
          {sportsStatus ? '' : ''}
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="secondary"
            onClick={() => testProvider('sports')}
            disabled={busy === 'sports'}
          >
            {t('Test')}
          </Button>
          {testResult.sports && (
            <span
              className={`text-[12px] ${
                testResult.sports.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'
              }`}
            >
              {testResult.sports.ok ? 'OK' : testResult.sports.reason ?? 'failed'}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
