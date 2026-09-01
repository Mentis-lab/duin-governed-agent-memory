import { t, tf } from '@/lib/i18n'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Toggle } from '@/components/ui/Toggle'
import { useModelStore } from '@/stores/model-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useProvidersStore } from '@/stores/providers-store'
import { toast } from '@/stores/toast-store'
import { DEFAULT_MODEL_CONFIG, type ModelConfig, type ModelInfo } from '@/lib/types'

type CatalogStatus =
  | 'verified'
  | 'missing'
  | 'no-key'
  | 'unsupported-endpoint'
  | 'auth-failed'
  | 'no-credit'
  | 'error'

interface OpenRouterBrowseModel {
  apiModelId: string
  name: string
  contextWindow: number
  supportsTools: boolean
  supportsVision: boolean
}

interface CatalogVerification {
  generatedAt: number
  providers: Array<{
    provider: string
    status: 'ok' | 'no-key' | 'unsupported-endpoint' | 'auth-failed' | 'no-credit' | 'error'
    reason?: string
    liveCount?: number
  }>
  models: Array<{
    modelId: string
    name: string
    provider: string
    apiModelId: string
    status: CatalogStatus
    reason?: string
  }>
}

/** Mirror of registry BackgroundModelStatus (model:describeBackground). */
interface BackgroundModelStatus {
  chosen: string | null
  effective: string | null
  automatic: string | null
  source: 'setting' | 'env' | 'auto' | 'none'
}

function statusChip(status: CatalogStatus | undefined): { label: string; tone: string } {
  switch (status) {
    case 'verified':
      return { label: 'verified', tone: 'bg-[var(--success)]/15 text-[var(--success)]' }
    case 'missing':
      return { label: 'missing', tone: 'bg-[var(--error)]/15 text-[var(--error)]' }
    case 'auth-failed':
      return { label: 'auth failed', tone: 'bg-[var(--error)]/15 text-[var(--error)]' }
    // Amber, not red, and it deliberately does not say "failed". The key is GOOD —
    // only the account is empty — and an operator who reads red-plus-failed goes and
    // rotates a credential that was never the problem.
    case 'no-credit':
      return { label: 'no credit', tone: 'bg-[var(--warning)]/15 text-[var(--warning)]' }
    case 'no-key':
      return { label: 'no key', tone: 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]' }
    case 'unsupported-endpoint':
      return { label: 'unverifiable', tone: 'bg-[var(--warning)]/15 text-[var(--warning)]' }
    case 'error':
      return { label: 'error', tone: 'bg-[var(--error)]/15 text-[var(--error)]' }
    default:
      return { label: 'unchecked', tone: 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]' }
  }
}

// Quick-add templates for the custom-model editor — one flagship per major
// provider family, mirroring the 2026-08-21 MODEL_CATALOG redo. Metadata must
// match the catalog entry so applying a preset produces a correctly-shaped draft.
const PRESET_TEMPLATES: ModelInfo[] = [
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    provider: 'openai',
    contextWindow: 1_050_000,
    supportsTools: true,
    supportsVision: true
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: false
  },
  {
    id: 'kimi-k3',
    name: 'Kimi K3',
    provider: 'moonshot',
    contextWindow: 1_048_576,
    supportsTools: true,
    supportsVision: true
  },
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    provider: 'zhipu',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: false
  },
  {
    id: 'qwen3.8-max',
    name: 'Qwen3.8-Max',
    provider: 'dashscope',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true
  }
]

function mergeConfig(stored: Partial<ModelConfig> | undefined): ModelConfig {
  return { ...DEFAULT_MODEL_CONFIG, ...(stored ?? {}) }
}

export function ModelSettings() {
  const models = useModelStore((s) => s.models)
  const loadModels = useModelStore((s) => s.loadModels)
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  // ── Background model ──
  // DUIN's own structured work (note extraction, conversation titles) is routed separately
  // from the chat picker — registry routeModel('extraction' | 'title'). Auto = each
  // provider's designated fast model for whatever key the operator has; a pick here
  // overrides it (and the DUIN_ROUTE_EXTRACTION env pin). The status is read back from
  // main rather than trusted from the stored value, because a pinned model whose key is
  // missing, or whose account is refusing, silently falls back to Auto — and this pane
  // must say so.
  const providerEntries = useProvidersStore((s) => s.providers)
  const providersLoaded = useProvidersStore((s) => s.loaded)
  const refreshProviders = useProvidersStore((s) => s.refresh)
  const hasKey = useProvidersStore((s) => s.hasKey)
  const [bgStatus, setBgStatus] = useState<BackgroundModelStatus | null>(null)
  const refreshBackground = useCallback(async () => {
    if (!window.api) return
    const res = await window.api.model.describeBackground()
    if (res.success) setBgStatus(res.data as BackgroundModelStatus)
  }, [])
  useEffect(() => {
    if (!providersLoaded) void refreshProviders()
  }, [providersLoaded, refreshProviders])
  // Re-read whenever key state changes: a new key changes what Auto resolves to and can
  // make a pinned model usable again.
  useEffect(() => {
    void refreshBackground()
  }, [refreshBackground, providerEntries])
  const backgroundValue = settings.backgroundModel?.trim() || 'auto'
  // Only ids routeModel can actually pin: catalog entries and local Ollama models. Custom /
  // imported models are not usable for background routing yet, and listing them would offer
  // a choice that silently falls back to Auto.
  const backgroundGroups = useMemo(() => {
    const by = new Map<string, ModelInfo[]>()
    for (const m of models) {
      if (m.internal || !(m.builtin || m.id.startsWith('ollama:'))) continue
      const key = m.provider ?? 'custom'
      const arr = by.get(key)
      if (arr) arr.push(m)
      else by.set(key, [m])
    }
    return [...by.entries()]
  }, [models])
  const modelLabel = (id: string | null | undefined): string =>
    id ? (models.find((m) => m.id === id)?.name ?? id) : ''
  const providerLabel = (id: string): string =>
    providerEntries.find((p) => p.id === id)?.label ?? id
  const handleBackgroundChange = async (value: string) => {
    const next = value === 'auto' ? '' : value
    const ok = await updateSettings({ backgroundModel: next })
    if (!ok) return // updateSettings reverted the optimistic write and toasted the failure
    toast.success(
      next
        ? tf('Background model set to {model}', { model: modelLabel(next) })
        : t('Background model set to Auto')
    )
    await refreshBackground()
  }
  const autoLabel = !bgStatus
    ? tf('Auto — currently {model}', { model: '…' })
    : bgStatus.automatic
      ? tf('Auto — currently {model}', { model: modelLabel(bgStatus.automatic) })
      : t('Auto — nothing routable yet (add an API key)')
  const [selectedId, setSelectedId] = useState<string>(
    settings.defaultModel || (models[0]?.id ?? 'deepseek-v4-pro')
  )
  const [testStatus, setTestStatus] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [verification, setVerification] = useState<CatalogVerification | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [orModels, setOrModels] = useState<OpenRouterBrowseModel[] | null>(null)
  const [orQuery, setOrQuery] = useState('')
  const [orLoading, setOrLoading] = useState(false)
  // UA provider-expansion: import a provider's live catalog as custom models.
  const [importProviders, setImportProviders] = useState<Array<{ id: string; label: string }>>([])
  const [importProvider, setImportProvider] = useState<string>('groq')
  const [liveIds, setLiveIds] = useState<string[] | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [draft, setDraft] = useState<ModelInfo>({
    id: '',
    name: '',
    contextWindow: 65536,
    supportsTools: true,
    supportsVision: false
  })

  useEffect(() => {
    if (!models.find((m) => m.id === selectedId) && models.length > 0) {
      setSelectedId(models[0].id)
    }
  }, [models, selectedId])

  const selectedModel = models.find((m) => m.id === selectedId)
  const cfg = useMemo(
    () => mergeConfig(settings.modelConfig?.[selectedId]),
    [settings.modelConfig, selectedId]
  )

  const writeConfig = async (partial: Partial<ModelConfig>) => {
    const next = {
      ...settings.modelConfig,
      [selectedId]: { ...cfg, ...partial }
    }
    await updateSettings({ modelConfig: next })
  }

  const handleSetDefault = async () => {
    await updateSettings({ defaultModel: selectedId })
    toast.success(`${selectedModel?.name ?? selectedId} set as default`)
  }

  // Custom = not shipped in MODEL_CATALOG. Derived from the builtin flag the
  // model:list handler stamps — the old hand-kept 4-id set here had drifted and
  // mislabelled 28 of 32 catalog entries as custom.
  const customModels = useMemo(() => models.filter((m) => !m.builtin && !m.internal), [models])

  const applyPreset = (preset: ModelInfo) => {
    setDraft({ ...preset })
  }

  const handleAddCustom = async () => {
    if (!window.api) return
    if (!draft.id.trim()) {
      toast.warning('Model id is required (e.g., deepseek-v4-pro)')
      return
    }
    if (!draft.name.trim()) {
      toast.warning('Display name is required')
      return
    }
    const result = await window.api.model.addCustom({
      id: draft.id.trim(),
      name: draft.name.trim(),
      contextWindow: draft.contextWindow,
      supportsTools: draft.supportsTools,
      supportsVision: draft.supportsVision
    })
    if (!result.success) {
      toast.error(`Failed to add model: ${result.error}`)
      return
    }
    await loadModels()
    toast.success(`${draft.name.trim()} added`)
    setDraft({
      id: '',
      name: '',
      contextWindow: 65536,
      supportsTools: true,
      supportsVision: false
    })
  }

  const handleRemoveCustom = async (id: string) => {
    if (!window.api) return
    if (!confirm(`Remove custom model "${id}"?`)) return
    const result = await window.api.model.removeCustom(id)
    if (!result.success) {
      toast.error(`Failed to remove model: ${result.error}`)
      return
    }
    await loadModels()
    toast.success(`${id} removed`)
    if (selectedId === id) {
      setSelectedId(models.find((m) => m.id !== id)?.id ?? 'deepseek-v4-pro')
    }
  }

  const loadOpenRouter = async () => {
    if (!window.api) return
    setOrLoading(true)
    try {
      const res = await window.api.model.openRouterCatalog()
      if (res.success) setOrModels(res.data as OpenRouterBrowseModel[])
      else toast.error(`OpenRouter: ${res.error}`)
    } finally {
      setOrLoading(false)
    }
  }

  const addOpenRouterModel = async (m: OpenRouterBrowseModel) => {
    if (!window.api) return
    const result = await window.api.model.addCustom({
      id: `openrouter:${m.apiModelId}`,
      name: m.name,
      provider: 'openrouter',
      contextWindow: m.contextWindow,
      supportsTools: m.supportsTools,
      supportsVision: m.supportsVision
    })
    if (!result.success) {
      toast.error(`Failed to add: ${result.error}`)
      return
    }
    await loadModels()
    toast.success(`${m.name} added via OpenRouter`)
  }

  // UA provider-expansion: populate the import-provider dropdown from the live
  // PROVIDERS table so new providers appear without hand-editing this component.
  useEffect(() => {
    if (!window.api) return
    void window.api.model.listProviders().then((res) => {
      if (res.success) {
        setImportProviders(
          (res.data as Array<{ id: string; label: string }>).map((p) => ({ id: p.id, label: p.label }))
        )
      }
    })
  }, [])

  const handleFetchLive = async () => {
    if (!window.api) return
    setImportBusy(true)
    try {
      const res = await window.api.model.listLive(importProvider)
      if (res.success) setLiveIds(res.data as string[])
      else toast.error(`Live catalog: ${res.error}`)
    } finally {
      setImportBusy(false)
    }
  }

  const handleImportLive = async (ids: string[]) => {
    if (!window.api) return
    setImportBusy(true)
    try {
      const res = await window.api.model.importLive(importProvider, ids)
      if (!res.success) {
        toast.error(`Import failed: ${res.error}`)
        return
      }
      const data = res.data as { added: number; skipped: number }
      await loadModels()
      toast.success(
        `Imported ${data.added} model${data.added === 1 ? '' : 's'}${
          data.skipped ? `, ${data.skipped} already present` : ''
        }`
      )
    } finally {
      setImportBusy(false)
    }
  }

  const statusByModelId = useMemo(() => {
    const map = new Map<string, CatalogStatus>()
    verification?.models.forEach((m) => map.set(m.modelId, m.status))
    return map
  }, [verification])

  const handleVerifyCatalog = async () => {
    if (!window.api) return
    setVerifying(true)
    try {
      const result = await window.api.model.verifyCatalog()
      if (!result.success) {
        toast.error(`Catalog verification failed: ${result.error}`)
        return
      }
      const report = result.data as CatalogVerification
      setVerification(report)
      const verifiedCount = report.models.filter((m) => m.status === 'verified').length
      const missingCount = report.models.filter((m) => m.status === 'missing').length
      const noKeyCount = report.models.filter((m) => m.status === 'no-key').length
      // Counted and surfaced separately: an out-of-credit provider used to land in
      // neither bucket, so a run where every paid provider was unfunded could still
      // toast "N verified" and read as healthy.
      const noCreditCount = report.models.filter((m) => m.status === 'no-credit').length
      if (noCreditCount > 0) {
        toast.warning(
          `${noCreditCount} model(s) on a provider that accepted the key but has no credit — fund the account, don't rotate the key`
        )
      }
      if (missingCount > 0) {
        toast.warning(
          `${verifiedCount} verified, ${missingCount} missing from live /v1/models, ${noKeyCount} pending a key`
        )
      } else if (verifiedCount > 0) {
        toast.success(
          `${verifiedCount} verified against live /v1/models${noKeyCount > 0 ? `, ${noKeyCount} pending a key` : ''}`
        )
      } else {
        toast.warning('No models could be verified. Add a provider key in Settings → API Keys.')
      }
    } catch (err) {
      toast.error(`Catalog verification failed: ${(err as Error).message ?? 'unknown error'}`)
    } finally {
      setVerifying(false)
    }
  }

  const handleTest = async () => {
    if (!window.api) return
    setTesting(true)
    setTestStatus(null)
    try {
      const conv = await window.api.conversation.create(selectedId)
      if (!conv.success) {
        setTestStatus(`Error: ${conv.error}`)
        toast.error(`Model test failed: ${conv.error}`)
        return
      }
      const conversationId = (conv.data as { id: string }).id
      const start = Date.now()
      const result = await window.api.chat.send({
        conversationId,
        model: selectedId,
        content: 'Respond with only the word PONG.',
        activeSkillIds: []
      })
      if (!result.success) {
        setTestStatus(`Error: ${result.error}`)
        toast.error(`Model test failed: ${result.error}`)
      } else {
        const elapsed = Date.now() - start
        setTestStatus(`Responded in ${elapsed} ms`)
        toast.success(`${selectedModel?.name ?? selectedId} responded in ${elapsed} ms`)
      }
      await window.api.conversation.delete(conversationId)
    } catch (err) {
      const msg = (err as Error).message ?? 'unknown error'
      setTestStatus(`Error: ${msg}`)
      toast.error(`Model test failed: ${msg}`)
    }
    setTesting(false)
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-mono text-[16px] font-semibold text-[var(--text-primary)]">{t('Models')}</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
          Per-model temperature, top-p, max tokens, and an optional system prompt override applied
          on every chat with this model. Use "Verify against providers" to confirm every model id
          in the picker actually exists at the provider it's routed to — the check calls each
          provider's live /v1/models endpoint with your stored key, no inferences.
        </p>
      </div>

      <div className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={handleVerifyCatalog} disabled={verifying}>
            {verifying ? 'Verifying...' : 'Verify against providers'}
          </Button>
          {verification && (
            <span className="font-mono text-[12px] text-[var(--text-muted)]">
              {verification.providers.map((p) => {
                const tone =
                  p.status === 'ok'
                    ? 'text-[var(--success)]'
                    : p.status === 'no-key'
                    ? 'text-[var(--text-muted)]'
                    : p.status === 'unsupported-endpoint' || p.status === 'no-credit'
                    ? 'text-[var(--warning)]'
                    : 'text-[var(--error)]'
                return (
                  <span key={p.provider} className={`mr-3 ${tone}`}>
                    {p.provider}:
                    {p.status === 'ok' ? ` ${p.liveCount ?? 0} live ids` : ` ${p.status}`}
                  </span>
                )
              })}
            </span>
          )}
        </div>
        {verification && (
          <p className="mt-2 text-[12px] text-[var(--text-muted)]">
            Chips on each model below show whether the apiModelId is present in the provider's
            live /v1/models response. Missing = the provider does not currently serve that id;
            unverifiable = the provider does not expose /v1/models (no auto-check possible).
          </p>
        )}
      </div>

      {/* Background model — see the hook block above for why the status comes from main. */}
      <div className="space-y-2 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
              {t('Background model')}
            </div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-muted)]">
              {t(
                'The model DUIN uses for its own structured work — note extraction and conversation titles — separate from the model you chat with. Auto picks the designated fast model for whichever API key you have.'
              )}
            </p>
          </div>
          <select
            value={backgroundValue}
            onChange={(e) => void handleBackgroundChange(e.target.value)}
            aria-label={t('Background model')}
            className="max-w-full shrink-0 rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          >
            <option value="auto">{autoLabel}</option>
            {backgroundGroups.map(([provider, group]) => (
              <optgroup key={provider} label={providerLabel(provider)}>
                {group.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {providersLoaded && provider !== 'ollama' && !hasKey(provider) ? ` ${t('(no key)')}` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        {bgStatus?.chosen && bgStatus.source !== 'setting' && (
          <p className="text-[12px] text-[var(--warning)]">
            {tf(
              "{chosen} isn't usable right now — no key, retired id, or the account is refusing — so DUIN is using Auto → {model}.",
              { chosen: modelLabel(bgStatus.chosen), model: modelLabel(bgStatus.effective) || '—' }
            )}
          </p>
        )}
        {bgStatus?.source === 'env' && (
          <p className="text-[12px] text-[var(--text-muted)]">
            {tf(
              'Pinned by the DUIN_ROUTE_EXTRACTION environment variable → {model}. Picking a model here overrides it.',
              { model: modelLabel(bgStatus.effective) }
            )}
          </p>
        )}
        <p className="text-[11px] text-[var(--text-muted)]">
          {t(
            'Catalog and local Ollama models only — custom and imported models are not routable for background work yet.'
          )}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {models.map((m) => {
          const status = statusByModelId.get(m.id)
          const chip = statusChip(status)
          const found = verification?.models.find((x) => x.modelId === m.id)
          return (
            <button
              key={m.id}
              onClick={() => setSelectedId(m.id)}
              title={found?.reason ?? `${m.id}`}
              className={`rounded border px-3 py-1.5 font-mono text-[12px] transition-colors ${
                selectedId === m.id
                  ? 'border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)]'
                  : 'border-[var(--panel-border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {m.name}
              {settings.defaultModel === m.id && (
                <span className="ml-1.5 text-[11px] uppercase text-[var(--text-muted)]">default</span>
              )}
              {verification && (
                <span
                  className={`ml-1.5 rounded px-1 py-0.5 text-[11px] uppercase tracking-wider ${chip.tone}`}
                >
                  {chip.label}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {selectedModel && (
        <div className="space-y-3 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
                Temperature ({cfg.temperature.toFixed(2)})
              </span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={cfg.temperature}
                onChange={(e) => writeConfig({ temperature: Number(e.target.value) })}
                className="accent-[var(--accent)]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
                Top-p ({cfg.topP.toFixed(2)})
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={cfg.topP}
                onChange={(e) => writeConfig({ topP: Number(e.target.value) })}
                className="accent-[var(--accent)]"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
              Max tokens (blank = model default)
            </span>
            <input
              type="number"
              min={1}
              value={cfg.maxTokens ?? ''}
              onChange={(e) => {
                const raw = e.target.value
                writeConfig({ maxTokens: raw === '' ? null : Math.max(1, Number(raw)) })
              }}
              placeholder={t('Unlimited')}
              className="rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
              System prompt override (blank = use DUIN default)
            </span>
            <textarea
              value={cfg.systemPromptOverride}
              onChange={(e) => writeConfig({ systemPromptOverride: e.target.value })}
              rows={3}
              spellCheck={false}
              placeholder={t("Replaces 'You are DUIN, a helpful AI assistant...' when set.")}
              className="resize-none rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1.5 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="secondary" onClick={handleSetDefault} disabled={settings.defaultModel === selectedId}>
              {t('Set as default')}
            </Button>
            <Button variant="primary" onClick={handleTest} disabled={testing}>
              {testing ? 'Testing...' : 'Test model'}
            </Button>
            {testStatus && (
              <span
                className={`text-[12px] ${
                  testStatus.startsWith('Error')
                    ? 'text-[var(--error)]'
                    : 'text-[var(--success)]'
                }`}
              >
                {testStatus}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="space-y-3 border-t border-[var(--panel-border)] pt-4">
        <div>
          <h4 className="font-mono text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
            {t('Custom models')}
          </h4>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
            Add any model id your DeepSeek key can call - e.g. <span className="font-mono">deepseek-v4-pro</span>.
            Builtins stay; customs override built-ins with the same id.
          </p>
        </div>

        {/* Add from OpenRouter — browse every model reachable via one OpenRouter key. */}
        <div className="space-y-2 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="font-mono text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
                {t('Add from OpenRouter')}
              </div>
              <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                Browse every model reachable via your OpenRouter key — one click to add. Needs an
                OpenRouter key in Settings → API Keys to actually run them.
              </p>
            </div>
            <Button variant="secondary" onClick={() => void loadOpenRouter()} disabled={orLoading}>
              {orLoading ? 'Loading…' : orModels ? 'Refresh' : 'Browse OpenRouter'}
            </Button>
          </div>
          {orModels && (
            <>
              <input
                value={orQuery}
                onChange={(e) => setOrQuery(e.target.value)}
                placeholder={`Search ${orModels.length} models…`}
                className="w-full rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {orModels
                  .filter((m) => {
                    const q = orQuery.trim().toLowerCase()
                    return (
                      !q || m.name.toLowerCase().includes(q) || m.apiModelId.toLowerCase().includes(q)
                    )
                  })
                  .slice(0, 60)
                  .map((m) => {
                    const already = customModels.some((c) => c.id === `openrouter:${m.apiModelId}`)
                    return (
                      <div
                        key={m.apiModelId}
                        className="flex items-center gap-2 rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1 text-[12px]"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[var(--text-primary)]">{m.name}</div>
                          <div className="truncate font-mono text-[11px] text-[var(--text-muted)]">
                            {m.apiModelId} · {Math.round(m.contextWindow / 1024)}K
                            {m.supportsTools ? ' · tools' : ''}
                            {m.supportsVision ? ' · vision' : ''}
                          </div>
                        </div>
                        <button
                          onClick={() => void addOpenRouterModel(m)}
                          disabled={already}
                          className="shrink-0 rounded bg-[var(--bg-tertiary)] px-2 py-0.5 text-[12px] text-[var(--text-secondary)] hover:text-[var(--accent)] disabled:opacity-40"
                        >
                          {already ? 'Added' : 'Add'}
                        </button>
                      </div>
                    )
                  })}
              </div>
            </>
          )}
        </div>

        {/* Import live models — pull any provider's CURRENT catalog and add the
            ones you want as custom models (tools/vision default off; edit after). */}
        <div className="space-y-2 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="font-mono text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
                {t('Import live models')}
              </div>
              <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                Pull a provider&apos;s current model list and import the ones you want. Needs that
                provider&apos;s key in Settings → API Keys.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <select
                value={importProvider}
                onChange={(e) => {
                  setImportProvider(e.target.value)
                  setLiveIds(null)
                }}
                className="rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              >
                {importProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <Button variant="secondary" onClick={() => void handleFetchLive()} disabled={importBusy}>
                {importBusy ? 'Loading…' : 'Fetch live'}
              </Button>
            </div>
          </div>
          {liveIds && (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] text-[var(--text-muted)]">
                  {liveIds.length} live model{liveIds.length === 1 ? '' : 's'}
                </span>
                <button
                  onClick={() => void handleImportLive(liveIds)}
                  disabled={importBusy || liveIds.length === 0}
                  className="shrink-0 rounded bg-[var(--bg-tertiary)] px-2 py-0.5 text-[12px] text-[var(--text-secondary)] hover:text-[var(--accent)] disabled:opacity-40"
                >
                  {t('Import all')}
                </button>
              </div>
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {liveIds.slice(0, 200).map((id) => (
                  <div
                    key={id}
                    className="flex items-center gap-2 rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1 text-[12px]"
                  >
                    <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-primary)]">
                      {id}
                    </div>
                    <button
                      onClick={() => void handleImportLive([id])}
                      disabled={importBusy}
                      className="shrink-0 rounded bg-[var(--bg-tertiary)] px-2 py-0.5 text-[12px] text-[var(--text-secondary)] hover:text-[var(--accent)] disabled:opacity-40"
                    >
                      {t('Add')}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {customModels.length > 0 && (
          <div className="space-y-1.5">
            {customModels.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-2 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12px]"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[var(--text-primary)]">{m.name}</div>
                  <div className="mt-0.5 truncate font-mono text-[12px] text-[var(--text-muted)]">
                    {m.id} · {Math.round(m.contextWindow / 1024)}K
                    {m.supportsTools ? ' · tools' : ''}
                    {m.supportsVision ? ' · vision' : ''}
                  </div>
                </div>
                <IconButton tone="danger" onClick={() => handleRemoveCustom(m.id)} title={t('Remove')} aria-label={t('Remove')}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </IconButton>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
              {t('Quick presets:')}
            </span>
            {PRESET_TEMPLATES.map((p) => (
              <button
                key={p.id}
                onClick={() => applyPreset(p)}
                className="rounded bg-[var(--bg-tertiary)] px-2 py-0.5 font-mono text-[12px] text-[var(--text-secondary)] hover:text-[var(--accent)]"
              >
                {p.name}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
                {t('Model id')}
              </span>
              <input
                type="text"
                value={draft.id}
                onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                placeholder="deepseek-v4-pro"
                className="rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
                {t('Display name')}
              </span>
              <input
                type="text"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={t('DeepSeek V4 Pro')}
                className="rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
                {t('Context window')}
              </span>
              <input
                type="number"
                min={1024}
                step={1024}
                value={draft.contextWindow}
                onChange={(e) =>
                  setDraft({ ...draft, contextWindow: Math.max(1024, Number(e.target.value) || 65536) })
                }
                className="rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </label>
            <div className="flex flex-col justify-end gap-1">
              <span className="text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
                {t('Capabilities')}
              </span>
              <div className="flex items-center gap-3 text-[12px] text-[var(--text-secondary)]">
                <label className="flex cursor-pointer items-center gap-1.5">
                  <Toggle
                    checked={draft.supportsTools}
                    onChange={(v) => setDraft({ ...draft, supportsTools: v })}
                    aria-label={t('Supports tools')}
                  />
                  {t('Tools')}
                </label>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <Toggle
                    checked={draft.supportsVision}
                    onChange={(v) => setDraft({ ...draft, supportsVision: v })}
                    aria-label={t('Supports vision')}
                  />
                  {t('Vision')}
                </label>
              </div>
            </div>
          </div>

          <Button variant="primary" onClick={handleAddCustom} disabled={!draft.id.trim() || !draft.name.trim()}>
            {t('Add model')}
          </Button>
        </div>
      </div>
    </div>
  )
}
