import { ipcMain } from 'electron'
import * as memStore from '../services/memory-store'
import type { MemoryListFilter } from '../services/memory-store'
import {
  MEMORY_TYPES,
  isMemorySource,
  type MemoryType,
  type MemoryWriteInput
} from '../services/memory-frontmatter'
import { messageOf } from '../services/guarded'

function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === 'string' && (MEMORY_TYPES as readonly string[]).includes(value)
}

export function registerMemoryHandlers(): void {
  // memory:list now optionally accepts a filter — `{ type?: MemoryType,
  // projectSlug?: string }`. Pre-D1 callers passed no args; that path
  // still returns the full legacy view via listMemories() so the
  // existing MemoryPanel keeps rendering during the D1→D3 transition.
  ipcMain.handle('memory:list', async (_event, filter?: unknown) => {
    try {
      if (filter && typeof filter === 'object') {
        const parsed: MemoryListFilter = {}
        const f = filter as Record<string, unknown>
        if (typeof f.type === 'string' && isMemoryType(f.type)) parsed.type = f.type
        if (typeof f.projectSlug === 'string') parsed.projectSlug = f.projectSlug
        return { success: true, data: memStore.listMemoryFiles(parsed) }
      }
      return { success: true, data: memStore.listMemories() }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('memory:add', async (_event, content) => {
    try {
      return { success: true, data: memStore.addMemory(content) }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('memory:update', async (_event, id, content) => {
    try {
      const entry = memStore.updateMemory(id, content)
      if (!entry) return { success: false, error: 'Memory entry not found' }
      return { success: true, data: entry }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('memory:delete', async (_event, idOrName) => {
    try {
      if (typeof idOrName === 'string') {
        const removed = memStore.deleteMemoryFile(idOrName)
        if (!removed) return { success: false, error: 'Memory entry not found' }
        return { success: true, data: null }
      }
      memStore.deleteMemory(Number(idOrName))
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('memory:clear', async () => {
    try {
      memStore.clearAllMemories()
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('memory:export', async () => {
    try {
      return { success: true, data: memStore.exportMemories() }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('memory:import', async (_event, entries) => {
    try {
      const parsed = typeof entries === 'string' ? JSON.parse(entries) : entries
      memStore.importMemories(parsed)
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  // ──────────────── Typed file-backed API (new in D1) ────────────────

  ipcMain.handle('memory:write', async (_event, payload?: unknown) => {
    try {
      if (!payload || typeof payload !== 'object') {
        return { success: false, error: 'memory:write requires a payload object' }
      }
      const p = payload as Record<string, unknown>
      const name = typeof p.name === 'string' ? p.name.trim() : ''
      const body = typeof p.body === 'string' ? p.body : ''
      const description = typeof p.description === 'string' ? p.description : ''
      const projectSlug = typeof p.projectSlug === 'string' ? p.projectSlug : undefined
      const sourceConversationId =
        typeof p.sourceConversationId === 'string' ? p.sourceConversationId : null
      const type = isMemoryType(p.type) ? p.type : null
      // Absent/unrecognized `mode` keeps the historical overwrite-by-name behaviour,
      // so pre-existing callers are untouched; only an explicit 'create' opts into
      // slug disambiguation.
      const mode = p.mode === 'create' ? ('create' as const) : ('overwrite' as const)
      if (!name) return { success: false, error: 'name is required' }
      if (!type) return { success: false, error: `type must be one of ${MEMORY_TYPES.join(', ')}` }
      if (!body) return { success: false, error: 'body is required' }
      // Provenance is DECLARED by the caller, never inferred here: this one handler
      // serves the operator saving a memory by hand and the model writing one from a
      // conversation, and nothing at this layer can tell those apart. An unrecognized
      // or absent value falls through to 'unknown' in the store.
      const source = isMemorySource(p.source) ? p.source : undefined
      const file = memStore.writeMemoryFile({
        name,
        description,
        type,
        source,
        body,
        projectSlug,
        sourceConversationId,
        mode
      } satisfies MemoryWriteInput & {
        projectSlug?: string
        sourceConversationId: string | null
        mode: 'create' | 'overwrite'
      })
      return { success: true, data: file }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('memory:read', async (_event, name: unknown) => {
    try {
      if (typeof name !== 'string' || !name.trim()) {
        return { success: false, error: 'name is required' }
      }
      const file = memStore.readMemoryFile(name.trim())
      if (!file) return { success: false, error: 'Memory entry not found' }
      return { success: true, data: file }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle(
    'memory:listBrokenLinks',
    async (_event, projectSlug?: unknown) => {
      try {
        const slug = typeof projectSlug === 'string' ? projectSlug : undefined
        return { success: true, data: memStore.getBrokenMemoryLinks(slug) }
      } catch (err) {
        return { success: false, error: messageOf(err) }
      }
    }
  )

  ipcMain.handle('memory:readIndex', async (_event, projectSlug?: unknown) => {
    try {
      const slug = typeof projectSlug === 'string' ? projectSlug : undefined
      return { success: true, data: memStore.loadMemoryIndex(slug) }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('memory:search', async (_event, query: unknown, limit?: unknown) => {
    try {
      if (typeof query !== 'string') return { success: false, error: 'query must be a string' }
      const lim = typeof limit === 'number' && limit > 0 ? Math.min(limit, 200) : 50
      return { success: true, data: memStore.searchMemoryFiles(query, lim) }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })
}
