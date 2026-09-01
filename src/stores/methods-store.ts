import { create } from 'zustand'
import { toast } from '@/stores/toast-store'
import type { Workflow } from '@/duin/lib/state'

// Mirrors skills-store so the Methods column can offer the same create/edit/import
// flow. Reads and writes both go through the `methods:*` IPC family: the list used to
// come over HTTP from the brain server, but a mutation and its refresh have to agree
// about what is on disk, and the HTTP read is served by a process that may not have
// noticed the write yet.

export interface MethodDraft {
  name: string
  description: string
  deliverable: string
  callsSkills: string[]
  content: string
}

interface MethodsState {
  methods: Workflow[]
  loading: boolean
  /** Set when the read itself failed, so the column can say so instead of showing
   *  an empty list that looks like "you have no methods". */
  error: string | null
  loadMethods: () => Promise<void>
  createMethod: (draft: MethodDraft) => Promise<boolean>
  updateMethod: (path: string, draft: MethodDraft) => Promise<boolean>
  deleteMethod: (path: string) => Promise<boolean>
  readMethod: (path: string) => Promise<(MethodDraft & { path: string }) | null>
}

export const useMethodsStore = create<MethodsState>((set, get) => ({
  methods: [],
  loading: false,
  error: null,

  loadMethods: async () => {
    set({ loading: true })
    try {
      const r = await window.api?.methods?.list?.()
      if (!r?.success) {
        set({ methods: [], error: r?.error ?? 'Could not read methods', loading: false })
        return
      }
      set({ methods: (r.data as Workflow[]) ?? [], error: null, loading: false })
    } catch (e) {
      set({ methods: [], error: e instanceof Error ? e.message : String(e), loading: false })
    }
  },

  createMethod: async (draft) => {
    const r = await window.api?.methods?.create?.(draft)
    if (!r?.success) {
      toast.error(r?.error ?? 'Could not create that method')
      return false
    }
    await get().loadMethods()
    toast.success(`Created "${draft.name}"`)
    return true
  },

  updateMethod: async (path, draft) => {
    const r = await window.api?.methods?.update?.(path, draft)
    if (!r?.success) {
      toast.error(r?.error ?? 'Could not save that method')
      return false
    }
    await get().loadMethods()
    toast.success(`Saved "${draft.name}"`)
    return true
  },

  deleteMethod: async (path) => {
    const r = await window.api?.methods?.delete?.(path)
    if (!r?.success) {
      toast.error(r?.error ?? 'Could not delete that method')
      return false
    }
    await get().loadMethods()
    return true
  },

  readMethod: async (path) => {
    const r = await window.api?.methods?.read?.(path)
    if (!r?.success) {
      toast.error(r?.error ?? 'Could not open that method')
      return null
    }
    return r.data as MethodDraft & { path: string }
  }
}))
