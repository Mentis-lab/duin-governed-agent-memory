import { ipcMain, BrowserWindow } from 'electron'
import { join } from 'path'
import { app } from 'electron'
import {
  MODEL_CATALOG,
  PROVIDERS,
  verifyCatalog,
  listLiveModelIds,
  describeBackgroundModel,
  readProviderPolicy,
  writeProviderPolicy,
  resolveRole,
  resolveModel,
  isCallableModel,
  type ProviderId
} from '../services/providers/registry'
import {
  listProviderHealth,
  refreshProviderHealth,
  onProviderHealthChanged
} from '../services/providers/provider-health'
import { MODEL_IPC, AUTO_ENGINE, type ProviderPolicy, type RouteTask } from '../services/providers/roles'
import { ROUTE_TASKS, POLICY_SPEEDS } from '../services/providers/router'
import { buildLiveModelImports, type ImportModelIdentity } from '../services/providers/model-import'
import { messageOf } from '../services/guarded'
import { readSettingsFile, writeSettingsFile } from '../services/settings-file'

interface ModelInfo {
  id: string
  name: string
  provider: ProviderId
  /** Verbatim wire id sent in the request `model` field. Present when the local
   *  `id` was namespaced away from the provider's real id (collision-safe live
   *  import); absent for hand-added models whose `id` IS the wire id. resolveModel
   *  reads this so a namespaced import still calls the provider with the true id. */
  apiModelId?: string
  contextWindow: number
  supportsTools: boolean
  supportsVision: boolean
  isReasoner?: boolean
  /** Whether a reasoning-effort toggle applies (the model is a reasoning model).
   *  Reuses the catalog flags rather than a parallel one. */
  supportsReasoningEffort?: boolean
  tier?: string
  description?: string
  internal?: boolean
  /** True for MODEL_CATALOG entries. The renderer derives "custom models" as
   *  !builtin — a hand-kept id list in ModelSettings drifted to 4 of 32 catalog
   *  entries and mislabelled the rest as custom (found in the 2026-08-21
   *  catalog redo's wiring sweep). */
  builtin?: boolean
}

// `hidden` entries stay in MODEL_CATALOG so their ids still resolve for the benchmark
// harnesses that pin them, but they never cross to the renderer — so no picker, model
// list or settings pane has to know they exist.
const BUILTIN_MODELS: ModelInfo[] = MODEL_CATALOG.filter((m) => !m.hidden).map((m) => ({
  id: m.id,
  name: m.name,
  provider: m.provider,
  contextWindow: m.contextWindow,
  supportsTools: m.supportsTools,
  supportsVision: m.supportsVision,
  isReasoner: m.isReasoner,
  supportsReasoningEffort: !!(m.reasoningCapOnToolUse || m.isReasoner),
  tier: m.tier,
  description: m.description,
  internal: m.internal,
  builtin: true
}))

const getSettingsPath = () => join(app.getPath('userData'), 'settings.json')

function readSettings(): Record<string, unknown> {
  return readSettingsFile(getSettingsPath()).data
}

function writeSettings(settings: Record<string, unknown>): void {
  writeSettingsFile(getSettingsPath(), settings)
}

function readCustomModels(): ModelInfo[] {
  const settings = readSettings()
  const raw = (settings.customModels as ModelInfo[] | undefined) ?? []
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (m) =>
      m &&
      typeof m.id === 'string' &&
      typeof m.name === 'string' &&
      typeof m.contextWindow === 'number'
  )
}

function combinedModels(): ModelInfo[] {
  const customs = readCustomModels().map((m) => ({
    ...m,
    // Rows written before model:addCustom required a provider were always routed to
    // DeepSeek; keeping that read for them changes nothing they did not already do.
    provider: (m.provider as ProviderId) || 'deepseek'
  }))
  const customIds = new Set(customs.map((m) => m.id))
  // Custom entries override built-ins with the same id.
  const builtIns = BUILTIN_MODELS.filter((m) => !customIds.has(m.id))
  return [...builtIns, ...customs]
}

// ── OpenRouter live catalog ────────────────────────────────────────────────
// OpenRouter's /v1/models is a PUBLIC endpoint (no key needed) listing every model
// reachable through the one OpenRouter key. Fetching it lets the user browse-and-add any of
// them instead of hand-typing ids — the "add models easier" path. Each becomes a custom model
// with id `openrouter:<vendor/model>` (routed by resolveModel's openrouter: branch).
interface OpenRouterApiModel {
  id: string
  name?: string
  context_length?: number
  architecture?: { input_modalities?: string[]; modality?: string }
  supported_parameters?: string[]
  pricing?: { prompt?: string; completion?: string }
}

export interface OpenRouterBrowseModel {
  apiModelId: string
  name: string
  contextWindow: number
  supportsTools: boolean
  supportsVision: boolean
  pricePrompt?: string
  priceCompletion?: string
}

function normalizeOpenRouterModel(m: OpenRouterApiModel): OpenRouterBrowseModel | null {
  if (!m || typeof m.id !== 'string' || !m.id) return null
  const modalities = m.architecture?.input_modalities ?? []
  const supportsVision =
    modalities.includes('image') || !!m.architecture?.modality?.includes('image')
  return {
    apiModelId: m.id,
    name: m.name || m.id,
    contextWindow: typeof m.context_length === 'number' && m.context_length > 0 ? m.context_length : 128_000,
    supportsTools: (m.supported_parameters ?? []).includes('tools'),
    supportsVision,
    pricePrompt: m.pricing?.prompt,
    priceCompletion: m.pricing?.completion
  }
}

export function registerModelHandlers(): void {
  ipcMain.handle('model:list', async () => {
    return { success: true, data: combinedModels() }
  })

  ipcMain.handle('model:listProviders', async () => {
    return { success: true, data: Object.values(PROVIDERS).filter((p) => !p.hidden) }
  })

  // ── P0 model plane (roles.ts MODEL_IPC) ──
  // Lane A implements, lanes B/C consume. Policy is the operator's ordered provider preference;
  // health is a completion (provider-health.ts); resolve answers a ROLE with a failover chain.

  ipcMain.handle(MODEL_IPC.policyGet, async () => {
    try {
      return { success: true, data: readProviderPolicy() }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle(MODEL_IPC.policySet, async (_event, patch: Partial<ProviderPolicy> | undefined) => {
    try {
      if (!patch || typeof patch !== 'object') return { success: false, error: 'policy patch must be an object' }
      const known = new Set(Object.keys(PROVIDERS))
      const bad = (v: unknown): string | null =>
        Array.isArray(v) ? (v.find((p) => typeof p !== 'string' || !known.has(p)) as string | undefined) ?? null : 'not a list'
      if (patch.order !== undefined) {
        const b = bad(patch.order)
        if (b) return { success: false, error: `order: unknown provider ${b}` }
      }
      if (patch.speed !== undefined && !(POLICY_SPEEDS as readonly unknown[]).includes(patch.speed)) {
        return { success: false, error: `speed must be one of ${POLICY_SPEEDS.join(' | ')}` }
      }
      if (patch.roles !== undefined) {
        if (!patch.roles || typeof patch.roles !== 'object') return { success: false, error: 'roles must be an object' }
        for (const [k, v] of Object.entries(patch.roles)) {
          if (!(ROUTE_TASKS as readonly string[]).includes(k)) return { success: false, error: `roles: unknown role ${k}` }
          const b = bad(v)
          if (b) return { success: false, error: `roles.${k}: unknown provider ${b}` }
        }
      }
      return { success: true, data: writeProviderPolicy(patch) }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  // Cached (may be up to HEALTH_TTL_MS stale); the fresh path is healthProbe.
  ipcMain.handle(MODEL_IPC.healthList, async () => {
    try {
      return { success: true, data: listProviderHealth() }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle(MODEL_IPC.healthProbe, async (_event, target: unknown) => {
    try {
      if (target !== 'all' && (typeof target !== 'string' || !(target in PROVIDERS))) {
        return { success: false, error: `Unknown provider: ${String(target)}` }
      }
      return { success: true, data: await refreshProviderHealth(target as ProviderId | 'all') }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle(MODEL_IPC.resolve, async (_event, task: unknown, pin?: unknown) => {
    try {
      if (typeof task !== 'string' || !(ROUTE_TASKS as readonly string[]).includes(task)) {
        return { success: false, error: `Unknown role: ${String(task)}` }
      }
      const pinned = typeof pin === 'string' && pin && pin !== AUTO_ENGINE ? pin : undefined
      return { success: true, data: resolveRole(task as RouteTask, { pin: pinned }) }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  // Push: every health/cooldown change → the full list, to every window (keychain:changed pattern).
  onProviderHealthChanged(() => {
    try {
      if (typeof BrowserWindow?.getAllWindows !== 'function') return
      const list = listProviderHealth()
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(MODEL_IPC.healthChanged, list)
      }
    } catch (err) {
      console.error('[model] health-changed broadcast failed:', err)
    }
  })

  // DEPRECATED shims — one phase. There is no stored default model any more (plan §0 D1):
  //   getActive → what the chat ROLE resolves to right now, or the AUTO_ENGINE sentinel.
  //   setActive(id) → moves that model's provider to the FRONT of the policy order. It does not
  //   pin a model (only a conversation may), so an unusable id changes nothing and says so.
  let deprecationWarned = false
  const warnDeprecated = (which: string): void => {
    if (deprecationWarned) return
    deprecationWarned = true
    console.warn(`[model] ${which} is deprecated (P0 model plane): use model:policy:* and model:resolve`)
  }

  ipcMain.handle('model:getActive', async () => {
    warnDeprecated('model:getActive')
    try {
      return { success: true, data: resolveRole('chat')?.modelId ?? AUTO_ENGINE }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('model:setActive', async (_event, id: unknown) => {
    warnDeprecated('model:setActive')
    try {
      if (typeof id !== 'string' || !id || id === AUTO_ENGINE) return { success: true, data: null }
      if (!isCallableModel(id)) {
        return { success: false, error: `${id} is not callable (no key or unknown id); policy unchanged` }
      }
      const provider = resolveModel(id).provider
      const current = readProviderPolicy()
      writeProviderPolicy({ order: [provider, ...current.order.filter((p) => p !== provider)] })
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  // Settings → Models → Background model: what DUIN's own structured work (extraction,
  // titles) resolves to right now and why, so a pinned-but-unusable choice reads as
  // "falling back to Auto → X" instead of silently doing something other than what the
  // operator picked. The setting itself is written through the ordinary settings:set path.
  ipcMain.handle('model:describeBackground', async () => {
    try {
      return { success: true, data: describeBackgroundModel() }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('model:addCustom', async (_event, model: ModelInfo) => {
    try {
      if (!model || typeof model.id !== 'string' || !model.id.trim()) {
        return { success: false, error: 'Model id is required' }
      }
      if (typeof model.name !== 'string' || !model.name.trim()) {
        return { success: false, error: 'Model display name is required' }
      }
      // The provider is where the id is sent. This used to default to DeepSeek whenever the
      // form left it out, so a hand-added Groq or Mistral id hit DeepSeek's endpoint while
      // the copy promised "any model id one of your keys can call". Missing or unknown is
      // now refused; only the legacy read path (combinedModels) still assumes DeepSeek for
      // rows written before the provider was required.
      const provider = typeof model.provider === 'string' ? model.provider.trim() : ''
      if (!provider || !(provider in PROVIDERS)) {
        return { success: false, error: 'Pick the provider that serves this model id' }
      }
      const settings = readSettings()
      const existing = (settings.customModels as ModelInfo[] | undefined) ?? []
      const filtered = existing.filter((m) => m.id !== model.id)
      filtered.push({
        id: model.id.trim(),
        name: model.name.trim(),
        provider: provider as ProviderId,
        contextWindow:
          typeof model.contextWindow === 'number' && model.contextWindow > 0
            ? model.contextWindow
            : 65536,
        supportsTools: !!model.supportsTools,
        supportsVision: !!model.supportsVision
      })
      settings.customModels = filtered
      writeSettings(settings)
      return { success: true, data: combinedModels() }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('model:removeCustom', async (_event, id: string) => {
    try {
      const settings = readSettings()
      const existing = (settings.customModels as ModelInfo[] | undefined) ?? []
      settings.customModels = existing.filter((m) => m.id !== id)
      writeSettings(settings)
      return { success: true, data: combinedModels() }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('model:verifyCatalog', async () => {
    try {
      const report = await verifyCatalog()
      return { success: true, data: report }
    } catch (err) {
      return { success: false, error: messageOf(err) || 'Catalog verification failed.' }
    }
  })

  // ── UA provider-expansion: live catalog import ──
  // Two-step affordance in Settings → Models:
  //   1. model:listLive  → pull a provider's CURRENT chat roster (listLiveModelIds,
  //      per its descriptor's catalog strategy). No mutation.
  //   2. model:importLive → turn a chosen id set into collision-safe custom
  //      models (buildLiveModelImports; tools/vision default OFF) and persist
  //      them into settings.customModels. Idempotent — re-import skips exact dupes.
  ipcMain.handle('model:listLive', async (_event, provider: string) => {
    try {
      if (typeof provider !== 'string' || !(provider in PROVIDERS)) {
        return { success: false, error: `Unknown provider: ${provider}` }
      }
      const ids = await listLiveModelIds(provider as ProviderId)
      return { success: true, data: ids }
    } catch (err) {
      return { success: false, error: messageOf(err) || 'Could not fetch live models.' }
    }
  })

  ipcMain.handle('model:importLive', async (_event, payload: { provider?: unknown; ids?: unknown }) => {
    try {
      const provider = payload?.provider
      const ids = payload?.ids
      if (typeof provider !== 'string' || !(provider in PROVIDERS)) {
        return { success: false, error: `Unknown provider: ${provider}` }
      }
      if (!Array.isArray(ids)) {
        return { success: false, error: 'ids must be an array of model id strings.' }
      }
      // Collide against BOTH built-in catalog ids (with their real apiModelIds)
      // and already-stored custom ids so an import never shadows or re-adds a
      // model already reachable.
      const existing: ImportModelIdentity[] = [
        ...MODEL_CATALOG.map((m) => ({ id: m.id, apiModelId: m.apiModelId, provider: m.provider })),
        ...readCustomModels().map((m) => ({ id: m.id, provider: m.provider ?? 'deepseek' }))
      ]
      const { additions, skipped } = buildLiveModelImports(provider, ids, existing)
      if (additions.length > 0) {
        const settings = readSettings()
        const current = (settings.customModels as ModelInfo[] | undefined) ?? []
        settings.customModels = [
          ...current,
          ...additions.map((a) => ({
            id: a.id,
            name: a.name,
            provider: a.provider as ProviderId,
            // Persist the verbatim wire id so resolveModel routes with the REAL
            // provider id even when the local id was namespaced on collision
            // (id `<provider>:<apiModelId>` ≠ apiModelId). Only stored when it
            // actually differs, to keep hand-added-style records lean.
            ...(a.apiModelId && a.apiModelId !== a.id ? { apiModelId: a.apiModelId } : {}),
            contextWindow: a.contextWindow,
            supportsTools: a.supportsTools,
            supportsVision: a.supportsVision
          }))
        ]
        writeSettings(settings)
      }
      return { success: true, data: { added: additions.length, skipped, models: combinedModels() } }
    } catch (err) {
      return { success: false, error: messageOf(err) || 'Live model import failed.' }
    }
  })

  ipcMain.handle('model:openRouterCatalog', async () => {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'HTTP-Referer': 'https://duin.app', 'X-Title': 'DUIN' }
      })
      if (!res.ok) return { success: false, error: `OpenRouter returned HTTP ${res.status}` }
      const json = (await res.json()) as { data?: OpenRouterApiModel[] }
      const models = (json.data ?? []).flatMap((m) => {
        const n = normalizeOpenRouterModel(m)
        return n ? [n] : []
      })
      models.sort((a, b) => a.name.localeCompare(b.name))
      return { success: true, data: models }
    } catch (err) {
      return { success: false, error: messageOf(err) || 'Could not reach OpenRouter.' }
    }
  })
}
