import { create } from 'zustand'
import type { Automation } from '@/stores/automations-store'
import type { Hook } from '@/stores/hooks-store'
import { query, invoke } from '@/lib/ipc-client'
import { describeError } from '@/lib/result'
import { toast } from '@/stores/toast-store'

/** The independently-refreshable sections of the Activity surface. */
export type ActivitySection = 'agents' | 'automations' | 'wakeups' | 'hooks' | 'taskGraph'

const PINNED_KEY = 'lamprey.activity.pinnedIds'
const COLLAPSED_KEY = 'lamprey.activity.collapsed'

export type ActivityKind = 'conversation' | 'workflow' | 'agent' | 'cron' | 'loop' | 'hook'
export type ActivityStatus =
  | 'running'
  | 'pending'
  | 'idle'
  | 'done'
  | 'error'
  | 'aborted'
  | 'disabled'

export interface ActivityNodeModel {
  id: string
  kind: ActivityKind
  title: string
  subtitle?: string
  status: ActivityStatus
  startedAt?: number | null
  finishedAt?: number | null
  tokenEstimate?: number | null
  canAbort?: boolean
  children?: ActivityNodeModel[]
}

export interface AgentRunSnapshot {
  id: string
  parentConvId: string | null
  parentRunId: string | null
  agentType: string
  label: string
  status: 'running' | 'done' | 'error' | 'aborted'
  startedAt: number
  finishedAt: number | null
  resultText: string | null
  error: string | null
  worktreePath: string | null
  background: boolean
}

export interface LoopWakeupSnapshot {
  id: string
  conversationId: string
  fireAt: number
  prompt: string
  reason: string | null
  status: 'pending' | 'fired' | 'cancelled' | 'error'
  createdAt: number
  firedAt: number | null
  error: string | null
}

interface IpcEnvelope<T> {
  success: boolean
  data?: T
  error?: string
}

// Canonical task-graph node view (conversation + agent-run). Mirrors the main
// TaskGraphNode shape over IPC; kept structurally minimal for the store.
export interface TaskGraphNodeSnapshot {
  id: string
  kind: 'conversation' | 'agent-run' | 'identity' | 'turn'
  title: string
  status: string
  ownerConversationId: string | null
  parentId: string | null
  createdAt: number
  updatedAt: number
  metadata: Record<string, string | number | boolean | null>
}

interface ActivityStoreState {
  agentRuns: AgentRunSnapshot[]
  automations: Automation[]
  wakeups: LoopWakeupSnapshot[]
  hooks: Hook[]
  taskGraphNodes: TaskGraphNodeSnapshot[]
  taskGraphTotal: number
  loading: boolean
  /** Aggregate: the first section error, for surfaces that show one banner. */
  error: string | null
  /** Per-section failure sentences. Absent key = that section read cleanly. */
  errors: Partial<Record<ActivitySection, string>>
  pinnedIds: string[]
  collapsed: boolean
  refresh: () => Promise<void>
  refreshAgents: () => Promise<void>
  refreshAutomations: () => Promise<void>
  refreshWakeups: () => Promise<void>
  refreshHooks: () => Promise<void>
  refreshTaskGraph: () => Promise<void>
  stopAgent: (id: string) => Promise<boolean>
  cancelWakeup: (id: string) => Promise<boolean>
  updateTaskMetadata: (
    taskId: string,
    action: 'rename' | 'pin' | 'unpin' | 'archive' | 'restore' | 'close',
    value?: string | null
  ) => Promise<boolean>
  togglePinned: (id: string) => void
  isPinned: (id: string) => boolean
  setCollapsed: (collapsed: boolean) => void
}

function readPinned(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage?.getItem(PINNED_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function readCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  const raw = window.localStorage?.getItem(COLLAPSED_KEY)
  return raw === '1' || raw === 'true'
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage?.setItem(key, value)
  } catch {
    // Ignore unavailable storage.
  }
}

/**
 * U1 — replaces `unwrapList`, which turned EVERY failed IPC into `[]`. On an
 * autonomy product that meant running agents, cron automations and pending loops
 * all rendered as "nothing is running" the moment the main process could not
 * answer. Each section now records its own failure sentence in `errors`, and the
 * previous rows are KEPT rather than blanked — a refresh that fails should not
 * erase what the operator could see a second ago.
 */
async function loadSection<T>(
  key: ActivitySection,
  label: string,
  call: (() => Promise<IpcEnvelope<T[]> | undefined>) | undefined,
  set: (fn: (s: ActivityStoreState) => Partial<ActivityStoreState>) => void
): Promise<T[] | null> {
  const r = await query<T[]>(label, call)
  if (!r.ok) {
    set((s) => ({ errors: { ...s.errors, [key]: r.error }, error: r.error }))
    return null
  }
  const rows = Array.isArray(r.data) ? r.data : []
  set((s) => {
    const errors = { ...s.errors }
    delete errors[key]
    return { errors, error: firstError(errors) }
  })
  return rows
}

function firstError(errors: Partial<Record<ActivitySection, string>>): string | null {
  const values = Object.values(errors).filter((v): v is string => Boolean(v))
  return values.length > 0 ? values[0] : null
}

export const useActivityStore = create<ActivityStoreState>((set, get) => ({
  agentRuns: [],
  automations: [],
  wakeups: [],
  hooks: [],
  taskGraphNodes: [],
  taskGraphTotal: 0,
  loading: false,
  error: null,
  errors: {},
  pinnedIds: readPinned(),
  collapsed: readCollapsed(),

  refresh: async () => {
    set({ loading: true, error: null })
    await Promise.all([
      get().refreshAgents(),
      get().refreshAutomations(),
      get().refreshWakeups(),
      get().refreshHooks()
    ])
    set({ loading: false })
  },

  // Each section: a failed read records WHY and leaves the last-known rows alone.
  // The old `if (!window.api?.x?.y) return` early-outs are gone — an absent preload
  // surface is a failure the operator should see, not a silent no-op that leaves
  // the panel asserting an empty list.
  refreshAgents: async () => {
    const rows = await loadSection<AgentRunSnapshot>(
      'agents',
      'agent runs',
      window.api?.tasks?.list ? () => window.api.tasks.list({ limit: 30 }) : undefined,
      set
    )
    if (rows) set({ agentRuns: rows })
  },

  refreshAutomations: async () => {
    const rows = await loadSection<Automation>(
      'automations',
      'automations',
      window.api?.automations?.list ? () => window.api.automations.list() : undefined,
      set
    )
    if (rows) set({ automations: rows })
  },

  refreshWakeups: async () => {
    const rows = await loadSection<LoopWakeupSnapshot>(
      'wakeups',
      'scheduled wakeups',
      window.api?.loops?.list ? () => window.api.loops.list({ limit: 30 }) : undefined,
      set
    )
    if (rows) set({ wakeups: rows })
  },

  refreshHooks: async () => {
    const rows = await loadSection<Hook>(
      'hooks',
      'hooks',
      window.api?.hooks?.list ? () => window.api.hooks.list() : undefined,
      set
    )
    if (rows) set({ hooks: rows })
  },

  // Additive: pull the canonical task graph. The TaskControlPanel manages its
  // own local copy for interactivity; this store method exists so other
  // surfaces can read a shared snapshot without re-implementing the IPC call.
  refreshTaskGraph: async () => {
    if (!window.api?.taskGraph?.graph) return
    const result = (await window.api.taskGraph.graph({ limit: 200 })) as IpcEnvelope<{
      nodes: TaskGraphNodeSnapshot[]
      total: number
    }>
    if (result?.success && result.data) {
      set({ taskGraphNodes: result.data.nodes, taskGraphTotal: result.data.total })
    }
  },

  // U2. These read `success` but returned a bare `false`, and the callers —
  // ActivityDashboard's abortNode, BackgroundTasksPanel — call them with `void`.
  // Pressing Stop on a RUNAWAY AGENT therefore did nothing visible whether it
  // worked or not. Now the reason is surfaced.
  updateTaskMetadata: async (taskId, action, value) => {
    try {
      await invoke('update task', () =>
        window.api.taskGraph.updateMetadata(taskId, action, value ?? null)
      )
      await get().refreshTaskGraph()
      return true
    } catch (e) {
      toast.error(describeError(e, 'Could not update that task'))
      return false
    }
  },

  stopAgent: async (id: string) => {
    try {
      await invoke('stop agent', () => window.api.tasks.stop(id))
      await get().refreshAgents()
      return true
    } catch (e) {
      toast.error(describeError(e, 'Could not stop that agent'))
      return false
    }
  },

  cancelWakeup: async (id: string) => {
    try {
      await invoke('cancel wakeup', () => window.api.loops.cancel(id))
      await get().refreshWakeups()
      return true
    } catch (e) {
      toast.error(describeError(e, 'Could not cancel that wakeup'))
      return false
    }
  },

  togglePinned: (id: string) => {
    set((state) => {
      const pinnedIds = state.pinnedIds.includes(id)
        ? state.pinnedIds.filter((pinnedId) => pinnedId !== id)
        : [...state.pinnedIds, id]
      writeLocal(PINNED_KEY, JSON.stringify(pinnedIds))
      return { pinnedIds }
    })
  },

  isPinned: (id: string) => get().pinnedIds.includes(id),

  setCollapsed: (collapsed: boolean) => {
    writeLocal(COLLAPSED_KEY, collapsed ? '1' : '0')
    set({ collapsed })
  }
}))
