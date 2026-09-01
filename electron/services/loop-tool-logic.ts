import type { Loop, BacklogItem, LoopStatus } from './loop-store'
import * as store from './loop-store'

// Loop Phase LP-4 — pure logic for the model-callable loop-control tools. The
// native tool handlers (loop-tool-pack.ts) are thin wrappers that inject the
// real loop-store; these functions take an injected seam so they unit-test
// without a DB (no skip), exactly like the controller core.

export const MIN_LOOP_DELAY_SECONDS = 30 // runaway floor for self-paced reschedule

export interface LoopToolStore {
  getActiveLoopForConversation(conversationId: string): Loop | null
  enqueueBacklog(loopId: string, tasks: string[]): BacklogItem[]
  inProgressBacklogItem(loopId: string): BacklogItem | null
  updateBacklogItem(id: string, patch: Parameters<typeof store.updateBacklogItem>[1]): BacklogItem | null
  updateLoop(id: string, patch: Parameters<typeof store.updateLoop>[1]): Loop | null
}

export type LoopControlAction = 'pause' | 'stop' | 'mission_complete' | 'continue'

export interface ToolResult {
  ok: boolean
  error?: string
  [k: string]: unknown
}

function noLoop(): ToolResult {
  return { ok: false, error: 'no active loop for this conversation' }
}

/** loop_enqueue — append task(s) to the current loop's backlog. */
export function applyLoopEnqueue(
  seam: LoopToolStore,
  conversationId: string,
  tasks: string[]
): ToolResult {
  const loop = seam.getActiveLoopForConversation(conversationId)
  if (!loop) return noLoop()
  const clean = (Array.isArray(tasks) ? tasks : []).map((t) => String(t ?? '').trim()).filter(Boolean)
  if (clean.length === 0) return { ok: false, error: 'no non-empty tasks provided' }
  const created = seam.enqueueBacklog(loop.id, clean)
  return { ok: true, enqueued: created.length, positions: created.map((c) => c.position) }
}

/** loop_complete_task — record the outcome of the in-progress backlog item.
 *
 *  OUTCOME ONLY: this must NOT flag the item `done`. Closing an item out belongs
 *  to runLoopIteration (loop-controller.ts), deliberately sequenced AFTER the
 *  durable git commit + journal entry and AFTER the 2BRAIN verify gate. This tool
 *  runs INSIDE the turn, so writing `done` here jumped both:
 *   - verify-reject leaves the item in_progress by issuing NO write at all, so a
 *     mid-turn `done` survived the rejection and the gate fired an event while
 *     changing nothing — the rejected output was then fed back as settled work;
 *   - a crash between this call and commitStep left a bare DB `done` with nothing
 *     committed, invisible to the L2 reconcile (it resolves the interrupted item
 *     via inProgressBacklogItem, which matches status='in_progress' only).
 *  What made it invisible: this write LOOKS like the completion write, and the
 *  ordering invariant it breaks is documented in a different file. `finishedAt`
 *  is likewise the controller's to set — an item that is not finished must not
 *  carry a finish time (reconcile can still reset this item to pending). */
export function applyLoopCompleteTask(
  seam: LoopToolStore,
  conversationId: string,
  result: string
): ToolResult {
  const loop = seam.getActiveLoopForConversation(conversationId)
  if (!loop) return noLoop()
  const item = seam.inProgressBacklogItem(loop.id)
  if (!item) return { ok: false, error: 'no task is currently in progress' }
  seam.updateBacklogItem(item.id, { result: String(result ?? '').slice(0, 4000) })
  return { ok: true, completed: item.id }
}

/** loop_control — pause / stop / mission_complete / continue (self-paced cadence). */
export function applyLoopControl(
  seam: LoopToolStore,
  conversationId: string,
  action: LoopControlAction,
  opts: { reason?: string; delaySeconds?: number; now: number; minDelaySeconds?: number }
): ToolResult {
  const loop = seam.getActiveLoopForConversation(conversationId)
  if (!loop) return noLoop()
  const reason = opts.reason?.trim() || undefined
  switch (action) {
    case 'pause':
      seam.updateLoop(loop.id, { status: 'paused', nextFireAt: null })
      return { ok: true, status: 'paused' }
    case 'stop':
      seam.updateLoop(loop.id, { status: 'stopped', stopReason: reason ?? 'model-stop', nextFireAt: null })
      return { ok: true, status: 'stopped' }
    case 'mission_complete':
      seam.updateLoop(loop.id, {
        status: 'done',
        stopReason: reason ?? 'mission-complete',
        nextFireAt: null
      })
      return { ok: true, status: 'done' }
    case 'continue': {
      const floor = Math.max(1, opts.minDelaySeconds ?? MIN_LOOP_DELAY_SECONDS)
      const delay = Math.max(floor, Math.round(opts.delaySeconds ?? floor))
      const nextFireAt = opts.now + delay * 1000
      seam.updateLoop(loop.id, { status: 'running' as LoopStatus, nextFireAt })
      return { ok: true, status: 'running', nextFireAt }
    }
    default:
      return { ok: false, error: `unknown action: ${String(action)}` }
  }
}

/** Production seam — binds the real loop-store. */
export function productionLoopToolStore(): LoopToolStore {
  return {
    getActiveLoopForConversation: store.getActiveLoopForConversation,
    enqueueBacklog: store.enqueueBacklog,
    inProgressBacklogItem: store.inProgressBacklogItem,
    updateBacklogItem: store.updateBacklogItem,
    updateLoop: store.updateLoop
  }
}
