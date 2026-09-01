import { create } from 'zustand'
import type { ModelInfo } from '@/lib/types'
import { invoke } from '@/lib/ipc-client'
import { describeError } from '@/lib/result'
import { toast } from '@/stores/toast-store'

interface ModelState {
  models: ModelInfo[]
  activeModel: string
  loadModels: (signal?: AbortSignal) => Promise<boolean>
  setActiveModel: (id: string) => Promise<void>
}

export const useModelStore = create<ModelState>((set, get) => ({
  models: [],
  // DUIN default — the agent/DUIN brain is the out-of-the-box model.
  // Overwritten by loadModels() with the persisted defaultModel once it resolves.
  activeModel: 'duin-brain',

  loadModels: async (signal) => {
    try {
      const [modelsResult, activeResult] = await Promise.all([
        window.api.model.list(),
        window.api.model.getActive()
      ])
      if (signal?.aborted) return false
      if (modelsResult.success) set({ models: modelsResult.data })
      if (activeResult.success) set({ activeModel: activeResult.data })
      return modelsResult.success && activeResult.success
    } catch (err) {
      if (signal?.aborted) return false
      // Leave the ChatInput fallback list in place, but don't fail silently.
      toast.error(`Couldn't load models${err instanceof Error ? `: ${err.message}` : ''}`)
      return false
    }
  },

  setActiveModel: async (id: string) => {
    // U2. Was an optimistic `set()` followed by a fire-and-forget IPC whose
    // `success:false` nobody read — so the picker showed a model that was NOT the
    // active one, and every subsequent turn ran against the old model with the UI
    // insisting otherwise. Roll the optimistic update back when the write fails.
    const previous = get().activeModel
    set({ activeModel: id })
    try {
      await invoke('set active model', () => window.api.model.setActive(id))
    } catch (e) {
      set({ activeModel: previous })
      toast.error(describeError(e, `Couldn't switch to ${id}`))
    }
  }
}))
