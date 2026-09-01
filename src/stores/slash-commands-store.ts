import { create } from 'zustand'

// Track 2 / C4 — renderer slash-command store. Pulls the visible
// commands list once on mount, subscribes to `slash:changed` so live
// file edits in `userData/slash-commands/` show up in the palette
// without a refresh, and exposes a `resolve` helper for ChatInput's
// `/<cmd>` dispatch.

export interface SlashCommand {
  name: string
  description: string
  args: string[]
  hidden: boolean
  body: string
  filePath: string
  source: 'user' | 'builtin' | 'plugin'
  /** 'method' entries are `type: method` vault notes surfaced as `/slug`; their
   *  prompt is resolved dynamically (no template body). */
  kind?: 'command' | 'method'
}

/** A resolved slash invocation. `activateSkills` is present only for methods —
 *  the skills to turn on for the turn the method prompt is dispatched into. */
export interface SlashResolveResult {
  name: string
  description: string
  prompt: string
  activateSkills?: string[]
}

interface SlashState {
  commands: SlashCommand[]
  loaded: boolean
  load: () => Promise<void>
  resolve: (name: string, rest?: string) => Promise<SlashResolveResult | null>
  applyChange: (next: SlashCommand[]) => void
}

export const useSlashCommandsStore = create<SlashState>((set) => ({
  commands: [],
  loaded: false,

  load: async () => {
    if (!window.api?.slash) return
    const r = await window.api.slash.list()
    if (r.success) set({ commands: r.data as SlashCommand[], loaded: true })
  },

  resolve: async (name: string, rest = '') => {
    if (!window.api?.slash) return null
    const r = await window.api.slash.resolve({ name, rest })
    if (!r.success) return null
    return r.data as SlashResolveResult
  },

  applyChange: (next: SlashCommand[]) => set({ commands: next })
}))
