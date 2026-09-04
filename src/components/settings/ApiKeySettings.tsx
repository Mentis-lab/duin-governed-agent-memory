import { t, tf } from '@/lib/i18n'
import { useCallback, useEffect, useState } from 'react'
import { PanelState } from '@/components/ui/PanelState'
import {
  ProviderKeyCard,
  SettingsLink,
  SettingsLoadError,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  ToggleRow,
  type KeyStatus
} from '@/components/ui/settings'
import { invoke, query } from '@/lib/ipc-client'
import { describeError } from '@/lib/result'
import { panelError, panelLoading, panelReady, type PanelStatus } from '@/lib/panel-state'
import { toast } from '@/stores/toast-store'
import type { ProviderInfo } from '@/lib/types'
import { ensurePlaintextConsentIfNeeded } from '@/lib/keychain-consent'
import { useProvidersStore, type ProviderEntry as StoreProviderEntry } from '@/stores/providers-store'
import { useSettingsStore } from '@/stores/settings-store'

interface ProviderEntry extends ProviderInfo {
  hasKey: boolean
}

interface SearchProviderEntry {
  id: string
  label: string
  docsUrl: string
  hasKey: boolean
}

interface KeysSnapshot {
  providers: ProviderEntry[]
  searchProviders: SearchProviderEntry[]
}

interface TestResult {
  ok: boolean
  message: string
}

/** What the test handler answers: the detailed shape, or the legacy boolean. */
type TestPayload = { ok: boolean; reason?: string; modelCount?: number } | boolean | undefined

function keyStatus(hasKey: boolean): KeyStatus {
  return hasKey ? 'stored' : 'none'
}

/** Free-tier notes for the search providers. Translated where rendered. */
const SEARCH_NOTES: Record<string, string> = {
  brave: 'Free tier: 2,000 queries a month. No credit card required.',
  serpapi: 'Free tier: 100 searches a month. No credit card required.',
  tavily: 'Free tier: 1,000 credits a month. No credit card required.'
}

export function ApiKeySettings() {
  const [snapshot, setSnapshot] = useState<PanelStatus<KeysSnapshot>>(panelLoading())
  // null = the encryption check has not answered or failed. That is "unknown", never a
  // plaintext alarm: the old page painted a failed check as "plaintext".
  const [encrypted, setEncrypted] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [testStatus, setTestStatus] = useState<Record<string, TestResult | null>>({})
  const cloudConsent = useSettingsStore((s) => s.settings.cloudExtractionConsent)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const refresh = useCallback(async () => {
    const [list, searchList, enc] = await Promise.all([
      query<ProviderEntry[]>('your provider keys', () => window.api.settings.listProviderKeys()),
      query<SearchProviderEntry[]>('your search provider keys', () => window.api.settings.listSearchProviderKeys()),
      query<boolean>('the encryption check', () => window.api.settings.isEncryptionAvailable())
    ])
    setEncrypted(enc.ok ? Boolean(enc.data) : null)
    if (!list.ok) {
      setSnapshot(panelError(list.error, list.cause))
      return
    }
    if (!searchList.ok) {
      setSnapshot(panelError(searchList.error, searchList.cause))
      return
    }
    // Push the fresh hasKey snapshot into the shared providers-store so the model picker
    // reflects a just-added/removed key immediately instead of stale locked/no-key badges.
    useProvidersStore.getState().setProviders(list.data as StoreProviderEntry[])
    setSnapshot(panelReady({ providers: list.data, searchProviders: searchList.data }))
  }, [])

  useEffect(() => {
    void refresh()
    // Keys can also be added from the chat composer's unlock prompt or the onboarding card
    // while this panel is open; without this the panel kept showing "no key" for a provider
    // that already had one, which is what made a key look like it needed entering twice.
    return window.api?.settings?.onKeychainChanged?.(() => {
      void refresh()
    })
  }, [refresh])

  const saveKey = async (providerId: string, label: string, key: string): Promise<boolean> => {
    // SEC-10: shared consent gate. Confirms once per session when encryption is off and
    // records consent on the main side so other panels and background paths inherit it.
    const consent = await ensurePlaintextConsentIfNeeded()
    if (!consent) return false
    setBusy(providerId)
    setTestStatus((s) => ({ ...s, [providerId]: null }))
    try {
      await invoke('save the key', () => window.api.settings.saveProviderKey(providerId, key))
      toast.success(tf('{name} key saved', { name: label }))
      await refresh()
      return true
    } catch (e) {
      toast.error(describeError(e, tf('Could not save the {name} key', { name: label })))
      return false
    } finally {
      setBusy(null)
    }
  }

  const testKey = async (providerId: string, label: string): Promise<void> => {
    setBusy(providerId)
    setTestStatus((s) => ({ ...s, [providerId]: null }))
    try {
      const data = await invoke<TestPayload>('test the key', () => window.api.settings.testProviderKey(providerId))
      if (typeof data === 'object' && data !== null) {
        if (data.ok) {
          const detail =
            typeof data.modelCount === 'number'
              ? tf('{name} accepted the key ({count} models available).', { name: label, count: data.modelCount })
              : tf('{name} accepted the key.', { name: label })
          setTestStatus((s) => ({ ...s, [providerId]: { ok: true, message: detail } }))
          toast.success(tf('{name} key works', { name: label }))
        } else {
          const reason = data.reason || t('The provider rejected the key.')
          setTestStatus((s) => ({ ...s, [providerId]: { ok: false, message: reason } }))
          toast.error(tf('{name} key check failed: {reason}', { name: label, reason }))
        }
      } else if (typeof data === 'boolean') {
        const msg = data ? tf('{name} accepted the key.', { name: label }) : t('The provider rejected the key.')
        setTestStatus((s) => ({ ...s, [providerId]: { ok: data, message: msg } }))
        if (data) toast.success(tf('{name} key works', { name: label }))
        else toast.error(tf('{name} key check failed: {reason}', { name: label, reason: msg }))
      } else {
        const reason = t('No response from the provider.')
        setTestStatus((s) => ({ ...s, [providerId]: { ok: false, message: reason } }))
        toast.error(tf('{name} key check failed: {reason}', { name: label, reason }))
      }
    } catch (e) {
      const reason = describeError(e, t('unknown error'))
      setTestStatus((s) => ({ ...s, [providerId]: { ok: false, message: reason } }))
      toast.error(tf('{name} key check failed: {reason}', { name: label, reason }))
    } finally {
      setBusy(null)
    }
  }

  const deleteKey = async (providerId: string, label: string): Promise<void> => {
    setBusy(providerId)
    try {
      await invoke('delete the key', () => window.api.settings.deleteProviderKey(providerId))
      toast.success(tf('{name} key deleted', { name: label }))
      await refresh()
    } catch (e) {
      toast.error(describeError(e, tf('Could not delete the {name} key', { name: label })))
    } finally {
      setBusy(null)
    }
  }

  // Search-provider keys have no test endpoint: search APIs are metered, so the next
  // research turn is the live validation rather than a paid call on settings entry.
  const saveSearchKey = async (providerId: string, label: string, key: string): Promise<boolean> => {
    const consent = await ensurePlaintextConsentIfNeeded()
    if (!consent) return false
    const busyId = `search:${providerId}`
    setBusy(busyId)
    try {
      await invoke('save the key', () => window.api.settings.saveSearchProviderKey(providerId, key))
      toast.success(tf('{name} key saved', { name: label }))
      await refresh()
      return true
    } catch (e) {
      toast.error(describeError(e, tf('Could not save the {name} key', { name: label })))
      return false
    } finally {
      setBusy(null)
    }
  }

  const deleteSearchKey = async (providerId: string, label: string): Promise<void> => {
    const busyId = `search:${providerId}`
    setBusy(busyId)
    try {
      await invoke('delete the key', () => window.api.settings.deleteSearchProviderKey(providerId))
      toast.success(tf('{name} key deleted', { name: label }))
      await refresh()
    } catch (e) {
      toast.error(describeError(e, tf('Could not delete the {name} key', { name: label })))
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsPage
      purpose={
        <>
          {t('Keys for the online models chat can use, and for the search engines behind web search. ')}
          {t('Stored encrypted on this computer and sent only to that provider.')}
        </>
      }
    >
      <PanelState
        state={snapshot}
        loading={<SettingsLoading what={t('your API keys')} />}
        error={(message, retry) => <SettingsLoadError what={t('your API keys')} message={message} onRetry={retry} />}
        empty={<p className="text-[12px] text-[var(--text-muted)]">{t('No providers are available in this build.')}</p>}
        isEmpty={(data) => data.providers.length === 0 && data.searchProviders.length === 0}
        onRetry={() => void refresh()}
      >
        {({ providers, searchProviders }) => (
          <>
            <SettingsSection
              label={t('Model providers')}
              description={t(
                'When you use an online model, DUIN sends your current question plus relevant excerpts and personalization context to that provider, and — to build your knowledge graph — your notes, in batches. Saving a key is your consent to that.'
              )}
            >
              {encrypted === false && (
                <SettingsRow
                  tone="warning"
                  label={t('Secure storage is not available on this computer')}
                  hint={t('Keys are saved as plain text in DUIN’s app folder. You will be asked to confirm before a key is saved.')}
                />
              )}

              <ToggleRow
                label={t('Send my notes to online providers to build the graph')}
                hint={t(
                  'When on, DUIN sends your notes to your online model in batches to build your knowledge graph on its own. Saving a provider key turns this back on, since the disclosure above counts as consent.'
                )}
                checked={cloudConsent === true}
                onChange={(next) => updateSettings({ cloudExtractionConsent: next })}
              />

              {providers.map((p) => {
                if (p.id === 'ollama') {
                  return (
                    <SettingsRow
                      key={p.id}
                      label={p.label}
                      hint={t('Runs on this machine, no key needed.')}
                      control={
                        p.docsUrl ? (
                          <a
                            href={p.docsUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[12px] text-[var(--accent)] underline-offset-2 hover:underline"
                          >
                            {t('About Ollama')} →
                          </a>
                        ) : undefined
                      }
                    />
                  )
                }
                const status = testStatus[p.id]
                return (
                  <ProviderKeyCard
                    key={p.id}
                    name={p.label}
                    status={keyStatus(p.hasKey)}
                    note={
                      p.routable === false ? (
                        <>
                          {t('A key here unlocks nothing until this provider’s models are imported under ')}
                          <SettingsLink tab="models">{t('Models')}</SettingsLink>.
                        </>
                      ) : undefined
                    }
                    docs={p.docsUrl ? { href: p.docsUrl, label: t('Get a key') } : undefined}
                    busy={busy === p.id}
                    onSave={(key) => saveKey(p.id, p.label, key)}
                    onTest={() => testKey(p.id, p.label)}
                    onDelete={() => deleteKey(p.id, p.label)}
                  >
                    {status && (
                      <p className={`text-[12px] ${status.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>
                        {status.message}
                      </p>
                    )}
                  </ProviderKeyCard>
                )
              })}
            </SettingsSection>

            <SettingsSection
              label={t('Search providers')}
              description={
                <>
                  {t(
                    'Web search and research need a search engine to find sources. The free option works only some of the time; a Brave, Tavily or SerpAPI key makes results reliable. Pick which one to use under '
                  )}
                  <SettingsLink tab="webTools">{t('Web Tools')}</SettingsLink>.
                </>
              }
            >
              {searchProviders.map((p) => (
                <ProviderKeyCard
                  key={`search:${p.id}`}
                  name={p.label}
                  status={keyStatus(p.hasKey)}
                  note={SEARCH_NOTES[p.id] ? t(SEARCH_NOTES[p.id]) : undefined}
                  docs={p.docsUrl ? { href: p.docsUrl, label: t('Get a free key') } : undefined}
                  busy={busy === `search:${p.id}`}
                  onSave={(key) => saveSearchKey(p.id, p.label, key)}
                  onDelete={() => deleteSearchKey(p.id, p.label)}
                />
              ))}
            </SettingsSection>
          </>
        )}
      </PanelState>
    </SettingsPage>
  )
}
