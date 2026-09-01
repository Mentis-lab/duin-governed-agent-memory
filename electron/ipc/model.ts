import { ipcMain } from 'electron'
import { join } from 'path'
import { app } from 'electron'
import {
  MODEL_CATALOG,
  PROVIDERS,
  verifyCatalog,
  listLiveModelIds,
  describeBackgroundModel,
  type ProviderId
} from '../services/providers/registry'
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

  ipcMain.handle('model:getActive', async () => {
    const settings = readSettings()
    // DUIN default — new installs default to the agent/DUIN brain so the
    // brain is the out-of-the-box model. Mirrors DEFAULT_APP_SETTINGS.defaultModel.
    return { success: true, data: (settings.defaultModel as string) || 'duin-brain' }
  })

  ipcMain.handle('model:setActive', async (_event, id) => {
    try {
      const settings = readSettings()
      settings.defaultModel = id
      writeSettings(settings)
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
      const settings = readSettings()
      const existing = (settings.customModels as ModelInfo[] | undefined) ?? []
      const filtered = existing.filter((m) => m.id !== model.id)
      filtered.push({
        id: model.id.trim(),
        name: model.name.trim(),
        provider: (model.provider as ProviderId) || 'deepseek',
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
