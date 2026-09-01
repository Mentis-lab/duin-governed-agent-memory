import { create } from 'zustand'
import { invoke } from '@/lib/ipc-client'
import { describeError } from '@/lib/result'
import { toast } from '@/stores/toast-store'

// Track 2 / C2 — renderer hooks store. The full list is fetched once on
// mount; create / update / delete invalidates and refetches. Test-run
// results are kept in a transient `lastTest` slot so the active editor
// can render the most recent run without holding it in component state.

// MUST stay in step with electron/services/hooks-store.ts's HookEvent. It did not: the
// main process fires eleven events, this copy declared five, and the six F3 autonomy
// lifecycle events (loops, automations, workflows) were therefore unreachable from the
// Settings UI — fired in production every day with no way for a user hook to subscribe.
// Two copies of one vocabulary is why; keeping them literally identical is the cheapest
// fix that does not restructure the preload boundary.
export type HookEvent =
  | 'sessionStart'
  | 'promptSubmit'
  | 'preToolUse'
  | 'postToolUse'
  | 'agentStop'
  | 'loopStarted'
  | 'loopIterationDone'
  | 'automationStarted'
  | 'automationDone'
  | 'workflowStarted'
  | 'workflowFinished'

export type HookLanguage = 'js' | 'shell'

export interface Hook {
  id: string
  event: HookEvent
  label: string
  command: string
  enabled: boolean
  createdAt: number
  language: HookLanguage
  timeoutMs: number
}

export interface HookLogEntry {
  hookId: string
  hookLabel: string
  kind: 'log' | 'error'
  message: string
}

export interface HookTestResult {
  thrown?: string
  logs: HookLogEntry[]
}

export interface HookSampleContext {
  conversationId?: string
  toolName?: string
  args?: Record<string, unknown>
  result?: string
  promptBody?: string
  cwd?: string
  // The F3 autonomy-lifecycle sandbox (hooks-runner.ts) — what loop/automation/workflow
  // hooks actually receive. Absent here, so the test runner could not offer a faithful
  // sample for the six events it now lists.
  trigger?: string
  sourceId?: string
  label?: string
}

interface HooksState {
  hooks: Hook[]
  loaded: boolean
  loading: boolean
  lastTest: { code: string; event: HookEvent; result: HookTestResult } | null
  load: () => Promise<void>
  create: (input: {
    event: HookEvent
    label: string
    command: string
    language?: HookLanguage
    timeoutMs?: number
  }) => Promise<Hook | null>
  update: (
    id: string,
    patch: Partial<{
      event: HookEvent
      label: string
      command: string
      enabled: boolean
      language: HookLanguage
      timeoutMs: number
    }>
  ) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
  test: (input: {
    code: string
    event: HookEvent
    context?: HookSampleContext
    timeoutMs?: number
  }) => Promise<HookTestResult | null>
  clearLastTest: () => void
}

export const useHooksStore = create<HooksState>((set, get) => ({
  hooks: [],
  loaded: false,
  loading: false,
  lastTest: null,

  load: async () => {
    if (!window.api?.hooks) return
    set({ loading: true })
    const res = await window.api.hooks.list()
    if (res.success) set({ hooks: res.data as Hook[], loaded: true })
    set({ loading: false })
  },

  // U2. These already read `success`, but they returned a bare null/false that
  // discarded the REASON, and every caller then rendered its own guess (or, in
  // the enable/disable toggle's case, nothing at all). Routing through invoke()
  // keeps the return contract and surfaces the handler's own message.
  create: async (input) => {
    if (!window.api?.hooks) return null
    try {
      const hook = await invoke<Hook>('create hook', () => window.api.hooks.create(input))
      await get().load()
      return hook ?? null
    } catch (e) {
      toast.error(describeError(e, 'Could not create that hook'))
      return null
    }
  },

  update: async (id, patch) => {
    if (!window.api?.hooks) return false
    try {
      await invoke('update hook', () => window.api.hooks.update(id, patch))
      await get().load()
      return true
    } catch (e) {
      toast.error(describeError(e, 'Could not update that hook'))
      return false
    }
  },

  remove: async (id) => {
    if (!window.api?.hooks) return false
    try {
      await invoke('delete hook', () => window.api.hooks.delete(id))
      await get().load()
      return true
    } catch (e) {
      toast.error(describeError(e, 'Could not delete that hook'))
      return false
    }
  },

  test: async (input) => {
    if (!window.api?.hooks?.test) return null
    const res = await window.api.hooks.test(input)
    if (!res.success) return null
    const result = res.data as HookTestResult
    set({ lastTest: { code: input.code, event: input.event, result } })
    return result
  },

  clearLastTest: () => set({ lastTest: null })
}))
