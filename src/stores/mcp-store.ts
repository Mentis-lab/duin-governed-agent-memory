import { create } from 'zustand'
import { invoke } from '@/lib/ipc-client'
import { describeError } from '@/lib/result'
import { toast } from '@/stores/toast-store'
import type {
  McpServerConfig,
  McpStatusEvent,
  McpResource,
  McpResourceTemplate
} from '@/lib/types'

type ServerWithStatus = McpServerConfig & { error?: string }

// MR — per-server resource slice. Keyed by server id so each connector's
// Resources expander loads + fails independently.
interface ResourceSlice {
  resources: McpResource[]
  templates: McpResourceTemplate[]
  loading: boolean
  error?: string
  loaded: boolean
}

const emptySlice = (): ResourceSlice => ({
  resources: [],
  templates: [],
  loading: false,
  loaded: false
})

interface McpState {
  servers: ServerWithStatus[]
  loaded: boolean
  loadServers: () => Promise<void>
  updateServerStatus: (event: McpStatusEvent) => void
  reconnect: (id: string) => Promise<void>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  removeServer: (id: string) => Promise<void>
  // MR — resources
  resourceSlices: Record<string, ResourceSlice>
  loadResources: (id: string) => Promise<void>
}

export const useMcpStore = create<McpState>((set) => ({
  servers: [],
  loaded: false,
  resourceSlices: {},

  loadServers: async () => {
    if (!window.api) return
    const result = await window.api.mcp.list()
    if (result.success && result.data) {
      set({ servers: result.data, loaded: true })
    }
  },

  updateServerStatus: (event: McpStatusEvent) => {
    set((state) => ({
      servers: state.servers.map((s) =>
        s.id === event.serverId
          ? { ...s, status: event.status, error: event.error }
          : s
      )
    }))
  },

  reconnect: async (id: string) => {
    // U2. The row was pinned to 'connecting' and the IPC result discarded, so a
    // refused reconnect left the server spinning forever with no way to tell that
    // it had already failed. Land the failure on the row instead.
    set((state) => ({
      servers: state.servers.map((s) =>
        s.id === id ? { ...s, status: 'connecting', error: undefined } : s
      )
    }))
    try {
      await invoke('reconnect server', () => window.api.mcp.reconnect(id))
    } catch (e) {
      const message = describeError(e, 'reconnect failed')
      set((state) => ({
        servers: state.servers.map((s) =>
          s.id === id ? { ...s, status: 'error', error: message } : s
        )
      }))
      toast.error(message)
    }
  },

  // A connector that lands disabled (the catalog ships several that way) had no way
  // back on, and one added by mistake could never be taken off. Both re-read the list
  // afterwards so the row reflects what the main process actually persisted.
  setEnabled: async (id: string, enabled: boolean) => {
    try {
      await invoke('update connector', () => window.api.mcp.setEnabled(id, enabled))
      await useMcpStore.getState().loadServers()
    } catch (e) {
      toast.error(describeError(e, 'could not change this connector'))
    }
  },

  removeServer: async (id: string) => {
    try {
      await invoke('remove connector', () => window.api.mcp.removeServer(id))
      await useMcpStore.getState().loadServers()
    } catch (e) {
      toast.error(describeError(e, 'could not remove this connector'))
    }
  },

  loadResources: async (id: string) => {
    if (!window.api) return
    set((state) => ({
      resourceSlices: {
        ...state.resourceSlices,
        [id]: { ...(state.resourceSlices[id] ?? emptySlice()), loading: true, error: undefined }
      }
    }))
    try {
      const [resList, tmplList] = await Promise.all([
        window.api.mcp.listResources(id),
        window.api.mcp.listResourceTemplates(id)
      ])
      const resources = resList.success && resList.data ? resList.data.items : []
      const templates = tmplList.success && tmplList.data ? tmplList.data.items : []
      const error = !resList.success
        ? resList.error
        : !tmplList.success
          ? tmplList.error
          : undefined
      set((state) => ({
        resourceSlices: {
          ...state.resourceSlices,
          [id]: { resources, templates, loading: false, loaded: true, error }
        }
      }))
    } catch (err) {
      set((state) => ({
        resourceSlices: {
          ...state.resourceSlices,
          [id]: {
            ...(state.resourceSlices[id] ?? emptySlice()),
            loading: false,
            loaded: true,
            error: (err as Error).message ?? 'Failed to load resources'
          }
        }
      }))
    }
  }
}))
