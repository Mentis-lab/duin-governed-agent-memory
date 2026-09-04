import { create } from 'zustand'
import { invoke, query } from '@/lib/ipc-client'
import { describeError } from '@/lib/result'
import { toast } from '@/stores/toast-store'

// Track 2 / C2 — renderer hooks store. The full list is fetched once on
// mount; create / update / delete invalidates and refetches. Test-run
// results are kept in a transient `lastTest` slot so the active editor
// can render the most recent run without holding it in component state.

// MUST stay in step with electron/services/hooks-store.ts's HookEvent (the parity test
// in hooks-event-parity.test.ts pins the two unions against each other). Two copies of
// one vocabulary is why; keeping them literally identical is the cheapest fix that does
// not restructure the preload boundary.
//
// loopStarted / loopIterationDone were declared on both sides but nothing in main ever
// fired them (loop-controller has no fireHooks call), so they are gone from both.
export type HookEvent =
  | 'sessionStart'
  | 'promptSubmit'
  | 'preToolUse'
  | 'postToolUse'
  | 'agentStop'
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
  // The autonomy-lifecycle sandbox (hooks-runner.ts) — what automation/workflow hooks
  // actually receive, so the test runner can offer a faithful sample for them.
  trigger?: string
  sourceId?: string
  label?: string
}

/**
 * Authoring a hook (create / update with a new body / test) goes through a native
 * approval dialog in main. Pressing Cancel there answers `success:false` with one of
 * these strings. That is the operator saying "no", not a failure: it must not toast.
 */
export function isHookApprovalCancelled(cause: unknown): boolean {
  const message = describeError(cause, '')
  return /\bHook (creation|update|test) cancelled$/.test(message)
}

interface HooksState {
  hooks: Hook[]
  loaded: boolean
  loading: boolean
  /** Set when the last `hooks:list` read failed; the page renders it with a Retry. */
  error: string | null
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
  error: null,
  lastTest: null,

  // A failed list used to leave `loaded` false forever, which the page painted as
  // "Loading…" with no way out. query() turns a thrown call, a missing handler and a
  // `success:false` envelope into one error the page can show and retry.
  load: async () => {
    set({ loading: true })
    const r = await query<Hook[]>('hooks', window.api?.hooks?.list)
    if (r.ok) set({ hooks: r.data, loaded: true, loading: false, error: null })
    else set({ loading: false, error: r.error })
  },

  // U2. These already read `success`, but they returned a bare null/false that
  // discarded the REASON, and every caller then rendered its own guess (or, in
  // the enable/disable toggle's case, nothing at all). Routing through invoke()
  // keeps the return contract and surfaces the handler's own message.
  create: async (input) => {
    try {
      const hook = await invoke<Hook>('create hook', () => window.api.hooks.create(input))
      await get().load()
      return hook ?? null
    } catch (e) {
      if (!isHookApprovalCancelled(e)) toast.error(describeError(e, 'Could not create that hook'))
      return null
    }
  },

  update: async (id, patch) => {
    try {
      await invoke('update hook', () => window.api.hooks.update(id, patch))
      await get().load()
      return true
    } catch (e) {
      if (!isHookApprovalCancelled(e)) toast.error(describeError(e, 'Could not update that hook'))
      return false
    }
  },

  remove: async (id) => {
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
    try {
      const result = await invoke<HookTestResult>('test hook', () => window.api.hooks.test(input))
      set({ lastTest: { code: input.code, event: input.event, result } })
      return result
    } catch (e) {
      if (!isHookApprovalCancelled(e)) toast.error(describeError(e, 'Could not run that hook'))
      return null
    }
  },

  clearLastTest: () => set({ lastTest: null })
}))
