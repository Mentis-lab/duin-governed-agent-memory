import { t, tf } from '@/lib/i18n'
import { useCallback, useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { PanelState } from '@/components/ui/PanelState'
import {
  ProviderKeyCard,
  SettingsLink,
  SettingsLoadError,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  useSavedFlash
} from '@/components/ui/settings'
import { flashWhenSaved } from '@/components/ui/settings/useSavedFlash'
import { invoke, query } from '@/lib/ipc-client'
import { describeError } from '@/lib/result'
import { panelFromResult, panelLoading, type PanelStatus } from '@/lib/panel-state'
import { toast } from '@/stores/toast-store'
import { ensurePlaintextConsentIfNeeded } from '@/lib/keychain-consent'

// Image Generation provider settings panel.
//
// Provider, model and canvas size auto-apply; the key is saved from its own card. The
// renderer never sees the stored key — `imageGen:getProvider` returns only `hasKey`.

type ImageGenProviderId = 'openai' | 'minimax' | 'seedream' | 'stability'

interface ProviderSnapshot {
  provider: ImageGenProviderId
  model: string
  size: string
  hasKey: boolean
}

interface TestSample {
  mimeType: string
  byteLength: number
}

interface TestResult {
  ok: boolean
  error?: string
  sample?: TestSample
}

interface ProviderOption {
  id: ImageGenProviderId
  label: string
  hint: string
  docsUrl: string
  models: Array<{ value: string; label: string }>
  /** True when the provider has a real implementation today. */
  available: boolean
}

// Keep the model lists in step with PROVIDER_MODELS in
// electron/services/image-gen-providers.ts — the main process drops any model
// it does not recognise, so a name only listed here silently falls back.
// Hints are translated where rendered (module scope would freeze the language).
const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    id: 'openai',
    label: 'OpenAI Images',
    hint: 'Uses OpenAI’s image models: gpt-image-2 to generate and edit, dall-e-2 for variations.',
    docsUrl: 'https://platform.openai.com/account/api-keys',
    models: [
      { value: 'gpt-image-2', label: 'gpt-image-2 (default)' },
      { value: 'gpt-image-1', label: 'gpt-image-1' },
      { value: 'dall-e-3', label: 'dall-e-3' },
      { value: 'dall-e-2', label: 'dall-e-2 (variations only)' }
    ],
    available: true
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    hint: 'Text-to-image only. MiniMax cannot edit or vary an existing image, so editing and variations stay on OpenAI.',
    docsUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    models: [{ value: 'image-01', label: 'image-01 (default)' }],
    available: true
  },
  {
    id: 'seedream',
    label: 'Seedream (Volcengine Ark)',
    hint: 'ByteDance Seedream via Ark, China region. Text-to-image only here, so editing and variations stay on OpenAI.',
    docsUrl: 'https://console.volcengine.com/ark',
    models: [
      { value: 'doubao-seedream-5-0-260128', label: 'Seedream 5.0 (default)' },
      { value: 'doubao-seedream-4-5-251128', label: 'Seedream 4.5' },
      { value: 'doubao-seedream-4-0-250828', label: 'Seedream 4.0' }
    ],
    available: true
  },
  {
    id: 'stability',
    label: 'Stability AI',
    hint: 'Not available yet.',
    docsUrl: 'https://platform.stability.ai/account/keys',
    models: [{ value: 'stable-diffusion-xl', label: 'stable-diffusion-xl' }],
    available: false
  }
]

const SIZE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '1024x1024', label: '1024 × 1024 (square)' },
  { value: '1024x1536', label: '1024 × 1536 (portrait)' },
  { value: '1536x1024', label: '1536 × 1024 (landscape)' },
  { value: 'auto', label: 'auto' }
]

function findProviderOption(id: ImageGenProviderId): ProviderOption {
  return PROVIDER_OPTIONS.find((p) => p.id === id) ?? PROVIDER_OPTIONS[0]
}

export function ImageGenSettings() {
  const [snapshot, setSnapshot] = useState<PanelStatus<ProviderSnapshot>>(panelLoading())
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const providerSelectId = useId()
  const modelSelectId = useId()
  const sizeSelectId = useId()
  const providerFlash = useSavedFlash()
  const modelFlash = useSavedFlash()
  const sizeFlash = useSavedFlash()

  const refresh = useCallback(async () => {
    const r = await query<ProviderSnapshot>('image generation settings', () => window.api.imageGen.getProvider())
    setSnapshot(panelFromResult(r))
  }, [])

  useEffect(() => {
    setSnapshot(panelLoading())
    void refresh()
  }, [refresh])

  /** One write for everything: provider + model + size, optionally with a key ('' deletes). */
  const write = async (
    provider: ImageGenProviderId,
    opts: { apiKey?: string; model?: string; size?: string },
    failure: string
  ): Promise<boolean> => {
    setBusy(true)
    setTestResult(null)
    try {
      const next = await invoke<ProviderSnapshot>('save image generation settings', () =>
        window.api.imageGen.setProvider(provider, opts)
      )
      setSnapshot(panelFromResult({ ok: true, data: next }))
      return true
    } catch (e) {
      toast.error(describeError(e, failure))
      return false
    } finally {
      setBusy(false)
    }
  }

  const changeProvider = (current: ProviderSnapshot, next: ImageGenProviderId): Promise<boolean> => {
    const opt = findProviderOption(next)
    return write(
      next,
      { model: opt.models[0]?.value, size: current.size || '1024x1024' },
      t('Could not switch the image provider')
    )
  }

  const changeModel = (current: ProviderSnapshot, model: string): Promise<boolean> =>
    write(current.provider, { model, size: current.size || '1024x1024' }, t('Could not save the model'))

  const changeSize = (current: ProviderSnapshot, size: string): Promise<boolean> =>
    write(current.provider, { model: current.model, size }, t('Could not save the canvas size'))

  const saveKey = async (current: ProviderSnapshot, key: string): Promise<boolean> => {
    // SEC-10: the key persists to the keychain; gate on the shared plaintext-consent prompt.
    const consent = await ensurePlaintextConsentIfNeeded()
    if (!consent) return false
    const option = findProviderOption(current.provider)
    const ok = await write(
      current.provider,
      { apiKey: key, model: current.model || option.models[0]?.value, size: current.size || '1024x1024' },
      tf('Could not save the {name} key', { name: option.label })
    )
    if (ok) toast.success(tf('{name} key saved', { name: option.label }))
    return ok
  }

  const deleteKey = async (current: ProviderSnapshot): Promise<void> => {
    const option = findProviderOption(current.provider)
    const ok = await write(
      current.provider,
      { apiKey: '', model: current.model || option.models[0]?.value, size: current.size || '1024x1024' },
      tf('Could not delete the {name} key', { name: option.label })
    )
    if (ok) toast.success(tf('{name} key deleted', { name: option.label }))
  }

  const runTest = async (): Promise<void> => {
    setBusy(true)
    setTestResult(null)
    try {
      const r = await query<TestResult>('the image generation test', () => window.api.imageGen.test())
      const data: TestResult = r.ok ? r.data : { ok: false, error: r.error }
      setTestResult(data)
      if (data.ok) toast.success(t('Image generation test passed'))
      else toast.error(tf('Image generation test failed: {reason}', { reason: data.error ?? t('unknown error') }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsPage
      purpose={
        <>
          {t('Which service draws, edits and varies images for chat. ')}
          {t('Stored encrypted on this computer and sent only to that provider.')}
        </>
      }
    >
      <PanelState
        state={snapshot}
        loading={<SettingsLoading what={t('image generation settings')} />}
        error={(message, retry) => (
          <SettingsLoadError what={t('image generation settings')} message={message} onRetry={retry} />
        )}
        empty={<p className="text-[12px] text-[var(--text-muted)]">{t('Image generation is not available in this build.')}</p>}
        onRetry={() => void refresh()}
      >
        {(current) => {
          const option = findProviderOption(current.provider)
          const modelKnown = option.models.some((m) => m.value === current.model)
          return (
            <>
              <SettingsSection label={t('Provider')}>
                <SettingsRow
                  label={t('Service')}
                  hint={t(option.hint)}
                  saved={providerFlash.saved}
                  control={
                    <>
                      <label htmlFor={providerSelectId} className="sr-only">
                        {t('Image provider')}
                      </label>
                      <Select
                        id={providerSelectId}
                        value={current.provider}
                        disabled={busy}
                        onChange={(e) =>
                          flashWhenSaved(changeProvider(current, e.target.value as ImageGenProviderId), providerFlash.flash)
                        }
                      >
                        {PROVIDER_OPTIONS.map((p) => (
                          <option key={p.id} value={p.id} disabled={!p.available}>
                            {p.available ? p.label : tf('{name} (not available yet)', { name: p.label })}
                          </option>
                        ))}
                      </Select>
                    </>
                  }
                />

                <ProviderKeyCard
                  name={option.label}
                  status={current.hasKey ? 'stored' : 'none'}
                  note={
                    current.provider === 'openai' ? (
                      <>
                        {t('Separate from the OpenAI key under ')}
                        <SettingsLink tab="api">{t('API Keys')}</SettingsLink>
                        {t('; image generation uses its own.')}
                      </>
                    ) : undefined
                  }
                  docs={{ href: option.docsUrl, label: t('Get a key') }}
                  busy={busy}
                  onSave={(key) => saveKey(current, key)}
                  onDelete={() => deleteKey(current)}
                  onTest={() => runTest()}
                >
                  {testResult && (
                    <p className={`text-[12px] ${testResult.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>
                      {testResult.ok
                        ? tf('OK · {type} ({bytes} bytes)', {
                            type: testResult.sample?.mimeType ?? t('image'),
                            bytes: testResult.sample?.byteLength ?? 0
                          })
                        : (testResult.error ?? t('failed'))}
                    </p>
                  )}
                </ProviderKeyCard>
              </SettingsSection>

              <SettingsSection label={t('Defaults')}>
                <SettingsRow
                  label={t('Model')}
                  hint={t('Used when a request does not name one.')}
                  saved={modelFlash.saved}
                  control={
                    <>
                      <label htmlFor={modelSelectId} className="sr-only">
                        {t('Image model')}
                      </label>
                      <Select
                        id={modelSelectId}
                        value={modelKnown ? current.model : (option.models[0]?.value ?? '')}
                        disabled={busy}
                        onChange={(e) => flashWhenSaved(changeModel(current, e.target.value), modelFlash.flash)}
                        className="font-mono"
                      >
                        {option.models.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </Select>
                    </>
                  }
                />
                <SettingsRow
                  label={t('Canvas size')}
                  hint={t('The size of a generated image unless the request asks for another.')}
                  saved={sizeFlash.saved}
                  control={
                    <>
                      <label htmlFor={sizeSelectId} className="sr-only">
                        {t('Canvas size')}
                      </label>
                      <Select
                        id={sizeSelectId}
                        value={current.size || '1024x1024'}
                        disabled={busy}
                        onChange={(e) => flashWhenSaved(changeSize(current, e.target.value), sizeFlash.flash)}
                        className="font-mono"
                      >
                        {SIZE_OPTIONS.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.label}
                          </option>
                        ))}
                      </Select>
                    </>
                  }
                />
              </SettingsSection>
            </>
          )
        }}
      </PanelState>
    </SettingsPage>
  )
}
