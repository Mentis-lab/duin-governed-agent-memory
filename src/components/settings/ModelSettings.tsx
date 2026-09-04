import { t, tf } from '@/lib/i18n'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Toggle } from '@/components/ui/Toggle'
import { PanelState } from '@/components/ui/PanelState'
import {
  DraftTextarea,
  NumberField,
  SavedMark,
  SettingsLink,
  SettingsLoadError,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  ToggleRow,
  useSavedFlash
} from '@/components/ui/settings'
import { flashWhenSaved } from '@/components/ui/settings/useSavedFlash'
import { invoke, query } from '@/lib/ipc-client'
import { describeError } from '@/lib/result'
import { panelFromResult, panelLoading, panelReady, type PanelStatus } from '@/lib/panel-state'
import { useDirtyGuard } from '@/hooks/useDirtyGuard'
import { useModelStore } from '@/stores/model-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useProvidersStore } from '@/stores/providers-store'
import { toast } from '@/stores/toast-store'
import { ApiKeyModal } from './ApiKeyModal'
import { healthReasonLabel, providerFixHint } from '@/lib/model-label'
import {
  AUTO_ENGINE,
  DEFAULT_MODEL_CONFIG,
  type ModelConfig,
  type ModelInfo,
  type ProviderHealth,
  type ProviderId,
  type ProviderPolicy,
  type RouteTask
} from '@/lib/types'

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

interface ImportProvider {
  id: string
  label: string
}

/** Chip copy is translated at RENDER time (t(label)); the table holds the English keys. */
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

/** Health chip for a provider row: what the last REAL completion probe said. */
function healthChip(h: ProviderHealth | undefined): { label: string; tone: string } {
  if (!h) return { label: 'unchecked', tone: 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]' }
  if (h.healthy) return { label: 'healthy', tone: 'bg-[var(--success)]/15 text-[var(--success)]' }
  const amber = h.reason === 'no-credit' || h.reason === 'rate-limit' || h.reason === 'no-key'
  return {
    label: healthReasonLabel(h.reason),
    tone: amber ? 'bg-[var(--warning)]/15 text-[var(--warning)]' : 'bg-[var(--error)]/15 text-[var(--error)]'
  }
}

/** The roles an operator can override. `embed` stays local by nature and `reason` is a legacy
 *  alias of chat, so neither is offered. Labels and hints are translated where rendered. */
const OVERRIDABLE_ROLES: Array<{ role: RouteTask; label: string; hint: string }> = [
  { role: 'chat', label: 'Chat', hint: 'Grounded answers to you' },
  { role: 'agentic', label: 'Agentic', hint: 'Tool-heavy turns, sub-agents, loops' },
  { role: 'extraction', label: 'Extraction', hint: 'Background comprehension of your notes' },
  { role: 'reviewer', label: 'Reviewer', hint: 'Reviews risky actions (prefers a different family)' },
  { role: 'jury', label: 'Jury', hint: 'Governs beliefs — distinct healthy families' },
  { role: 'title', label: 'Titles', hint: 'Conversation titles — cheapest healthy model' }
]

/** Engine speed (policy.speed): which tier of EACH provider is tried first, inside the order. */
const SPEED_OPTIONS: Array<{ value: NonNullable<ProviderPolicy['speed']>; label: string; copy: string }> = [
  { value: 'fast', label: 'Fast', copy: 'fast: the quick model of each provider first' },
  { value: 'balanced', label: 'Balanced', copy: 'balanced: the strong model first' },
  { value: 'strong', label: 'Strong', copy: 'strong: the reasoning model first' }
]

const EMPTY_DRAFT: ModelInfo = {
  id: '',
  name: '',
  contextWindow: 65536,
  supportsTools: true,
  supportsVision: false
}

function mergeConfig(stored: Partial<ModelConfig> | undefined): ModelConfig {
  return { ...DEFAULT_MODEL_CONFIG, ...(stored ?? {}) }
}

function formatAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return tf('{n}s ago', { n: s })
  const m = Math.round(s / 60)
  if (m < 60) return tf('{n}m ago', { n: m })
  return tf('{n}h ago', { n: Math.round(m / 60) })
}

/**
 * Main's health detail for a keyed provider with nothing to probe is English prose
 * (electron/services/providers/provider-health.ts); it points at this page's Custom models
 * section, so give it the operator's language here.
 */
function localizeDetail(detail: string): string {
  if (detail.startsWith('no model to probe with')) {
    return t('No model to probe with: add one under Custom models below.')
  }
  return detail
}

const RANGE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])

/**
 * A slider that commits once — on pointer-up, blur, or a keyboard step — instead of writing
 * settings.json on every drag tick. The draft follows the stored value while idle.
 */
function RangeField({
  label,
  value,
  min,
  max,
  step,
  onCommit
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onCommit: (next: number) => Promise<boolean | void> | boolean | void
}): React.ReactElement {
  const id = useId()
  const [draft, setDraft] = useState(value)
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    if (!dragging) setDraft(value)
  }, [value, dragging])
  const { saved, flash } = useSavedFlash()
  const commit = (next: number): void => {
    setDragging(false)
    if (next !== value) flashWhenSaved(onCommit(next), flash)
  }
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex items-center justify-between text-[12px] text-[var(--text-secondary)]">
        <span>
          {label} · {draft.toFixed(2)}
        </span>
        {saved && <SavedMark />}
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerDown={() => setDragging(true)}
        onPointerUp={(e) => commit(Number(e.currentTarget.value))}
        onBlur={(e) => commit(Number(e.currentTarget.value))}
        onKeyUp={(e) => {
          if (RANGE_KEYS.has(e.key)) commit(Number(e.currentTarget.value))
        }}
        className="accent-[var(--accent)]"
      />
    </div>
  )
}

export function ModelSettings() {
  const models = useModelStore((s) => s.models)
  const loadModels = useModelStore((s) => s.loadModels)
  const policy = useModelStore((s) => s.policy)
  const health = useModelStore((s) => s.health)
  const probe = useModelStore((s) => s.probe)
  const setPolicy = useModelStore((s) => s.setPolicy)
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const providerEntries = useProvidersStore((s) => s.providers)
  const providersLoaded = useProvidersStore((s) => s.loaded)
  const refreshProviders = useProvidersStore((s) => s.refresh)
  useEffect(() => {
    if (!providersLoaded) void refreshProviders()
  }, [providersLoaded, refreshProviders])
  // Policy + cached health arrive with loadModels; re-read on mount so the pane is fresh.
  useEffect(() => {
    void loadModels()
  }, [loadModels])

  // ── Providers & policy ──
  // The operator's ORDER is the primary key of every resolution; health — a real
  // completion — filters out what cannot answer. There is no default model.
  const [keyModal, setKeyModal] = useState<ProviderId | null>(null)
  const [probing, setProbing] = useState<string | null>(null)
  const [showRoles, setShowRoles] = useState(false)
  const providerLabel = useCallback(
    (id: string): string => providerEntries.find((p) => p.id === id)?.label ?? id,
    [providerEntries]
  )
  const healthFor = (id: string): ProviderHealth | undefined => health.find((h) => h.provider === id)
  /** The universe of providers (the PROVIDERS table, via listProviders), in the effective order:
   *  the explicit policy order first, then the rest in catalog order. An empty explicit order
   *  means "every keyed provider in catalog order" — shown as the catalog order. */
  const orderedProviders = useMemo<ProviderId[]>(() => {
    const known = providerEntries.map((p) => p.id)
    const explicit = (policy?.order ?? []).filter((p) => known.includes(p))
    const rest = known.filter((p) => !explicit.includes(p))
    return [...explicit, ...rest]
  }, [policy, providerEntries])
  const explicitOrder = policy?.order?.length ? policy.order : null
  const moveProvider = async (id: ProviderId, delta: -1 | 1) => {
    const current = [...orderedProviders]
    const i = current.indexOf(id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= current.length) return
    ;[current[i], current[j]] = [current[j], current[i]]
    await setPolicy({ order: current })
  }
  // The way back from "Move up": an empty order means catalog order again.
  const resetOrder = async () => {
    if (await setPolicy({ order: [] })) toast.success(t('Provider order reset to the catalog order'))
  }
  const probeOne = async (id: string | 'all') => {
    setProbing(id)
    try {
      await probe(id)
    } finally {
      setProbing(null)
    }
  }
  const roleFirst = (role: RouteTask): ProviderId | '' => policy?.roles?.[role]?.[0] ?? ''
  const { saved: rolesSaved, flash: flashRoles } = useSavedFlash()
  const setRoleOverride = (role: RouteTask, provider: ProviderId | ''): void => {
    const roles: Partial<Record<RouteTask, ProviderId[]>> = { ...(policy?.roles ?? {}) }
    if (provider) roles[role] = [provider, ...orderedProviders.filter((p) => p !== provider)]
    else delete roles[role]
    flashWhenSaved(setPolicy({ roles }), flashRoles)
  }
  const { saved: speedSaved, flash: flashSpeed } = useSavedFlash()
  // Three numbers, not two: a provider with no key is not "unhealthy", it is unconfigured.
  const healthyCount = health.filter((h) => h.healthy).length
  const noKeyCount = health.filter((h) => !h.healthy && h.reason === 'no-key').length
  const failingCount = health.filter((h) => !h.healthy && h.reason !== 'no-key').length

  const [selectedId, setSelectedId] = useState<string>(models[0]?.id ?? '')
  const [testStatus, setTestStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [verification, setVerification] = useState<CatalogVerification | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [orModels, setOrModels] = useState<OpenRouterBrowseModel[] | null>(null)
  const [orQuery, setOrQuery] = useState('')
  const [orLoading, setOrLoading] = useState(false)
  // Import a provider's live catalog as custom models. The provider list is a READ and
  // renders its failure; an empty select here used to be indistinguishable from "no providers".
  const [importProviders, setImportProviders] = useState<PanelStatus<ImportProvider[]>>(panelLoading())
  const [importProvider, setImportProvider] = useState<string>('groq')
  const [liveIds, setLiveIds] = useState<string[] | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [draft, setDraft] = useState<ModelInfo>(EMPTY_DRAFT)
  // The provider is the endpoint the id is sent to. The form used to omit it and main
  // stamped DeepSeek on every hand-added model, so a Groq or Mistral id was silently
  // routed to DeepSeek; now the operator picks it and the add is refused without one.
  const [draftProvider, setDraftProvider] = useState<ProviderId | ''>('')
  const draftDirty = draft.id.trim() !== '' || draft.name.trim() !== '' || draftProvider !== ''
  useDirtyGuard('settings:models:custom-model', t('the custom model form'), draftDirty)

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

  const writeConfig = (partial: Partial<ModelConfig>): Promise<boolean> => {
    const next = {
      ...settings.modelConfig,
      [selectedId]: { ...cfg, ...partial }
    }
    return updateSettings({ modelConfig: next })
  }

  // Custom = not shipped in MODEL_CATALOG. Derived from the builtin flag the
  // model:list handler stamps.
  const customModels = useMemo(() => models.filter((m) => !m.builtin && !m.internal), [models])

  const handleAddCustom = async () => {
    if (!draft.id.trim()) {
      toast.warning(t('Model id is required (the id the provider serves)'))
      return
    }
    if (!draft.name.trim()) {
      toast.warning(t('Display name is required'))
      return
    }
    if (!draftProvider) {
      toast.warning(t('Pick the provider that serves this model id'))
      return
    }
    try {
      await invoke('add model', () =>
        window.api.model.addCustom({
          id: draft.id.trim(),
          name: draft.name.trim(),
          provider: draftProvider,
          contextWindow: draft.contextWindow,
          supportsTools: draft.supportsTools,
          supportsVision: draft.supportsVision
        })
      )
    } catch (e) {
      toast.error(describeError(e, t('Could not add the model')))
      return
    }
    await loadModels()
    toast.success(tf('{name} added', { name: draft.name.trim() }))
    setDraftProvider('')
    setDraft(EMPTY_DRAFT)
  }

  const handleRemoveCustom = async (id: string) => {
    if (!window.confirm(tf('Remove the custom model "{id}"?', { id }))) return
    try {
      await invoke('remove model', () => window.api.model.removeCustom(id))
    } catch (e) {
      toast.error(describeError(e, t('Could not remove the model')))
      return
    }
    await loadModels()
    toast.success(tf('{id} removed', { id }))
    if (selectedId === id) {
      setSelectedId(models.find((m) => m.id !== id)?.id ?? '')
    }
  }

  const loadOpenRouter = async () => {
    setOrLoading(true)
    try {
      const r = await query<OpenRouterBrowseModel[]>('OpenRouter catalog', () => window.api.model.openRouterCatalog())
      if (r.ok) setOrModels(r.data)
      else toast.error(r.error)
    } finally {
      setOrLoading(false)
    }
  }

  const addOpenRouterModel = async (m: OpenRouterBrowseModel) => {
    try {
      await invoke('add model', () =>
        window.api.model.addCustom({
          id: `openrouter:${m.apiModelId}`,
          name: m.name,
          provider: 'openrouter',
          contextWindow: m.contextWindow,
          supportsTools: m.supportsTools,
          supportsVision: m.supportsVision
        })
      )
    } catch (e) {
      toast.error(describeError(e, t('Could not add the model')))
      return
    }
    await loadModels()
    toast.success(tf('{name} added via OpenRouter', { name: m.name }))
  }

  const loadImportProviders = useCallback(async () => {
    setImportProviders(panelLoading())
    const r = await query<ImportProvider[]>('the provider list', () => window.api.model.listProviders())
    setImportProviders(r.ok ? panelReady(r.data.map((p) => ({ id: p.id, label: p.label }))) : panelFromResult(r))
  }, [])
  useEffect(() => {
    void loadImportProviders()
  }, [loadImportProviders])

  const handleFetchLive = async () => {
    setImportBusy(true)
    try {
      const r = await query<string[]>('the live model list', () => window.api.model.listLive(importProvider))
      if (r.ok) setLiveIds(r.data)
      else toast.error(r.error)
    } finally {
      setImportBusy(false)
    }
  }

  const handleImportLive = async (ids: string[]) => {
    setImportBusy(true)
    try {
      const data = await invoke<{ added: number; skipped: number }>('import models', () =>
        window.api.model.importLive(importProvider, ids)
      )
      await loadModels()
      toast.success(
        data.skipped
          ? tf('Imported {added} models, {skipped} already present', { added: data.added, skipped: data.skipped })
          : tf('Imported {added} models', { added: data.added })
      )
    } catch (e) {
      toast.error(describeError(e, t('Could not import the models')))
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
    setVerifying(true)
    try {
      const r = await query<CatalogVerification>('the catalog check', () => window.api.model.verifyCatalog())
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      const report = r.data
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
          tf('{n} models are on a provider that accepted the key but has no credit. Fund the account; the key is fine.', {
            n: noCreditCount
          })
        )
      }
      if (missingCount > 0) {
        toast.warning(
          tf('{verified} verified, {missing} missing from the provider’s list, {noKey} waiting for a key', {
            verified: verifiedCount,
            missing: missingCount,
            noKey: noKeyCount
          })
        )
      } else if (verifiedCount > 0) {
        toast.success(
          noKeyCount > 0
            ? tf('{verified} verified, {noKey} waiting for a key', { verified: verifiedCount, noKey: noKeyCount })
            : tf('{verified} verified against the providers', { verified: verifiedCount })
        )
      } else {
        toast.warning(t('No models could be verified. Add a provider key under API Keys.'))
      }
    } finally {
      setVerifying(false)
    }
  }

  const handleTest = async () => {
    if (!selectedId) return
    setTesting(true)
    setTestStatus(null)
    const modelName = selectedModel?.name ?? selectedId
    try {
      // A throwaway conversation PINNED to the selected model — the test says whether THIS
      // model answers, not whatever the policy would pick. It is deleted whatever happens.
      const conv = await invoke<{ id: string }>('create the test conversation', () =>
        window.api.conversation.create(selectedId)
      )
      const conversationId = conv.id
      try {
        const start = Date.now()
        await invoke('send the test message', () =>
          window.api.chat.send({
            conversationId,
            model: selectedId,
            content: 'Respond with only the word PONG.',
            activeSkillIds: []
          })
        )
        const elapsed = Date.now() - start
        setTestStatus({ ok: true, message: tf('Responded in {ms} ms', { ms: elapsed }) })
        toast.success(tf('{name} responded in {ms} ms', { name: modelName, ms: elapsed }))
      } finally {
        try {
          await invoke('delete the test conversation', () => window.api.conversation.delete(conversationId))
        } catch (e) {
          toast.warning(describeError(e, t('The test conversation could not be removed')))
        }
      }
    } catch (e) {
      const msg = describeError(e, t('unknown error'))
      setTestStatus({ ok: false, message: tf('Error: {message}', { message: msg }) })
      toast.error(tf('Model test failed: {message}', { message: msg }))
    } finally {
      setTesting(false)
    }
  }

  const orderHint = (
    <>
      {explicitOrder
        ? t('Your order, top first. Health decides who can answer; order decides who goes first.')
        : t('Catalog order until you move a provider. Then the order is yours.')}
      {health.length > 0
        ? ` · ${tf('{healthy} healthy, {failing} failing, {noKey} without a key', {
            healthy: healthyCount,
            failing: failingCount,
            noKey: noKeyCount
          })}`
        : ''}
    </>
  )

  const activeSpeed = policy?.speed ?? 'fast'
  const providerSelectId = useId()
  const modelIdInputId = useId()
  const displayNameInputId = useId()

  return (
    <SettingsPage
      purpose={t(
        'There is no default model. Every job asks for a role, and the role goes to the first provider in your order that can answer. A conversation can pin one model from its composer.'
      )}
    >
      <SettingsSection
        label={t('Provider order')}
        actions={
          <>
            {explicitOrder && (
              <Button size="sm" onClick={() => void resetOrder()}>
                {t('Reset to catalog order')}
              </Button>
            )}
            <Button size="sm" onClick={() => void probeOne('all')} disabled={probing !== null}>
              {probing === 'all' ? t('Probing…') : t('Probe all')}
            </Button>
          </>
        }
      >
        <SettingsRow label={t('Providers')} hint={orderHint}>
          {!providersLoaded ? (
            <SettingsLoading what={t('providers')} />
          ) : orderedProviders.length === 0 ? (
            <SettingsLoadError
              what={t('providers')}
              message={t('The provider list came back empty.')}
              onRetry={() => void refreshProviders()}
            />
          ) : (
            <div className="divide-y divide-[var(--panel-border)] rounded-md border border-[var(--panel-border)]">
              {orderedProviders.map((pid, idx) => {
                const h = healthFor(pid)
                const chip = healthChip(h)
                const hint = h && !h.healthy ? providerFixHint(h.reason, providerLabel(pid)) : ''
                const when = !h
                  ? t('not probed yet')
                  : h.reason === 'no-key'
                    ? t('no key')
                    : h.checkedAt
                      ? formatAgo(h.checkedAt)
                      : t('not probed yet')
                return (
                  <div key={pid} className="flex items-center gap-2 px-2 py-1.5 text-[12px]" title={hint || undefined}>
                    <span className="w-5 shrink-0 font-mono text-[11px] text-[var(--text-muted)]">{idx + 1}</span>
                    <div className="flex shrink-0 flex-col">
                      <IconButton
                        onClick={() => void moveProvider(pid, -1)}
                        disabled={idx === 0}
                        title={t('Move up')}
                        aria-label={tf('Move {name} up', { name: providerLabel(pid) })}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
                          <path d="M18 15l-6-6-6 6" />
                        </svg>
                      </IconButton>
                      <IconButton
                        onClick={() => void moveProvider(pid, 1)}
                        disabled={idx === orderedProviders.length - 1}
                        title={t('Move down')}
                        aria-label={tf('Move {name} down', { name: providerLabel(pid) })}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </IconButton>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[var(--text-primary)]">{providerLabel(pid)}</div>
                      <div className="truncate font-mono text-[11px] text-[var(--text-muted)]">
                        {h?.probedModelId ? `${h.probedModelId} · ` : ''}
                        {when}
                        {typeof h?.latencyMs === 'number' ? ` · ${h.latencyMs} ms` : ''}
                        {h?.detail && !h.healthy ? ` · ${localizeDetail(h.detail)}` : ''}
                      </div>
                    </div>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] uppercase tracking-wider ${chip.tone}`}>
                      {t(chip.label)}
                    </span>
                    {h?.reason === 'no-key' ? (
                      <Button size="sm" onClick={() => setKeyModal(pid)}>
                        {t('Add key')}
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => void probeOne(pid)} disabled={probing !== null}>
                        {probing === pid ? t('Probing…') : t('Probe now')}
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </SettingsRow>

        <ToggleRow
          label={t('Background stays local')}
          hint={t(
            'Note extraction, the jury, titles and embeddings only use providers on this machine (Ollama). Chat and agentic turns still follow the order above.'
          )}
          checked={policy?.localOnlyBackground === true}
          onChange={(v) => setPolicy({ localOnlyBackground: v })}
        />

        <SettingsRow
          label={t('Engine speed')}
          hint={t(SPEED_OPTIONS.find((o) => o.value === activeSpeed)?.copy ?? SPEED_OPTIONS[0].copy)}
          saved={speedSaved}
          control={
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('Engine speed')}>
              {SPEED_OPTIONS.map(({ value, label, copy }) => {
                const active = activeSpeed === value
                return (
                  <Button
                    key={value}
                    size="sm"
                    variant={active ? 'primary' : 'secondary'}
                    role="radio"
                    aria-checked={active}
                    title={t(copy)}
                    onClick={() => {
                      if (!active) flashWhenSaved(setPolicy({ speed: value }), flashSpeed)
                    }}
                  >
                    {t(label)}
                  </Button>
                )
              })}
            </div>
          }
        />

        <SettingsRow
          label={t('Prefer a provider per role')}
          hint={t('Advanced. Each role follows the order above unless you pick a provider to try first for it.')}
          saved={rolesSaved}
          control={
            <Button size="sm" variant="ghost" aria-expanded={showRoles} onClick={() => setShowRoles((v) => !v)}>
              {showRoles ? t('Hide roles') : t('Show roles')}
            </Button>
          }
        >
          {showRoles && (
            <div className="space-y-1.5">
              {OVERRIDABLE_ROLES.map(({ role, label, hint }) => (
                <div key={role} className="flex items-center gap-3 text-[12px]">
                  <div className="min-w-0 flex-1">
                    <div className="text-[var(--text-primary)]">{t(label)}</div>
                    <div className="text-[11px] text-[var(--text-muted)]">{t(hint)}</div>
                  </div>
                  <Select
                    value={roleFirst(role)}
                    onChange={(e) => setRoleOverride(role, e.target.value as ProviderId | '')}
                    aria-label={t(label)}
                    className="max-w-[45%] shrink-0 font-mono"
                  >
                    <option value="">{t('follow order')}</option>
                    {orderedProviders.map((pid) => {
                      const ph = healthFor(pid)
                      return (
                        <option key={pid} value={pid}>
                          {providerLabel(pid)}
                          {ph && !ph.healthy ? ` (${t(healthReasonLabel(ph.reason))})` : ''}
                        </option>
                      )
                    })}
                  </Select>
                </div>
              ))}
            </div>
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        label={t('Catalog check')}
        actions={
          <Button size="sm" variant="primary" onClick={() => void handleVerifyCatalog()} disabled={verifying}>
            {verifying ? t('Verifying…') : t('Verify against providers')}
          </Button>
        }
      >
        <SettingsRow
          label={t('Verify model ids against your providers')}
          hint={t(
            'Checks every model id in the picker against the provider’s live model list with your stored key. Missing means the provider does not serve that id right now; unverifiable means the provider publishes no list.'
          )}
        >
          {verification ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[12px] text-[var(--text-muted)]">
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
                  <span key={p.provider} className={tone}>
                    {providerLabel(p.provider)}:{' '}
                    {p.status === 'ok' ? tf('{n} live ids', { n: p.liveCount ?? 0 }) : t(statusChip(p.status).label)}
                  </span>
                )
              })}
            </div>
          ) : (
            <p className="text-[12px] text-[var(--text-muted)]">{t('Not checked yet.')}</p>
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection label={t('Per-model settings')}>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('Pick a model to configure')}>
          {models
            .filter((m) => m.id !== AUTO_ENGINE)
            .map((m) => {
              const status = statusByModelId.get(m.id)
              const chip = statusChip(status)
              const found = verification?.models.find((x) => x.modelId === m.id)
              const active = selectedId === m.id
              return (
                <Button
                  key={m.id}
                  size="sm"
                  variant={active ? 'primary' : 'secondary'}
                  aria-pressed={active}
                  onClick={() => setSelectedId(m.id)}
                  title={found?.reason ?? m.id}
                  className="font-mono"
                >
                  {m.name}
                  {verification && (
                    <span className={`ml-1.5 rounded px-1 py-0.5 text-[11px] uppercase tracking-wider ${chip.tone}`}>
                      {t(chip.label)}
                    </span>
                  )}
                </Button>
              )
            })}
        </div>

        {selectedModel && (
          <SettingsRow
            label={selectedModel.name}
            hint={t(
              'Temperature, top-p, max tokens and a system prompt override for this model. Applied whenever a conversation is pinned to it or the policy picks it.'
            )}
          >
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <RangeField
                  label={t('Temperature')}
                  value={cfg.temperature}
                  min={0}
                  max={2}
                  step={0.05}
                  onCommit={(v) => writeConfig({ temperature: v })}
                />
                <RangeField
                  label={t('Top-p')}
                  value={cfg.topP}
                  min={0}
                  max={1}
                  step={0.05}
                  onCommit={(v) => writeConfig({ topP: v })}
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[12px] text-[var(--text-secondary)]">{t('Max tokens')}</div>
                  <div className="text-[11px] text-[var(--text-muted)]">{t('0 means the model’s own default.')}</div>
                </div>
                <NumberField
                  aria-label={t('Max tokens')}
                  value={cfg.maxTokens ?? 0}
                  spec={{ min: 1, integer: true, zeroMeansOff: true }}
                  unit={t('tokens')}
                  onCommit={(n) => writeConfig({ maxTokens: n === 0 ? null : n })}
                />
              </div>

              <div>
                <div className="mb-1 text-[12px] text-[var(--text-secondary)]">{t('System prompt override')}</div>
                <DraftTextarea
                  aria-label={t('System prompt override')}
                  value={cfg.systemPromptOverride}
                  rows={3}
                  placeholder={t('Leave blank to use the default prompt.')}
                  onCommit={(text) => writeConfig({ systemPromptOverride: text })}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" size="sm" onClick={() => void handleTest()} disabled={testing}>
                  {testing ? t('Testing…') : t('Test model')}
                </Button>
                {testStatus && (
                  <span className={`text-[12px] ${testStatus.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>
                    {testStatus.message}
                  </span>
                )}
              </div>
            </div>
          </SettingsRow>
        )}
      </SettingsSection>

      <SettingsSection
        label={t('Custom models')}
        description={t(
          'Add any model id one of your keys can call. Built-in models stay; a custom model with the same id replaces the built-in one.'
        )}
      >
        <SettingsRow
          label={t('Add from OpenRouter')}
          hint={
            <>
              {t('Browse every model your OpenRouter key can reach and add one with a click. Running it needs an OpenRouter key under ')}
              <SettingsLink tab="api">{t('API Keys')}</SettingsLink>.
            </>
          }
          control={
            <Button size="sm" onClick={() => void loadOpenRouter()} disabled={orLoading}>
              {orLoading ? t('Loading…') : orModels ? t('Refresh') : t('Browse OpenRouter')}
            </Button>
          }
        >
          {orModels && (
            <div className="space-y-2">
              <Input
                value={orQuery}
                onChange={(e) => setOrQuery(e.target.value)}
                aria-label={t('Search OpenRouter models')}
                placeholder={tf('Search {n} models…', { n: orModels.length })}
                className="font-mono"
              />
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {orModels
                  .filter((m) => {
                    const q = orQuery.trim().toLowerCase()
                    return !q || m.name.toLowerCase().includes(q) || m.apiModelId.toLowerCase().includes(q)
                  })
                  .slice(0, 60)
                  .map((m) => {
                    const already = customModels.some((c) => c.id === `openrouter:${m.apiModelId}`)
                    return (
                      <div
                        key={m.apiModelId}
                        className="flex items-center gap-2 rounded-md border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1 text-[12px]"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[var(--text-primary)]">{m.name}</div>
                          <div className="truncate font-mono text-[11px] text-[var(--text-muted)]">
                            {m.apiModelId} · {Math.round(m.contextWindow / 1024)}K
                            {m.supportsTools ? ` · ${t('tools')}` : ''}
                            {m.supportsVision ? ` · ${t('vision')}` : ''}
                          </div>
                        </div>
                        <Button size="sm" variant="ghost" onClick={() => void addOpenRouterModel(m)} disabled={already}>
                          {already ? t('Added') : t('Add')}
                        </Button>
                      </div>
                    )
                  })}
              </div>
            </div>
          )}
        </SettingsRow>

        <SettingsRow
          label={t('Import live models')}
          hint={
            <>
              {t('Pull a provider’s current model list and import the ones you want. Needs that provider’s key under ')}
              <SettingsLink tab="api">{t('API Keys')}</SettingsLink>.
            </>
          }
          control={
            <PanelState
              state={importProviders}
              loading={<SettingsLoading what={t('the provider list')} />}
              error={(message, retry) => <SettingsLoadError what={t('the provider list')} message={message} onRetry={retry} />}
              empty={<span className="text-[12px] text-[var(--text-muted)]">{t('No providers to import from.')}</span>}
              onRetry={() => void loadImportProviders()}
            >
              {(list) => (
                <>
                  <Select
                    value={importProvider}
                    aria-label={t('Provider to import from')}
                    onChange={(e) => {
                      setImportProvider(e.target.value)
                      setLiveIds(null)
                    }}
                    className="font-mono"
                  >
                    {list.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </Select>
                  <Button size="sm" onClick={() => void handleFetchLive()} disabled={importBusy}>
                    {importBusy ? t('Loading…') : t('Fetch live')}
                  </Button>
                </>
              )}
            </PanelState>
          }
        >
          {liveIds && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] text-[var(--text-muted)]">
                  {tf('{n} live models', { n: liveIds.length })}
                </span>
                <Button size="sm" onClick={() => void handleImportLive(liveIds)} disabled={importBusy || liveIds.length === 0}>
                  {t('Import all')}
                </Button>
              </div>
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {liveIds.slice(0, 200).map((id) => (
                  <div
                    key={id}
                    className="flex items-center gap-2 rounded-md border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1 text-[12px]"
                  >
                    <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-primary)]">{id}</div>
                    <Button size="sm" variant="ghost" onClick={() => void handleImportLive([id])} disabled={importBusy}>
                      {t('Add')}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </SettingsRow>

        {customModels.length > 0 && (
          <SettingsRow label={t('Your custom models')}>
            <div className="space-y-1.5">
              {customModels.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center gap-2 rounded-md border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-[12px]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[var(--text-primary)]">{m.name}</div>
                    <div className="mt-0.5 truncate font-mono text-[12px] text-[var(--text-muted)]">
                      {m.id} · {Math.round(m.contextWindow / 1024)}K
                      {m.supportsTools ? ` · ${t('tools')}` : ''}
                      {m.supportsVision ? ` · ${t('vision')}` : ''}
                    </div>
                  </div>
                  <IconButton
                    tone="danger"
                    onClick={() => void handleRemoveCustom(m.id)}
                    title={t('Remove')}
                    aria-label={tf('Remove {name}', { name: m.name })}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </IconButton>
                </div>
              ))}
            </div>
          </SettingsRow>
        )}

        <SettingsRow label={t('Add a model by id')} hint={t('For a model id the picker does not list yet.')}>
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2 flex flex-col gap-1">
                <label htmlFor={providerSelectId} className="text-[12px] text-[var(--text-secondary)]">
                  {t('Provider')}
                </label>
                <PanelState
                  state={importProviders}
                  loading={<SettingsLoading what={t('the provider list')} />}
                  error={(message, retry) => (
                    <SettingsLoadError what={t('the provider list')} message={message} onRetry={retry} />
                  )}
                  empty={<span className="text-[12px] text-[var(--text-muted)]">{t('No providers to import from.')}</span>}
                  onRetry={() => void loadImportProviders()}
                >
                  {(list) => (
                    <Select
                      id={providerSelectId}
                      value={draftProvider}
                      onChange={(e) => setDraftProvider(e.target.value as ProviderId | '')}
                      className="w-full"
                    >
                      <option value="">{t('Pick the provider that serves this model id')}</option>
                      {list.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </PanelState>
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={modelIdInputId} className="text-[12px] text-[var(--text-secondary)]">
                  {t('Model id')}
                </label>
                <Input
                  id={modelIdInputId}
                  type="text"
                  value={draft.id}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                  placeholder={t('the id the provider serves')}
                  className="font-mono"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={displayNameInputId} className="text-[12px] text-[var(--text-secondary)]">
                  {t('Display name')}
                </label>
                <Input
                  id={displayNameInputId}
                  type="text"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder={t('How the picker shows it')}
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[12px] text-[var(--text-secondary)]">{t('Context window')}</span>
                <NumberField
                  aria-label={t('Context window')}
                  value={draft.contextWindow}
                  spec={{ min: 1024, integer: true }}
                  unit={t('tokens')}
                  onCommit={(n) => setDraft((d) => ({ ...d, contextWindow: n }))}
                />
              </div>
              <div className="flex flex-col justify-end gap-1">
                <span className="text-[12px] text-[var(--text-secondary)]">{t('Capabilities')}</span>
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
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleAddCustom()}
              disabled={!draft.id.trim() || !draft.name.trim() || !draftProvider}
            >
              {t('Add model')}
            </Button>
          </div>
        </SettingsRow>
      </SettingsSection>

      {keyModal && (
        <ApiKeyModal
          required={false}
          defaultProvider={keyModal}
          onDismiss={() => setKeyModal(null)}
          onComplete={() => {
            // Main probes on key save; re-read so the chip is the fresh one, not the cache.
            const saved = keyModal
            setKeyModal(null)
            void probeOne(saved)
          }}
        />
      )}
    </SettingsPage>
  )
}
