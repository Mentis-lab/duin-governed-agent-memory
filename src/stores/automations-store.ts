import { create } from 'zustand'
import { toast } from '@/stores/toast-store'

// Renderer-side store for the cron automations panel (G1).

/**
 * The renderer's view of an automation.
 *
 * This interface used to stop at `lastResult`, declaring 9 of the backend's 22 columns. The
 * IPC sent the rest and nothing could read them — so `disabledReason`, which the runner
 * writes whenever it kills a failing automation, was invisible purely because a type stopped
 * short. An automation the system disabled looked identical to one the operator paused, and
 * the store comment behind it claimed the reason "is surfaced on the card."
 *
 * The dead columns are deliberately still NOT declared: `lastTriggerKey` is never written,
 * and the goal/loop-ceiling block has no caller that can set it. Declaring them would imply
 * they mean something.
 */
export interface Automation {
  id: string
  label: string
  cron: string
  prompt: string
  model: string | null
  enabled: boolean
  createdAt: number
  lastRunAt: number | null
  lastResult: string | null
  /** The schedule in words, computed by the one shared humanizer in the main process. */
  scheduleLabel: string | null
  /** When the runner next intends to fire this. Null once it can't (or hasn't) computed one. */
  nextRunAt: number | null
  /** Why the RUNNER turned this off. Null when the operator did it, or when it's enabled. */
  disabledReason: string | null
  /** JSON-encoded ChannelRef for delivery, or null — meaning the result goes nowhere. */
  deliverTo: string | null
  retryAttempt: number
  retryAt: number | null
}

/** One attempt from the durable `automation_runs` ledger. */
export interface AutomationRun {
  id: string
  automationId: string
  triggerKind: string
  scheduledAt: number | null
  startedAt: number
  finishedAt: number | null
  attempt: number
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  result: string | null
  error: string | null
}

/**
 * What the operator should understand about this automation's state, derived rather than
 * stored: the three cases are visually identical today because only `enabled` is rendered.
 */
export type AutomationHealth = 'healthy' | 'paused' | 'auto-disabled'

export function automationHealth(a: Automation): AutomationHealth {
  if (a.enabled) return 'healthy'
  return a.disabledReason ? 'auto-disabled' : 'paused'
}

export interface CronValidation {
  valid: boolean
  description?: string | null
  nextFireAt?: number | null
  error?: string
}

interface AutomationsState {
  automations: Automation[]
  loading: boolean
  refresh: () => Promise<void>
  create: (input: {
    label: string
    cron: string
    prompt: string
    model?: string
  }) => Promise<Automation | null>
  update: (
    id: string,
    patch: Partial<{ label: string; cron: string; prompt: string; model: string; enabled: boolean }>
  ) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
  runNow: (id: string) => Promise<boolean>
  validateCron: (expr: string) => Promise<CronValidation>
}

export const useAutomationsStore = create<AutomationsState>((set, get) => ({
  automations: [],
  loading: false,

  refresh: async () => {
    if (!window.api?.automations) return
    set({ loading: true })
    const res = await window.api.automations.list()
    if (res.success) set({ automations: (res.data as Automation[]) ?? [] })
    else toast.error(`Load automations failed: ${res.error}`)
    set({ loading: false })
  },

  create: async (input) => {
    if (!window.api?.automations) return null
    const res = await window.api.automations.create(input)
    if (!res.success) {
      toast.error(`Create failed: ${res.error}`)
      return null
    }
    await get().refresh()
    return (res.data as Automation) ?? null
  },

  update: async (id, patch) => {
    if (!window.api?.automations) return false
    const res = await window.api.automations.update(id, patch)
    if (!res.success) {
      toast.error(`Update failed: ${res.error}`)
      return false
    }
    await get().refresh()
    return true
  },

  remove: async (id) => {
    if (!window.api?.automations) return false
    const res = await window.api.automations.delete(id)
    if (!res.success) {
      toast.error(`Delete failed: ${res.error}`)
      return false
    }
    set((state) => ({ automations: state.automations.filter((a) => a.id !== id) }))
    return true
  },

  runNow: async (id) => {
    if (!window.api?.automations) return false
    const res = await window.api.automations.runNow(id)
    // Refresh either way — a failed run still updates last_run_at and the run ledger, and
    // that is exactly when the operator most wants to see the row.
    if (!res.success) {
      toast.error(`Run failed — ${res.error}`)
      await get().refresh()
      return false
    }
    // "Queued" was wrong: runNow awaits the whole run, so by the time this fires the
    // automation has already finished.
    toast.success('Automation finished.')
    await get().refresh()
    return true
  },

  validateCron: async (expr: string) => {
    if (!window.api?.automations?.validateCron) {
      return { valid: false, error: 'IPC unavailable' }
    }
    const res = await window.api.automations.validateCron(expr)
    if (!res.success) return { valid: false, error: res.error }
    return res.data as CronValidation
  }
}))
