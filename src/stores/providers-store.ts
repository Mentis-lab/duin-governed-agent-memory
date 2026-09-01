import { create } from 'zustand'
import type { ProviderInfo } from '@/lib/types'
import { toast } from '@/stores/toast-store'

export interface ProviderEntry extends ProviderInfo {
  hasKey: boolean
}

interface ProvidersState {
  providers: ProviderEntry[]
  loaded: boolean
  setProviders: (providers: ProviderEntry[]) => void
  refresh: () => Promise<void>
  hasKey: (providerId: string | undefined) => boolean
  byId: (providerId: string) => ProviderEntry | undefined
}

export const useProvidersStore = create<ProvidersState>((set, get) => ({
  providers: [],
  loaded: false,
  setProviders: (providers) => {
    set({ providers, loaded: true })
  },
  refresh: async () => {
    if (!window.api?.settings?.listProviderKeys) return
    try {
      const result = await window.api.settings.listProviderKeys()
      if (result.success) {
        set({ providers: result.data as ProviderEntry[], loaded: true })
      } else {
        // Mark loaded so the UI stops waiting, and surface it — a silent no-op
        // here leaves stale "locked"/"no-key" badges on the model picker.
        set({ loaded: true })
        toast.error(`Couldn't load provider keys${(result as { error?: string }).error ? `: ${(result as { error?: string }).error}` : ''}`)
      }
    } catch (err) {
      set({ loaded: true })
      toast.error(`Couldn't load provider keys${err instanceof Error ? `: ${err.message}` : ''}`)
    }
  },
  hasKey: (providerId) => {
    if (!providerId) return false
    return get().providers.some((p) => p.id === providerId && p.hasKey)
  },
  byId: (providerId) => get().providers.find((p) => p.id === providerId)
}))

// Single sync point for key state. The main process broadcasts on every
// keychain write, so a key pasted in Settings — or in the onboarding
// "connect a model" card — unlocks the chat composer immediately, with no
// restart and no re-entering the same key at the second surface. Subscribing
// here rather than in each component means a NEW key-entry surface inherits
// the sync for free instead of having to remember to call refresh().
if (typeof window !== 'undefined' && window.api?.settings?.onKeychainChanged) {
  window.api.settings.onKeychainChanged(() => {
    void useProvidersStore.getState().refresh()
  })
}
