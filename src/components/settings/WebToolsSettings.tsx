import { t, tf } from '@/lib/i18n'
import { useCallback, useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { PanelState } from '@/components/ui/PanelState'
import {
  SettingsLink,
  SettingsLoadError,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  SettingsSection
} from '@/components/ui/settings'
import { invoke, query } from '@/lib/ipc-client'
import { describeError } from '@/lib/result'
import { panelFromResult, panelLoading, type PanelStatus } from '@/lib/panel-state'
import { useDirtyGuard } from '@/hooks/useDirtyGuard'
import { toast } from '@/stores/toast-store'

// Web-tools settings panel: which search provider powers web search in chat.
//
// Keys are NOT entered here. Brave / Tavily / SerpAPI keys live on the API Keys page
// (one home for keys); this page reads `hasKey` for each provider and links there.
// SearXNG needs the address of an instance instead. Settings persist under the
// `webTools` key of settings.json; the renderer never sees raw key material.

// SOURCE-LOCK: mirrors WebSearchProviderId in electron/services/web-search-adapters.ts.
type ProviderId = 'duckduckgo' | 'brave' | 'tavily' | 'serpapi' | 'searxng' | 'wikipedia'

interface ProviderEntry {
  id: ProviderId
  label: string
  requiresKey: boolean
  requiresEndpoint: boolean
  /** Whether this provider's adapter implements image search at all. */
  supportsImages?: boolean
  hasKey: boolean
  active: boolean
}

interface ProviderState {
  provider: ProviderId
  searxngEndpoint: string | null
  providers: ProviderEntry[]
}

interface TestStatus {
  ok: boolean
  message: string
}

const DOC_LINKS: Record<ProviderId, string> = {
  duckduckgo: 'https://duckduckgo.com/',
  brave: 'https://api.search.brave.com/app/keys',
  tavily: 'https://app.tavily.com/home',
  serpapi: 'https://serpapi.com/manage-api-key',
  searxng: 'https://docs.searxng.org/admin/installation.html',
  wikipedia: 'https://www.wikipedia.org/'
}

/** Short names for the provider rows; main's labels carry their own key notes. */
const PROVIDER_NAMES: Record<ProviderId, string> = {
  duckduckgo: 'DuckDuckGo',
  brave: 'Brave Search',
  tavily: 'Tavily',
  serpapi: 'SerpAPI',
  searxng: 'SearXNG',
  wikipedia: 'Wikipedia'
}

/** A SearXNG address must be a full http(s) URL, or the adapter builds requests against nothing. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim())
}

export function WebToolsSettings() {
  const [state, setState] = useState<PanelStatus<ProviderState>>(panelLoading())
  const [endpoint, setEndpoint] = useState<string>('')
  const [endpointError, setEndpointError] = useState<string | null>(null)
  const [busy, setBusy] = useState<ProviderId | 'test' | null>(null)
  const [testStatus, setTestStatus] = useState<TestStatus | null>(null)
  const endpointId = useId()

  const refresh = useCallback(async () => {
    const r = await query<ProviderState>('web tools settings', () => window.api.webTools.getProvider())
    if (r.ok) setEndpoint(r.data.searxngEndpoint ?? '')
    setState(panelFromResult(r))
  }, [])

  useEffect(() => {
    setState(panelLoading())
    void refresh()
  }, [refresh])

  const savedEndpoint = state.phase === 'ready' ? (state.data.searxngEndpoint ?? '') : ''
  useDirtyGuard('settings:webTools:searxng', t('the SearXNG address'), endpoint.trim() !== savedEndpoint.trim())

  const activate = async (p: ProviderEntry) => {
    setBusy(p.id)
    try {
      // SearXNG: main REPLACES the stored address with what this call carries, so the
      // saved one has to ride along or activating the provider would wipe it.
      const opts = p.id === 'searxng' && savedEndpoint ? { endpoint: savedEndpoint } : {}
      await invoke('activate the provider', () => window.api.webTools.setProvider(p.id, opts))
      toast.success(tf('Web search now uses {name}', { name: PROVIDER_NAMES[p.id] }))
      await refresh()
    } catch (e) {
      toast.error(describeError(e, tf('Could not switch to {name}', { name: PROVIDER_NAMES[p.id] })))
    } finally {
      setBusy(null)
    }
  }

  const saveEndpoint = async () => {
    const trimmed = endpoint.trim()
    if (!isHttpUrl(trimmed)) {
      setEndpointError(t('Enter the full address, starting with http:// or https://'))
      return
    }
    setEndpointError(null)
    setBusy('searxng')
    try {
      await invoke('save the SearXNG address', () => window.api.webTools.setProvider('searxng', { endpoint: trimmed }))
      toast.success(t('SearXNG address saved'))
      await refresh()
    } catch (e) {
      toast.error(describeError(e, t('Could not save the SearXNG address')))
    } finally {
      setBusy(null)
    }
  }

  const runTest = async () => {
    setBusy('test')
    setTestStatus(null)
    try {
      const r = await query<{ ok: boolean; error?: string }>('the web search test', () => window.api.webTools.testAdapter())
      if (!r.ok) {
        setTestStatus({ ok: false, message: r.error })
        toast.error(tf('Web search test failed: {message}', { message: r.error }))
        return
      }
      if (r.data.ok) {
        setTestStatus({ ok: true, message: t('The provider answered with at least one result.') })
        toast.success(t('Web search test passed'))
      } else {
        const msg = r.data.error ?? t('The provider returned no results.')
        setTestStatus({ ok: false, message: msg })
        toast.error(tf('Web search test failed: {message}', { message: msg }))
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsPage
      purpose={t(
        'Which search engine powers web search in chat. Brave, Tavily and SerpAPI need a key from API Keys; SearXNG needs the address of an instance you trust.'
      )}
    >
      <PanelState
        state={state}
        loading={<SettingsLoading what={t('web tools settings')} />}
        error={(message, retry) => <SettingsLoadError what={t('web tools settings')} message={message} onRetry={retry} />}
        empty={<p className="text-[12px] text-[var(--text-muted)]">{t('No search providers are available in this build.')}</p>}
        isEmpty={(data) => data.providers.length === 0}
        onRetry={() => void refresh()}
      >
        {(data) => {
          // Older main processes do not send supportsImages. Treat "not sent by anyone"
          // as unknown and stay quiet, rather than warning that every provider is broken.
          const imageCapable = data.providers.filter((p) => p.supportsImages).map((p) => PROVIDER_NAMES[p.id] ?? p.id)
          const activeEntry = data.providers.find((p) => p.active)
          const activeSupportsImages = activeEntry?.supportsImages ?? true
          const activeName = activeEntry ? PROVIDER_NAMES[activeEntry.id] ?? activeEntry.id : data.provider
          return (
            <>
              <SettingsSection
                label={t('Active provider')}
                actions={
                  <Button size="sm" onClick={() => void runTest()} disabled={busy !== null}>
                    {busy === 'test' ? t('Testing…') : t('Test web search')}
                  </Button>
                }
              >
                <SettingsRow
                  label={activeName}
                  hint={
                    imageCapable.length > 0 && !activeSupportsImages
                      ? tf('{provider} cannot search images. Providers that can: {list}.', {
                          provider: activeName,
                          list: imageCapable.join(', ')
                        })
                      : t('Runs a one-query search to confirm the provider answers.')
                  }
                  tone={imageCapable.length > 0 && !activeSupportsImages ? 'warning' : 'default'}
                >
                  {testStatus && (
                    <p className={`text-[12px] ${testStatus.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>
                      {testStatus.message}
                    </p>
                  )}
                </SettingsRow>
              </SettingsSection>

              <SettingsSection label={t('Providers')}>
                {data.providers.map((p) => {
                  const name = PROVIDER_NAMES[p.id] ?? p.label
                  const endpointSaved = Boolean(data.searxngEndpoint?.trim())
                  // "Use this provider" used to work with no key and the search tool then
                  // went dead: the adapter builds nothing without one. Gate it on what is stored.
                  const ready = p.requiresKey ? p.hasKey : p.requiresEndpoint ? endpointSaved : true
                  const hint = p.requiresKey ? (
                    p.hasKey ? (
                      t('Key saved.')
                    ) : (
                      <>
                        {t('No key yet. ')}
                        <SettingsLink tab="api">{t('Add the key under API Keys')}</SettingsLink>
                      </>
                    )
                  ) : p.requiresEndpoint ? (
                    endpointSaved ? t('Address saved.') : t('Needs the address of an instance you trust.')
                  ) : p.id === 'duckduckgo' ? (
                    t('No key needed. Free, but it returns nothing some of the time.')
                  ) : (
                    t('No key needed.')
                  )
                  return (
                    <SettingsRow
                      key={p.id}
                      label={
                        <span className="flex items-center gap-2">
                          <span
                            aria-hidden
                            className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                              ready ? 'bg-[var(--success)]' : 'bg-[var(--text-muted)]'
                            }`}
                          />
                          {name}
                          {p.active && (
                            <span className="rounded bg-[var(--accent)]/15 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-[var(--accent)]">
                              {t('Active')}
                            </span>
                          )}
                        </span>
                      }
                      hint={
                        <>
                          {hint}{' '}
                          <a
                            href={DOC_LINKS[p.id]}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[var(--accent)] underline-offset-2 hover:underline"
                          >
                            {p.requiresKey ? t('Get a key') : tf('About {name}', { name })} →
                          </a>
                        </>
                      }
                      control={
                        !p.active ? (
                          <Button
                            size="sm"
                            onClick={() => void activate(p)}
                            disabled={busy !== null || !ready}
                            title={
                              ready
                                ? undefined
                                : p.requiresEndpoint
                                  ? t('Save the address first')
                                  : t('Add the key first')
                            }
                          >
                            {t('Use this provider')}
                          </Button>
                        ) : undefined
                      }
                    >
                      {p.requiresEndpoint && (
                        <div className="space-y-1">
                          <label htmlFor={endpointId} className="text-[12px] text-[var(--text-secondary)]">
                            {t('Instance address')}
                          </label>
                          <div className="flex flex-wrap items-center gap-2">
                            <Input
                              id={endpointId}
                              type="url"
                              inputMode="url"
                              value={endpoint}
                              onChange={(e) => {
                                setEndpoint(e.target.value)
                                if (endpointError) setEndpointError(null)
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  void saveEndpoint()
                                }
                              }}
                              placeholder="https://searxng.example.com"
                              aria-invalid={endpointError ? true : undefined}
                              className="min-w-[240px] flex-1 font-mono"
                            />
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => void saveEndpoint()}
                              disabled={busy !== null || !endpoint.trim() || endpoint.trim() === savedEndpoint.trim()}
                            >
                              {t('Save address')}
                            </Button>
                          </div>
                          {endpointError && (
                            <p role="alert" className="text-[12px] text-[var(--error)]">
                              {endpointError}
                            </p>
                          )}
                          <p className="text-[11px] text-[var(--text-muted)]">
                            {t('Saving the address also makes SearXNG the active provider.')}
                          </p>
                        </div>
                      )}
                    </SettingsRow>
                  )
                })}
              </SettingsSection>
            </>
          )
        }}
      </PanelState>
    </SettingsPage>
  )
}
