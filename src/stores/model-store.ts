import { create } from 'zustand'
import {
  AUTO_ENGINE,
  type IpcResponse,
  type ModelInfo,
  type ProviderHealth,
  type ProviderPolicy,
  type RoleResolution,
  type RouteTask
} from '@/lib/types'
import { toast } from '@/stores/toast-store'

// ── The renderer's ONE model-plane source of truth (cohesion build P0, roles.ts) ──
//
// There is no default model. The renderer holds three things, all read from main:
//   policy     — the operator's provider order / per-role overrides / local-only switch
//   health     — per-provider ProviderHealth from a REAL completion probe (usable = healthy)
//   resolution — what the `chat` role resolves to for the ACTIVE conversation (its pin, or
//                the policy when the pin is AUTO_ENGINE)
// The composer chip, the status line and the picker all render from here, so they cannot
// disagree (L5 F6 found three sources). chat-store owns the per-conversation PIN and asks
// this store to re-resolve whenever it changes.
//
// IPC surface: the MODEL_IPC channels of roles.ts, reached through window.api.model. The
// methods are typed locally (`ModelIpc`) and every call degrades to "unknown" when a method is
// absent, so a preload built before lane A's surface still renders — with empty health and no
// resolution, never with a fabricated one.

interface ModelIpc {
  list: () => Promise<IpcResponse<ModelInfo[]>>
  policyGet?: () => Promise<IpcResponse<ProviderPolicy>>
  policySet?: (partial: Partial<ProviderPolicy>) => Promise<IpcResponse<ProviderPolicy>>
  healthList?: () => Promise<IpcResponse<ProviderHealth[]>>
  healthProbe?: (provider: string) => Promise<IpcResponse<ProviderHealth[]>>
  resolve?: (task: RouteTask, pin?: string) => Promise<IpcResponse<RoleResolution | null>>
  onHealthChanged?: (cb: (health: ProviderHealth[]) => void) => () => void
}

function modelIpc(): ModelIpc | null {
  const api = (globalThis as { window?: { api?: { model?: unknown } } }).window?.api?.model
  return api && typeof api === 'object' ? (api as ModelIpc) : null
}

interface ModelState {
  models: ModelInfo[]
  policy: ProviderPolicy | null
  health: ProviderHealth[]
  /** Resolution of the `chat` role for the active conversation's pin; null = nothing usable
   *  (or the surface is not available yet). */
  resolution: RoleResolution | null
  /** The pin the current `resolution` was computed for (AUTO_ENGINE = no pin). */
  resolvedFor: string
  /** True once policy + health have been read at least once. */
  loaded: boolean
  loadModels: (signal?: AbortSignal) => Promise<boolean>
  /** Re-resolve the chat role for a pin (AUTO_ENGINE = follow the policy). */
  refreshResolution: (pin?: string) => Promise<void>
  refreshHealth: () => Promise<void>
  /** Fresh completion probe for one provider (or 'all'); returns the new health rows. */
  probe: (provider: string | 'all') => Promise<ProviderHealth[]>
  setPolicy: (partial: Partial<ProviderPolicy>) => Promise<boolean>
  healthFor: (provider: string | undefined) => ProviderHealth | undefined
  isProviderHealthy: (provider: string | undefined) => boolean
}

export const useModelStore = create<ModelState>((set, get) => ({
  models: [],
  policy: null,
  health: [],
  resolution: null,
  resolvedFor: AUTO_ENGINE,
  loaded: false,

  loadModels: async (signal) => {
    const ipc = modelIpc()
    if (!ipc) return false
    try {
      const [modelsResult, policyResult, healthResult] = await Promise.all([
        ipc.list(),
        ipc.policyGet ? ipc.policyGet() : Promise.resolve(null),
        ipc.healthList ? ipc.healthList() : Promise.resolve(null)
      ])
      if (signal?.aborted) return false
      if (modelsResult.success) set({ models: modelsResult.data })
      if (policyResult?.success) set({ policy: policyResult.data })
      if (healthResult?.success) set({ health: healthResult.data })
      set({ loaded: true })
      await get().refreshResolution(get().resolvedFor)
      return modelsResult.success
    } catch (err) {
      if (signal?.aborted) return false
      toast.error(`Couldn't load models${err instanceof Error ? `: ${err.message}` : ''}`)
      return false
    }
  },

  refreshResolution: async (pin = get().resolvedFor) => {
    const ipc = modelIpc()
    set({ resolvedFor: pin })
    if (!ipc?.resolve) {
      set({ resolution: null })
      return
    }
    try {
      const res = await ipc.resolve('chat', pin && pin !== AUTO_ENGINE ? pin : undefined)
      // A later pin change wins over a slower answer for an older one.
      if (get().resolvedFor !== pin) return
      set({ resolution: res.success ? res.data : null })
    } catch {
      if (get().resolvedFor === pin) set({ resolution: null })
    }
  },

  refreshHealth: async () => {
    const ipc = modelIpc()
    if (!ipc?.healthList) return
    try {
      const res = await ipc.healthList()
      if (res.success) set({ health: res.data })
    } catch {
      /* cached health stays; the next push refreshes it */
    }
    await get().refreshResolution()
  },

  probe: async (provider) => {
    const ipc = modelIpc()
    if (!ipc?.healthProbe) return get().health
    try {
      const res = await ipc.healthProbe(provider)
      if (!res.success) {
        toast.error(`Probe failed: ${res.error}`)
        return get().health
      }
      // A single-provider probe returns that provider's row(s); merge them over the cache.
      const fresh = res.data
      const merged = provider === 'all'
        ? fresh
        : [...get().health.filter((h) => !fresh.some((f) => f.provider === h.provider)), ...fresh]
      set({ health: merged })
      await get().refreshResolution()
      return merged
    } catch (err) {
      toast.error(`Probe failed${err instanceof Error ? `: ${err.message}` : ''}`)
      return get().health
    }
  },

  setPolicy: async (partial) => {
    const ipc = modelIpc()
    if (!ipc?.policySet) {
      toast.error('Provider policy is not available in this build')
      return false
    }
    const previous = get().policy
    // Optimistic, rolled back on a failed write — the pane must never show an order main
    // did not accept.
    if (previous) set({ policy: { ...previous, ...partial } })
    try {
      const res = await ipc.policySet(partial)
      if (!res.success) {
        set({ policy: previous })
        toast.error(`Couldn't save the provider policy: ${res.error}`)
        return false
      }
      set({ policy: res.data })
      await get().refreshResolution()
      return true
    } catch (err) {
      set({ policy: previous })
      toast.error(`Couldn't save the provider policy${err instanceof Error ? `: ${err.message}` : ''}`)
      return false
    }
  },

  healthFor: (provider) => (provider ? get().health.find((h) => h.provider === provider) : undefined),

  isProviderHealthy: (provider) => get().healthFor(provider)?.healthy === true
}))

// Health pushes from main (a probe on key save, on boot, on a classified failure) land here
// once, so every surface re-renders from the same rows.
const pushSurface = modelIpc()
if (pushSurface?.onHealthChanged) {
  pushSurface.onHealthChanged((health) => {
    useModelStore.setState({ health })
    void useModelStore.getState().refreshResolution()
  })
}
